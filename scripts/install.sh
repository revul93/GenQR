#!/usr/bin/env bash
# GenQR one-line installer for Linux (Debian/Ubuntu, RHEL/Rocky/Alma/Fedora):
#
#   curl -fsSL https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.sh | sudo bash
#
# Optional settings (environment variables, put them after sudo: `| sudo GENQR_PORT=8080 bash`):
#   GENQR_REPO     git URL to clone            (default: https://github.com/revul93/GenQR.git)
#   GENQR_BRANCH   branch to track             (default: main)
#   GENQR_DIR      install directory           (default: /opt/genqr)
#   GENQR_PORT     HTTP port of the app        (default: 3000)
#   GENQR_HOST     address the app listens on  (default: 0.0.0.0; use 127.0.0.1 behind a proxy)
#   GENQR_USER     service account             (default: genqr)
#
# Running it again on an installed server refreshes the system files (service units,
# sudoers rule, genqrctl) and then updates GenQR.
#
# Security model: the GenQR folder belongs to the service account. Root never runs code
# from it: this installer is self-contained, writes the system files from its own copy,
# and the updater runs as the service account (restarting the service through a sudoers
# rule limited to start/stop/restart of genqr.service).
set -Eeuo pipefail

GENQR_REPO="${GENQR_REPO:-https://github.com/revul93/GenQR.git}"
GENQR_BRANCH="${GENQR_BRANCH:-main}"
GENQR_DIR="${GENQR_DIR:-/opt/genqr}"
GENQR_PORT="${GENQR_PORT:-3000}"
GENQR_HOST="${GENQR_HOST:-0.0.0.0}"
GENQR_USER="${GENQR_USER:-genqr}"
NODE_MAJOR=22

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "Installation failed (line $LINENO). Fix the problem above and run the installer again."' ERR

[ "$(id -u)" -eq 0 ] || die "Run as root, e.g.: curl -fsSL <installer-url> | sudo bash"
command -v systemctl > /dev/null || die "systemd is required."

as_app() { (cd "$GENQR_DIR" && runuser -u "$GENQR_USER" -- env HOME="$GENQR_DIR" GENQR_ROOT="$GENQR_DIR" NODE_ENV=production "$@"); }

# --- System packages ------------------------------------------------------------
if command -v apt-get > /dev/null; then
  PM=apt
elif command -v dnf > /dev/null; then
  PM=dnf
elif command -v yum > /dev/null; then
  PM=yum
else
  die "Unsupported distribution: apt, dnf or yum is required."
fi

