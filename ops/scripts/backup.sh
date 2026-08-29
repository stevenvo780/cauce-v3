#!/bin/sh
set -eu
umask 077

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_URL_FILE:-}" ]; then
  [ -r "$DATABASE_URL_FILE" ] || { printf 'DATABASE_URL_FILE is not readable\n' >&2; exit 2; }
  DATABASE_URL=
  IFS= read -r DATABASE_URL < "$DATABASE_URL_FILE" || [ -n "$DATABASE_URL" ]
  export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL or DATABASE_URL_FILE must be set outside version control}"
# shellcheck disable=SC1007  # CDPATH= empty on purpose: cd with no interference
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR=${BACKUP_DIR:-"$ROOT/backups"}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
case "$BACKUP_RETENTION_DAYS" in ''|*[!0-9]*) printf 'BACKUP_RETENTION_DAYS must be a non-negative integer\n' >&2; exit 2 ;; esac
node "$ROOT/scripts/check-postgres-tls.mjs"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/cauce-$stamp.dump"
tmp="$final.partial"
trap 'rm -f "$tmp"' EXIT
pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --serializable-deferrable --file="$tmp"
pg_restore --list "$tmp" >/dev/null
[ -s "$tmp" ] || { printf 'pg_dump produced an empty backup\n' >&2; exit 1; }
mv "$tmp" "$final"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
find "$BACKUP_DIR" -type f \( -name 'cauce-*.dump' -o -name 'cauce-*.dump.sha256' \) -mtime "+$BACKUP_RETENTION_DAYS" -delete
printf '%s\n' "$final"
