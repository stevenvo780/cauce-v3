#!/bin/sh
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PRIVATE_PG="$ROOT/scripts/private-postgres-command.py"

private_database_phase() {
  [ "${CAUCE_PRIVATE_POSTGRES_SESSION:-}" = prepared-v1 ] \
    && [ "${PGSERVICE:-}" = cauce_restore ] \
    && [ -n "${PGSERVICEFILE:-}" ] && [ -n "${PGPASSFILE:-}" ] \
    && [ -z "${DATABASE_URL:-}" ] && [ -z "${DATABASE_URL_FILE:-}" ] || {
      printf 'restore private PostgreSQL session was not prepared by the trusted helper\n' >&2
      exit 2
    }
  stable_backup=${1:?private restore phase requires the immutable backup descriptor}
  [ -r "$stable_backup" ] || { printf 'immutable backup snapshot is unavailable\n' >&2; exit 2; }

  psql_value() {
    psql --dbname=service=cauce_restore -X -v ON_ERROR_STOP=1 -Atqc "$1"
  }

  pg_restore --list "$stable_backup" >/dev/null
  actual_db=$(psql_value 'SELECT current_database()')
  [ "$actual_db" = "$RESTORE_EXPECT_DB" ] || { printf 'connected database does not match RESTORE_EXPECT_DB\n' >&2; exit 2; }
  case "$actual_db" in
    ''|*[!a-z0-9_]*) printf 'restore database name must use lowercase letters, digits and underscores only\n' >&2; exit 2 ;;
  esac
  case "$actual_db" in
    *_drill|*_drill_*|*_restore|*_restore_*) ;;
    *) printf 'restore database name must contain an explicit _drill or _restore boundary\n' >&2; exit 2 ;;
  esac

  server_version_num=$(psql_value 'SHOW server_version_num')
  case "$server_version_num" in
    ''|*[!0-9]*) printf 'could not verify PostgreSQL server version\n' >&2; exit 2 ;;
  esac
  [ "$((server_version_num / 10000))" -eq 16 ] || {
    printf 'restore requires PostgreSQL major version 16\n' >&2
    exit 2
  }
  [ "$(psql_value "SELECT coalesce((SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid()), 'f')")" = t ] || {
    printf 'restore connection is not using PostgreSQL TLS\n' >&2
    exit 2
  }
  database_marker_count=$(psql_value "SELECT count(*) FROM pg_db_role_setting setting JOIN pg_database database ON database.oid=setting.setdatabase WHERE database.datname=current_database() AND setting.setrole=0 AND setting.setconfig @> ARRAY['cauce.environment=restore-drill']")
  [ "$database_marker_count" = 1 ] \
    && [ "$(psql_value "SELECT coalesce(current_setting('cauce.environment', true), '')")" = restore-drill ] || {
      printf 'restore target lacks the persistent database-level restore-drill marker\n' >&2
      exit 2
    }

  server_addr=$(psql_value "SELECT coalesce(inet_server_addr()::text, 'local-socket')")
  case "$server_addr" in
    local-socket) printf 'restore refuses local sockets because TLS identity cannot be verified\n' >&2; exit 2 ;;
    127.0.0.1|::1) server_address_class=loopback ;;
    *)
      [ "$RESTORE_NETWORK_ISOLATION" = private-test-network-no-egress ] || {
        printf 'a remote restore target contradicts RESTORE_NETWORK_ISOLATION=network-none\n' >&2
        exit 2
      }
      server_address_class=remote
      ;;
  esac

  other_connections=$(psql_value "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")
  [ "$other_connections" = 0 ] || {
    printf 'restore target has other active connections and is not isolated\n' >&2
    exit 2
  }
  user_object_count=$(psql_value "WITH user_namespaces AS (
    SELECT oid FROM pg_namespace WHERE nspname='public' OR (nspname<>'information_schema' AND nspname!~'^pg_')
  ), user_objects AS (
    SELECT relation.oid FROM pg_class relation JOIN user_namespaces namespace ON namespace.oid=relation.relnamespace
    UNION ALL SELECT procedure.oid FROM pg_proc procedure JOIN user_namespaces namespace ON namespace.oid=procedure.pronamespace
    UNION ALL SELECT type_value.oid FROM pg_type type_value JOIN user_namespaces namespace ON namespace.oid=type_value.typnamespace
    UNION ALL SELECT operator.oid FROM pg_operator operator JOIN user_namespaces namespace ON namespace.oid=operator.oprnamespace
    UNION ALL SELECT collation.oid FROM pg_collation collation JOIN user_namespaces namespace ON namespace.oid=collation.collnamespace
    UNION ALL SELECT conversion.oid FROM pg_conversion conversion JOIN user_namespaces namespace ON namespace.oid=conversion.connamespace
  )
  SELECT (SELECT count(*) FROM user_objects)
       + (SELECT count(*) FROM pg_namespace WHERE nspname<>'public' AND nspname<>'information_schema' AND nspname!~'^pg_')
       + (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')
       + (SELECT count(*) FROM pg_default_acl)
       + (SELECT count(*) FROM pg_event_trigger)
       + (SELECT count(*) FROM pg_publication)
       + (SELECT count(*) FROM pg_largeobject_metadata)")
  [ "$user_object_count" = 0 ] || {
    printf 'restore target is not empty; refusing to clean or overwrite it\n' >&2
    exit 2
  }

  pg_restore "$stable_backup" --dbname=service=cauce_restore --exit-on-error --single-transaction --no-owner --no-acl
  core_table_count=$(psql_value "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('schema_migrations','tenants','rooms','memberships','messages','deliveries','adapter_outbox','connection_leases')")
  [ "$core_table_count" = 8 ] || { printf 'restored database lacks the complete Cauce core schema\n' >&2; exit 1; }
  applied_migration_count=$(psql_value 'SELECT count(*) FROM schema_migrations')
  case "$applied_migration_count" in
    ''|*[!0-9]*|0) printf 'restored database has no applied migrations\n' >&2; exit 1 ;;
  esac
  latest_migration=$(psql_value 'SELECT max(version) FROM schema_migrations')
  printf '%s\n' "$latest_migration" | LC_ALL=C grep -Eq '^[0-9]{3}_[a-z0-9_]+\.sql$' || {
    printf 'restored database latest migration is invalid\n' >&2
    exit 1
  }
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$actual_db" "$server_address_class" "$core_table_count" "$applied_migration_count" "$latest_migration"
}

