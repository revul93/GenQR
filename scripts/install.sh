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
#   GENQR_USER     service account             (default: genqr)
#
# Running it again on an installed server performs an update instead.
set -Eeuo pipefail

GENQR_REPO="${GENQR_REPO:-https://github.com/revul93/GenQR.git}"
GENQR_BRANCH="${GENQR_BRANCH:-main}"
GENQR_DIR="${GENQR_DIR:-/opt/genqr}"
GENQR_PORT="${GENQR_PORT:-3000}"
GENQR_USER="${GENQR_USER:-genqr}"
NODE_MAJOR=22

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "Installation failed (line $LINENO). Fix the problem above and run the installer again."' ERR

[ "$(id -u)" -eq 0 ] || die "Run as root, e.g.: curl -fsSL <installer-url> | sudo bash"
command -v systemctl > /dev/null || die "systemd is required."

if [ -d "$GENQR_DIR/.git" ]; then
  info "GenQR is already installed in $GENQR_DIR — running an update instead"
  exec "$GENQR_DIR/scripts/update.sh"
fi

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

info "Installing system packages (git, curl, build tools)"
if [ "$PM" = apt ]; then
  apt-get update -qq > /dev/null
  pkg_install ca-certificates curl git build-essential python3
else
  pkg_install ca-certificates curl git gcc-c++ make python3
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

# --- Service account and code -------------------------------------------------------
if ! id -u "$GENQR_USER" > /dev/null 2>&1; then
  info "Creating service account $GENQR_USER"
  useradd --system --home-dir "$GENQR_DIR" --no-create-home --shell /usr/sbin/nologin "$GENQR_USER"
fi
mkdir -p "$GENQR_DIR"
[ -z "$(ls -A "$GENQR_DIR")" ] || die "$GENQR_DIR exists and is not empty. Remove it or set GENQR_DIR."
chown "$GENQR_USER:" "$GENQR_DIR"

info "Cloning $GENQR_REPO ($GENQR_BRANCH) into $GENQR_DIR"
runuser -u "$GENQR_USER" -- env HOME="$GENQR_DIR" git clone --quiet --branch "$GENQR_BRANCH" "$GENQR_REPO" "$GENQR_DIR"

# The rest uses the helpers shipped with the code.
# shellcheck source=lib.sh
source "$GENQR_DIR/scripts/lib.sh"

info "Installing dependencies and building (this can take a few minutes)"
build_app

info "Writing configuration"
as_app mkdir -p data logs backups config
if [ ! -f "$GENQR_DIR/.env" ]; then
  KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  sed -e "s|^PORT=.*|PORT=$GENQR_PORT|" -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" "$GENQR_DIR/.env.example" > "$GENQR_DIR/.env"
  chown "$GENQR_USER:" "$GENQR_DIR/.env"
  chmod 600 "$GENQR_DIR/.env"
fi
[ -f "$GENQR_DIR/config/database.json" ] || as_app cp config/database.example.json config/database.json

info "Creating the database"
as_app node server/dist/cli/index.js migrate
secure_files

info "Installing systemd services and the genqrctl command"
install_units
systemctl enable --now genqr.service genqr-update.path > /dev/null 2>&1

info "Waiting for GenQR to start"
wait_healthy || die "GenQR did not start. See: journalctl -u genqr -n 100"

TOKEN="$(as_app node server/dist/cli/index.js setup-token 2> /dev/null || true)"
IP="$(hostname -I 2> /dev/null | awk '{print $1}')"
trap - ERR

cat <<EOF

  GenQR is installed and running.

  Open:         http://${IP:-<server-ip>}:$GENQR_PORT/
  Setup token:  ${TOKEN:-(run: genqrctl setup-token)}

  Next steps:
    - Put a reverse proxy with HTTPS in front of it (see $GENQR_DIR/deploy/nginx.conf.example)
      and open port 443 in the firewall.
    - Complete the setup wizard in the browser using the token above.

  Manage it with: genqrctl status | start | stop | restart | logs | update | reset-password <user>

EOF
