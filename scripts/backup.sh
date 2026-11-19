#!/usr/bin/env bash
# Back up TorHQ state (SQLite db + env file). Media libraries are NOT included.
set -euo pipefail
# Everything written here (the DB copy, the env file holding TORHQ_MASTER_KEY, the
# tarball, a newly created destination directory) is owner-only from the first byte.
umask 077
DEST="${1:-/srv/torhq/backups}"
APP="${TORHQ_APP_DIR:-/srv/torhq/app}"
DB="${TORHQ_DB:-/srv/torhq/data/torhq.db}"
ENV_FILE="${TORHQ_ENV_FILE:-/etc/torhq/torhq.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${DEST}"

# A run leaves only the finished tarball: on any exit remove the loose copies, the
# SQLite -shm/-wal sidecars the verification step creates, and a half-written tarball.
DONE=0
cleanup() {
  rm -f "${DEST}/torhq-${STAMP}.db" "${DEST}/torhq-${STAMP}.db-shm" \
    "${DEST}/torhq-${STAMP}.db-wal" "${DEST}/torhq-${STAMP}.db-journal" \
    "${DEST}/torhq-${STAMP}.env"
  if [ "${DONE}" != "1" ]; then rm -f "${DEST}/torhq-${STAMP}.tar.gz"; fi
}
trap cleanup EXIT

# Online, consistent, WAL-safe backup.
#
# This must never be a plain `cp` of the .db file: TorHQ runs in WAL mode, so a
# live database keeps most of its content in the -wal sidecar and the main file
# alone can be a near-empty 4 KB stub. Copying it produces a backup that looks
# plausible and restores to nothing.
#
# The sqlite3 CLI is not a dependency of TorHQ and is absent from the standard
# LXC install, so better-sqlite3's backup API — which ships with the app — is the
# primary path, and sqlite3 is only the fallback.
if [ -f "${APP}/node_modules/better-sqlite3/package.json" ]; then
  node -e '
    const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[2], { readonly: true });
    db.backup(process.argv[3])
      .then((r) => console.log(`  ${r.totalPages} pages copied`))
      .catch((e) => { console.error(`backup failed: ${e.message}`); process.exit(1); });
  ' "${APP}" "${DB}" "${DEST}/torhq-${STAMP}.db"
elif command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB}" ".backup '${DEST}/torhq-${STAMP}.db'"
else
  echo "error: neither ${APP}/node_modules/better-sqlite3 nor the sqlite3 CLI is available." >&2
  echo "       Refusing to copy ${DB} directly — with WAL enabled that backup would be incomplete." >&2
  exit 1
fi

# A backup that restores to an empty database is worse than no backup, because
# it is only discovered at restore time. Verify before declaring success.
USERS="$(node -e '
  const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
  const db = new Database(process.argv[2], { readonly: true });
  process.stdout.write(String(db.prepare("select count(*) c from users").get().c));
' "${APP}" "${DEST}/torhq-${STAMP}.db" 2>/dev/null || echo "?")"
if [ "${USERS}" = "0" ]; then
  echo "error: the backup contains no user accounts — it did not capture the live database." >&2
  exit 1
fi

cp "${ENV_FILE}" "${DEST}/torhq-${STAMP}.env"
tar -czf "${DEST}/torhq-${STAMP}.tar.gz" -C "${DEST}" "torhq-${STAMP}.db" "torhq-${STAMP}.env"
DONE=1
cleanup
echo "Backup written: ${DEST}/torhq-${STAMP}.tar.gz (${USERS} user account(s))"
echo "NOTE: the .env holds TORHQ_MASTER_KEY — protect this backup; secrets are unreadable without it."
