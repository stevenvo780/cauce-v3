#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-schema}
case $action in
  runtime|console|release) ;;
  *)
    printf 'schema rollback is forbidden: restore a verified PostgreSQL backup into a new V3 database.\n' >&2
    printf 'use rollback.sh runtime, rollback.sh console, or rollback.sh release for image selectors.\n' >&2
    printf 'for an alias cutover rollback use: cutover-rollback.sh host-native|container ALIAS SNAPSHOT.json\n' >&2
    exit 2
    ;;
esac

: "${CAUCE_ENV_FILE:?set the private production compose env file}"

pin_helper="$ROOT/scripts/pin-production-release.py"
[[ -x $pin_helper ]] || { printf 'release rollback requires the production release pin helper\n' >&2; exit 2; }
canonical_selector() {
  "$pin_helper" field --env-file "$CAUCE_ENV_FILE" --name "$1"
}
# Never source the secret-bearing environment and never accept caller-exported
# current/previous selectors. These five values come only from the private
# canonical env; rollback targets come only from its authenticated baseline.
CAUCE_CURRENT_RUNTIME_IMAGE=$(canonical_selector CAUCE_RUNTIME_IMAGE)
CAUCE_CURRENT_CONSOLE_IMAGE=$(canonical_selector CAUCE_CONSOLE_IMAGE)
CAUCE_CURRENT_OVERRIDE_MANIFEST=$(canonical_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST)
CAUCE_CURRENT_ROLLBACK_BASELINE_FILE=$(canonical_selector CAUCE_ROLLBACK_BASELINE_FILE)
CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256=$(canonical_selector CAUCE_ROLLBACK_BASELINE_SHA256)

baseline_helper="$ROOT/scripts/rollback-baseline.py"
[[ -x $baseline_helper ]] || { printf 'release rollback requires the rollback baseline helper\n' >&2; exit 2; }
baseline_field() {
  "$baseline_helper" field \
    --baseline "$CAUCE_CURRENT_ROLLBACK_BASELINE_FILE" \
    --expected-baseline-sha256 "$CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256" \
    --name "$1"
}
baseline_forward_commit=$(baseline_field forward-release-commit)
baseline_forward_runtime=$(baseline_field forward-runtime-image)
baseline_forward_source_digest=$(baseline_field forward-runtime-source-digest)
baseline_runtime=$(baseline_field bridge-runtime-image)
baseline_console=$(baseline_field console-image)
baseline_manifest=$(baseline_field override-manifest)
baseline_bridge_evidence=$(baseline_field bridge-evidence)
baseline_bridge_evidence_sha256=$(baseline_field bridge-evidence-sha256)
[[ $baseline_forward_runtime == "$CAUCE_CURRENT_RUNTIME_IMAGE" ]] || {
  printf 'release rollback refused: baseline belongs to a different forward runtime\n' >&2
  exit 1
}

target_runtime=$CAUCE_CURRENT_RUNTIME_IMAGE
target_console=$CAUCE_CURRENT_CONSOLE_IMAGE
target_manifest=$CAUCE_CURRENT_OVERRIDE_MANIFEST
case $action in
  runtime)
    target_runtime=$baseline_runtime
    target_manifest=$baseline_manifest
    ;;
  console)
    target_console=$baseline_console
    ;;
  release)
    target_runtime=$baseline_runtime
    target_console=$baseline_console
    target_manifest=$baseline_manifest
    ;;
esac

expected_confirmation="release-selectors:${action}:${CAUCE_CURRENT_RUNTIME_IMAGE}|${CAUCE_CURRENT_CONSOLE_IMAGE}|${CAUCE_CURRENT_OVERRIDE_MANIFEST}|${CAUCE_CURRENT_ROLLBACK_BASELINE_FILE}|${CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256}->${target_runtime}|${target_console}|${target_manifest}|${CAUCE_CURRENT_ROLLBACK_BASELINE_FILE}|${CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256}"
[[ ${CAUCE_ROLLBACK_CONFIRM:-} == "$expected_confirmation" ]] || {
  printf 'set CAUCE_ROLLBACK_CONFIRM to the exact release-selectors action/current-to-target transition\n' >&2
  exit 2
}

