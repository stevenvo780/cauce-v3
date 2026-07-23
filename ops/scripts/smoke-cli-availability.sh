#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/home" "$sandbox/config" "$sandbox/cache" "$sandbox/data"
results_file="$sandbox/results.tsv"
: >"$results_file"

record() { printf '%s\t%s\n' "$1" "$2" >>"$results_file"; }
failures=0
for spec in \
  "OpenClaw:${OPENCLAW_CLI:-openclaw}" \
  "Hermes:${HERMES_CLI:-hermes}" \
  "OpenCode:${OPENCODE_CLI:-opencode}" \
  "Claude:${CLAUDE_CLI:-claude}" \
  "Codex:${CODEX_CLI:-codex}"; do
  label=${spec%%:*}
  command_name=${spec#*:}
  if [[ -z "$command_name" || "$command_name" =~ [[:space:]] ]]; then
    printf 'FAIL %s: command override must be one executable path\n' "$label" >&2
    record "$label" failed
    failures=$((failures + 1))
    continue
  fi
  resolved=$(command -v -- "$command_name" || true)
  if [[ -z "$resolved" ]]; then
    printf 'FAIL %s: executable unavailable\n' "$label" >&2
    record "$label" failed
    failures=$((failures + 1))
    continue
  fi
  version_file="$sandbox/${label}.version"
  help_file="$sandbox/${label}.help"
  clean_env=(env -i PATH="$PATH" HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" XDG_CACHE_HOME="$sandbox/cache" XDG_DATA_HOME="$sandbox/data" CI=1 NO_COLOR=1)
  if ! timeout 10s "${clean_env[@]}" "$resolved" --version >"$version_file" 2>&1; then
    printf 'FAIL %s: --version failed in isolated environment\n' "$label" >&2
    record "$label" failed
    failures=$((failures + 1))
    continue
  fi
  if ! timeout 10s "${clean_env[@]}" "$resolved" --help >"$help_file" 2>&1; then
    printf 'FAIL %s: --help failed in isolated environment\n' "$label" >&2
    record "$label" failed
    failures=$((failures + 1))
    continue
  fi
  if [[ ! -s "$version_file" || ! -s "$help_file" ]]; then
    printf 'FAIL %s: version/help output was empty\n' "$label" >&2
    record "$label" failed
    failures=$((failures + 1))
    continue
  fi
  printf 'PASS %s authentic availability/version/help\n' "$label"
  record "$label" passed
done

if [[ -n ${CAUCE_CLI_ARTIFACT_DIR:-} ]]; then
  mkdir -p "$CAUCE_CLI_ARTIFACT_DIR"
  python3 - "$results_file" "$CAUCE_CLI_ARTIFACT_DIR/report.json" <<'PY'
import datetime, json, pathlib, sys
rows = []
for line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name, status = line.split("\t", 1)
    rows.append({
        "name": f"{name} executable --version/--help in isolated HOME",
        "status": status,
        "evidence": "authentic-cli-availability",
        "evidenceClass": "version-help-only",
    })
failed = sum(row["status"] != "passed" for row in rows)
payload = {
    "schemaVersion": 1,
    "suite": "cauce-v3-authentic-cli-availability",
    "mode": "authentic-cli-smoke",
    "scope": "version-help-only; no prompt, auth, session, or model execution",
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "summary": {"tests": len(rows), "passed": len(rows) - failed, "failed": failed, "skipped": 0},
    "tests": rows,
}
path = pathlib.Path(sys.argv[2])
tmp = path.with_suffix(".tmp")
tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
tmp.replace(path)
PY
  "$ROOT/scripts/manifest.sh" "$CAUCE_CLI_ARTIFACT_DIR" >/dev/null
fi

((failures == 0)) || exit 1
printf 'authentic CLI availability smoke passed; no prompt or model execution occurred\n'
