#!/usr/bin/env bash
# Pull new code and rebuild in place, then restart. Run as root.
set -euo pipefail
APP_DIR="/srv/torhq/app"
ENV_FILE="${TORHQ_ENV_FILE:-/etc/torhq/torhq.env}"
cd "${APP_DIR}"

"${APP_DIR}/scripts/backup.sh" >/dev/null || true

# --- code ------------------------------------------------------------------
# A dirty working tree makes `git pull --ff-only` fail, and the failure is easy
# to miss in the middle of an upgrade — the build then quietly ships whatever
# was already on disk. Say so, and name the files, rather than guessing at what
# the local edits were for: discarding someone's hotfix is not this script's
# call to make.
if [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: ${APP_DIR} has uncommitted changes:" >&2
    git status --short >&2
    echo >&2
    echo "Commit them, or discard them with 'git reset --hard @' (after taking a" >&2
    echo "copy), then re-run this script." >&2
    exit 1
  fi
  git pull --ff-only
fi

npm ci --include=dev   # devDependencies (tsc/vite) are needed to build
npm run build

# --- database --------------------------------------------------------------
# Migrations need the same configuration the service runs with — above all
# TORHQ_MASTER_KEY, without which loadEnv() throws before a single migration
# runs. systemd supplies it from EnvironmentFile; a shell does not, so this
# script has to load it itself.
#
# And the result is NOT ignorable. This used to end in `|| true` on the grounds
# that migrations are idempotent, which confuses "safe to re-run" with "safe to
# skip": every upgrade silently skipped them, and the failure would only surface
# as a broken app the first time a release actually changed the schema.
if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
  set +a
else
  echo "warning: ${ENV_FILE} not readable — migrations will use the ambient environment" >&2
fi
npm run migrate --workspace server

chown -R torhq:torhq /srv/torhq
"${APP_DIR}/scripts/install-updater.sh"
systemctl restart torhq
echo "Upgrade complete. journalctl -u torhq -f"