if [ "${1:-}" = --private-database-phase ]; then
  shift
  private_database_phase "$@"
  exit $?
fi

[ -z "${DATABASE_URL:-}" ] || {
  printf 'restore requires DATABASE_URL_FILE; DATABASE_URL must remain unset\n' >&2
  exit 2
}
: "${DATABASE_URL_FILE:?DATABASE_URL_FILE must name the private connection file}"
: "${RESTORE_EXPECT_DB:?RESTORE_EXPECT_DB must name the intended database}"
: "${RESTORE_EXPECT_BACKUP_SHA256:?RESTORE_EXPECT_BACKUP_SHA256 must independently select the backup bytes}"
: "${RESTORE_EVIDENCE_FILE:?RESTORE_EVIDENCE_FILE must be a new absolute JSON path}"
[ "${RESTORE_TARGET_CLASS:-}" = "isolated-non-production" ] || {
  printf 'RESTORE_TARGET_CLASS must be isolated-non-production\n' >&2
  exit 2
}
case "${RESTORE_NETWORK_ISOLATION:-}" in
  network-none|private-test-network-no-egress) ;;
  *) printf 'RESTORE_NETWORK_ISOLATION must be network-none or private-test-network-no-egress\n' >&2; exit 2 ;;
esac
case "$RESTORE_EVIDENCE_FILE" in
  /*.json) ;;
  /*) printf 'RESTORE_EVIDENCE_FILE must end in .json\n' >&2; exit 2 ;;
  *) printf 'RESTORE_EVIDENCE_FILE must be absolute\n' >&2; exit 2 ;;
esac
[ ! -e "$RESTORE_EVIDENCE_FILE" ] && [ ! -L "$RESTORE_EVIDENCE_FILE" ] || {
  printf 'RESTORE_EVIDENCE_FILE already exists; use a new path\n' >&2
  exit 2
}
[ -d "$(dirname -- "$RESTORE_EVIDENCE_FILE")" ] || {
  printf 'RESTORE_EVIDENCE_FILE parent directory does not exist\n' >&2
  exit 2
}

file=${1:?usage: restore.sh BACKUP.dump}
[ -f "$file" ] && [ ! -L "$file" ] && [ -r "$file" ] || {
  printf 'backup must be a readable regular non-symlink file\n' >&2
  exit 2
}
[ "${RESTORE_CONFIRM:-}" = "restore:$RESTORE_EXPECT_DB:isolated-non-production" ] || {
  printf 'set RESTORE_CONFIRM=restore:%s:isolated-non-production to continue\n' "$RESTORE_EXPECT_DB" >&2
  exit 2
}

sidecar=$file.sha256
[ -f "$sidecar" ] && [ ! -L "$sidecar" ] && [ -r "$sidecar" ] || {
  printf 'a readable regular non-symlink checksum sidecar is required\n' >&2
  exit 2
}
snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/cauce-restore-snapshot.XXXXXXXX")
chmod 0700 "$snapshot_dir"
snapshot_path=$snapshot_dir/backup.dump
cleanup_snapshot() {
  rm -f -- "$snapshot_path"
  rmdir -- "$snapshot_dir" 2>/dev/null || true
}
trap cleanup_snapshot EXIT HUP INT TERM
exec 3< "$file"
source_file=/proc/$$/fd/3
[ -r "$source_file" ] || { printf 'could not hold a stable backup descriptor\n' >&2; exit 2; }
snapshot_result=$(python3 - "$file" "$source_file" "$sidecar" "$(basename -- "$file")" \
  "$RESTORE_EXPECT_BACKUP_SHA256" "$snapshot_path" <<'PY'
import hashlib
import os
import pathlib
import re
import stat
import sys

backup_path = pathlib.Path(sys.argv[1])
stable_backup = pathlib.Path(sys.argv[2])
sidecar = pathlib.Path(sys.argv[3])
backup_name = sys.argv[4]
expected = sys.argv[5]
snapshot = pathlib.Path(sys.argv[6])
if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected):
    raise SystemExit("RESTORE_EXPECT_BACKUP_SHA256 must be sha256:<64 lowercase hex>")
before = backup_path.lstat()
opened = stable_backup.stat()
if ((before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
        or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
        or stat.S_IMODE(opened.st_mode) not in {0o400, 0o600}
        or opened.st_uid not in {0, os.geteuid()}):
    raise SystemExit("backup must remain an owned private single-link regular file")
sidecar_before = sidecar.lstat()
if (not stat.S_ISREG(sidecar_before.st_mode) or sidecar_before.st_nlink != 1
        or stat.S_IMODE(sidecar_before.st_mode) not in {0o400, 0o600}
        or sidecar_before.st_uid not in {0, os.geteuid()} or sidecar_before.st_size > 1024):
    raise SystemExit("checksum sidecar must be an owned private single-link regular file")
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
descriptor = os.open(sidecar, flags)
try:
    sidecar_opened = os.fstat(descriptor)
    if (sidecar_opened.st_dev, sidecar_opened.st_ino) != (sidecar_before.st_dev, sidecar_before.st_ino):
        raise SystemExit("checksum sidecar changed while opening")
    content = os.read(descriptor, 1025)
finally:
    os.close(descriptor)
try:
    lines = content.decode("utf-8").splitlines()
except UnicodeDecodeError:
    raise SystemExit("checksum sidecar must be UTF-8") from None
if len(lines) != 1:
    raise SystemExit("checksum sidecar must contain exactly one entry")
match = re.fullmatch(r"([a-f0-9]{64})  ([^/\\]+)", lines[0])
if match is None or match.group(2) != backup_name:
    raise SystemExit("checksum sidecar must bind the backup basename exactly")
digest = hashlib.sha256()
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
snapshot_descriptor = os.open(snapshot, flags, 0o400)
try:
    with stable_backup.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
            view = memoryview(block)
            while view:
                written = os.write(snapshot_descriptor, view)
                if written < 1:
                    raise SystemExit("immutable backup snapshot could not progress")
                view = view[written:]
    os.fsync(snapshot_descriptor)
finally:
    os.close(snapshot_descriptor)
observed = digest.hexdigest()
if observed != match.group(1):
    raise SystemExit("backup checksum mismatch")
if expected != f"sha256:{observed}":
    raise SystemExit("backup differs from RESTORE_EXPECT_BACKUP_SHA256")
snapshot_metadata = snapshot.stat(follow_symlinks=False)
if (not stat.S_ISREG(snapshot_metadata.st_mode)
        or stat.S_IMODE(snapshot_metadata.st_mode) != 0o400
        or snapshot_metadata.st_nlink != 1
        or snapshot_metadata.st_uid not in {0, os.geteuid()}
        or snapshot_metadata.st_size <= 0):
    raise SystemExit("immutable backup snapshot metadata is invalid")
print("\t".join(str(value) for value in (
    observed,
    snapshot_metadata.st_dev,
    snapshot_metadata.st_ino,
    snapshot_metadata.st_mode,
    snapshot_metadata.st_nlink,
    snapshot_metadata.st_uid,
    snapshot_metadata.st_gid,
    snapshot_metadata.st_size,
    snapshot_metadata.st_mtime_ns,
    snapshot_metadata.st_ctime_ns,
)))
PY
) || exit $?
exec 3<&-
tab=$(printf '\t')
IFS="$tab" read -r backup_sha256 snapshot_dev snapshot_ino snapshot_mode snapshot_nlink \
  snapshot_uid snapshot_gid snapshot_size snapshot_mtime snapshot_ctime snapshot_extra <<EOF
$snapshot_result
EOF
[ -n "$backup_sha256" ] && [ -n "$snapshot_dev" ] && [ -n "$snapshot_ino" ] \
  && [ -n "$snapshot_mode" ] && [ -n "$snapshot_nlink" ] && [ -n "$snapshot_uid" ] \
  && [ -n "$snapshot_gid" ] && [ -n "$snapshot_size" ] && [ -n "$snapshot_mtime" ] \
  && [ -n "$snapshot_ctime" ] && [ -z "$snapshot_extra" ] || {
    printf 'immutable backup snapshot returned an invalid identity contract\n' >&2
    exit 1
  }
exec 4< "$snapshot_path"
python3 - "$snapshot_path" 4 "$snapshot_dev" "$snapshot_ino" "$snapshot_mode" "$snapshot_nlink" \
  "$snapshot_uid" "$snapshot_gid" "$snapshot_size" "$snapshot_mtime" "$snapshot_ctime" <<'PY'
import fcntl
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
descriptor = int(sys.argv[2])
expected = tuple(int(value) for value in sys.argv[3:])
if expected[3] != 1:
    raise SystemExit("immutable backup snapshot identity contract is invalid")
metadata = os.fstat(descriptor)
observed = (
    metadata.st_dev,
    metadata.st_ino,
    metadata.st_mode,
    metadata.st_nlink,
    metadata.st_uid,
    metadata.st_gid,
    metadata.st_size,
    metadata.st_mtime_ns,
    metadata.st_ctime_ns,
)
flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
if (observed != expected or not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o400
        or metadata.st_nlink != 1
        or flags & os.O_ACCMODE != os.O_RDONLY):
    raise SystemExit("immutable backup snapshot identity changed before restore")
parent = path.parent
directory = os.open(
    parent,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
)
try:
    named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
    named_identity = (
        named.st_dev, named.st_ino, named.st_mode, named.st_nlink, named.st_uid,
        named.st_gid, named.st_size, named.st_mtime_ns, named.st_ctime_ns,
    )
    if named_identity != expected:
        raise SystemExit("immutable backup snapshot path changed before unlink")
    os.unlink(path.name, dir_fd=directory)
    os.fsync(directory)
finally:
    os.close(directory)
unlinked = os.fstat(descriptor)
if ((unlinked.st_dev, unlinked.st_ino, unlinked.st_mode, unlinked.st_uid,
     unlinked.st_gid, unlinked.st_size, unlinked.st_mtime_ns)
        != (expected[0], expected[1], expected[2], expected[4], expected[5],
            expected[6], expected[7])
        or unlinked.st_nlink != 0 or unlinked.st_ctime_ns < expected[8]):
    raise SystemExit("immutable backup snapshot changed while unlinking")
PY
stable_file=/proc/self/fd/4

evidence_identity=$(python3 - "$RESTORE_EVIDENCE_FILE" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
parent = path.parent
if parent.resolve(strict=True) != parent:
    raise SystemExit("restore evidence parent must be an absolute resolved directory without symlinks")
before = parent.lstat()
if (not stat.S_ISDIR(before.st_mode) or before.st_uid not in {0, os.geteuid()}
        or stat.S_IMODE(before.st_mode) & 0o022):
    raise SystemExit("restore evidence parent must be owned and not group/world writable")
directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
directory = os.open(parent, directory_flags)
try:
    opened_parent = os.fstat(directory)
    if (opened_parent.st_dev, opened_parent.st_ino) != (before.st_dev, before.st_ino):
        raise RuntimeError("restore evidence parent changed while opening")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path.name, flags, 0o600, dir_fd=directory)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1 or metadata.st_uid not in {0, os.geteuid()}):
            raise RuntimeError("restore evidence reservation is not an owned private single-link regular file")
        os.fsync(descriptor)
        os.fsync(directory)
        print(f"{metadata.st_dev}:{metadata.st_ino}:{opened_parent.st_dev}:{opened_parent.st_ino}")
    finally:
        os.close(descriptor)
finally:
    os.close(directory)
PY
) || exit $?
cleanup_evidence() {
  python3 - "$RESTORE_EVIDENCE_FILE" "$evidence_identity" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected = tuple(int(value) for value in sys.argv[2].split(":"))
try:
    parent = path.parent
    before = parent.lstat()
    if (before.st_dev, before.st_ino) != expected[2:]:
        raise ValueError
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened_parent = os.fstat(directory)
        metadata = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if ((opened_parent.st_dev, opened_parent.st_ino) != expected[2:]
                or (metadata.st_dev, metadata.st_ino) != expected[:2]
                or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1):
            raise ValueError
        os.unlink(path.name, dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)
except (OSError, ValueError):
    print("restore evidence cleanup refused a changed path", file=sys.stderr)
PY
}
cleanup_all() {
  cleanup_evidence
  cleanup_snapshot
}
trap cleanup_all EXIT
trap 'exit 130' HUP INT TERM

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_result=$(python3 "$PRIVATE_PG" "$DATABASE_URL_FILE" --pass-fd 4 -- \
  "$0" --private-database-phase "$stable_file")
IFS="$tab" read -r actual_db server_address_class core_table_count applied_migration_count latest_migration extra <<EOF
$database_result
EOF
[ -n "$actual_db" ] && [ -n "$server_address_class" ] && [ -n "$core_table_count" ] \
  && [ -n "$applied_migration_count" ] && [ -n "$latest_migration" ] && [ -z "$extra" ] || {
    printf 'private restore phase returned an invalid result contract\n' >&2
    exit 1
  }
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 - "$RESTORE_EVIDENCE_FILE" "$evidence_identity" "$(basename -- "$file")" "$backup_sha256" "$actual_db" \
  "$server_address_class" "$RESTORE_NETWORK_ISOLATION" "$core_table_count" "$applied_migration_count" "$latest_migration" \
  "$started_at" "$finished_at" <<'PY'
import json
import os
import pathlib
import stat
import sys

(
    evidence_name,
    evidence_identity,
    backup_name,
    backup_sha256,
    database_name,
    server_address_class,
    network_isolation_declaration,
    core_table_count,
    applied_migration_count,
    latest_migration,
    started_at,
    finished_at,
) = sys.argv[1:]
evidence = {
    "schemaVersion": 1,
    "suite": "cauce-v3-restore",
    "startedAt": started_at,
    "finishedAt": finished_at,
    "backup": {
        "file": backup_name,
        "sha256": backup_sha256,
        "checksumSidecarVerified": True,
        "catalogVerified": True,
        "immutableSnapshot": True,
    },
    "target": {
        "database": database_name,
        "postgresMajor": 16,
        "serverAddressClass": server_address_class,
        "targetWasEmpty": True,
        "databaseMarker": "cauce.environment=restore-drill",
        "productionConnected": False,
        "networkIsolationDeclaration": network_isolation_declaration,
    },
    "transport": {"sslMode": "verify-full", "rootCaConfigured": True, "tlsActive": True},
    "restore": {
        "fullRestore": True,
        "singleTransaction": True,
        "cleanApplied": False,
        "coreTableCount": int(core_table_count),
        "appliedMigrationCount": int(applied_migration_count),
        "latestMigration": latest_migration,
    },
}
path = pathlib.Path(evidence_name)
expected = tuple(int(value) for value in evidence_identity.split(":"))
parent = path.parent
before = parent.lstat()
if (before.st_dev, before.st_ino) != expected[2:]:
    raise RuntimeError("restore evidence parent changed during the restore")
directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
opened_parent = os.fstat(directory)
if (opened_parent.st_dev, opened_parent.st_ino) != expected[2:]:
    os.close(directory)
    raise RuntimeError("restore evidence parent changed while reopening")
flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(path.name, flags, dir_fd=directory)
try:
    metadata = os.fstat(descriptor)
    if ((metadata.st_dev, metadata.st_ino) != expected[:2] or not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1
            or metadata.st_uid not in {0, os.geteuid()}):
        raise RuntimeError("restore evidence reservation changed during the restore")
    os.ftruncate(descriptor, 0)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        descriptor = -1
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    metadata = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
    if ((metadata.st_dev, metadata.st_ino) != expected[:2] or not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1):
        raise RuntimeError("restore evidence is not a mode-0600 regular file")
    os.fsync(directory)
except BaseException:
    if descriptor >= 0:
        os.close(descriptor)
    try:
        metadata = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if (metadata.st_dev, metadata.st_ino) == expected[:2]:
            os.unlink(path.name, dir_fd=directory)
            os.fsync(directory)
    except OSError:
        pass
    raise
finally:
    os.close(directory)
PY
trap - EXIT HUP INT TERM
exec 4<&-
cleanup_snapshot
printf 'restore completed for isolated database %s; evidence: %s\n' "$RESTORE_EXPECT_DB" "$RESTORE_EVIDENCE_FILE"