pkg_install() {
  if [ "$PM" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" > /dev/null
  else
    "$PM" install -y -q "$@" > /dev/null
  fi
}

info "Installing system packages (git, curl, sudo, build tools)"
if [ "$PM" = apt ]; then
  apt-get update -qq > /dev/null
  pkg_install ca-certificates curl git sudo build-essential python3
else
  pkg_install ca-certificates curl git sudo gcc-c++ make python3
fi

node_major() { if command -v node > /dev/null; then node -p 'process.versions.node.split(".")[0]'; else echo 0; fi; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  info "Installing Node.js $NODE_MAJOR LTS from NodeSource"
  if [ "$PM" = apt ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null
  fi
  pkg_install nodejs
fi
info "Using Node.js $(node -v)"

# --- System files (written from this installer, never from the GenQR folder) ---------
install_system_files() {
  local node_bin systemctl_bin
  node_bin="$(command -v node)"
  systemctl_bin="$(command -v systemctl)"

  printf 'GENQR_DIR=%q\nGENQR_USER=%q\n' "$GENQR_DIR" "$GENQR_USER" > /etc/genqr.conf
  chmod 644 /etc/genqr.conf

  cat > /etc/systemd/system/genqr.service <<EOF
[Unit]
Description=GenQR - QR code generator and short-link service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$GENQR_USER
Group=$GENQR_USER
WorkingDirectory=$GENQR_DIR
Environment=NODE_ENV=production
Environment=GENQR_ROOT=$GENQR_DIR
ExecStart=$node_bin $GENQR_DIR/server/dist/index.js
# Always: the app exits on purpose to restart itself (e.g. after a database switch).
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

  # "Update now" in the web UI drops data/update.request; this runs the updater as the
  # service account (not root).
  cat > /etc/systemd/system/genqr-update.path <<EOF
[Unit]
Description=Watch for GenQR update requests

[Path]
PathExists=$GENQR_DIR/data/update.request
Unit=genqr-update.service

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/genqr-update.service <<EOF
[Unit]
Description=GenQR update job

[Service]
Type=oneshot
User=$GENQR_USER
Group=$GENQR_USER
WorkingDirectory=$GENQR_DIR
Environment=HOME=$GENQR_DIR
ExecStart=$GENQR_DIR/scripts/update.sh --from-ui
EOF

  # The only privilege the service account gets: controlling its own service.
  local sudoers=/etc/sudoers.d/genqr
  cat > "$sudoers.tmp" <<EOF
# Installed by GenQR: lets the updater restart the GenQR service, nothing else.
Defaults:$GENQR_USER !requiretty
$GENQR_USER ALL=(root) NOPASSWD: $systemctl_bin start genqr.service, $systemctl_bin stop genqr.service, $systemctl_bin restart genqr.service
EOF
  chmod 440 "$sudoers.tmp"
  visudo -cf "$sudoers.tmp" > /dev/null || die "The generated sudoers rule is invalid."
  mv -f "$sudoers.tmp" "$sudoers"

  # A root-owned copy (not a link into the GenQR folder).
  install -m 0755 -o root -g root "$1" /usr/local/bin/genqrctl

  systemctl daemon-reload
}

# --- Existing installation: refresh system files, then update as the service account ---
if [ -d "$GENQR_DIR/.git" ]; then
  info "GenQR is already installed in $GENQR_DIR — refreshing system files"
  GENQR_USER="$(stat -c %U "$GENQR_DIR")"
  # genqrctl comes from the repository on GitHub, not from the local folder.
  RAW_BASE="$(printf '%s' "$GENQR_REPO" | sed -E 's#^https://github.com/([^/]+)/([^/.]+)(\.git)?$#https://raw.githubusercontent.com/\1/\2#')"
  CTL="$(mktemp)"
  if curl -fsSL "$RAW_BASE/$GENQR_BRANCH/scripts/genqrctl" -o "$CTL" && head -1 "$CTL" | grep -q bash; then
    install_system_files "$CTL"
  else
    die "Could not download genqrctl from $RAW_BASE; nothing was changed."
  fi
  rm -f "$CTL"
  # Older versions ran the updater as root and left root-owned files behind.
  for f in "$GENQR_DIR/data/update.lock" "$GENQR_DIR/data/update-status.json" "$GENQR_DIR/logs/update.log"; do
    [ -e "$f" ] && chown "$GENQR_USER:" "$f"
  done
  systemctl enable --now genqr-update.path > /dev/null 2>&1

  # Bring the code to the latest version first, so the updater that runs next is the
  # current one (older updaters expected to run as root).
  info "Updating GenQR"
  as_app git fetch --quiet origin "$GENQR_BRANCH" || die "Could not fetch from $GENQR_REPO."
  as_app git merge --quiet --ff-only "origin/$GENQR_BRANCH" || die "Local changes in $GENQR_DIR prevent updating; inspect with: git -C $GENQR_DIR status"
  trap - ERR
  # --force: rebuild, migrate and restart on the code just pulled (it backs up the database first).
  exec runuser -u "$GENQR_USER" -- env HOME="$GENQR_DIR" "$GENQR_DIR/scripts/update.sh" --force
fi

# --- Fresh installation -------------------------------------------------------------
if ! id -u "$GENQR_USER" > /dev/null 2>&1; then
  info "Creating service account $GENQR_USER"
  useradd --system --home-dir "$GENQR_DIR" --no-create-home --shell /usr/sbin/nologin "$GENQR_USER"
fi
mkdir -p "$GENQR_DIR"
[ -z "$(ls -A "$GENQR_DIR")" ] || die "$GENQR_DIR exists and is not empty. Remove it or set GENQR_DIR."
chown "$GENQR_USER:" "$GENQR_DIR"

info "Cloning $GENQR_REPO ($GENQR_BRANCH) into $GENQR_DIR"
runuser -u "$GENQR_USER" -- env HOME="$GENQR_DIR" git clone --quiet --branch "$GENQR_BRANCH" "$GENQR_REPO" "$GENQR_DIR"
# Snapshot genqrctl now, before anything else has run as the service account.
CTL="$(mktemp)"
cp "$GENQR_DIR/scripts/genqrctl" "$CTL"

info "Installing dependencies and building (this can take a few minutes)"
as_app npm ci --include=dev --no-audit --no-fund --loglevel=error
as_app npm run build --silent

info "Writing configuration"
as_app mkdir -p data logs backups config
if [ ! -f "$GENQR_DIR/.env" ]; then
  KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  sed -e "s|^PORT=.*|PORT=$GENQR_PORT|" -e "s|^HOST=.*|HOST=$GENQR_HOST|" -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" "$GENQR_DIR/.env.example" |
    as_app sh -c 'umask 077; cat > .env'
fi
[ -f "$GENQR_DIR/config/database.json" ] || as_app cp config/database.example.json config/database.json

info "Creating the database"
as_app node server/dist/cli/index.js migrate
as_app chmod -R o-rwx,g-w data logs backups config

info "Installing systemd services, the sudoers rule and the genqrctl command"
install_system_files "$CTL"
rm -f "$CTL"
systemctl enable --now genqr.service genqr-update.path > /dev/null 2>&1

info "Waiting for GenQR to start"
for _ in $(seq 1 60); do curl -fsS --max-time 3 "http://127.0.0.1:$GENQR_PORT/api/health" > /dev/null 2>&1 && break; sleep 2; done
curl -fsS --max-time 3 "http://127.0.0.1:$GENQR_PORT/api/health" > /dev/null 2>&1 || die "GenQR did not start. See: journalctl -u genqr -n 100"

TOKEN="$(as_app node server/dist/cli/index.js setup-token 2> /dev/null || true)"
IP="$(hostname -I 2> /dev/null | awk '{print $1}')"
trap - ERR

cat <<EOF

  GenQR is installed and running.

  Open:         http://${IP:-<server-ip>}:$GENQR_PORT/
  Setup token:  ${TOKEN:-(run: genqrctl setup-token)}

  Next steps:
    - Put a reverse proxy with HTTPS in front of it (see $GENQR_DIR/deploy/nginx.conf.example),
      then set HOST=127.0.0.1 in $GENQR_DIR/.env and run: genqrctl restart
    - Complete the setup wizard in the browser using the token above.

  Manage it with: genqrctl status | start | stop | restart | logs | update | reset-password <user>

EOF
