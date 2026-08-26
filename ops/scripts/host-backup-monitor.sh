#!/bin/sh
# Staleness watchdog for host-backup.sh. Runs independently of the nightly
# backup job (its own timer, every few hours) so a dead timer, a masked unit,
# or a backup that silently stopped running is caught even though nothing
# "failed" in the moment -- the absence of a recent success IS the failure.
#
# Reads $STATUS_FILE written by every host-backup.sh run (success or failure)
# and fails loudly (non-zero exit -> systemd unit goes `failed` -> OnFailure=
# alert fires) if:
#   - the status file is missing entirely (backup has never run / was wiped)
#   - the last run's "overall" was not "ok"
#   - the last run is older than $MAX_AGE_HOURS (default 30h -- backup runs
#     nightly, so this catches one missed run before a second is due)
set -u

STATUS_FILE=${STATUS_FILE:-/var/log/cauce-v3-backup/status.json}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-30}
REQUIRE_RETENTION_PRESERVED=${REQUIRE_RETENTION_PRESERVED:-0}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

case "$REQUIRE_RETENTION_PRESERVED" in
  0|1) ;;
  *) printf '%s [backup-monitor] ALERT REQUIRE_RETENTION_PRESERVED must be 0 or 1\n' "$(ts)" >&2; exit 2 ;;
esac

python3 - "$STATUS_FILE" "$MAX_AGE_HOURS" "$REQUIRE_RETENTION_PRESERVED" <<'PY'
import datetime
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import sys

path = sys.argv[1]
try:
    max_age_hours = float(sys.argv[2])
except (TypeError, ValueError, OverflowError):
    print("ALERT backup monitor MAX_AGE_HOURS must be a finite positive number", file=sys.stderr)
    raise SystemExit(2)
if not math.isfinite(max_age_hours) or max_age_hours <= 0:
    print("ALERT backup monitor MAX_AGE_HOURS must be a finite positive number", file=sys.stderr)
    raise SystemExit(2)
require_retention_preserved = sys.argv[3] == "1"


def private_open(name, label, *, maximum=None):
    target = pathlib.Path(name)
    if not target.is_absolute():
        raise ValueError(f"{label} path is not absolute")
    parent = target.parent
    if parent.resolve(strict=True) != parent:
        raise ValueError(f"{label} parent is not canonical")
    parent_metadata = parent.lstat()
    if (not stat.S_ISDIR(parent_metadata.st_mode)
            or parent_metadata.st_uid not in {0, os.geteuid()}
            or stat.S_IMODE(parent_metadata.st_mode) & 0o022):
        raise ValueError(f"{label} parent is not owned and protected")
    directory = os.open(
        parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened_parent = os.fstat(directory)
        if ((opened_parent.st_dev, opened_parent.st_ino) != (parent_metadata.st_dev, parent_metadata.st_ino)
                or not stat.S_ISDIR(opened_parent.st_mode)
                or opened_parent.st_uid not in {0, os.geteuid()}
                or stat.S_IMODE(opened_parent.st_mode) & 0o022):
            raise ValueError(f"{label} parent changed while opening")
        before = os.stat(target.name, dir_fd=directory, follow_symlinks=False)
        descriptor = os.open(
            target.name,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory,
        )
        opened = os.fstat(descriptor)
        if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or opened.st_uid not in {0, os.geteuid()}
                or stat.S_IMODE(opened.st_mode) not in {0o400, 0o600}
                or opened.st_size < 1 or (maximum is not None and opened.st_size > maximum)):
            os.close(descriptor)
            raise ValueError(f"{label} is not an owned private single-link regular file")
    except BaseException:
        os.close(directory)
        raise
    return target.name, directory, descriptor, opened


def stable_file(metadata):
    return (
        metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
        metadata.st_nlink, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns,
    )


def private_bytes(name, label, *, maximum):
    basename, directory, descriptor, opened = private_open(name, label, maximum=maximum)
    try:
        chunks = []
        remaining = opened.st_size
        while remaining:
            block = os.read(descriptor, min(remaining, 64 * 1024))
            if not block:
                raise ValueError(f"{label} changed while reading")
            chunks.append(block)
            remaining -= len(block)
        if os.read(descriptor, 1):
            raise ValueError(f"{label} grew while reading")
        final_opened = os.fstat(descriptor)
        final_named = os.stat(basename, dir_fd=directory, follow_symlinks=False)
        if stable_file(final_opened) != stable_file(opened) or stable_file(final_named) != stable_file(opened):
            raise ValueError(f"{label} changed while reading")
    finally:
        os.close(descriptor)
        os.close(directory)
    return b"".join(chunks)


def private_json(name, label):
    try:
        return json.loads(private_bytes(name, label, maximum=1024 * 1024).decode("utf-8"))
    except UnicodeDecodeError as error:
        raise ValueError(f"{label} is not UTF-8 JSON") from error


def private_sha256(name, label):
    basename, directory, descriptor, opened = private_open(name, label)
    digest = hashlib.sha256()
    try:
        while block := os.read(descriptor, 1024 * 1024):
            digest.update(block)
        final_opened = os.fstat(descriptor)
        final_named = os.stat(basename, dir_fd=directory, follow_symlinks=False)
        if stable_file(final_opened) != stable_file(opened) or stable_file(final_named) != stable_file(opened):
            raise ValueError(f"{label} changed while hashing")
    finally:
        os.close(descriptor)
        os.close(directory)
    return digest.hexdigest(), pathlib.Path(name)


try:
    status = private_json(path, "status")
except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
    print(f"ALERT backup monitor could not authenticate status: {error}", file=sys.stderr)
    raise SystemExit(1)

