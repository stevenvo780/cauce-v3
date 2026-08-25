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

if [ ! -f "$STATUS_FILE" ]; then
  printf '%s [backup-monitor] ALERT no status file at %s -- host-backup.sh has never completed a run\n' "$(ts)" "$STATUS_FILE" >&2
  exit 1
fi

python3 - "$STATUS_FILE" "$MAX_AGE_HOURS" "$REQUIRE_RETENTION_PRESERVED" <<'PY'
import datetime, json, os, re, stat, sys

path, max_age_hours = sys.argv[1], float(sys.argv[2])
require_retention_preserved = sys.argv[3] == "1"
with open(path) as fh:
    status = json.load(fh)

problems = []
if status.get("schema_version") != 4:
    problems.append(f'unsupported status schema_version={status.get("schema_version")!r} (expected 4)')

overall = status.get("overall")
if overall != "ok":
    problems.append(f'last run overall="{overall}" (expected "ok")')

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
        metadata = os.lstat(evidence_path)
        if not os.path.isabs(evidence_path) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError("not an absolute regular file")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ValueError("permissions are not private")
        with open(evidence_path, encoding="utf-8") as handle:
            evidence = json.load(handle)
        dump_file = os.path.basename(db.get("file", ""))
        if (evidence.get("schema_version") != 1
                or evidence.get("suite") != "cauce-v3-host-backup-restore"
                or evidence.get("dump_file") != dump_file
                or not re.fullmatch(r"[a-f0-9]{64}", str(evidence.get("dump_sha256", "")))
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(evidence.get("database_image_digest", "")))
                or evidence.get("isolated") is not True or evidence.get("network") != "none"
                or evidence.get("full_restore") is not True
                or not isinstance(evidence.get("core_table_count"), int)
                or evidence.get("core_table_count") < 8
                or not isinstance(evidence.get("applied_migration_count"), int)
                or evidence.get("applied_migration_count") < 1):
            raise ValueError("restore evidence contract mismatch")
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

finished_raw = status.get("run_finished_utc", "")
try:
    finished = datetime.datetime.strptime(finished_raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    age_hours = (datetime.datetime.now(datetime.timezone.utc) - finished).total_seconds() / 3600.0
except (TypeError, ValueError, OverflowError):
    problems.append(f'unparseable run_finished_utc="{finished_raw}"')
    age_hours = None

if age_hours is not None and age_hours > max_age_hours:
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
