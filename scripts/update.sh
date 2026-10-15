#!/usr/bin/env bash
# GenQR updater: backup → git pull → install/build → migrate → restart → health check.
# Rolls back to the previous commit and database backup if any step after the backup fails.
#
#   genqrctl update            update if a newer commit exists on the tracked branch
#   genqrctl update --force    rebuild and restart even when already up to date
#
# Also started by systemd (genqr-update.path → genqr-update.service) when an admin
# clicks "Update now"; that run passes --from-ui.
set -Eeuo pipefail

GENQR_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=lib.sh
source "$GENQR_DIR/scripts/lib.sh"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --from-ui) ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"

DATA="$GENQR_DIR/data"
LOGS="$GENQR_DIR/logs"
REQUEST="$DATA/update.request"
STATUS="$DATA/update-status.json"
LOG="$LOGS/update.log"
APP_USER="$(app_user)"
mkdir -p "$DATA" "$LOGS" "$GENQR_DIR/backups"
chown "$APP_USER:" "$DATA" "$LOGS" "$GENQR_DIR/backups"

# Only one update at a time.
exec 9> "$DATA/update.lock"
flock -n 9 || die "Another update is already running."

REQUESTED_BY="cli:${SUDO_USER:-$(id -un)}"
if [ -f "$REQUEST" ]; then
  REQUESTED_BY="$(sed -n 's/.*"requestedBy":"\([^"]*\)".*/\1/p' "$REQUEST")"
  rm -f "$REQUEST"
fi

# Keep the previous log, then mirror everything to the new one (the web UI tails it).
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
exec > >(tee -a "$LOG") 2>&1
chown "$APP_USER:" "$LOG"

OLD_COMMIT=""
NEW_COMMIT=""
BACKUP=""

log() { echo "[$(date '+%F %T')] $*"; }

write_status() {
  local msg="${2//\"/\'}"
  printf '{"state":"%s","message":"%s","requestedBy":"%s","fromCommit":"%s","toCommit":"%s","at":"%s"}\n' \
    "$1" "$msg" "$REQUESTED_BY" "$OLD_COMMIT" "$NEW_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS.tmp"
  chown "$APP_USER:" "$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"
}

fail() {
  trap - ERR
  log "ERROR: $1"
  write_status failed "$1"
  exit 1
}

rollback() {
  trap - ERR
  local reason="$1"
  log "ERROR: $reason"
  log "Rolling back to ${OLD_COMMIT:0:7}"
  write_status running "Rolling back: $reason"
  systemctl stop "$GENQR_SERVICE" || true
  as_app git reset --hard "$OLD_COMMIT" || true
  build_app || log "Rebuilding the previous version failed"
  if [ -f "$BACKUP/genqr.db" ]; then
    local dbfile; dbfile="$(sqlite_file)"
    log "Restoring database from $BACKUP/genqr.db"
    rm -f "$dbfile-wal" "$dbfile-shm"
    cp -f "$BACKUP/genqr.db" "$dbfile"
    chown "$APP_USER:" "$dbfile"
  fi
  install_units || true
  systemctl start "$GENQR_SERVICE" || true
  if wait_healthy "$OLD_COMMIT"; then
    write_status failed "$reason. Rolled back to ${OLD_COMMIT:0:7}."
  else
    write_status failed "$reason. ROLLBACK ALSO FAILED - check: journalctl -u $GENQR_SERVICE"
  fi
  exit 1
}

trap 'fail "Update step failed (line $LINENO)"' ERR

log "GenQR update started by $REQUESTED_BY"
OLD_COMMIT="$(as_app git rev-parse HEAD)"
BRANCH="$(as_app git rev-parse --abbrev-ref HEAD)"
write_status running "Checking for updates"

if [ -n "$(as_app git status --porcelain --untracked-files=no)" ]; then
  fail "Tracked files were modified locally in $GENQR_DIR; refusing to update. Inspect with: git -C $GENQR_DIR status"
fi

log "Fetching origin/$BRANCH"
as_app git fetch --prune origin "$BRANCH" || fail "Could not fetch from the git remote"
NEW_COMMIT="$(as_app git rev-parse "origin/$BRANCH")"

if [ "$NEW_COMMIT" = "$OLD_COMMIT" ] && [ "$FORCE" -eq 0 ]; then
  log "Already up to date (${OLD_COMMIT:0:7})"
  write_status up-to-date "Already on the latest version"
  exit 0
fi
log "Updating ${OLD_COMMIT:0:7} -> ${NEW_COMMIT:0:7}"
as_app git log --oneline "$OLD_COMMIT..$NEW_COMMIT" | sed 's/^/    /' || true

# --- Backup -------------------------------------------------------------------
BACKUP="$GENQR_DIR/backups/$(date +%Y%m%d-%H%M%S)-${OLD_COMMIT:0:7}"
log "Backing up configuration and database to $BACKUP"
write_status running "Backing up"
as_app mkdir -p "$BACKUP"
cp -a "$GENQR_DIR/.env" "$GENQR_DIR/config" "$BACKUP/" 2>/dev/null || true
DB_CLIENT="$(db_client)"
if [ "$DB_CLIENT" = "sqlite" ]; then
  as_app node server/dist/cli/index.js backup "$BACKUP/genqr.db"
else
  warn "Automatic backup of $DB_CLIENT databases is not built in yet; make sure your DBA backups are current."
fi

# From here on, any failure restores the previous version.
trap 'rollback "Update step failed (line $LINENO)"' ERR

log "Applying new code"
write_status running "Installing ${NEW_COMMIT:0:7}"
as_app git merge --ff-only "origin/$BRANCH"

log "Installing dependencies and building"
write_status running "Building"
build_app

log "Applying database migrations"
write_status running "Migrating database"
as_app node server/dist/cli/index.js migrate

log "Updating systemd units"
install_units

log "Restarting $GENQR_SERVICE"
write_status running "Restarting"
systemctl restart "$GENQR_SERVICE"
wait_healthy "$NEW_COMMIT" || rollback "The new version did not become healthy"

trap - ERR
log "Update complete: now on ${NEW_COMMIT:0:7}"
write_status success "Updated to ${NEW_COMMIT:0:7}"

# Keep the 10 most recent backups.
ls -1dt "$GENQR_DIR"/backups/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf || true
