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

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -f "$STATUS_FILE" ]; then
  printf '%s [backup-monitor] ALERT no status file at %s -- host-backup.sh has never completed a run\n' "$(ts)" "$STATUS_FILE" >&2
  exit 1
fi

python3 - "$STATUS_FILE" "$MAX_AGE_HOURS" <<'PY'
import json, sys, datetime

path, max_age_hours = sys.argv[1], float(sys.argv[2])
with open(path) as fh:
    status = json.load(fh)

problems = []
overall = status.get("overall")
if overall != "ok":
    problems.append(f'last run overall="{overall}" (expected "ok")')
    for section in ("db", "ut_nexus"):
        s = status.get(section, {})
        if s.get("status") not in ("ok", None):
            problems.append(f'{section}: {s.get("status")} -- {s.get("detail", "")}')
    off = status.get("offsite", {})
    for key in ("db_status", "ut_nexus_status"):
        if off.get(key) not in ("ok", None):
            problems.append(f'offsite.{key}: {off.get(key)} -- {off.get(key.replace("status", "detail"), "")}')

finished_raw = status.get("run_finished_utc", "")
try:
    finished = datetime.datetime.strptime(finished_raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    age_hours = (datetime.datetime.now(datetime.timezone.utc) - finished).total_seconds() / 3600.0
except ValueError:
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