problems = []
if status.get("schema_version") != 4:
    problems.append(f'unsupported status schema_version={status.get("schema_version")!r} (expected 4)')

overall = status.get("overall")
if overall != "ok":
    problems.append(f'last run overall="{overall}" (expected "ok")')

started = None
finished = None
now = datetime.datetime.now(datetime.timezone.utc)
try:
    started = datetime.datetime.strptime(
        status.get("run_started_utc", ""), "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
    finished = datetime.datetime.strptime(
        status.get("run_finished_utc", ""), "%Y-%m-%dT%H:%M:%SZ",
    ).replace(tzinfo=datetime.timezone.utc)
    if started > finished:
        problems.append("run_started_utc is after run_finished_utc")
    if finished > now:
        problems.append("run_finished_utc is in the future")
except (TypeError, ValueError, OverflowError):
    problems.append("backup run timestamps are invalid")

# Never trust the aggregate flag by itself.  Each mandatory stage is checked
# independently so a malformed or manually edited `overall=ok` cannot hide a
# failed/missing database dump or off-host copy.
db = status.get("db", {})
if db.get("status") != "ok":
    problems.append(f'db: {db.get("status")} -- {db.get("detail", "")}')

restore = status.get("restore", {})
if (restore.get("status") != "ok" or restore.get("isolated") is not True
        or restore.get("network") != "none" or not restore.get("evidence_file")):
    problems.append(
        f'restore: {restore.get("status")} isolated={restore.get("isolated")} '
        f'network={restore.get("network")} -- {restore.get("detail", "")}'
    )
else:
    evidence_path = restore["evidence_file"]
    try:
        dump_path = db.get("file", "")
        if not isinstance(dump_path, str) or not dump_path:
            raise ValueError("database dump path is missing")
        dump_sha256, dump_target = private_sha256(dump_path, "database dump")
        sidecar_path = f"{dump_path}.sha256"
        sidecar = private_bytes(sidecar_path, "database dump checksum", maximum=1024).decode("utf-8")
        expected_sidecar = f"{dump_sha256}  {dump_target.name}\n"
        if sidecar != expected_sidecar:
            raise ValueError("database dump checksum sidecar mismatch")
        if evidence_path != f"{dump_path}.restore.json":
            raise ValueError("restore evidence path is not bound to the database dump")
        evidence = private_json(evidence_path, "restore evidence")
        dump_file = dump_target.name
        if (evidence.get("schema_version") != 1
                or evidence.get("suite") != "cauce-v3-host-backup-restore"
                or evidence.get("dump_file") != dump_file
                or evidence.get("dump_sha256") != dump_sha256
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(evidence.get("database_image_digest", "")))
                or evidence.get("isolated") is not True or evidence.get("network") != "none"
                or evidence.get("full_restore") is not True
                or not isinstance(evidence.get("core_table_count"), int)
                or evidence.get("core_table_count") < 8
                or not isinstance(evidence.get("applied_migration_count"), int)
                or evidence.get("applied_migration_count") < 1):
            raise ValueError("restore evidence contract mismatch")
        if started is None or finished is None:
            raise ValueError("backup run timestamps are invalid")
        verified = datetime.datetime.strptime(
            evidence.get("verified_at_utc", ""), "%Y-%m-%dT%H:%M:%SZ",
        ).replace(tzinfo=datetime.timezone.utc)
        if not started <= verified <= finished:
            raise ValueError("restore evidence timestamp is outside the backup run")
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        problems.append(f"restore evidence invalid: {error}")

retention = status.get("retention", {})
retention_status = retention.get("status")
if retention_status not in {"local-pruned-after-offsite", "preserved-for-release"}:
    problems.append(f'retention.status: {retention_status} (not a completed safe policy)')
if require_retention_preserved:
    if retention.get("skip_requested") is not True or retention_status != "preserved-for-release":
        problems.append("release snapshot did not preserve retention")

off = status.get("offsite", {})
if off.get("strategy") != "append-only-no-delete":
    problems.append(f'offsite.strategy: {off.get("strategy")} (expected append-only-no-delete)')
if off.get("db_status") != "ok":
    problems.append(f'offsite.db_status: {off.get("db_status")} -- {off.get("db_detail", "")}')

ut = status.get("ut_nexus", {})
if ut.get("enabled") is True:
    if ut.get("status") != "ok":
        problems.append(f'ut_nexus: {ut.get("status")} -- {ut.get("detail", "")}')
    if off.get("ut_nexus_status") != "ok":
        problems.append(
            f'offsite.ut_nexus_status: {off.get("ut_nexus_status")} -- '
            f'{off.get("ut_nexus_detail", "")}'
        )
elif ut.get("enabled") is False:
    if ut.get("status") != "disabled" or off.get("ut_nexus_status") != "disabled":
        problems.append("ut_nexus disabled state is internally inconsistent")
else:
    problems.append("ut_nexus.enabled must be a boolean")

age_hours = (now - finished).total_seconds() / 3600.0 if finished is not None else None

if age_hours is not None:
    if age_hours < 0:
        # Keep this independent from the timestamp-order diagnostic.  A future
        # status must never become "extra fresh" if other validation is edited.
        problems.append("last successful status write has a negative age")
    elif age_hours > max_age_hours:
        problems.append(f"last successful status write is {age_hours:.1f}h old (threshold {max_age_hours}h)")

if problems:
    print(f"ALERT backup monitor found {len(problems)} problem(s):", file=sys.stderr)
    for p in problems:
        print(f"  - {p}", file=sys.stderr)
    sys.exit(1)

age_str = f"{age_hours:.1f}h" if age_hours is not None else "unknown"
print(f"OK last backup run finished {status.get('run_finished_utc')} ({age_str} ago), overall=ok")
sys.exit(0)
PY
