#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
phase=${1:-}
[[ $phase == pre || $phase == apply || $phase == post ]] || {
  printf 'usage: reconcile-stale-console-outbox.sh pre|apply|post\n' >&2
  exit 2
}
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
out=${CAUCE_OUTBOX_RECONCILE_EVIDENCE_DIR:-"$ROOT/artifacts/outbox-reconciliation"}
mkdir -p "$out"
tmp=$(mktemp "$out/.${phase}.XXXXXX")
trap 'rm -f "$tmp"' EXIT

baseline_args=()
if [[ $phase == post ]]; then
  [[ -f $out/pre.json && -f $out/apply.json ]] || {
    printf 'outbox reconciliation post gate requires pre.json and apply.json\n' >&2
    exit 2
  }
  baseline=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generatedAt"])' "$out/pre.json")
  baseline_args=(-e "CAUCE_OUTBOX_BASELINE_AT=$baseline")
fi
confirm_args=()
if [[ $phase == apply ]]; then
  [[ -f $out/pre.json ]] || { printf 'outbox reconciliation apply requires pre.json\n' >&2; exit 2; }
  confirm_args=(-e 'CAUCE_OUTBOX_RECONCILE_CONFIRM=dead-letter:fenced:legacy-console-origin-relay-has-no-transport-v1')
fi
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod run --rm --no-deps -T \
  "${baseline_args[@]}" "${confirm_args[@]}" migrator \
  node deploy/reconcile-stale-console-outbox.mjs "$phase" >"$tmp"

python3 - "$phase" "$tmp" "$out/pre.json" "$out/apply.json" <<'PY'
import json, pathlib, re, sys

phase, report_path, pre_path, apply_path = sys.argv[1:]
report = json.loads(pathlib.Path(report_path).read_text(encoding="utf-8"))
if report.get("schemaVersion") != 1 or report.get("suite") != "cauce-v3-legacy-console-outbox-reconciliation":
    raise SystemExit("outbox reconciliation evidence contract mismatch")
if report.get("phase") != phase or report.get("reason") != "fenced:legacy-console-origin-relay-has-no-transport-v1":
    raise SystemExit("outbox reconciliation phase/reason mismatch")
counts = report.get("counts", {})
if any(not isinstance(value, int) or value < 0 for value in counts.values()):
    raise SystemExit("outbox reconciliation contains an invalid count")
if counts.get("staleProcessing") != 0 or counts.get("inconsistentDeadLetters") != 0:
    raise SystemExit("outbox reconciliation found claimed or inconsistent legacy rows")
if phase == "pre":
    if counts.get("candidates") not in (0, 1):
        raise SystemExit("outbox reconciliation expected zero or one exact legacy candidate")
elif phase == "apply":
    application = report.get("application", {})
    if application.get("appliedCount") not in (0, 1):
        raise SystemExit("outbox reconciliation applied an unexpected row count")
    if any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in application.get("rowDigests", [])):
        raise SystemExit("outbox reconciliation row digest is invalid")
    if counts.get("candidates") != 0:
        raise SystemExit("outbox reconciliation left its candidate pending")
elif phase == "post":
    pre = json.loads(pathlib.Path(pre_path).read_text(encoding="utf-8"))
    applied = json.loads(pathlib.Path(apply_path).read_text(encoding="utf-8"))
    applied_count = applied.get("application", {}).get("appliedCount")
    if counts.get("candidates") != 0:
        raise SystemExit("post gate still has a stale console origin-relay candidate")
    if counts.get("deadBeforeBaseline") != pre.get("counts", {}).get("deadTotal"):
        raise SystemExit("historical dead-letter population changed during reconciliation")
    if counts.get("deadAfterBaseline") != applied_count:
        raise SystemExit("new dead letters differ from the one audited reconciliation")
    if counts.get("deadTotal") != counts.get("deadBeforeBaseline") + counts.get("deadAfterBaseline"):
        raise SystemExit("dead-letter before/after accounting is inconsistent")
PY
chmod 0600 "$tmp"
mv -f -- "$tmp" "$out/$phase.json"
trap - EXIT
"$ROOT/scripts/manifest.sh" "$out" >/dev/null
printf 'outbox reconciliation %s evidence: %s/%s.json\n' "$phase" "$out" "$phase"
