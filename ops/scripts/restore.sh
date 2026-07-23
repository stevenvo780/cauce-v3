#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_URL_FILE:-}" ]; then
  [ -r "$DATABASE_URL_FILE" ] || { printf 'DATABASE_URL_FILE is not readable\n' >&2; exit 2; }
  DATABASE_URL=
  IFS= read -r DATABASE_URL < "$DATABASE_URL_FILE" || [ -n "$DATABASE_URL" ]
  export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL or DATABASE_URL_FILE must be set outside version control}"
: "${RESTORE_EXPECT_DB:?RESTORE_EXPECT_DB must name the intended database}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node "$ROOT/scripts/check-postgres-tls.mjs"
file=${1:?usage: restore.sh BACKUP.dump}
[ -r "$file" ] || { printf 'backup is not readable: %s\n' "$file" >&2; exit 2; }
[ "${RESTORE_CONFIRM:-}" = "restore:$RESTORE_EXPECT_DB" ] || {
  printf 'set RESTORE_CONFIRM=restore:%s to continue\n' "$RESTORE_EXPECT_DB" >&2
  exit 2
}
actual_db=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT current_database()')
[ "$actual_db" = "$RESTORE_EXPECT_DB" ] || { printf 'connected database does not match RESTORE_EXPECT_DB\n' >&2; exit 2; }
server_addr=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT coalesce(inet_server_addr()::text, 'local-socket')")
case "$server_addr" in
  local-socket|127.0.0.1|::1) ;;
  *) [ "${ALLOW_REMOTE_RESTORE:-no}" = yes ] || { printf 'remote restore refused; set ALLOW_REMOTE_RESTORE=yes only in a maintenance window\n' >&2; exit 2; } ;;
esac
pg_restore --list "$file" >/dev/null
if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
elif [ "${RESTORE_ALLOW_UNSIGNED:-no}" != yes ]; then
  printf 'checksum sidecar is required (RESTORE_ALLOW_UNSIGNED=yes only for a documented legacy drill)\n' >&2
  exit 2
fi
pg_restore "$file" --dbname="$DATABASE_URL" --clean --if-exists --exit-on-error --single-transaction --no-owner --no-acl
printf 'restore completed for database %s\n' "$RESTORE_EXPECT_DB"
