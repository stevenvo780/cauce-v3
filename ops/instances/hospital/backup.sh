#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "El backup Hospital requiere root" >&2; exit 1; }

BACKUP_ROOT=/var/backups/cauce-v3-hospital
DUMP_ROOT=$BACKUP_ROOT/dumps
STATUS_FILE=$BACKUP_ROOT/status.json
DB_CONTAINER=hospital-cauce-postgres-1
DB_USER=cauce_hospital
DB_NAME=cauce_hospital
BLOB_VOLUME=hospital-cauce_blobs_data
LOCK_FILE=/run/lock/hospital-cauce-backup.lock
RETENTION_DAYS=${HOSPITAL_CAUCE_BACKUP_RETENTION_DAYS:-14}
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
restore_container=
restore_blob_volume=
partial=
blob_partial=
manifest_partial=
error_log=
status_published=0
publishing=0

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
    "schema_version": 2,
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
  if [[ "$restore_blob_volume" =~ ^[a-f0-9]{64}$ ]]; then
    docker volume rm "$restore_blob_volume" >/dev/null 2>&1 \
      || echo "No pude retirar el volumen temporal de verificación" >&2
  fi
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$blob_partial" ] || rm -f "$blob_partial"
  [ -z "$manifest_partial" ] || rm -f "$manifest_partial"
  [ -z "$error_log" ] || rm -f "$error_log"
  if [ "$publishing" -eq 1 ] && [ "$status_published" -eq 0 ]; then
    rm -f "$final" "$final.sha256" "$final.restore.json" \
      "$final.blobs.tar" "$final.blobs.tar.sha256" "$final.blobs.tsv" \
      "$final.sha256.tmp" "$final.blobs.tar.sha256.tmp"
  fi
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
if docker volume inspect "$BLOB_VOLUME" >/dev/null 2>&1; then
  blob_volume_present=true
else
  blob_volume_present=false
fi

final=$DUMP_ROOT/cauce-hospital-$stamp.dump
if [ -e "$final" ] || [ -e "$final.sha256" ] || [ -e "$final.restore.json" ] \
   || [ -e "$final.blobs.tar" ] || [ -e "$final.blobs.tar.sha256" ] \
   || [ -e "$final.blobs.tsv" ]; then
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

manifest_partial=$final.blobs.tsv.partial
blob_table_present=$(docker exec "$restore_container" psql -XAtq -v ON_ERROR_STOP=1 \
  -U postgres -d cauce_restore -c "SELECT to_regclass('public.blobs') IS NOT NULL" 2>>"$error_log")
case "$blob_table_present" in
  t)
    blob_table_present=true
    docker exec "$restore_container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d cauce_restore \
      -c "COPY (SELECT DISTINCT sha256, bytes FROM blobs ORDER BY sha256, bytes) TO STDOUT" \
      >"$manifest_partial" 2>>"$error_log"
    ;;
  f)
    blob_table_present=false
    : >"$manifest_partial"
    ;;
  *) echo "No pude determinar si el respaldo restaurado contiene blobs" >&2; exit 1 ;;
esac
[ "$(stat -c %s "$manifest_partial")" -le 268435456 ] \
  || { echo "El manifiesto de blobs excede el límite del monitor" >&2; exit 1; }
blob_partial=$final.blobs.tar.partial
if [ "$blob_volume_present" = true ]; then
  docker run --rm --network none --read-only --user 1000:1000 \
    --mount "type=volume,src=$BLOB_VOLUME,dst=/blobs,readonly" \
    "$database_image" tar -C /blobs --exclude=./tmp -cf - . \
    >"$blob_partial" 2>>"$error_log"
else
  [ "$blob_table_present" = false ] \
    || { echo "El volumen de blobs Hospital no existe" >&2; exit 1; }
  tar -cf "$blob_partial" --files-from /dev/null
fi
[ -s "$blob_partial" ] || { echo "El archivo de blobs quedó vacío" >&2; exit 1; }

