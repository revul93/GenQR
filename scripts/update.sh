#!/usr/bin/env bash
# GenQR updater: backup → git pull → install/build → migrate → restart → health check.
# Rolls back to the previous commit and database backup if any step after the pull fails.
#
#   genqrctl update            update if a newer commit exists on the tracked branch
#   genqrctl update --force    rebuild and restart even when already up to date
#
# Runs as the GenQR service account, never as root: the service is restarted through a
# sudoers rule (installed by install.sh) that allows only start/stop/restart of
# genqr.service. Also started by systemd (genqr-update.path → genqr-update.service, running
# as the service account) when an admin clicks "Update now"; that run passes --from-ui.
#
# Two stages: stage 1 (this file as it was before the pull) fetches, backs up and
# fast-forwards; it then re-executes the *newly pulled* update.sh with --continue, so
# build/migrate/restart steps always come from the version being installed.
set -Eeuo pipefail

GENQR_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=lib.sh
source "$GENQR_DIR/scripts/lib.sh"

FORCE=0
CONTINUE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --from-ui) ;;
    --continue) CONTINUE=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

APP_USER="$(app_user)"
# Started as root by hand: drop to the service account. (Stage 2 may still arrive as root
# from the updater of older versions; it then only uses root to restart the service.)
if [ "$(id -u)" -eq 0 ] && [ "$CONTINUE" -eq 0 ]; then
  exec runuser -u "$APP_USER" -- env HOME="$GENQR_DIR" "$0" "$@"
fi

DATA="$GENQR_DIR/data"
LOGS="$GENQR_DIR/logs"
REQUEST="$DATA/update.request"
STATUS="$DATA/update-status.json"
LOG="$LOGS/update.log"

# State handed from stage 1 to stage 2.
OLD_COMMIT="${GENQR_UPDATE_OLD:-}"
NEW_COMMIT="${GENQR_UPDATE_NEW:-}"
BACKUP="${GENQR_UPDATE_BACKUP:-}"
REQUESTED_BY="${GENQR_UPDATE_BY:-cli:${SUDO_USER:-$(id -un)}}"
REQUESTED_BY="${REQUESTED_BY//[^A-Za-z0-9._:@-]/}"

log() { echo "[$(date '+%F %T')] $*"; }

# Written as the service account, via a temp file, so no other user can redirect the write.
write_status() {
  local msg="${2//\"/\'}"
  printf '{"state":"%s","message":"%s","requestedBy":"%s","fromCommit":"%s","toCommit":"%s","at":"%s"}\n' \
    "$1" "$msg" "$REQUESTED_BY" "$OLD_COMMIT" "$NEW_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
    as_app sh -c 'umask 027; cat > "$1.tmp" && mv -f "$1.tmp" "$1"' _ "$STATUS"
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
  service_ctl stop || true
  # Undo this update's migrations while the new code (which knows how) is still in place.
  if [ "${MIGRATED:-0}" -eq 1 ] && [ ! -f "$BACKUP/genqr.db" ]; then
    as_app node server/dist/cli/index.js migrate-rollback || log "Undoing the migrations failed"
  fi
  as_app git reset --hard "$OLD_COMMIT" || true
  build_app || log "Rebuilding the previous version failed"
  if [ -f "$BACKUP/genqr-dump.json.gz" ]; then
    log "Restoring database contents from $BACKUP/genqr-dump.json.gz"
    as_app node server/dist/cli/index.js restore "$BACKUP/genqr-dump.json.gz" || log "Restoring the dump failed"
  fi
  if [ -f "$BACKUP/genqr.db" ]; then
    local dbfile; dbfile="$(sqlite_file)"
    log "Restoring database from $BACKUP/genqr.db"
    as_app rm -f "$dbfile-wal" "$dbfile-shm"
    as_app cp -f "$BACKUP/genqr.db" "$dbfile"
  fi
  service_ctl start || true
  if wait_healthy "$OLD_COMMIT"; then
    write_status failed "$reason. Rolled back to ${OLD_COMMIT:0:7}."
  else
    write_status failed "$reason. ROLLBACK ALSO FAILED - check: journalctl -u $GENQR_SERVICE"
  fi
  exit 1
}