# The env file is the sole production selector. Docker Compose normally gives
# caller-exported variables precedence over --env-file, so every operation
# explicitly removes every release/override control that could bypass the CAS.
canonical_env=(
  env
  -u CAUCE_RUNTIME_IMAGE
  -u CAUCE_CONSOLE_IMAGE
  -u CAUCE_COMPOSE_OVERRIDE_MANIFEST
  -u CAUCE_ROLLBACK_BASELINE_FILE
  -u CAUCE_ROLLBACK_BASELINE_SHA256
  -u CAUCE_COMPOSE_OVERRIDES_DIR
  -u CAUCE_LOCAL_POSTGRES
)
compose_prod() {
  "${canonical_env[@]}" CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/compose.sh" prod "$@"
}
health_prod() {
  "${canonical_env[@]}" CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/stack-health.sh" prod
}
pin_transition() {
  local operation=$1 expected_runtime=$2 next_runtime=$3 expected_console=$4 next_console=$5 expected_manifest=$6 next_manifest=$7
  "$pin_helper" "$operation" \
    --env-file "$CAUCE_ENV_FILE" \
    --expected-runtime-image "$expected_runtime" \
    --target-runtime-image "$next_runtime" \
    --expected-console-image "$expected_console" \
    --target-console-image "$next_console" \
    --expected-override-manifest "$expected_manifest" \
    --target-override-manifest "$next_manifest" \
    --expected-rollback-baseline "$CAUCE_CURRENT_ROLLBACK_BASELINE_FILE" \
    --target-rollback-baseline "$CAUCE_CURRENT_ROLLBACK_BASELINE_FILE" \
    --expected-rollback-baseline-sha256 "$CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256" \
    --target-rollback-baseline-sha256 "$CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256" \
    --baseline-forward-release-commit "$baseline_forward_commit" \
    --baseline-forward-runtime-image "$baseline_forward_runtime" \
    --baseline-forward-runtime-source-digest "$baseline_forward_source_digest"
}
pull_and_resolve() {
  local reference=$1 output digests
  docker pull "$reference" >/dev/null || {
    printf 'release rollback could not retrieve an immutable image from its registry\n' >&2
    return 1
  }
  output=$(docker image inspect --format '{{.Id}}' "$reference") || return 1
  [[ $output =~ ^sha256:[0-9a-f]{64}$ ]] || {
    printf 'release rollback image resolved to an invalid image ID\n' >&2
    return 1
  }
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reference") || return 1
  grep -Fqx -- "$reference" <<<"$digests" || {
    printf 'release rollback image is not bound to the requested registry digest\n' >&2
    return 1
  }
  printf '%s\n' "$output"
}

# Validate the complete logical transition before inventorying or mutating a
# service. All current and target images must be registry-recoverable so the
# compensation path never depends on a daemon cache.
pin_transition check \
  "$CAUCE_CURRENT_RUNTIME_IMAGE" "$target_runtime" \
  "$CAUCE_CURRENT_CONSOLE_IMAGE" "$target_console" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST" "$target_manifest" >/dev/null
current_runtime_id=$(pull_and_resolve "$CAUCE_CURRENT_RUNTIME_IMAGE")
if [[ $target_runtime == "$CAUCE_CURRENT_RUNTIME_IMAGE" ]]; then
  target_runtime_id=$current_runtime_id
else
  target_runtime_id=$(pull_and_resolve "$target_runtime")
fi
current_console_id=$(pull_and_resolve "$CAUCE_CURRENT_CONSOLE_IMAGE")
if [[ $target_console == "$CAUCE_CURRENT_CONSOLE_IMAGE" ]]; then
  target_console_id=$current_console_id
else
  target_console_id=$(pull_and_resolve "$target_console")
fi