blob_counts=$(python3 - "$manifest_partial" "$blob_partial" <<'PY'
from pathlib import Path
import hashlib
import re
import sys
import tarfile

rows = {}
manifest = Path(sys.argv[1]).read_text(encoding="ascii")
if manifest and not manifest.endswith("\n"):
    raise SystemExit("Manifiesto de blobs restaurado incompleto")
for line in manifest.splitlines():
    match = re.fullmatch(r"([a-f0-9]{64})\t([1-9][0-9]*)", line)
    if match is None or match.group(1) in rows:
        raise SystemExit("Manifiesto de blobs restaurado inválido")
    rows[match.group(1)] = int(match.group(2))

found = set()
with tarfile.open(sys.argv[2], "r|") as archive:
    for member in archive:
        if member.isdir() and member.name in {".", "./"}:
            continue
        match = re.fullmatch(r"\./([a-f0-9]{64})", member.name)
        if not member.isfile() or match is None or match.group(1) in found:
            raise SystemExit("Archivo de blobs contiene una entrada insegura")
        digest = match.group(1)
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit("No pude leer un blob del archivo")
        hasher = hashlib.sha256()
        size = 0
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
            size += len(chunk)
        if hasher.hexdigest() != digest or size < 1 or (digest in rows and size != rows[digest]):
            raise SystemExit("Blob archivado no coincide con digest o tamaño restaurado")
        found.add(digest)

if not rows.keys() <= found:
    raise SystemExit("El archivo no contiene todos los blobs de la base restaurada")
print(len(rows), sum(rows.values()), len(found))
PY
)
read -r blob_rows blob_bytes archived_blobs <<<"$blob_counts"

restore_blob_volume=$(docker volume create --label cauce.hospital.backup-verify=true)
[[ "$restore_blob_volume" =~ ^[a-f0-9]{64}$ ]] \
  || { echo "Docker no creó un volumen temporal identificable" >&2; exit 1; }
docker run --rm -i --network none --read-only --user 0:0 \
  --mount "type=volume,src=$restore_blob_volume,dst=/blobs" \
  "$database_image" tar -C /blobs -xf - <"$blob_partial" 2>>"$error_log"
docker run --rm --network none --read-only --user 1000:1000 \
  --mount "type=volume,src=$restore_blob_volume,dst=/blobs,readonly" \
  "$database_image" tar -C /blobs -cf - . >/dev/null 2>>"$error_log" \
  || { echo "UID 1000 no puede rearchivar los blobs restaurados" >&2; exit 1; }
docker run --rm -i --network none --read-only --user 1000:1000 \
  --mount "type=volume,src=$restore_blob_volume,dst=/blobs,readonly" \
  "$database_image" sh -eu -c '
    tab=$(printf "\t")
    while IFS="$tab" read -r digest expected_bytes; do
      file="/blobs/$digest"
      [ -f "$file" ] && [ ! -L "$file" ] || exit 1
      [ "$(stat -c %s "$file")" = "$expected_bytes" ] || exit 1
      actual=$(sha256sum "$file")
      [ "${actual%% *}" = "$digest" ] || exit 1
    done
  ' <"$manifest_partial" 2>>"$error_log" \
  || { echo "La restauración aislada de blobs no conserva digest y tamaño" >&2; exit 1; }
docker volume rm "$restore_blob_volume" >/dev/null
restore_blob_volume=

IFS=$'\t' read -r migrations tenants rooms agents profiles memberships acl_edges topology core_tables < <(
  docker exec "$restore_container" psql -XAtq -F $'\t' -U postgres -d cauce_restore -c \
    "SELECT (SELECT count(*) FROM schema_migrations),
            (SELECT count(*) FROM tenants),
            (SELECT count(*) FROM rooms),
            (SELECT count(*) FROM agents WHERE enabled),
            (SELECT count(*) FROM agent_profiles p JOIN agents a USING (tenant_id, alias) WHERE a.enabled),
            (SELECT count(*) FROM memberships WHERE enabled),
            (SELECT count(*) FROM acl_edges),
            (SELECT string_agg(a.alias || ':' || a.role_template_slug || ':' || m.role, ',' ORDER BY a.alias)
               FROM agents a
               JOIN memberships m ON m.tenant_id=a.tenant_id AND m.alias=a.alias
              WHERE a.tenant_id='Hospital' AND m.room_id='grp.hospital' AND a.enabled AND m.enabled),
            (SELECT count(*) FROM information_schema.tables WHERE table_schema='public');"
)
if ! [[ "$migrations" =~ ^[1-9][0-9]*$ ]] \
   || [ "$tenants" != 1 ] || [ "$rooms" != 1 ] || [ "$agents" != 3 ] \
   || [ "$profiles" != 3 ] || [ "$memberships" != 4 ] || [ "$acl_edges" != 0 ] \
   || [ "$topology" != 'operador:hospital-lider:operator,perseo:hospital-praxis-developer:agent,teseo:hospital-praxis-developer:agent' ] \
   || ! [[ "$core_tables" =~ ^[1-9][0-9]*$ ]]; then
  echo "La restauración aislada no conserva la topología Hospital" >&2
  exit 1
