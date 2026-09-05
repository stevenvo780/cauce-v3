#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "El backup Hospital requiere root" >&2; exit 1; }

BACKUP_ROOT=/var/backups/cauce-v3-hospital
DUMP_ROOT=$BACKUP_ROOT/dumps
STATUS_FILE=$BACKUP_ROOT/status.json
DB_CONTAINER=hospital-cauce-postgres-1
DB_USER=cauce_hospital
DB_NAME=cauce_hospital
LOCK_FILE=/run/lock/hospital-cauce-backup.lock
RETENTION_DAYS=${HOSPITAL_CAUCE_BACKUP_RETENTION_DAYS:-14}
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
restore_container=
partial=
error_log=
status_published=0

case "$RETENTION_DAYS" in
  ''|*[!0-9]*) echo "HOSPITAL_CAUCE_BACKUP_RETENTION_DAYS debe ser entero" >&2; exit 2 ;;
esac
[ "$RETENTION_DAYS" -ge 1 ] || { echo "La retención debe ser positiva" >&2; exit 2; }

write_failed_status() {
  python3 - "$STATUS_FILE" "$started_at" <<'PY'
from pathlib import Path
import datetime
import json
import os
import sys
import tempfile

path = Path(sys.argv[1])
document = {
    "schema_version": 1,
    "overall": "failed",
    "run_started_utc": sys.argv[2],
    "run_finished_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
fd, temporary = tempfile.mkstemp(prefix=".status-", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(document, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
PY
}

cleanup() {
  if [ -n "$restore_container" ]; then
    docker rm -f "$restore_container" >/dev/null 2>&1 || true
  fi
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$error_log" ] || rm -f "$error_log"
}

on_exit() {
  local rc=$?
  trap - EXIT
  cleanup
  if [ "$rc" -ne 0 ] && [ "$status_published" -eq 0 ]; then
    write_failed_status || true
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

umask 077
install -d -m 0755 /run/lock
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Ya hay un backup Hospital en ejecución" >&2; exit 75; }
[ ! -L "$BACKUP_ROOT" ] || { echo "El directorio de backup no puede ser symlink" >&2; exit 1; }
install -d -o root -g root -m 0700 "$BACKUP_ROOT" "$DUMP_ROOT"
[ "$(docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" = true ] \
  || { echo "PostgreSQL Hospital no está activo" >&2; exit 1; }

final=$DUMP_ROOT/cauce-hospital-$stamp.dump
if [ -e "$final" ] || [ -e "$final.sha256" ] || [ -e "$final.restore.json" ]; then
  echo "Ya existe un backup con el sello $stamp" >&2
  exit 1
fi
partial=$final.partial
error_log=$final.partial.err
: >"$error_log"

docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --format=custom --compress=9 --no-owner --no-acl --serializable-deferrable \
  >"$partial" 2>"$error_log"
[ -s "$partial" ] || { echo "pg_dump produjo un archivo vacío" >&2; exit 1; }
docker exec -i "$DB_CONTAINER" pg_restore --list <"$partial" >/dev/null 2>>"$error_log"

database_image=$(docker inspect --format '{{.Image}}' "$DB_CONTAINER")
[[ "$database_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || { echo "No pude fijar la imagen de PostgreSQL" >&2; exit 1; }
restore_container="hospital-cauce-backup-restore-$stamp-$$"
docker run -d --name "$restore_container" --network none \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2147483648 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=cauce_restore -e POSTGRES_USER=postgres \
  "$database_image" >/dev/null 2>>"$error_log"

ready=0
for _attempt in $(seq 1 60); do
  if docker exec "$restore_container" pg_isready -U postgres -d cauce_restore >/dev/null 2>>"$error_log"; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "El verificador aislado no arrancó" >&2; exit 1; }
docker exec -i "$restore_container" pg_restore -U postgres -d cauce_restore \
  --exit-on-error --single-transaction --no-owner --no-acl <"$partial" 2>>"$error_log"

IFS=$'\t' read -r migrations tenants rooms agents profiles memberships acl_edges topology core_tables < <(
  docker exec "$restore_container" psql -XAtq -F $'\t' -U postgres -d cauce_restore -c \
    "SELECT (SELECT count(*) FROM schema_migrations),
            (SELECT count(*) FROM tenants),
            (SELECT count(*) FROM rooms),
            (SELECT count(*) FROM agents),
            (SELECT count(*) FROM agent_profiles),
            (SELECT count(*) FROM memberships),
            (SELECT count(*) FROM acl_edges),
            (SELECT string_agg(a.alias || ':' || a.role_template_slug || ':' || m.role, ',' ORDER BY a.alias)
               FROM agents a
               JOIN memberships m ON m.tenant_id=a.tenant_id AND m.alias=a.alias
              WHERE a.tenant_id='Hospital' AND m.room_id='grp.hospital'),
            (SELECT count(*) FROM information_schema.tables WHERE table_schema='public');"
)
if ! [[ "$migrations" =~ ^[1-9][0-9]*$ ]] \
   || [ "$tenants" != 1 ] || [ "$rooms" != 1 ] || [ "$agents" != 3 ] \
   || [ "$profiles" != 3 ] || [ "$memberships" != 4 ] || [ "$acl_edges" != 0 ] \
   || [ "$topology" != 'backend:hospital-developer:agent,frontend:hospital-developer:agent,operador:hospital-lider:operator' ] \
   || ! [[ "$core_tables" =~ ^[1-9][0-9]*$ ]]; then
  echo "La restauración aislada no conserva la topología Hospital" >&2
  exit 1
fi

docker rm -f "$restore_container" >/dev/null
restore_container=
chmod 0600 "$partial"
mv "$partial" "$final"
partial=
dump_sha=$(sha256sum "$final" | cut -d' ' -f1)
printf '%s  %s\n' "$dump_sha" "$(basename "$final")" >"$final.sha256.tmp"
chmod 0600 "$final.sha256.tmp"
mv "$final.sha256.tmp" "$final.sha256"

verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$final.restore.json" "$(basename "$final")" "$dump_sha" "$database_image" \
  "$migrations" "$tenants" "$rooms" "$agents" "$profiles" "$memberships" "$acl_edges" \
  "$topology" "$core_tables" "$verified_at" <<'PY'
from pathlib import Path
import json
import os
import sys
import tempfile

path = Path(sys.argv[1])
document = {
    "schema_version": 1,
    "suite": "hospital-cauce-backup-restore",
    "dump_file": sys.argv[2],
    "dump_sha256": sys.argv[3],
    "database_image_digest": sys.argv[4],
    "migration_count": int(sys.argv[5]),
    "tenant_count": int(sys.argv[6]),
    "room_count": int(sys.argv[7]),
    "agent_count": int(sys.argv[8]),
    "profile_count": int(sys.argv[9]),
    "membership_count": int(sys.argv[10]),
    "acl_edge_count": int(sys.argv[11]),
    "agent_topology": sys.argv[12],
    "public_table_count": int(sys.argv[13]),
    "isolated": True,
    "network": "none",
    "full_restore": True,
    "verified_at_utc": sys.argv[14],
}
fd, temporary = tempfile.mkstemp(prefix=".restore-", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(document, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
PY

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$STATUS_FILE" "$started_at" "$finished_at" "$final" "$dump_sha" "$final.restore.json" <<'PY'
from pathlib import Path
import json
import os
import sys
import tempfile

path = Path(sys.argv[1])
document = {
    "schema_version": 1,
    "overall": "ok",
    "run_started_utc": sys.argv[2],
    "run_finished_utc": sys.argv[3],
    "dump_file": sys.argv[4],
    "dump_sha256": sys.argv[5],
    "restore_evidence_file": sys.argv[6],
    "offsite": False,
}
fd, temporary = tempfile.mkstemp(prefix=".status-", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(document, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
PY
status_published=1

find "$DUMP_ROOT" -maxdepth 1 -type f \
  \( -name 'cauce-hospital-*.dump' -o -name 'cauce-hospital-*.dump.sha256' -o -name 'cauce-hospital-*.dump.restore.json' \) \
  -mtime "+$RETENTION_DAYS" -delete
rm -f "$error_log"
error_log=
echo "Backup Hospital verificado por restauración aislada: $(basename "$final")"
