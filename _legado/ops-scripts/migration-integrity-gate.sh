#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
phase=${1:-pre}
[[ $phase == pre || $phase == post ]] || {
  printf 'migration integrity gate: usage: migration-integrity-gate.sh pre|post\n' >&2
  exit 2
}
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
out=${CAUCE_MIGRATION_EVIDENCE_DIR:-"$ROOT/artifacts/migration-integrity"}
mkdir -p "$out"
tmp=$(mktemp "$out/.${phase}.XXXXXX")
trap 'rm -f "$tmp"' EXIT

CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod run --rm --no-deps -T migrator \
  node deploy/migration-integrity.mjs "$phase" >"$tmp"
python3 - "$tmp" "$ROOT/schemas/migration-integrity-evidence.schema.json" "$phase" <<'PY'
import json, pathlib, sys
from jsonschema import Draft202012Validator, FormatChecker

report_path = pathlib.Path(sys.argv[1])
schema_path = pathlib.Path(sys.argv[2])
expected_phase = sys.argv[3]
report = json.loads(report_path.read_text(encoding="utf-8"))
schema = json.loads(schema_path.read_text(encoding="utf-8"))
errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(report), key=lambda item: list(item.absolute_path))
if errors:
    raise SystemExit("migration integrity evidence schema failed: " + errors[0].message)
if report.get("phase") != expected_phase:
    raise SystemExit("migration integrity evidence phase mismatch")
legacy = [entry for entry in report["entries"] if entry["version"] == "024_agent_role_templates.sql"]
if len(legacy) != 1 or not legacy[0]["applied"] or "observedSchemaSha256" not in legacy[0]:
    raise SystemExit("migration integrity evidence lacks exact 024 structural verification")
PY
chmod 0600 "$tmp"
mv -f -- "$tmp" "$out/$phase.json"
trap - EXIT
"$ROOT/scripts/manifest.sh" "$out" >/dev/null
printf 'migration integrity %s evidence: %s/%s.json\n' "$phase" "$out" "$phase"
