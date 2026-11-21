#!/usr/bin/env bash
# TorHQ installer for Debian 12 (run as root inside the unprivileged LXC).
# Idempotent: safe to re-run for upgrades.
set -euo pipefail

TORHQ_USER="${TORHQ_USER:-torhq}"
TORHQ_HOME="/srv/torhq"
APP_DIR="${TORHQ_HOME}/app"
ENV_DIR="/etc/torhq"
NODE_MAJOR=22

echo "==> TorHQ install starting"

if [[ $EUID -ne 0 ]]; then echo "Run as root (inside the LXC)."; exit 1; fi

# 1. System user (no login shell, owns the data dirs).
if ! id "${TORHQ_USER}" &>/dev/null; then
  adduser --system --group --home "${TORHQ_HOME}" --shell /usr/sbin/nologin "${TORHQ_USER}"
fi

# 2. Node.js 22 (NodeSource) if node is missing or too old.
if ! command -v node &>/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt ${NODE_MAJOR} ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR}"
  apt-get update
  apt-get install -y ca-certificates curl gnupg build-essential python3
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

# 3. Directory layout, owned by the torhq user.
mkdir -p "${APP_DIR}" "${TORHQ_HOME}/data" "${TORHQ_HOME}/staging" \
         "${TORHQ_HOME}/downloads" "${TORHQ_HOME}/libraries"/{movies,tv,music,books,manga} \
         "${ENV_DIR}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cp -a "${SRC_DIR}/." "${APP_DIR}/"

# 4. Build (installs deps + compiles server and web).
# --include=dev forces devDependencies (tsc/vite) even if NODE_ENV=production
# is inherited; they are required to build. `npm ci` needs the committed lockfile.
echo "==> Building TorHQ"
cd "${APP_DIR}"
npm ci --include=dev
npm run build

# 5. Env file (created once; never overwritten).
if [[ ! -f "${ENV_DIR}/torhq.env" ]]; then
  cp "${APP_DIR}/.env.example" "${ENV_DIR}/torhq.env"
  KEY="$(openssl rand -base64 48)"
  sed -i "s#^TORHQ_MASTER_KEY=.*#TORHQ_MASTER_KEY=${KEY}#" "${ENV_DIR}/torhq.env"
  echo "==> Generated a master key in ${ENV_DIR}/torhq.env"
fi
chmod 640 "${ENV_DIR}/torhq.env"
chown -R "${TORHQ_USER}:${TORHQ_USER}" "${TORHQ_HOME}" "${ENV_DIR}"

# 6. systemd unit.
cp "${APP_DIR}/deploy/torhq.service" /etc/systemd/system/torhq.service

# The unit's namespace/mount-based sandboxing (ProtectSystem=strict, PrivateTmp,
# PrivateDevices, Protect*, RestrictNamespaces) requires privileges an
# unprivileged LXC doesn't grant, so the service would fail to start there with
# status=226/NAMESPACE. Inside a container, drop in an override that relaxes only
# those directives — the container itself is the isolation boundary. seccomp/prctl
# based hardening (NoNewPrivileges, RestrictAddressFamilies, LockPersonality)
# still applies.
if systemd-detect-virt --container --quiet 2>/dev/null; then
  echo "==> Container detected — relaxing namespace-based systemd sandboxing"
  mkdir -p /etc/systemd/system/torhq.service.d
  cat > /etc/systemd/system/torhq.service.d/10-lxc.conf <<'EOF'
[Service]
ProtectSystem=false
ProtectHome=false
PrivateTmp=false
PrivateDevices=false
ProtectKernelTunables=false
ProtectKernelModules=false
ProtectControlGroups=false
RestrictNamespaces=false
EOF
fi

systemctl daemon-reload
systemctl enable torhq
export APP_DIR TORHQ_USER
"${APP_DIR}/scripts/install-updater.sh"
systemctl restart torhq

echo "==> Done. Check status:  systemctl status torhq"
echo "==> Logs:                journalctl -u torhq -f"
echo "==> Open http://<lxc-ip>:8787 and create the admin account."
