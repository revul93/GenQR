# Shared helpers for install.sh, update.sh and genqrctl. Source it after setting GENQR_DIR.
# shellcheck shell=bash

GENQR_SERVICE="genqr"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Owner of the install directory = the service account.
app_user() { stat -c %U "$GENQR_DIR"; }

# Run a command as the service account from the install directory.
as_app() {
  local user; user="$(app_user)"
  if [ "$(id -un)" = "$user" ]; then
    (cd "$GENQR_DIR" && GENQR_ROOT="$GENQR_DIR" "$@")
  else
    (cd "$GENQR_DIR" && runuser -u "$user" -- env HOME="$GENQR_DIR" GENQR_ROOT="$GENQR_DIR" NODE_ENV=production "$@")
  fi
}

# Install + build. Dev dependencies are needed to compile TypeScript and bundle the client.
build_app() {
  as_app npm ci --include=dev --no-audit --no-fund
  as_app npm run build
}

read_port() {
  local port
  port="$(sed -n 's/^PORT=//p' "$GENQR_DIR/.env" 2>/dev/null | tail -n1)"
  echo "${port:-3000}"
}

db_client() {
  as_app node -e 'try { console.log(require("./config/database.json").client) } catch { console.log("sqlite") }'
}

# Absolute path of the SQLite database file (only meaningful when db_client is sqlite).
sqlite_file() {
  as_app node -e '
    const path = require("path");
    let f = "data/genqr.db";
    try { f = require("./config/database.json").connection.filename || f } catch {}
    console.log(path.resolve(process.cwd(), f));'
}

# Wait until /api/health answers, optionally on a specific commit. Returns 1 on timeout.
wait_healthy() {
  local expect="${1:-}" port body i
  port="$(read_port)"
  for i in $(seq 1 60); do
    if body="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
      if [ -z "$expect" ] || [[ "$body" == *"\"commit\":\"$expect\""* ]]; then return 0; fi
    fi
    sleep 2
  done
  return 1
}

# Render deploy/*.service|*.path templates into /etc/systemd/system.
install_units() {
  local node_bin unit user
  node_bin="$(command -v node)"
  user="$(app_user)"
  for unit in genqr.service genqr-update.service genqr-update.path; do
    sed -e "s|@GENQR_DIR@|$GENQR_DIR|g" -e "s|@NODE_BIN@|$node_bin|g" -e "s|@GENQR_USER@|$user|g" \
      "$GENQR_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  done
  chmod +x "$GENQR_DIR/scripts/update.sh" "$GENQR_DIR/scripts/genqrctl"
  ln -sf "$GENQR_DIR/scripts/genqrctl" /usr/local/bin/genqrctl
  systemctl daemon-reload
}