# ---------------------------------------------------------------------------------
# Stage 2: runs from the newly pulled code.
# ---------------------------------------------------------------------------------
if [ "$CONTINUE" -eq 1 ]; then
  [ -n "$OLD_COMMIT" ] && [ -n "$NEW_COMMIT" ] || die "--continue is internal to the updater."
  trap 'rollback "Update step failed (line $LINENO)"' ERR

  log "Installing dependencies and building"
  write_status running "Building"
  build_app

  log "Checking the database driver"
  as_app node server/dist/cli/index.js install-driver

  log "Applying database migrations"
  write_status running "Migrating database"
  MIGRATE_OUT="$(as_app node server/dist/cli/index.js migrate)"
  echo "$MIGRATE_OUT"
  if [[ "$MIGRATE_OUT" == *"Applied migrations"* ]]; then MIGRATED=1; fi
  secure_files

  log "Restarting $GENQR_SERVICE"
  write_status running "Restarting"
  service_ctl restart
  wait_healthy "$NEW_COMMIT" || rollback "The new version did not become healthy"

  trap - ERR
  DONE="Updated to ${NEW_COMMIT:0:7}"
  # Service definitions, sudoers and genqrctl are installed by root from install.sh, never
  # from this (service-owned) folder. Tell the admin when they changed.
  if ! as_app git diff --quiet "$OLD_COMMIT" "$NEW_COMMIT" -- scripts/install.sh scripts/genqrctl 2> /dev/null; then
    DONE="$DONE. System files changed: re-run the installer (curl … install.sh | sudo bash) to apply them."
    log "NOTE: this version changes the installer or genqrctl. Apply with: curl -fsSL https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.sh | sudo bash"
  fi
  log "Update complete: now on ${NEW_COMMIT:0:7}"
  write_status success "$DONE"

  # Keep the 10 most recent backups.
  as_app sh -c 'ls -1dt backups/*/ 2> /dev/null | tail -n +11 | xargs -r rm -rf' || true
  exit 0
fi

# ---------------------------------------------------------------------------------
# Stage 1: check, back up, pull.
# ---------------------------------------------------------------------------------
mkdir -p "$DATA" "$LOGS" "$GENQR_DIR/backups"
# Older versions ran this as root and left root-owned files behind; the service account
# owns these folders, so it can replace them.
for f in "$DATA/update.lock" "$STATUS" "$LOG"; do [ ! -e "$f" ] || [ -w "$f" ] || rm -f "$f"; done

# Only one update at a time. The lock (fd 9) is inherited by stage 2.
exec 9> "$DATA/update.lock"
flock -n 9 || die "Another update is already running."

if [ -f "$REQUEST" ]; then
  REQUESTED_BY="$(sed -n 's/.*"requestedBy":"\([^"]*\)".*/\1/p' "$REQUEST" | tr -cd 'A-Za-z0-9._:@-')"
  rm -f "$REQUEST"
fi

# Keep the previous log, then mirror everything to the new one (the web UI tails it).
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
(umask 027; : > "$LOG")
exec > >(tee -a "$LOG") 2>&1

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

BACKUP="$GENQR_DIR/backups/$(date +%Y%m%d-%H%M%S)-${OLD_COMMIT:0:7}"
log "Backing up configuration and database to $BACKUP"
write_status running "Backing up"
as_app mkdir -p "$BACKUP"
as_app cp -a .env config "$BACKUP/" 2> /dev/null || true
DB_CLIENT="$(db_client)"
if [ "$DB_CLIENT" = "sqlite" ]; then
  as_app node server/dist/cli/index.js backup "$BACKUP/genqr.db"
else
  as_app node server/dist/cli/index.js backup "$BACKUP/genqr-dump.json.gz"
fi

trap 'rollback "Update step failed (line $LINENO)"' ERR
log "Applying new code"
write_status running "Installing ${NEW_COMMIT:0:7}"
as_app git merge --ff-only "origin/$BRANCH"

# Hand over to the update.sh that was just pulled.
trap - ERR
export GENQR_UPDATE_OLD="$OLD_COMMIT" GENQR_UPDATE_NEW="$NEW_COMMIT" GENQR_UPDATE_BACKUP="$BACKUP" GENQR_UPDATE_BY="$REQUESTED_BY"
exec bash "$GENQR_DIR/scripts/update.sh" --continue
