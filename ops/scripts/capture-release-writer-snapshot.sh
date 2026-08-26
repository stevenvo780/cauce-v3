#!/bin/bash
# Publish one exact, secret-free external-writer recovery snapshot under the release lock.
set -euo pipefail

system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly system_path
PATH=$system_path
export PATH
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT NODE_OPTIONS

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output=${1:?usage: capture-release-writer-snapshot.sh OUTPUT.json [--maintenance-offline-zeus]}
shift
maintenance=0
if (($#)); then
  [[ $# == 1 && $1 == --maintenance-offline-zeus ]] || {
    printf 'usage: capture-release-writer-snapshot.sh OUTPUT.json [--maintenance-offline-zeus]\n' >&2
    exit 2
  }
  maintenance=1
fi
: "${CAUCE_ENV_FILE:?set the absolute private production env file}"
[[ $output = /* ]] || { printf 'writer snapshot output path must be absolute\n' >&2; exit 2; }
bootstrap_legacy_fleet=${CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_FILE:-}
bootstrap_legacy_fleet_sha=${CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_SHA256:-}
if [[ -n $bootstrap_legacy_fleet || -n $bootstrap_legacy_fleet_sha ]]; then
  [[ $bootstrap_legacy_fleet = /* \
     && $bootstrap_legacy_fleet_sha =~ ^sha256:[a-f0-9]{64}$ ]] || {
    printf 'writer snapshot capture received an invalid bootstrap legacy-fleet capability\n' >&2
    exit 2
  }
  bootstrap_legacy=1
else
  bootstrap_legacy=0
fi
if ((maintenance == 1)); then
  : "${CAUCE_CHANGE_ID:?set the non-secret maintenance change ID}"
  : "${CAUCE_MAINTENANCE_CONFIRM:?set the exact Zeus maintenance confirmation}"
  [[ $CAUCE_CHANGE_ID =~ ^[A-Za-z0-9._-]+$ \
     && $CAUCE_MAINTENANCE_CONFIRM == "offline:Steven:zeus:$CAUCE_CHANGE_ID" ]] || {
    printf 'writer snapshot capture refused: Zeus maintenance authority is invalid\n' >&2
    exit 2
  }
fi

pin_helper="$ROOT/scripts/pin-production-release.py"
baseline_helper="$ROOT/scripts/rollback-baseline.py"
compose_helper="$ROOT/scripts/compose.sh"
health_helper="$ROOT/scripts/stack-health.sh"
writer_helper="$ROOT/scripts/release-writer-state.py"
for executable in "$pin_helper" "$baseline_helper" "$compose_helper" "$health_helper" "$writer_helper"; do
  [[ -x $executable ]] || { printf 'writer snapshot capture requires every canonical helper\n' >&2; exit 2; }
done

if [[ -z ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-} ]]; then
  ((bootstrap_legacy == 0)) || {
    printf 'writer snapshot capture refuses an ambient bootstrap legacy-fleet capability\n' >&2
    exit 2
  }
  args=("$output")
  ((maintenance == 0)) || args+=(--maintenance-offline-zeus)
  outer_env=(/usr/bin/env -i "PATH=$system_path" 'LC_ALL=C' 'PYTHONDONTWRITEBYTECODE=1'
    "CAUCE_ENV_FILE=$CAUCE_ENV_FILE")
  for allowed in CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE \
    CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256; do
    [[ ! -v $allowed ]] || outer_env+=("$allowed=${!allowed}")
  done
  if ((maintenance == 1)); then
    outer_env+=("CAUCE_CHANGE_ID=$CAUCE_CHANGE_ID" "CAUCE_MAINTENANCE_CONFIRM=$CAUCE_MAINTENANCE_CONFIRM")
  fi
  exec "${outer_env[@]}" "$pin_helper" locked-exec --env-file "$CAUCE_ENV_FILE" -- "$0" "${args[@]}"
fi
[[ $CAUCE_RELEASE_TRANSITION_LOCK_FD =~ ^[0-9]+$ \
   && $CAUCE_RELEASE_TRANSITION_LOCK_FD -ge 3 \
   && ${CAUCE_RELEASE_TRANSITION_LOCK_TOKEN:-} =~ ^[a-f0-9]{64}$ ]] || {
  printf 'writer snapshot capture inherited an invalid transition lock capability\n' >&2
  exit 2
}
transition_lock_fd=$CAUCE_RELEASE_TRANSITION_LOCK_FD

compose_profiles=$(python3 - "$CAUCE_ENV_FILE" <<'PY'
import pathlib
import re
import sys

allowed = ("origin-relay", "telegram", "terminal", "shadow", "observability")
denied = {
    "COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES",
    "COMPOSE_DISABLE_ENV_FILE", "COMPOSE_IGNORE_ORPHANS", "COMPOSE_REMOVE_ORPHANS",
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS",
    "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
}
values = {}
for number, raw in enumerate(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines(), 1):
    if not raw or raw.startswith("#"):
        continue
    if "=" not in raw:
        raise SystemExit(f"invalid production env line {number}")
    key, value = raw.split("=", 1)
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None or key in values:
        raise SystemExit("invalid or duplicate production env key")
    values[key] = value
if values.get("COMPOSE_PROJECT_NAME") != "cauce-v3-prod" or denied.intersection(values):
    raise SystemExit("unsafe production Docker/Compose controls")
profiles = [item.strip() for item in values.get("COMPOSE_PROFILES", "").split(",") if item.strip()]
if len(profiles) != len(set(profiles)) or any(item not in allowed for item in profiles):
    raise SystemExit("unsupported production profile")
print(",".join(item for item in allowed if item in profiles))
PY
) || { printf 'writer snapshot capture refused: unsafe Docker/Compose controls\n' >&2; exit 2; }
trusted_home=$(getent passwd "$(id -u)" | cut -d: -f6)
trusted_user=$(id -un)
[[ $trusted_home = /* && -d $trusted_home && ! -L $trusted_home ]] || {
  printf 'writer snapshot capture requires a trusted invoking-account home\n' >&2
  exit 2
}

selector() {
  "$pin_helper" field --env-file "$CAUCE_ENV_FILE" --name "$1" --lock-fd "$transition_lock_fd"
}
runtime=$(selector CAUCE_RUNTIME_IMAGE)
console=$(selector CAUCE_CONSOLE_IMAGE)
manifest=$(selector CAUCE_COMPOSE_OVERRIDE_MANIFEST)
manifest_sha=$(selector CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256)
baseline=$(selector CAUCE_ROLLBACK_BASELINE_FILE)
baseline_sha=$(selector CAUCE_ROLLBACK_BASELINE_SHA256)
artifact_baseline=${CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE:-$baseline}
artifact_baseline_sha=${CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256:-$baseline_sha}
if { [[ -v CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE ]] \
     && [[ ! -v CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256 ]]; } \
   || { [[ ! -v CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE ]] \
     && [[ -v CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256 ]]; }; then
  printf 'writer snapshot capture requires both target baseline selectors together\n' >&2
  exit 2
fi
[[ $artifact_baseline = /* \
   && $artifact_baseline_sha =~ ^sha256:[a-f0-9]{64}$ \
   && $(dirname -- "$output") == "$(dirname -- "$artifact_baseline")" ]] || {
  printf 'writer snapshot output must be beside the authenticated durable release baseline\n' >&2
  exit 2
}
"$baseline_helper" check --baseline "$artifact_baseline" \
  --expected-baseline-sha256 "$artifact_baseline_sha" >/dev/null
legacy_compose_args=()
if ((bootstrap_legacy == 1)); then
  "$baseline_helper" check --baseline "$baseline" \
    --expected-baseline-sha256 "$baseline_sha" >/dev/null
  baseline_kind=$("$baseline_helper" field --baseline "$baseline" \
    --expected-baseline-sha256 "$baseline_sha" --name baseline-kind)
  baseline_legacy_fleet=$("$baseline_helper" field --baseline "$baseline" \
    --expected-baseline-sha256 "$baseline_sha" --name legacy-fleet-snapshot)
  baseline_legacy_fleet_sha=$("$baseline_helper" field --baseline "$baseline" \
    --expected-baseline-sha256 "$baseline_sha" --name legacy-fleet-snapshot-sha256)
  [[ $baseline_kind == legacy-pre-migration \
     && $baseline_legacy_fleet == "$bootstrap_legacy_fleet" \
     && $baseline_legacy_fleet_sha == "$bootstrap_legacy_fleet_sha" ]] || {
    printf 'writer snapshot capture refused: bootstrap legacy-fleet is not selected by its baseline\n' >&2
    exit 1
  }
  legacy_compose_args=(--legacy-fleet-snapshot "$bootstrap_legacy_fleet"
    --legacy-fleet-snapshot-sha256 "$bootstrap_legacy_fleet_sha")
fi
release_id=$("$baseline_helper" field --baseline "$baseline" \
  --expected-baseline-sha256 "$baseline_sha" --name forward-release-commit)

placeholder_dir=$(mktemp -d)
chmod 0700 "$placeholder_dir"
placeholder_base="$placeholder_dir/selector"
placeholder_marker="${placeholder_base}.state.json"
printf '%s\n' '{"kind":"cauce-v3-release-writer-snapshot-placeholder","schemaVersion":1,"writersExpectedCandidate":0}' >"$placeholder_base"
chmod 0600 "$placeholder_base"
placeholder_sha="sha256:$(sha256sum "$placeholder_base" | cut -d' ' -f1)"
printf '%s\n' "{\"kind\":\"cauce-v3-release-state\",\"mode\":\"candidate\",\"releaseId\":\"capture-placeholder\",\"schemaVersion\":1,\"snapshotPath\":\"$placeholder_base\",\"snapshotSha256\":\"$placeholder_sha\",\"updatedAt\":\"1970-01-01T00:00:00Z\",\"writersExpected\":0,\"writersObserved\":0}" >"$placeholder_marker"
chmod 0444 "$placeholder_marker"
cleanup() {
  rm -f -- "$placeholder_marker" "$placeholder_base"
  rmdir -- "$placeholder_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

canonical_env=(env -i "PATH=$system_path" "HOME=$trusted_home" "USER=$trusted_user"
  "LOGNAME=$trusted_user" 'LC_ALL=C' 'PYTHONDONTWRITEBYTECODE=1'
  'DOCKER_HOST=unix:///var/run/docker.sock' "DOCKER_CONFIG=$trusted_home/.docker"
  'COMPOSE_PROJECT_NAME=cauce-v3-prod' "COMPOSE_PROFILES=$compose_profiles"
  "CAUCE_ENV_FILE=$CAUCE_ENV_FILE"
  "CAUCE_RELEASE_TRANSITION_LOCK_FD=$CAUCE_RELEASE_TRANSITION_LOCK_FD"
  "CAUCE_RELEASE_TRANSITION_LOCK_TOKEN=$CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"
  "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=$placeholder_base")
if ((maintenance == 1)); then
  canonical_env+=("CAUCE_CHANGE_ID=$CAUCE_CHANGE_ID" "CAUCE_MAINTENANCE_CONFIRM=$CAUCE_MAINTENANCE_CONFIRM")
fi
compose_prod() { "${canonical_env[@]}" "$compose_helper" prod "$@"; }

"$pin_helper" manifest --env-file "$CAUCE_ENV_FILE" --path "$manifest" \
  --expected-sha256 "$manifest_sha" --require-selected --lock-fd "$transition_lock_fd" >/dev/null
model=$(compose_prod config --format json)
classified=$(printf '%s' "$model" | "${canonical_env[@]}" "$writer_helper" \
  --ops-root "$ROOT" compose-model --runtime-image "$runtime" --console-image "$console" \
  "${legacy_compose_args[@]}")
mapfile -t configured < <(cut -f2 <<<"$classified" | LC_ALL=C sort)
mapfile -t writers < <(awk -F '\t' '$1 == "writer" {print $2}' <<<"$classified" | LC_ALL=C sort)
mapfile -t expected_long_lived < <(printf '%s\n' "${configured[@]}" | grep -Fvx migrator)
expected=$(printf '%s\n' "${expected_long_lived[@]}" | LC_ALL=C sort)
expected_materialized=$(printf '%s\n' "${configured[@]}" | LC_ALL=C sort)
running=$(compose_prod ps --services --status running | LC_ALL=C sort)
materialized=$(compose_prod ps --all --services | LC_ALL=C sort)
[[ -n $expected && $running == "$expected" && $materialized == "$expected_materialized" ]] || {
  printf 'writer snapshot capture refused: running/materialized Compose topology is not exact\n' >&2
  exit 1
}
migrator_container=$(compose_prod ps --all -q migrator)
[[ -n $migrator_container && $migrator_container != *$'\n'* ]] || {
  printf 'writer snapshot capture refused: materialized migrator identity is ambiguous\n' >&2
  exit 1
}
migrator_state=$("${canonical_env[@]}" docker inspect \
  --format '{{.State.Status}} {{.State.ExitCode}}' "$migrator_container")
[[ $migrator_state == 'exited 0' ]] || {
  printf 'writer snapshot capture refused: materialized migrator is not exited/0\n' >&2
  exit 1
}
health_args=(prod)
((maintenance == 0)) || health_args+=(--maintenance-offline-zeus)
"${canonical_env[@]}" "$health_helper" "${health_args[@]}" >/dev/null
fleet=$(compose_prod run --rm --no-deps -T migrator node deploy/fleet-snapshot.mjs)
capture_args=(--ops-root "$ROOT" capture)
for service in "${writers[@]}"; do capture_args+=(--compose-writer "$service"); done
snapshot=$(printf '%s' "$fleet" | "${canonical_env[@]}" "$writer_helper" "${capture_args[@]}")
snapshot+=$'\n'
snapshot_sha=$(printf '%s' "$snapshot" | "${canonical_env[@]}" "$writer_helper" \
  --ops-root "$ROOT" publish --path "$output" --allow-identical)
expected_count=$(python3 - "$output" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["writersExpectedCandidate"])
PY
)
"${canonical_env[@]}" "$writer_helper" --ops-root "$ROOT" marker \
  --snapshot "$output" --expected-sha256 "$snapshot_sha" --path "${output}.state.json" \
  --release-id "$release_id" --mode candidate \
  --writers-expected "$expected_count" --writers-observed "$expected_count" >/dev/null
printf 'release writer snapshot captured create-only: path=%s sha256=%s marker=%s\n' \
  "$output" "$snapshot_sha" "${output}.state.json"
