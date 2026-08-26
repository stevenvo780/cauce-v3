#!/usr/bin/env bash
set -euo pipefail

OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT="$OPS/.."
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
state="$OPS/.test-state/testcontainers-$run_id"
destination="$OPS/artifacts/testcontainers/$run_id"
mkdir -p "$state/previous" "$destination"

for name in real restarts; do
  if [[ -e "$OPS/artifacts/$name" ]]; then mv "$OPS/artifacts/$name" "$state/previous/$name"; fi
done

restore() {
  for name in real restarts; do
    if [[ -e "$OPS/artifacts/$name" ]]; then mv "$OPS/artifacts/$name" "$destination/$name"; fi
    if [[ -e "$state/previous/$name" ]]; then mv "$state/previous/$name" "$OPS/artifacts/$name"; fi
  done
  rm -rf "$state"
}
trap restore EXIT

CAUCE_REQUIRE_TESTCONTAINERS=1 CAUCE_EVIDENCE_CLASS=testcontainers \
  pnpm --dir "$PROJECT" test:e2e
for name in real restarts; do
  [[ -f "$OPS/artifacts/$name/report.json" && -f "$OPS/artifacts/$name/junit.xml" \
      && -f "$OPS/artifacts/$name/SHA256SUMS" ]] || {
    printf 'Testcontainers evidence incomplete for %s\n' "$name" >&2
    exit 1
  }
done
# Validate before the trap publishes this run into the timestamped evidence tree.
validation_run="$state/validation"
mkdir -p "$validation_run"
ln -s "$OPS/artifacts/real" "$validation_run/real"
ln -s "$OPS/artifacts/restarts" "$validation_run/restarts"
PYTHONDONTWRITEBYTECODE=1 python3 "$OPS/scripts/validate-testcontainers-evidence.py" --run-dir "$validation_run"
printf 'Testcontainers reports (separate from runtime evidence): %s\n' "$destination"