# A schema-029 runtime rollback is permitted only to the tested bridge image.
# A compatibility label is not evidence: the bridge must have exercised the
# complete shim/state/lifecycle contract on a recent isolated restore, and that evidence is
# bound to the exact registry-recovered image ID.
if [[ $target_runtime != "$CAUCE_CURRENT_RUNTIME_IMAGE" ]]; then
  bridge_validator="$ROOT/scripts/validate-rollback-bridge-evidence.py"
  [[ -x $bridge_validator ]] || {
    printf 'release rollback requires the rollback bridge evidence validator\n' >&2
    exit 2
  }
  "$bridge_validator" \
    --evidence "$baseline_bridge_evidence" \
    --expected-evidence-sha256 "$baseline_bridge_evidence_sha256" \
    --expected-repository-digest "$target_runtime" \
    --expected-image-id "$target_runtime_id" \
    --expected-candidate-repository-digest "$baseline_forward_runtime" \
    --expected-candidate-image-id "$current_runtime_id" \
    --expected-candidate-source-digest "$baseline_forward_source_digest" >/dev/null || {
    printf 'release rollback refused: target runtime lacks exact passing rollback bridge evidence\n' >&2
    exit 1
  }
  current_schema=$(compose_prod exec -T gateway node deploy/schema-version.mjs) || {
    printf 'release rollback could not measure the current database schema\n' >&2
    exit 1
  }
  current_schema=${current_schema%$'\r'}
  [[ $current_schema != *$'\n'* && $current_schema =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || {
    printf 'release rollback refused: current database schema probe was invalid\n' >&2
    exit 1
  }
  if [[ $current_schema != 029_reconcile_declared_fleet.sql ]]; then
    printf 'release rollback refused: rollback bridge evidence is valid only for exact schema 029\n' >&2
    exit 1
  fi
fi

runtime_services=(
  gateway dispatcher outbox-metrics relay-worker terminal-relay
  telegram-bridge shadow-router shadow-guard
)
case $action in
  runtime) candidate_services=("${runtime_services[@]}"); mandatory=(gateway dispatcher outbox-metrics) ;;
  console) candidate_services=(console); mandatory=(console) ;;
  release) candidate_services=("${runtime_services[@]}" console); mandatory=(gateway dispatcher outbox-metrics console) ;;
esac
running_output=$(compose_prod ps --services --status running) || {
  printf 'release rollback could not inventory running services\n' >&2
  exit 1
}
declare -A was_running=()
while IFS= read -r service; do [[ -n $service ]] && was_running[$service]=1; done <<<"$running_output"
selected=()
for service in "${candidate_services[@]}"; do
  [[ -n ${was_running[$service]+x} ]] && selected+=("$service")
done
for required in "${mandatory[@]}"; do
  [[ -n ${was_running[$required]+x} ]] || {
    printf 'release rollback refused: mandatory service was not running before rollback: %s\n' "$required" >&2
    exit 1
  }
done

verify_selected() {
  local runtime_id=$1 console_id=$2 service container_id expected_id running_id
  for service in "${selected[@]}"; do
    container_id=$(compose_prod ps -q "$service") || return 1
    [[ -n $container_id ]] || {
      printf 'release rollback lost a selected service container\n' >&2
      return 1
    }
    expected_id=$runtime_id
    [[ $service != console ]] || expected_id=$console_id
    running_id=$(docker inspect --format '{{.Image}}' "$container_id") || return 1
    [[ $running_id == "$expected_id" ]] || {
      printf 'release rollback image mismatch for %s\n' "$service" >&2
      return 1
    }
  done
}

deploy_selected() {
  local runtime_id=$1 console_id=$2
  compose_prod pull "${selected[@]}" || return 1
  compose_prod up -d --no-build --no-deps --wait --wait-timeout 180 "${selected[@]}" || return 1
  verify_selected "$runtime_id" "$console_id" || return 1
  health_prod || return 1
}

# Runtime, console, override manifest and authenticated rollback-baseline
# pointer/hash are checked and move in one durable replace.
# A host/service restart therefore converges to the selected rollback, never to
# a rejected partial combination.
pin_transition swap \
  "$CAUCE_CURRENT_RUNTIME_IMAGE" "$target_runtime" \
  "$CAUCE_CURRENT_CONSOLE_IMAGE" "$target_console" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST" "$target_manifest" >/dev/null

if deploy_selected "$target_runtime_id" "$target_console_id"; then
  printf '%s rollback completed for %s running service(s); all durable release selectors were updated\n' \
    "$action" "${#selected[@]}"
  exit 0
else
  failure=$?
fi
printf 'release rollback verification failed; restoring the prior durable release selectors\n' >&2
if ! pin_transition swap \
  "$target_runtime" "$CAUCE_CURRENT_RUNTIME_IMAGE" \
  "$target_console" "$CAUCE_CURRENT_CONSOLE_IMAGE" \
  "$target_manifest" "$CAUCE_CURRENT_OVERRIDE_MANIFEST" >/dev/null; then
  printf 'release rollback compensation failed before service recovery; production env requires operator recovery\n' >&2
  exit "$failure"
fi
if ! deploy_selected "$current_runtime_id" "$current_console_id"; then
  printf 'release rollback compensation restored configuration but could not restore every prior service\n' >&2
  exit "$failure"
fi
printf 'release rollback failed safely: prior durable release selectors and running services were restored\n' >&2
exit "$failure"