fi

docker rm -f "$restore_container" >/dev/null
restore_container=
chmod 0600 "$partial" "$blob_partial" "$manifest_partial"
publishing=1
mv "$partial" "$final"
partial=
mv "$blob_partial" "$final.blobs.tar"
blob_partial=
mv "$manifest_partial" "$final.blobs.tsv"
manifest_partial=
dump_sha=$(sha256sum "$final" | cut -d' ' -f1)
blob_sha=$(sha256sum "$final.blobs.tar" | cut -d' ' -f1)
manifest_sha=$(sha256sum "$final.blobs.tsv" | cut -d' ' -f1)
printf '%s  %s\n' "$dump_sha" "$(basename "$final")" >"$final.sha256.tmp"
chmod 0600 "$final.sha256.tmp"
mv "$final.sha256.tmp" "$final.sha256"
printf '%s  %s\n' "$blob_sha" "$(basename "$final.blobs.tar")" >"$final.blobs.tar.sha256.tmp"
chmod 0600 "$final.blobs.tar.sha256.tmp"
mv "$final.blobs.tar.sha256.tmp" "$final.blobs.tar.sha256"

verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$final.restore.json" "$(basename "$final")" "$dump_sha" "$database_image" \
  "$migrations" "$tenants" "$rooms" "$agents" "$profiles" "$memberships" "$acl_edges" \
  "$topology" "$core_tables" "$verified_at" "$(basename "$final.blobs.tar")" "$blob_sha" \
  "$(basename "$final.blobs.tsv")" "$manifest_sha" "$blob_rows" "$blob_bytes" "$archived_blobs" \
  "$blob_table_present" "$blob_volume_present" <<'PY'
from pathlib import Path
import json
import os
import sys
import tempfile

path = Path(sys.argv[1])
document = {
    "schema_version": 2,
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
    "blob_archive_file": sys.argv[15],
    "blob_archive_sha256": sys.argv[16],
    "blob_manifest_file": sys.argv[17],
    "blob_manifest_sha256": sys.argv[18],
    "blob_row_count": int(sys.argv[19]),
    "blob_row_bytes": int(sys.argv[20]),
    "archived_blob_count": int(sys.argv[21]),
    "blob_table_present": sys.argv[22] == "true",
    "blob_volume_present": sys.argv[23] == "true",
    "blob_volume": "hospital-cauce_blobs_data",
    "blob_restore_verified": True,
    "blob_restore_uid": 1000,
    "blob_restore_network": "none",
    "blob_restore_row_count": int(sys.argv[19]),
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
python3 - "$STATUS_FILE" "$started_at" "$finished_at" "$final" "$dump_sha" "$final.restore.json" \
  "$final.blobs.tar" "$blob_sha" "$final.blobs.tsv" "$manifest_sha" <<'PY'
from pathlib import Path
import json
import os
import sys
import tempfile

path = Path(sys.argv[1])
document = {
    "schema_version": 2,
    "overall": "ok",
    "run_started_utc": sys.argv[2],
    "run_finished_utc": sys.argv[3],
    "dump_file": sys.argv[4],
    "dump_sha256": sys.argv[5],
    "restore_evidence_file": sys.argv[6],
    "blob_archive_file": sys.argv[7],
    "blob_archive_sha256": sys.argv[8],
    "blob_manifest_file": sys.argv[9],
    "blob_manifest_sha256": sys.argv[10],
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
  \( -name 'cauce-hospital-*.dump' -o -name 'cauce-hospital-*.dump.sha256' \
     -o -name 'cauce-hospital-*.dump.restore.json' -o -name 'cauce-hospital-*.dump.blobs.tar' \
     -o -name 'cauce-hospital-*.dump.blobs.tar.sha256' -o -name 'cauce-hospital-*.dump.blobs.tsv' \) \
  -mtime "+$RETENTION_DAYS" -delete
rm -f "$error_log"
error_log=
echo "Backup Hospital verificado por restauración aislada y $blob_rows blobs: $(basename "$final")"
echo "Restauración: detener escritores; restaurar $(basename "$final") con pg_restore en una base nueva; extraer $(basename "$final.blobs.tar") en un volumen nuevo; verificar con el monitor antes de conmutar."
echo "Reversión: volver a la base y al volumen anteriores sin borrarlos."
