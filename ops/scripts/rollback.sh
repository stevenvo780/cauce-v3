#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-schema}

# Production overrides both hooks after it has constructed the exact ingress
# inventory. The isolated lifecycle harness has no externally reachable
# ingress, so its default is an explicit no-op.
transition_assert_quiesced() { return 0; }
transition_quiesce_for_compensation() { return 0; }

# The selector mutation, Compose deployment, verification and compensation are
# one shared transaction engine.  Production and the isolated bridge-evidence
# cycle provide different admission/deploy adapters, but execute these exact
# ordering and compensation semantics under one inherited pin lock.
execute_release_transition() {
  local current_runtime=$1 target_runtime=$2 current_console=$3 target_console=$4
  local current_manifest=$5 target_manifest=$6 current_manifest_sha=$7 target_manifest_sha=$8
  local current_runtime_id=$9 target_runtime_id=${10}
  local current_console_id=${11} target_console_id=${12} failure
  CAUCE_RELEASE_TRANSACTION_OUTCOME=selector-swap-failed
  CAUCE_RELEASE_TRANSACTION_FORWARD_RESPONSE_LOST=false
  CAUCE_RELEASE_TRANSACTION_INVERSE_RESPONSE_LOST=false
  local swap_failure=1
  if ! transition_assert_quiesced; then
    printf 'release rollback refused: ingress is not durably quiesced before selector CAS\n' >&2
    return 1
  fi
  if pin_transition swap \
    "$current_runtime" "$target_runtime" \
    "$current_console" "$target_console" \
    "$current_manifest" "$target_manifest" \
    "$current_manifest_sha" "$target_manifest_sha" >/dev/null; then
    :
  else
    swap_failure=$?
    if ! pin_transition check \
      "$target_runtime" "$target_runtime" \
      "$target_console" "$target_console" \
      "$target_manifest" "$target_manifest" \
      "$target_manifest_sha" "$target_manifest_sha" >/dev/null; then
      return "$swap_failure"
    fi
    CAUCE_RELEASE_TRANSACTION_FORWARD_RESPONSE_LOST=true
    printf 'release rollback detected a lost selector-CAS response after target state became durable; continuing verification\n' >&2
  fi
  CAUCE_RELEASE_TRANSACTION_OUTCOME=target-deploy-failed
  if deploy_selected "$target_runtime_id" "$target_console_id"; then
    if pin_transition check \
      "$target_runtime" "$target_runtime" \
      "$target_console" "$target_console" \
      "$target_manifest" "$target_manifest" \
      "$target_manifest_sha" "$target_manifest_sha" >/dev/null; then
      CAUCE_RELEASE_TRANSACTION_OUTCOME=committed
      return 0
    else
      failure=$?
    fi
  else
    failure=$?
  fi
  printf 'release rollback verification failed; restoring the prior durable release selectors\n' >&2
  CAUCE_RELEASE_TRANSACTION_OUTCOME=compensation-quiesce-failed
  if ! transition_quiesce_for_compensation; then
    printf 'CRITICAL: rollback target ingress could not be closed before inverse selector CAS\n' >&2
    return "$failure"
  fi
  CAUCE_RELEASE_TRANSACTION_OUTCOME=compensation-selector-failed
  if pin_transition swap \
    "$target_runtime" "$current_runtime" \
    "$target_console" "$current_console" \
    "$target_manifest" "$current_manifest" \
    "$target_manifest_sha" "$current_manifest_sha" >/dev/null; then
    :
  elif pin_transition check \
    "$current_runtime" "$current_runtime" \
    "$current_console" "$current_console" \
    "$current_manifest" "$current_manifest" \
    "$current_manifest_sha" "$current_manifest_sha" >/dev/null; then
    CAUCE_RELEASE_TRANSACTION_INVERSE_RESPONSE_LOST=true
    printf 'release rollback detected a lost inverse-CAS response after prior state became durable; continuing recovery\n' >&2
  else
    return "$failure"
  fi
  CAUCE_RELEASE_TRANSACTION_OUTCOME=compensation-deploy-failed
  if ! deploy_selected "$current_runtime_id" "$current_console_id"; then
    return "$failure"
  fi
  if ! pin_transition check \
    "$current_runtime" "$current_runtime" \
    "$current_console" "$current_console" \
    "$current_manifest" "$current_manifest" \
    "$current_manifest_sha" "$current_manifest_sha" >/dev/null; then
    return "$failure"
  fi
  CAUCE_RELEASE_TRANSACTION_OUTCOME=compensated
  return "$failure"
}

run_isolated_evidence_cycle() {
  [[ ${CAUCE_ROLLBACK_EVIDENCE_MODE:-} == isolated-compose-v1 ]] || {
    printf 'isolated rollback evidence capability is absent\n' >&2
    return 2
  }
  : "${CAUCE_ROLLBACK_EVIDENCE_ROOT:?set isolated evidence root}"
  : "${CAUCE_ROLLBACK_EVIDENCE_PROJECT:?set isolated Compose project}"
  : "${CAUCE_ROLLBACK_EVIDENCE_COMPOSE_FILE:?set isolated Compose file}"
  : "${CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_IMAGE:?set candidate image}"
  : "${CAUCE_ROLLBACK_EVIDENCE_BRIDGE_IMAGE:?set bridge image}"
  : "${CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_ID:?set candidate image ID}"
  : "${CAUCE_ROLLBACK_EVIDENCE_BRIDGE_ID:?set bridge image ID}"

  local evidence_root=$CAUCE_ROLLBACK_EVIDENCE_ROOT
  local project=$CAUCE_ROLLBACK_EVIDENCE_PROJECT
  local compose_file=$CAUCE_ROLLBACK_EVIDENCE_COMPOSE_FILE
  local candidate=$CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_IMAGE
  local bridge=$CAUCE_ROLLBACK_EVIDENCE_BRIDGE_IMAGE
  local candidate_id=$CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_ID
  local bridge_id=$CAUCE_ROLLBACK_EVIDENCE_BRIDGE_ID
  local canonical_root mode owner
  canonical_root=$(realpath -e -- "$evidence_root") || return 2
  [[ $canonical_root == "$evidence_root" && ! -L $evidence_root && -d $evidence_root ]] || {
    printf 'isolated rollback evidence root is not canonical\n' >&2
    return 2
  }
  mode=$(stat -c '%a' -- "$evidence_root")
  owner=$(stat -c '%u' -- "$evidence_root")
  [[ $mode == 700 && ( $owner == 0 || $owner == "$(id -u)" ) ]] || {
    printf 'isolated rollback evidence root must be owned mode 0700\n' >&2
    return 2
  }
  [[ $compose_file == "$ROOT/compose.rollback-bridge.yaml" && -f $compose_file && ! -L $compose_file ]] || {
    printf 'isolated rollback evidence requires the canonical Compose topology\n' >&2
    return 2
  }
  [[ $project =~ ^cauce-rollback-bridge-[a-f0-9]{16}$ ]] || {
    printf 'isolated rollback evidence project is invalid\n' >&2
    return 2
  }
  [[ $candidate =~ @sha256:[a-f0-9]{64}$ && $bridge =~ @sha256:[a-f0-9]{64}$ ]] || {
    printf 'isolated rollback evidence images are not immutable\n' >&2
    return 2
  }
  [[ $candidate_id =~ ^sha256:[a-f0-9]{64}$ && $bridge_id =~ ^sha256:[a-f0-9]{64}$ ]] || {
    printf 'isolated rollback evidence image IDs are invalid\n' >&2
    return 2
  }

  local env_file="$evidence_root/release.env"
  local candidate_manifest="$evidence_root/candidate.manifest"
  local bridge_manifest="$evidence_root/bridge.manifest"
  local baseline="$evidence_root/rollback-baseline.json"
  local writer_snapshot="$evidence_root/writer-snapshot.json"
  local compose_override="$evidence_root/transition.compose.yaml"
  local failure_marker="$evidence_root/failure-observed"
  local lost_response_marker="$evidence_root/lost-forward-cas-response"
  umask 077
  if [[ ! -e $env_file ]]; then
    [[ ! -e $candidate_manifest && ! -e $bridge_manifest && ! -e $baseline \
       && ! -e $writer_snapshot && ! -e $compose_override ]] || {
      printf 'isolated rollback evidence selector files are partially initialized\n' >&2
      return 2
    }
    printf 'candidate %s\n' "$candidate" >"$candidate_manifest"
    printf 'bridge %s\n' "$bridge" >"$bridge_manifest"
    printf '{"kind":"isolated-rollback-evidence-baseline","schemaVersion":1}\n' >"$baseline"
    printf '{"kind":"isolated-rollback-writer-snapshot","schemaVersion":1}\n' >"$writer_snapshot"
    local baseline_sha candidate_manifest_sha bridge_manifest_sha writer_snapshot_sha
    baseline_sha="sha256:$(sha256sum "$baseline" | awk '{print $1}')"
    candidate_manifest_sha="sha256:$(sha256sum "$candidate_manifest" | awk '{print $1}')"
    bridge_manifest_sha="sha256:$(sha256sum "$bridge_manifest" | awk '{print $1}')"
    writer_snapshot_sha="sha256:$(sha256sum "$writer_snapshot" | awk '{print $1}')"
    printf '%s\n' \
      "CAUCE_RUNTIME_IMAGE=$candidate" \
      "CAUCE_CONSOLE_IMAGE=$candidate" \
      "CAUCE_COMPOSE_OVERRIDE_MANIFEST=$candidate_manifest" \
      "CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=$candidate_manifest_sha" \
      "CAUCE_ROLLBACK_BASELINE_FILE=$baseline" \
      "CAUCE_ROLLBACK_BASELINE_SHA256=$baseline_sha" \
      "CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=$writer_snapshot" \
      "CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=$writer_snapshot_sha" >"$env_file"
    printf '%s\n' \
      'services:' \
      '  candidate:' \
      '    command: ["node", "-e", "setInterval(() => {}, 2147483647)"]' \
      '    healthcheck:' \
      '      test: ["CMD", "node", "/rollback-probes/database-health.mjs"]' \
      '      interval: 1s' \
      '      timeout: 3s' \
      '      retries: 20' \
      '  bridge:' \
      '    command: ["node", "-e", "setInterval(() => {}, 2147483647)"]' \
      '    healthcheck:' \
      '      test: ["CMD", "node", "/rollback-probes/database-health.mjs"]' \
      '      interval: 1s' \
      '      timeout: 3s' \
      '      retries: 20' >"$compose_override"
    chmod 0600 "$candidate_manifest" "$bridge_manifest" "$baseline" "$writer_snapshot" \
      "$env_file" "$compose_override"
  fi
  for private_path in "$candidate_manifest" "$bridge_manifest" "$baseline" "$writer_snapshot" \
    "$env_file" "$compose_override"; do
    [[ -f $private_path && ! -L $private_path && $(stat -c '%a' -- "$private_path") == 600 ]] || {
      printf 'isolated rollback evidence selector state is not private\n' >&2
      return 2
    }
  done
  local baseline_sha candidate_manifest_sha bridge_manifest_sha writer_snapshot_sha
  baseline_sha="sha256:$(sha256sum "$baseline" | awk '{print $1}')"
  candidate_manifest_sha="sha256:$(sha256sum "$candidate_manifest" | awk '{print $1}')"
  bridge_manifest_sha="sha256:$(sha256sum "$bridge_manifest" | awk '{print $1}')"
  writer_snapshot_sha="sha256:$(sha256sum "$writer_snapshot" | awk '{print $1}')"
  export CAUCE_ENV_FILE=$env_file

  local pin_helper="$ROOT/scripts/pin-production-release.py"
  [[ -x $pin_helper ]] || { printf 'isolated rollback evidence requires the pin helper\n' >&2; return 2; }
  if [[ -z ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-} ]]; then
    exec "$pin_helper" locked-exec --env-file "$env_file" -- "$0" evidence-cycle
  fi
  [[ $CAUCE_RELEASE_TRANSITION_LOCK_FD =~ ^[0-9]+$ \
     && $CAUCE_RELEASE_TRANSITION_LOCK_FD -ge 3 ]] || {
    printf 'isolated rollback evidence inherited an invalid transition lock\n' >&2
    return 2
  }
  local transition_lock_fd=$CAUCE_RELEASE_TRANSITION_LOCK_FD
  evidence_compose() {
    env \
      -u CAUCE_RUNTIME_IMAGE -u CAUCE_CONSOLE_IMAGE -u CAUCE_COMPOSE_OVERRIDE_MANIFEST \
      -u CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256 \
      -u CAUCE_ROLLBACK_BASELINE_FILE -u CAUCE_ROLLBACK_BASELINE_SHA256 \
      -u CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE -u CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256 \
      docker compose -f "$compose_file" -f "$compose_override" \
      --project-name "$project" --profile probe "$@"
  }
  evidence_selector() {
    "$pin_helper" field --env-file "$env_file" --name "$1" --lock-fd "$transition_lock_fd"
  }
  pin_transition() {
    local operation=$1 expected_runtime=$2 next_runtime=$3 expected_console=$4 next_console=$5
    local expected_manifest=$6 next_manifest=$7 expected_manifest_sha=$8 next_manifest_sha=$9
    local status=0
    "$pin_helper" "$operation" \
      --env-file "$env_file" \
      --expected-runtime-image "$expected_runtime" --target-runtime-image "$next_runtime" \
      --expected-console-image "$expected_console" --target-console-image "$next_console" \
      --expected-override-manifest "$expected_manifest" --target-override-manifest "$next_manifest" \
      --expected-override-manifest-sha256 "$expected_manifest_sha" \
      --target-override-manifest-sha256 "$next_manifest_sha" \
      --expected-rollback-baseline "$baseline" --target-rollback-baseline "$baseline" \
      --expected-rollback-baseline-sha256 "$baseline_sha" --target-rollback-baseline-sha256 "$baseline_sha" \
      --expected-writer-snapshot "$writer_snapshot" --target-writer-snapshot "$writer_snapshot" \
      --expected-writer-snapshot-sha256 "$writer_snapshot_sha" \
      --target-writer-snapshot-sha256 "$writer_snapshot_sha" \
      --baseline-forward-release-commit "${candidate_id#sha256:}" \
      --baseline-forward-runtime-image "$candidate" \
      --baseline-forward-runtime-source-digest "$candidate_id" \
      --isolated-evidence-root "$evidence_root" --lock-fd "$transition_lock_fd" || status=$?
    ((status == 0)) || return "$status"
    if [[ $operation == swap && $expected_runtime == "$candidate" && $next_runtime == "$bridge" \
       && ! -e $lost_response_marker ]]; then
      : >"$lost_response_marker"
      chmod 0600 "$lost_response_marker"
      return 43
    fi
  }
  verify_evidence_service() {
    local service=$1 expected_id=$2 container_id running_id health
    container_id=$(evidence_compose ps -q "$service") || return 1
    [[ -n $container_id && $container_id != *$'\n'* ]] || return 1
    running_id=$(docker inspect --format '{{.Image}}' "$container_id") || return 1
    [[ $running_id == "$expected_id" ]] || return 1
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id") || return 1
    [[ $health == healthy ]] || return 1
    evidence_compose exec -T "$service" node /rollback-probes/database-health.mjs >/dev/null
  }
  deploy_selected() {
    local _runtime_id=$1 _console_id=$2 selected service other expected_id failure_observed=false
    selected=$(evidence_selector CAUCE_RUNTIME_IMAGE) || return 1
    case $selected in
      "$candidate") service=candidate; other=bridge; expected_id=$candidate_id ;;
      "$bridge") service=bridge; other=candidate; expected_id=$bridge_id ;;
      *) return 1 ;;
    esac
    evidence_compose stop --timeout 10 "$other" >/dev/null || return 1
    evidence_compose up -d --force-recreate --no-build --no-deps --wait --wait-timeout 60 "$service" >/dev/null || return 1
    verify_evidence_service "$service" "$expected_id" || return 1
    if [[ $service == bridge && ! -e $failure_marker ]]; then
      evidence_compose stop --timeout 10 postgres >/dev/null || return 1
      if evidence_compose exec -T bridge node /rollback-probes/database-health.mjs >/dev/null 2>&1; then
        failure_observed=false
      else
        failure_observed=true
      fi
      evidence_compose up -d --no-build --no-deps --wait --wait-timeout 60 postgres >/dev/null || return 1
      [[ $failure_observed == true ]] || return 1
      : >"$failure_marker"
      chmod 0600 "$failure_marker"
      return 42
    fi
  }

  rm -f -- "$failure_marker" "$lost_response_marker"
  evidence_compose up -d --force-recreate --no-build --no-deps --wait --wait-timeout 60 candidate >/dev/null
  verify_evidence_service candidate "$candidate_id"
  local initial_candidate_container
  initial_candidate_container=$(evidence_compose ps -q candidate)
  [[ -n $initial_candidate_container && $initial_candidate_container != *$'\n'* ]] || return 1
  local failure=0
  if execute_release_transition \
    "$candidate" "$bridge" "$candidate" "$candidate" \
    "$candidate_manifest" "$bridge_manifest" \
    "$candidate_manifest_sha" "$bridge_manifest_sha" \
    "$candidate_id" "$bridge_id" "$candidate_id" "$candidate_id"; then
    printf 'isolated rollback evidence unexpectedly committed the injected failure\n' >&2
    return 1
  else
    failure=$?
  fi
  [[ $failure == 42 && $CAUCE_RELEASE_TRANSACTION_OUTCOME == compensated ]] || {
    printf 'isolated rollback evidence did not complete shared compensation (failure=%s outcome=%s)\n' \
      "$failure" "$CAUCE_RELEASE_TRANSACTION_OUTCOME" >&2
    return 1
  }

  local failure_observed=false selector_restored=false candidate_restored=false services_restored=false
  local forward_response_lost=false
  local compose_recreated=false
  [[ -f $failure_marker && ! -L $failure_marker && $(stat -c '%a' -- "$failure_marker") == 600 ]] && failure_observed=true
  [[ -f $lost_response_marker && ! -L $lost_response_marker \
    && $(stat -c '%a' -- "$lost_response_marker") == 600 \
    && $CAUCE_RELEASE_TRANSACTION_FORWARD_RESPONSE_LOST == true ]] && forward_response_lost=true
  local selected_runtime selected_manifest selected_manifest_sha container_id running_id running_services
  selected_runtime=$(evidence_selector CAUCE_RUNTIME_IMAGE)
  selected_manifest=$(evidence_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST)
  selected_manifest_sha=$(evidence_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256)
  [[ $selected_runtime == "$candidate" && $selected_manifest == "$candidate_manifest" \
    && $selected_manifest_sha == "$candidate_manifest_sha" ]] && selector_restored=true
  container_id=$(evidence_compose ps -q candidate)
  running_id=$(docker inspect --format '{{.Image}}' "$container_id")
  [[ $running_id == "$candidate_id" ]] && candidate_restored=true
  [[ -n $container_id && $container_id != "$initial_candidate_container" ]] && compose_recreated=true
  running_services=$(evidence_compose ps --services --status running | LC_ALL=C sort)
  [[ $running_services == $'candidate\npostgres' ]] && services_restored=true
  verify_evidence_service candidate "$candidate_id"
  [[ $failure_observed == true && $forward_response_lost == true \
    && $selector_restored == true && $candidate_restored == true \
    && $compose_recreated == true && $services_restored == true ]] || {
    printf 'isolated rollback evidence compensation observations are incomplete\n' >&2
    return 1
  }
  printf '{"candidateImageRestored":%s,"composeRecreateObserved":%s,"failureInjection":"postgres-unavailable-after-selector-swap","failureObserved":%s,"lostForwardCasResponseRecovered":%s,"rollbackAction":"rollback-sh-shared-transaction","selectorCasRestored":%s,"servicesRestored":%s,"status":"passed","transitionLockScope":"selector-deploy-health-compensation"}\n' \
    "$candidate_restored" "$compose_recreated" "$failure_observed" "$forward_response_lost" "$selector_restored" "$services_restored"
}

if [[ $action == evidence-cycle ]]; then
  run_isolated_evidence_cycle
  exit $?
fi

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

# Production rollback executes with one closed control-plane environment.  The
# private env remains interpolation data for Compose; it cannot redirect the
# Docker daemon, select another project/profile set, or inject ambient values.
system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly system_path
PATH=$system_path
export PATH
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT NODE_OPTIONS

pin_helper="$ROOT/scripts/pin-production-release.py"
[[ -x $pin_helper ]] || { printf 'release rollback requires the production release pin helper\n' >&2; exit 2; }
writer_helper="$ROOT/scripts/release-writer-state.py"
[[ -x $writer_helper ]] || { printf 'release rollback requires the writer-state helper\n' >&2; exit 2; }

# One parent process owns the canonical release-pin flock for the complete
# transition.  The re-executed rollback and every nested field/check/swap call
# receive the same authenticated descriptor capability.  This serializes
# preflight, selector publication, Compose recreation, readiness and possible
# compensation against every other production pin operation without releasing
# the lock between phases.
if [[ -z ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-} ]]; then
  outer_env=(/usr/bin/env -i "PATH=$system_path" 'LC_ALL=C' 'PYTHONDONTWRITEBYTECODE=1'
    "CAUCE_ENV_FILE=$CAUCE_ENV_FILE" "CAUCE_ROLLBACK_CONFIRM=${CAUCE_ROLLBACK_CONFIRM:-}")
  exec "${outer_env[@]}" "$pin_helper" locked-exec --env-file "$CAUCE_ENV_FILE" -- "$0" "$action"
fi
[[ $CAUCE_RELEASE_TRANSITION_LOCK_FD =~ ^[0-9]+$ \
   && $CAUCE_RELEASE_TRANSITION_LOCK_FD -ge 3 \
   && ${CAUCE_RELEASE_TRANSITION_LOCK_TOKEN:-} =~ ^[a-f0-9]{64}$ ]] || {
  printf 'release rollback inherited an invalid production transition lock\n' >&2
  exit 2
}
transition_lock_fd=$CAUCE_RELEASE_TRANSITION_LOCK_FD
if [[ -z ${CAUCE_WRITER_REMOTE_GUARD_FD:-} ]]; then
  exec "$writer_helper" --ops-root "$ROOT" guarded-exec -- "$ROOT/scripts/rollback.sh" "$action"
fi

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
) || { printf 'release rollback refused: unsafe Docker/Compose controls\n' >&2; exit 2; }
trusted_home=$(getent passwd "$(id -u)" | cut -d: -f6)
trusted_user=$(id -un)
[[ $trusted_home = /* && -d $trusted_home && ! -L $trusted_home ]] || {
  printf 'release rollback requires a trusted invoking-account home\n' >&2
  exit 2
}
HOME=$trusted_home
USER=$trusted_user
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_CONFIG=$trusted_home/.docker
COMPOSE_PROJECT_NAME=cauce-v3-prod
COMPOSE_PROFILES=$compose_profiles
export HOME USER DOCKER_HOST DOCKER_CONFIG COMPOSE_PROJECT_NAME COMPOSE_PROFILES
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE \
  COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE \
  COMPOSE_IGNORE_ORPHANS COMPOSE_REMOVE_ORPHANS
canonical_selector() {
  "$pin_helper" field --env-file "$CAUCE_ENV_FILE" --name "$1" --lock-fd "$transition_lock_fd"
}
# Never source the secret-bearing environment and never accept caller-exported
# current/previous selectors. These eight values come only from the private
# canonical env; rollback targets come only from its authenticated baseline.
CAUCE_CURRENT_RUNTIME_IMAGE=$(canonical_selector CAUCE_RUNTIME_IMAGE)
CAUCE_CURRENT_CONSOLE_IMAGE=$(canonical_selector CAUCE_CONSOLE_IMAGE)
CAUCE_CURRENT_OVERRIDE_MANIFEST=$(canonical_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST)
CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256=$(canonical_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256)
CAUCE_CURRENT_ROLLBACK_BASELINE_FILE=$(canonical_selector CAUCE_ROLLBACK_BASELINE_FILE)
CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256=$(canonical_selector CAUCE_ROLLBACK_BASELINE_SHA256)
CAUCE_CURRENT_WRITER_SNAPSHOT_FILE=$(canonical_selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE)
CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256=$(canonical_selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256)
"$writer_helper" --ops-root "$ROOT" validate \
  --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
  --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" >/dev/null || {
  printf 'release rollback refused: selected writer recovery snapshot is invalid\n' >&2
  exit 1
}

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
baseline_manifest_sha256=$(baseline_field override-manifest-sha256)
baseline_bridge_evidence=$(baseline_field bridge-evidence)
baseline_bridge_evidence_sha256=$(baseline_field bridge-evidence-sha256)
[[ $baseline_forward_runtime == "$CAUCE_CURRENT_RUNTIME_IMAGE" ]] || {
  printf 'release rollback refused: baseline belongs to a different forward runtime\n' >&2
  exit 1
}

target_runtime=$CAUCE_CURRENT_RUNTIME_IMAGE
target_console=$CAUCE_CURRENT_CONSOLE_IMAGE
target_manifest=$CAUCE_CURRENT_OVERRIDE_MANIFEST
target_manifest_sha256=$CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256
case $action in
  runtime)
    target_runtime=$baseline_runtime
    target_manifest=$baseline_manifest
    target_manifest_sha256=$baseline_manifest_sha256
    ;;
  console)
    target_console=$baseline_console
    ;;
  release)
    target_runtime=$baseline_runtime
    target_console=$baseline_console
    target_manifest=$baseline_manifest
    target_manifest_sha256=$baseline_manifest_sha256
    ;;
esac

readonly BRIDGE_READ_ONLY_LABEL='io.cauce.rollback-bridge.read-only'
readonly BRIDGE_READ_ONLY_CAPABILITY='server-v2'
readonly SCHEMA_COMPATIBILITY_LABEL='io.cauce.schema.compatible-through'
readonly CONSOLE_JOURNAL_LABEL='io.cauce.console.publish-journal'
readonly CONSOLE_JOURNAL_CAPABILITY='multi-intent-v1'

expected_confirmation="release-selectors:${action}:${CAUCE_CURRENT_RUNTIME_IMAGE}|${CAUCE_CURRENT_CONSOLE_IMAGE}|${CAUCE_CURRENT_OVERRIDE_MANIFEST}|${CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256}|${CAUCE_CURRENT_ROLLBACK_BASELINE_FILE}|${CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256}|${CAUCE_CURRENT_WRITER_SNAPSHOT_FILE}|${CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256}->${target_runtime}|${target_console}|${target_manifest}|${target_manifest_sha256}|${CAUCE_CURRENT_ROLLBACK_BASELINE_FILE}|${CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256}|${CAUCE_CURRENT_WRITER_SNAPSHOT_FILE}|${CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256}"
[[ ${CAUCE_ROLLBACK_CONFIRM:-} == "$expected_confirmation" ]] || {
  printf 'set CAUCE_ROLLBACK_CONFIRM to the exact release-selectors action/current-to-target transition\n' >&2
  exit 2
}

# The env file is the sole production selector. Docker Compose normally gives
# caller-exported variables precedence over --env-file, so every operation
# explicitly removes every release/override control that could bypass the CAS.
canonical_env=(
  /usr/bin/env -i
  "PATH=$system_path"
  "HOME=$trusted_home"
  "USER=$trusted_user"
  'LC_ALL=C'
  'PYTHONDONTWRITEBYTECODE=1'
  'DOCKER_HOST=unix:///var/run/docker.sock'
  "DOCKER_CONFIG=$trusted_home/.docker"
  'COMPOSE_PROJECT_NAME=cauce-v3-prod'
  "COMPOSE_PROFILES=$compose_profiles"
  "CAUCE_RELEASE_TRANSITION_LOCK_FD=$CAUCE_RELEASE_TRANSITION_LOCK_FD"
  "CAUCE_RELEASE_TRANSITION_LOCK_TOKEN=$CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"
  "CAUCE_WRITER_REMOTE_GUARD_FD=$CAUCE_WRITER_REMOTE_GUARD_FD"
  "CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256=$CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256"
  "CAUCE_WRITER_REMOTE_GUARDS=$CAUCE_WRITER_REMOTE_GUARDS"
)
compose_prod() {
  local result
  validate_selected_release_files || return 1
  set +e
  "${canonical_env[@]}" CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/compose.sh" prod "$@"
  result=$?
  set -e
  validate_selected_release_files || return 1
  return "$result"
}
health_prod() {
  local result
  validate_selected_release_files || return 1
  set +e
  "${canonical_env[@]}" CAUCE_ENV_FILE="$CAUCE_ENV_FILE" "$ROOT/scripts/stack-health.sh" prod
  result=$?
  set -e
  validate_selected_release_files || return 1
  return "$result"
}
validate_selected_release_files() {
  local manifest manifest_sha snapshot snapshot_sha
  manifest=$(canonical_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST) || return 1
  manifest_sha=$(canonical_selector CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256) || return 1
  snapshot=$(canonical_selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE) || return 1
  snapshot_sha=$(canonical_selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256) || return 1
  "$pin_helper" manifest --env-file "$CAUCE_ENV_FILE" --path "$manifest" \
    --expected-sha256 "$manifest_sha" --require-selected \
    --lock-fd "$transition_lock_fd" >/dev/null || return 1
  "$writer_helper" --ops-root "$ROOT" validate --snapshot "$snapshot" \
    --expected-sha256 "$snapshot_sha" >/dev/null
}
pin_transition() {
  local operation=$1 expected_runtime=$2 next_runtime=$3 expected_console=$4 next_console=$5
  local expected_manifest=$6 next_manifest=$7 expected_manifest_sha=$8 next_manifest_sha=$9
  "$pin_helper" "$operation" \
    --env-file "$CAUCE_ENV_FILE" \
    --expected-runtime-image "$expected_runtime" \
    --target-runtime-image "$next_runtime" \
    --expected-console-image "$expected_console" \
    --target-console-image "$next_console" \
    --expected-override-manifest "$expected_manifest" \
    --target-override-manifest "$next_manifest" \
    --expected-override-manifest-sha256 "$expected_manifest_sha" \
    --target-override-manifest-sha256 "$next_manifest_sha" \
    --expected-rollback-baseline "$CAUCE_CURRENT_ROLLBACK_BASELINE_FILE" \
    --target-rollback-baseline "$CAUCE_CURRENT_ROLLBACK_BASELINE_FILE" \
    --expected-rollback-baseline-sha256 "$CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256" \
    --target-rollback-baseline-sha256 "$CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256" \
    --expected-writer-snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --target-writer-snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --expected-writer-snapshot-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" \
    --target-writer-snapshot-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" \
    --baseline-forward-release-commit "$baseline_forward_commit" \
    --baseline-forward-runtime-image "$baseline_forward_runtime" \
    --baseline-forward-runtime-source-digest "$baseline_forward_source_digest" \
    --lock-fd "$transition_lock_fd"
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

image_label() {
  local reference=$1 label=$2 value
  value=$(docker image inspect --format "{{ index .Config.Labels \"$label\" }}" "$reference") \
    || return 1
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || return 1
  printf '%s\n' "$value"
}

bridge_read_only_gate_active() {
  local container running_id response
  [[ $(image_label "$target_runtime" "$BRIDGE_READ_ONLY_LABEL") == \
      "$BRIDGE_READ_ONLY_CAPABILITY" ]] || return 1
  container=$(compose_prod ps -q gateway) || return 1
  [[ -n $container && $container != *$'\n'* ]] || return 1
  running_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
  [[ $running_id == "$target_runtime_id" ]] || return 1
  response=$(compose_prod exec -T gateway node --input-type=module - <<'NODE'
const response = await fetch('http://127.0.0.1:8081/v3/__rollback_bridge_read_only_probe__', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
let body;
try { body = await response.json(); } catch { body = null; }
if (response.status !== 503 || body?.error !== 'rollback_bridge_read_only') process.exit(1);
process.stdout.write('rollback-bridge-read-only-active');
NODE
  ) || return 1
  [[ $response == rollback-bridge-read-only-active ]]
}

# Validate the complete logical transition before inventorying or mutating a
# service. All current and target images must be registry-recoverable so the
# compensation path never depends on a daemon cache.
pin_transition check \
  "$CAUCE_CURRENT_RUNTIME_IMAGE" "$target_runtime" \
  "$CAUCE_CURRENT_CONSOLE_IMAGE" "$target_console" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST" "$target_manifest" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256" "$target_manifest_sha256" >/dev/null
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

if [[ $target_runtime != "$CAUCE_CURRENT_RUNTIME_IMAGE" ]]; then
  [[ $(image_label "$target_runtime" "$BRIDGE_READ_ONLY_LABEL") == \
      "$BRIDGE_READ_ONLY_CAPABILITY" ]] || {
    printf 'release rollback refused: target bridge lacks the exact server-side read-only capability\n' >&2
    exit 1
  }
fi
if [[ $action == console && $target_console != "$CAUCE_CURRENT_CONSOLE_IMAGE" ]]; then
  if [[ $(image_label "$target_console" "$CONSOLE_JOURNAL_LABEL") == \
      "$CONSOLE_JOURNAL_CAPABILITY" ]]; then
    :
  elif bridge_read_only_gate_active; then
    printf 'release rollback admitted a legacy console only because the active gateway proved the server-side read-only bridge gate\n' >&2
  else
    printf 'release rollback refused: target console lacks compatible multi-intent publish journal capability and no bridge read-only gate is selected\n' >&2
    exit 1
  fi
fi

# A schema-037 runtime rollback is permitted only to the tested bridge image.
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
  current_schema_label=$(image_label "$CAUCE_CURRENT_RUNTIME_IMAGE" "$SCHEMA_COMPATIBILITY_LABEL")
  if [[ $current_schema_label != "$current_schema" ]]; then
    printf 'release rollback refused: authenticated current image schema label differs from the database\n' >&2
    exit 1
  fi
  if [[ $current_schema != 037_console_publish_intent_indexes.sql ]]; then
    printf 'release rollback refused: rollback bridge evidence is valid only for exact schema 037\n' >&2
    exit 1
  fi
fi

writer_expected_candidate=$(python3 - "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" <<'PY'
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["writersExpectedCandidate"])
PY
)
"$writer_helper" --ops-root "$ROOT" marker-check \
  --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
  --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" \
  --path "${CAUCE_CURRENT_WRITER_SNAPSHOT_FILE}.state.json" \
  --release-id "$baseline_forward_commit" --mode candidate \
  --writers-expected "$writer_expected_candidate" \
  --writers-observed "$writer_expected_candidate" >/dev/null || {
  printf 'release rollback refused: current candidate marker is inconsistent\n' >&2
  exit 1
}

compose_model=$(compose_prod config --format json | "$writer_helper" --ops-root "$ROOT" \
  compose-model --runtime-image "$CAUCE_CURRENT_RUNTIME_IMAGE" \
  --console-image "$CAUCE_CURRENT_CONSOLE_IMAGE") || {
  printf 'release rollback refused: current Compose model is not canonical\n' >&2
  exit 1
}
runtime_services=()
writer_services=()
runtime_core_services=()
bridge_core_services=()
configured_long_lived=()
while IFS=$'\t' read -r role service _reference; do
  [[ $role == migrator ]] || configured_long_lived+=("$service")
  case $role in
    core)
      runtime_services+=("$service")
      runtime_core_services+=("$service")
      # The dispatcher is a database writer even though it belongs to the
      # central runtime plane.  A rollback bridge is server-side read-only, so
      # it may run the gateway and observability services but never dispatcher.
      [[ $service == dispatcher ]] || bridge_core_services+=("$service")
      ;;
    writer) runtime_services+=("$service"); writer_services+=("$service") ;;
    console) bridge_core_services+=("$service") ;;
  esac
done <<<"$compose_model"
normalize_services() {
  python3 -c '
import re, sys
items = [line.strip() for line in sys.stdin if line.strip()]
if len(items) != len(set(items)) or any(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", item) is None for item in items):
    raise SystemExit(1)
print("\n".join(sorted(items)))
'
}
expected_candidate_running=$(printf '%s\n' "${configured_long_lived[@]}" | LC_ALL=C sort)
expected_bridge_running=$expected_candidate_running
bridge_stopped_services=(dispatcher "${writer_services[@]}")
if ((${#bridge_stopped_services[@]})); then
  expected_bridge_running=$(printf '%s\n' "$expected_candidate_running" \
    | grep -Fvx -f <(printf '%s\n' "${bridge_stopped_services[@]}") | LC_ALL=C sort)
fi
case $action in
  runtime) candidate_services=("${runtime_services[@]}"); mandatory=(gateway dispatcher outbox-metrics) ;;
  console) candidate_services=(console); mandatory=(console) ;;
  release) candidate_services=("${runtime_services[@]}" console); mandatory=(gateway dispatcher outbox-metrics console) ;;
esac
running_output=$(compose_prod ps --services --status running) || {
  printf 'release rollback could not inventory running services\n' >&2
  exit 1
}
materialized_output=$(compose_prod ps --all --services) || {
  printf 'release rollback could not inventory materialized services\n' >&2
  exit 1
}
running_normalized=$(normalize_services <<<"$running_output") || exit 1
materialized_normalized=$(normalize_services <<<"$materialized_output") || exit 1
[[ $running_normalized == "$expected_candidate_running" \
   && $materialized_normalized == "$expected_candidate_running" ]] || {
  printf 'release rollback refused: running/materialized services differ from the exact candidate topology\n' >&2
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
candidate_selected=("${selected[@]}")
bridge_selected=("${bridge_core_services[@]}")

ingress_services=(console)
bridge_ingress_services=(console)
if [[ $action != console ]]; then
  # Close every user-facing ingress plus dispatcher before CAS.  Gateway and
  # console may reopen behind the read-only bridge; dispatcher must remain
  # stopped for the complete rollback_bridge_degraded interval.
  ingress_services=(gateway dispatcher console)
  bridge_ingress_services=(gateway console)
fi
expected_quiesced_running=$(
  { printf '%s\n' "$expected_candidate_running" \
      | grep -Fvx -f <(printf '%s\n' "${writer_services[@]}" "${ingress_services[@]}") \
      || true; } | LC_ALL=C sort
)

append_unique_service() {
  local service=$1 existing
  for existing in "${selected[@]}"; do
    [[ $existing != "$service" ]] || return 0
  done
  selected+=("$service")
}

writer_state_check() {
  local mode=$1 fleet
  fleet=$(compose_prod run --rm --no-deps -T migrator node deploy/fleet-snapshot.mjs) || return 1
  local -a args=(
    --ops-root "$ROOT" check --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE"
    --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" --mode "$mode" --fleet-stdin
  )
  local service
  for service in "${writer_services[@]}"; do args+=(--compose-writer "$service"); done
  printf '%s' "$fleet" | "$writer_helper" "${args[@]}" >/dev/null
}

inventory_is() {
  local expected=$1 materialization=${2:-retained} running materialized expected_materialized
  running=$(compose_prod ps --services --status running | normalize_services) || return 1
  materialized=$(compose_prod ps --all --services | normalize_services) || return 1
  expected_materialized=$expected_candidate_running
  [[ $materialization != absent ]] || expected_materialized=$expected_bridge_running
  [[ $running == "$expected" && $materialized == "$expected_materialized" ]]
}

compose_writers_stopped() {
  local service container state_line running pid extra
  for service in "${writer_services[@]}"; do
    container=$(compose_prod ps -q "$service") || return 1
    [[ -n $container && $container != *$'\n'* ]] || return 1
    state_line=$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$container") || return 1
    read -r running pid extra <<<"$state_line"
    [[ $running == false && $pid == 0 && -z ${extra:-} ]] || return 1
  done
}

wait_writer_state() {
  local mode=$1 expected=$2 materialization=${3:-retained} attempt
  for attempt in $(seq 1 20); do
    if writer_state_check "$mode" && inventory_is "$expected" "$materialization" \
       && { [[ $mode != stopped && $mode != fenced ]] \
            || { [[ $materialization == absent ]] && bridge_mutators_absent; } \
            || { [[ $materialization == retained ]] && compose_writers_stopped; }; }; then
      return 0
    fi
    sleep 2
  done
  return 1
}

write_release_marker() {
  local mode=$1 expected=$2 observed=$3
  "$writer_helper" --ops-root "$ROOT" marker \
    --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" \
    --path "${CAUCE_CURRENT_WRITER_SNAPSHOT_FILE}.state.json" \
    --release-id "$baseline_forward_commit" --mode "$mode" \
    --writers-expected "$expected" --writers-observed "$observed" >/dev/null || return 1
  "$writer_helper" --ops-root "$ROOT" marker-check \
    --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" \
    --path "${CAUCE_CURRENT_WRITER_SNAPSHOT_FILE}.state.json" \
    --release-id "$baseline_forward_commit" --mode "$mode" \
    --writers-expected "$expected" --writers-observed "$observed" >/dev/null
}

quiesce_writers() {
  local wanted_running=${1-$expected_bridge_running}
  writer_state_check restored || return 1
  if ((${#writer_services[@]})); then
    compose_prod stop --timeout 45 "${writer_services[@]}" || true
  fi
  "$writer_helper" --ops-root "$ROOT" fence \
    --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" >/dev/null || true
  wait_writer_state fenced "$wanted_running"
}

terminal_fence_preflight() {
  compose_prod run --rm --no-deps -T migrator node --input-type=module - <<'NODE'
import { createPool } from './packages/store/dist/db.js';
import { assertProductionPostgresTls } from './deploy/postgres-tls.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
await assertProductionPostgresTls();
const pool = createPool(connectionString, {
  max: 1, connectionTimeoutMillis: 2_000, applicationName: 'cauce-rollback-terminal-preflight',
});
const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='1000ms'");
  await client.query("SET LOCAL statement_timeout='3000ms'");
  const result = await client.query(`
    WITH expected_columns(name,type_name,not_null) AS (VALUES
      ('relay_claim_sha256','bytea',false),
      ('relay_claim_epoch','bigint',true),
      ('relay_claimed_at','timestamp with time zone',false),
      ('relay_claim_expires_at','timestamp with time zone',false),
      ('request_id','uuid',true),
      ('request_sha256','bytea',true),
      ('browser_owner_sha256','bytea',true),
      ('browser_owner_generation','bigint',true),
      ('relay_instance_id','text',false),
      ('relay_boot_id','uuid',false)
    ), checked_columns AS (
      SELECT count(attribute.attname)=10
             AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
             AND bool_and(attribute.attnotnull=expected.not_null) AS exact
        FROM expected_columns expected
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid='terminal_sessions'::regclass
         AND attribute.attname=expected.name AND NOT attribute.attisdropped
    ), checked_constraints AS (
      SELECT
        bool_or(constraint_record.conname='terminal_sessions_relay_claim_shape'
          AND position('relay_claim_epoch > 0' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0) AS claim_exact,
        bool_or(constraint_record.conname='terminal_sessions_browser_owner_shape'
          AND position('octet_length(request_sha256) = 32' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0
          AND position('browser_owner_generation > 0' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0) AS owner_exact,
        bool_or(constraint_record.conname='terminal_sessions_relay_instance_shape'
          AND position('relay_instance_id IS NULL' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0
          AND position('relay_instance_id ~ ' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0
          AND position('relay_boot_id IS NULL' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0
          AND position('relay_boot_id IS NOT NULL' in pg_get_expr(
            constraint_record.conbin,constraint_record.conrelid
          ))>0) AS instance_exact
        FROM pg_constraint constraint_record
       WHERE constraint_record.conrelid='terminal_sessions'::regclass
         AND constraint_record.contype='c' AND constraint_record.convalidated
    ), profile_expected_columns(table_name,position,name,type_name) AS (VALUES
      ('agent_profile_runtime_expectations',1,'tenant_id','text'),
      ('agent_profile_runtime_expectations',2,'alias','text'),
      ('agent_profile_runtime_expectations',3,'revision','bigint'),
      ('agent_profile_runtime_expectations',4,'generation','text'),
      ('agent_profile_runtime_expectations',5,'documents','jsonb'),
      ('agent_profile_runtime_expectations',6,'recorded_at','timestamp with time zone'),
      ('agent_profile_runtime_expectations',7,'updated_at','timestamp with time zone'),
      ('agent_profile_runtime_adoptions',1,'tenant_id','text'),
      ('agent_profile_runtime_adoptions',2,'alias','text'),
      ('agent_profile_runtime_adoptions',3,'revision','bigint'),
      ('agent_profile_runtime_adoptions',4,'generation','text'),
      ('agent_profile_runtime_adoptions',5,'documents','jsonb'),
      ('agent_profile_runtime_adoptions',6,'delivery_id','uuid'),
      ('agent_profile_runtime_adoptions',7,'attempt','integer'),
      ('agent_profile_runtime_adoptions',8,'instance_id','text'),
      ('agent_profile_runtime_adoptions',9,'epoch','bigint'),
      ('agent_profile_runtime_adoptions',10,'adopted_at','timestamp with time zone')
    ), profile_checked_columns AS (
      SELECT count(attribute.attname)=17
             AND bool_and(attribute.attnum=expected.position)
             AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
             AND bool_and(attribute.attnotnull)
             AND (SELECT count(*)=17 FROM pg_attribute actual
               WHERE actual.attrelid IN (
                 'agent_profile_runtime_expectations'::regclass,
                 'agent_profile_runtime_adoptions'::regclass
               ) AND actual.attnum>0 AND NOT actual.attisdropped) AS exact
        FROM profile_expected_columns expected
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid=('public.'||expected.table_name)::regclass
         AND attribute.attname=expected.name AND NOT attribute.attisdropped
    ), profile_checked_constraints AS (
      SELECT count(*)=15
             AND bool_and(constraint_record.convalidated)
             AND bool_and(NOT constraint_record.condeferrable)
             AND bool_or(constraint_record.conname='agent_profile_runtime_expectations_documents_valid'
               AND pg_get_constraintdef(constraint_record.oid,true)=
                 'CHECK (cauce_profile_runtime_documents_valid(documents))')
             AND bool_or(constraint_record.conname='agent_profile_runtime_adoptions_documents_valid'
               AND pg_get_constraintdef(constraint_record.oid,true)=
                 'CHECK (cauce_profile_runtime_documents_valid(documents))')
             AND bool_or(constraint_record.conname='agent_profile_runtime_adoptions_delivery_id_key'
               AND pg_get_constraintdef(constraint_record.oid,true)='UNIQUE (delivery_id)')
             AND bool_or(constraint_record.conname='agent_profile_runtime_adoptions_delivery_id_fkey'
               AND pg_get_constraintdef(constraint_record.oid,true)=
                 'FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE RESTRICT') AS exact
        FROM pg_constraint constraint_record
       WHERE constraint_record.conrelid IN (
         'agent_profile_runtime_expectations'::regclass,
         'agent_profile_runtime_adoptions'::regclass
       )
    ), profile_checked_functions AS (
      SELECT count(*)=2
             AND bool_or(procedure.proname='cauce_profile_runtime_documents_valid'
               AND pg_get_function_identity_arguments(procedure.oid)='candidate jsonb'
               AND procedure.prorettype='boolean'::regtype AND procedure.provolatile='i'
               AND procedure.proparallel='s'
               AND position('jsonb_object_keys' in pg_get_functiondef(procedure.oid))>0
               AND position('^[a-f0-9]{64}$' in pg_get_functiondef(procedure.oid))>0)
             AND bool_or(procedure.proname='cauce_profile_runtime_adoption_matches_expectation'
               AND procedure.prorettype='trigger'::regtype
               AND position('expectation.documents = new.documents'
                 in lower(pg_get_functiondef(procedure.oid)))>0) AS exact
        FROM pg_proc procedure
       WHERE procedure.pronamespace='public'::regnamespace
         AND procedure.proname IN (
           'cauce_profile_runtime_documents_valid',
           'cauce_profile_runtime_adoption_matches_expectation'
         )
    ), profile_checked_trigger AS (
      SELECT count(*)=1 AND bool_and(NOT trigger_record.tgisinternal)
             AND bool_and(trigger_record.tgenabled='O')
             AND bool_and(position('BEFORE INSERT OR UPDATE'
               in pg_get_triggerdef(trigger_record.oid))>0)
             AND bool_and(position(
               'EXECUTE FUNCTION cauce_profile_runtime_adoption_matches_expectation()'
               in pg_get_triggerdef(trigger_record.oid))>0) AS exact
        FROM pg_trigger trigger_record
       WHERE trigger_record.tgrelid='agent_profile_runtime_adoptions'::regclass
         AND trigger_record.tgname='agent_profile_runtime_adoptions_expectation_guard'
    ), shadow_expected_column(position,name,type_name,not_null,default_expression) AS (VALUES
      (18,'claim_target_started','boolean',true,'false'::text)
    ), shadow_checked_column AS (
      SELECT count(attribute.attname)=1
             AND bool_and(attribute.attnum=expected.position)
             AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
             AND bool_and(attribute.attnotnull=expected.not_null)
             AND bool_and(attribute.attidentity='' AND attribute.attgenerated='')
             AND bool_and(pg_get_expr(definition.adbin,definition.adrelid)
               IS NOT DISTINCT FROM expected.default_expression)
             AND (SELECT count(*)=18 FROM pg_attribute actual
               WHERE actual.attrelid='shadow_router_inbox'::regclass
                 AND actual.attnum>0 AND NOT actual.attisdropped) AS exact
        FROM shadow_expected_column expected
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid='shadow_router_inbox'::regclass
         AND attribute.attname=expected.name AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef definition
          ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
    ), shadow_checked_constraint AS (
      SELECT count(*)=1 AND bool_and(constraint_record.convalidated)
             AND bool_and(NOT constraint_record.connoinherit)
             AND bool_and(encode(digest(convert_to(
               pg_get_constraintdef(constraint_record.oid,true),'UTF8'
             ),'sha256'),'hex')=
               '3744b38b5e27f0def89f983afce9987b6bfb225a120dbec432fdb426008a262c') AS exact
        FROM pg_constraint constraint_record
       WHERE constraint_record.conrelid='shadow_router_inbox'::regclass
         AND constraint_record.conname='shadow_router_inbox_claim_phase_shape'
         AND constraint_record.contype='c'
    ), shadow_expected_functions(name,body_sha256) AS (VALUES
      ('cauce_shadow_router_claim_phase_transition',
       '7c24fde424d76277733cb0403399378cc88942a186fff9754afa3355fc11f54c'),
      ('cauce_shadow_router_mapping_status_monotonic',
       'ce8ca46fd783f4d05d00ce59fad7d08c2ebf26bfd8c47c38b3082b4164dc84fa'),
      ('cauce_shadow_router_mapping_terminal_reconcile',
       '12c9f73d21b93bdf6f283b156c35590ccd082183f69833d3b245123166ae7eb5')
    ), shadow_checked_functions AS (
      SELECT count(procedure.oid)=3
             AND bool_and(procedure.prorettype='trigger'::regtype)
             AND bool_and(procedure.provolatile='v' AND procedure.proparallel='u')
             AND bool_and(NOT procedure.prosecdef AND NOT procedure.proleakproof)
             AND bool_and(NOT procedure.proisstrict AND NOT procedure.proretset)
             AND bool_and(procedure.prokind='f' AND procedure.pronargdefaults=0)
             AND bool_and(procedure.proconfig IS NULL AND language_record.lanname='plpgsql')
             AND bool_and(pg_get_function_identity_arguments(procedure.oid)='')
             AND bool_and(encode(digest(convert_to(procedure.prosrc,'UTF8'),'sha256'),'hex')
               =expected.body_sha256) AS exact
        FROM shadow_expected_functions expected
        LEFT JOIN pg_proc procedure
          ON procedure.pronamespace='public'::regnamespace AND procedure.proname=expected.name
        LEFT JOIN pg_language language_record ON language_record.oid=procedure.prolang
    ), shadow_expected_triggers(table_name,name,definition) AS (VALUES
      ('shadow_router_inbox','shadow_router_inbox_claim_phase_transition',
       'CREATE TRIGGER shadow_router_inbox_claim_phase_transition BEFORE UPDATE ON shadow_router_inbox FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_claim_phase_transition()'),
      ('shadow_router_mappings','shadow_router_mapping_status_monotonic',
       'CREATE TRIGGER shadow_router_mapping_status_monotonic BEFORE UPDATE OF status ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_status_monotonic()'),
      ('shadow_router_mappings','shadow_router_mapping_terminal_reconcile',
       'CREATE TRIGGER shadow_router_mapping_terminal_reconcile AFTER INSERT OR UPDATE ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_terminal_reconcile()')
    ), shadow_checked_triggers AS (
      SELECT count(trigger_record.oid)=3 AND bool_and(trigger_record.tgenabled='O')
             AND bool_and(NOT trigger_record.tgisinternal)
             AND bool_and(pg_get_triggerdef(trigger_record.oid,true)=expected.definition) AS exact
        FROM shadow_expected_triggers expected
        LEFT JOIN pg_trigger trigger_record
          ON trigger_record.tgrelid=('public.'||expected.table_name)::regclass
         AND trigger_record.tgname=expected.name
    ), journal_expected_indexes(name,definition) AS (VALUES
      ('audit_events_console_publish_head_037_idx',
       'CREATE INDEX audit_events_console_publish_head_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> ''operator_scope_hash''::text)), ((metadata ->> ''conversation_hash''::text)), id DESC) WHERE (action = ''console.publish.head''::text)'),
      ('audit_events_console_publish_key_037_idx',
       'CREATE INDEX audit_events_console_publish_key_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> ''idempotency_key''::text)), id) WHERE (action = ANY (ARRAY[''console.publish.prepare''::text, ''console.publish.confirm''::text, ''console.publish.expire''::text]))'),
      ('audit_events_console_publish_nonce_037_idx',
       'CREATE INDEX audit_events_console_publish_nonce_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> ''operator_scope_hash''::text)), ((metadata ->> ''intent_nonce_hash''::text)), id DESC) WHERE (action = ''console.publish.prepare''::text)'),
      ('audit_events_console_publish_rate_037_idx',
       'CREATE INDEX audit_events_console_publish_rate_037_idx ON public.audit_events USING btree (tenant_id, actor_alias, ((metadata ->> ''operator_scope_hash''::text)), created_at DESC, id DESC) WHERE (action = ''console.publish.prepare''::text)')
    ), journal_checked_indexes AS (
      SELECT count(index_record.indexrelid)=4
             AND bool_and(index_record.indisvalid AND index_record.indisready)
             AND bool_and(NOT index_record.indisunique AND NOT index_record.indisexclusion)
             AND bool_and(access_method.amname='btree')
             AND bool_and(pg_get_indexdef(index_record.indexrelid)=expected.definition)
             AND (SELECT count(*)=4
                    FROM pg_class candidate
                    JOIN pg_namespace namespace_record
                      ON namespace_record.oid=candidate.relnamespace
                   WHERE namespace_record.nspname='public'
                     AND candidate.relname LIKE 'audit_events_console_publish%037_idx') AS exact
        FROM journal_expected_indexes expected
        LEFT JOIN pg_class index_class ON index_class.relname=expected.name
          AND index_class.relnamespace='public'::regnamespace
        LEFT JOIN pg_index index_record ON index_record.indexrelid=index_class.oid
          AND index_record.indrelid='audit_events'::regclass
        LEFT JOIN pg_am access_method ON access_method.oid=index_class.relam
    )
    SELECT
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='032_terminal_session_claim_fencing.sql') AS schema_032,
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='033_terminal_browser_owner_fencing.sql') AS schema_033,
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='034_terminal_relay_instance_fencing.sql') AS schema_034,
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='035_agent_profile_runtime_adoption.sql') AS schema_035,
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='036_shadow_router_target_phase.sql') AS schema_036,
      EXISTS (SELECT 1 FROM schema_migrations
        WHERE version='037_console_publish_intent_indexes.sql') AS schema_037,
      coalesce((SELECT exact FROM checked_columns),false) AS columns_exact,
      coalesce((SELECT claim_exact FROM checked_constraints),false) AS claim_constraint_exact,
      coalesce((SELECT owner_exact FROM checked_constraints),false) AS owner_constraint_exact,
      coalesce((SELECT instance_exact FROM checked_constraints),false) AS instance_constraint_exact,
      coalesce((SELECT exact FROM profile_checked_columns),false) AS profile_columns_exact,
      coalesce((SELECT exact FROM profile_checked_constraints),false) AS profile_constraints_exact,
      coalesce((SELECT exact FROM profile_checked_functions),false) AS profile_functions_exact,
      coalesce((SELECT exact FROM profile_checked_trigger),false) AS profile_trigger_exact,
      coalesce((SELECT exact FROM shadow_checked_column),false) AS shadow_column_exact,
      coalesce((SELECT exact FROM shadow_checked_constraint),false) AS shadow_constraint_exact,
      coalesce((SELECT exact FROM shadow_checked_functions),false) AS shadow_functions_exact,
      coalesce((SELECT exact FROM shadow_checked_triggers),false) AS shadow_triggers_exact,
      coalesce((SELECT exact FROM journal_checked_indexes),false) AS journal_indexes_exact,
      EXISTS (
        SELECT 1 FROM pg_index index_record
        JOIN pg_class index_class ON index_class.oid=index_record.indexrelid
        JOIN pg_attribute request_attribute
          ON request_attribute.attrelid=index_record.indrelid
         AND request_attribute.attname='request_id' AND NOT request_attribute.attisdropped
       WHERE index_record.indrelid='terminal_sessions'::regclass
         AND index_class.relname='terminal_sessions_request_id_idx'
         AND index_record.indisunique AND index_record.indisvalid AND index_record.indisready
         AND index_record.indpred IS NULL AND index_record.indexprs IS NULL
         AND index_record.indnkeyatts=1 AND index_record.indnatts=1
         AND index_record.indkey[0]=request_attribute.attnum
      ) AS request_unique_exact,
      (has_table_privilege(current_user,'terminal_sessions','SELECT')
        AND has_table_privilege(current_user,'terminal_sessions','UPDATE')) AS privileges_exact,
      (has_table_privilege(current_user,'schema_migrations','SELECT')
        AND has_table_privilege(current_user,'agent_profile_runtime_expectations','SELECT')
        AND has_table_privilege(current_user,'agent_profile_runtime_expectations','INSERT')
        AND has_table_privilege(current_user,'agent_profile_runtime_expectations','UPDATE')
        AND has_table_privilege(current_user,'agent_profile_runtime_adoptions','SELECT')
        AND has_table_privilege(current_user,'agent_profile_runtime_adoptions','INSERT')
        AND has_table_privilege(current_user,'agent_profiles','SELECT')
        AND has_table_privilege(current_user,'agent_profiles','UPDATE')
        AND has_table_privilege(current_user,'deliveries','SELECT')
        AND has_table_privilege(current_user,'audit_events','SELECT')
        AND has_table_privilege(current_user,'audit_events','INSERT')
        AND coalesce(has_sequence_privilege(
          current_user,pg_get_serial_sequence('audit_events','id'),'USAGE'
        ),false)
        AND has_function_privilege(
          current_user,'cauce_profile_runtime_documents_valid(jsonb)','EXECUTE'
        )
        AND has_function_privilege(
          current_user,'cauce_profile_runtime_adoption_matches_expectation()','EXECUTE'
        )) AS profile_privileges_exact,
      (cauce_profile_runtime_documents_valid(
        '[{"name":"AGENTS.md","path":"/profiles/AGENTS.md","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb
       ) AND NOT cauce_profile_runtime_documents_valid('[]'::jsonb)) AS profile_behavior_exact,
      (has_table_privilege(current_user,'shadow_router_inbox','SELECT')
        AND has_table_privilege(current_user,'shadow_router_inbox','INSERT')
        AND has_table_privilege(current_user,'shadow_router_inbox','UPDATE')
        AND has_table_privilege(current_user,'shadow_router_mappings','SELECT')
        AND has_table_privilege(current_user,'shadow_router_mappings','INSERT')
        AND has_table_privilege(current_user,'shadow_router_mappings','UPDATE')
        AND has_function_privilege(
          current_user,'cauce_shadow_router_claim_phase_transition()','EXECUTE'
        )
        AND has_function_privilege(
          current_user,'cauce_shadow_router_mapping_status_monotonic()','EXECUTE'
        )
        AND has_function_privilege(
          current_user,'cauce_shadow_router_mapping_terminal_reconcile()','EXECUTE'
        )) AS shadow_privileges_exact,
      (SELECT count(*)::text FROM shadow_router_inbox
        WHERE status='processing') AS shadow_processing_count,
      (SELECT count(*)::text FROM terminal_sessions
        WHERE closed_at IS NULL AND revoked_at IS NULL) AS open_count
  `);
  const row = result.rows[0];
  if (row?.schema_032 !== true || row.schema_033 !== true || row.schema_034 !== true
      || row.schema_035 !== true || row.schema_036 !== true || row.schema_037 !== true
      || row.columns_exact !== true
      || row.claim_constraint_exact !== true || row.owner_constraint_exact !== true
      || row.instance_constraint_exact !== true
      || row.profile_columns_exact !== true || row.profile_constraints_exact !== true
      || row.profile_functions_exact !== true || row.profile_trigger_exact !== true
      || row.shadow_column_exact !== true || row.shadow_constraint_exact !== true
      || row.shadow_functions_exact !== true || row.shadow_triggers_exact !== true
      || row.journal_indexes_exact !== true
      || row.request_unique_exact !== true || row.privileges_exact !== true
      || row.profile_privileges_exact !== true || row.profile_behavior_exact !== true
      || row.shadow_privileges_exact !== true || row.shadow_processing_count !== '0'
      || row.open_count !== '0') {
    throw new Error('terminal fencing preflight is not exact and fully drained');
  }
  await client.query('SET LOCAL enable_seqscan=off');
  await client.query("SET LOCAL plan_cache_mode='force_generic_plan'");
  const journalPlans = [
    {
      name: 'console_key_037', types: 'text,text,text',
      sql: `SELECT action,metadata FROM audit_events
             WHERE tenant_id=$1 AND actor_alias=$2
               AND metadata->>'idempotency_key'=$3
               AND action IN (
                 'console.publish.prepare','console.publish.confirm','console.publish.expire'
               ) ORDER BY id LIMIT 4`,
      parameters: "'Steven','kant','console:rollback-preflight'",
      index: 'audit_events_console_publish_key_037_idx',
    },
    {
      name: 'console_nonce_037', types: 'text,text,text,text',
      sql: `SELECT metadata FROM audit_events
             WHERE tenant_id=$1 AND actor_alias=$2
               AND action='console.publish.prepare'
               AND metadata->>'operator_scope_hash'=$3
               AND metadata->>'intent_nonce_hash'=$4
             ORDER BY id DESC LIMIT 2`,
      parameters: `'Steven','kant','${'a'.repeat(64)}','${'b'.repeat(64)}'`,
      index: 'audit_events_console_publish_nonce_037_idx',
    },
    {
      name: 'console_rate_037', types: 'text,text,text,integer,integer',
      sql: `WITH recent AS MATERIALIZED (
              SELECT created_at FROM audit_events
               WHERE tenant_id=$1 AND actor_alias=$2
                 AND action='console.publish.prepare'
                 AND metadata->>'operator_scope_hash'=$3
                 AND created_at>now()-interval '24 hours'
               ORDER BY created_at DESC,id DESC LIMIT $5
            ) SELECT created_at FROM recent
               WHERE created_at>now()-interval '10 minutes' OFFSET $4 LIMIT 1`,
      parameters: `'Steven','kant','${'a'.repeat(64)}',119,2000`,
      index: 'audit_events_console_publish_rate_037_idx',
    },
    {
      name: 'console_head_037', types: 'text,text,text,text',
      sql: `SELECT metadata FROM audit_events
             WHERE tenant_id=$1 AND actor_alias=$2
               AND action='console.publish.head'
               AND metadata->>'operator_scope_hash'=$3
               AND metadata->>'conversation_hash'=$4
             ORDER BY id DESC LIMIT 2`,
      parameters: `'Steven','kant','${'a'.repeat(64)}','${'c'.repeat(64)}'`,
      index: 'audit_events_console_publish_head_037_idx',
    },
  ];
  for (const probe of journalPlans) {
    await client.query(`PREPARE ${probe.name}(${probe.types}) AS ${probe.sql}`);
    const plan = await client.query(`EXPLAIN (COSTS OFF) EXECUTE ${probe.name}(${probe.parameters})`);
    const rendered = plan.rows.map((planRow) => planRow['QUERY PLAN']).join('\n');
    if (!rendered.includes(probe.index)) {
      throw new Error('console publish journal preflight is not index-backed');
    }
  }
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
NODE
}

ingress_is_stopped() {
  local service container state_line running pid extra
  for service in "${ingress_services[@]}"; do
    container=$(compose_prod ps -q "$service") || return 1
    [[ $container != *$'\n'* ]] || return 1
    if [[ -z $container ]]; then
      [[ $service == dispatcher ]] || return 1
      continue
    fi
    state_line=$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$container") \
      || return 1
    read -r running pid extra <<<"$state_line"
    [[ $running == false && $pid == 0 && -z ${extra:-} ]] || return 1
  done
}

bridge_mutators_absent() {
  local service container
  for service in dispatcher "${writer_services[@]}"; do
    container=$(compose_prod ps -q "$service") || return 1
    [[ -z $container ]] || return 1
  done
}

remove_bridge_mutators() {
  local -a mutators=(dispatcher "${writer_services[@]}")
  compose_prod stop --timeout 45 "${mutators[@]}" || true
  compose_prod rm -f "${mutators[@]}" || return 1
  bridge_mutators_absent
}

quiesce_external_ingress() {
  compose_prod stop --timeout 45 "${ingress_services[@]}" || true
  ingress_is_stopped || return 1
  printf 'release rollback mutation gate CLOSED: console, gateway and dispatcher are stopped before CAS\n' >&2
}

transition_assert_quiesced() {
  ingress_is_stopped
}

transition_quiesce_for_compensation() {
  quiesce_external_ingress
}

restore_candidate_mode() {
  local -a restore_services=("${ingress_services[@]}")
  if ((${#writer_services[@]})); then
    restore_services+=("${writer_services[@]}")
  fi
  compose_prod up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${restore_services[@]}" || return 1
  "$writer_helper" --ops-root "$ROOT" restore \
    --snapshot "$CAUCE_CURRENT_WRITER_SNAPSHOT_FILE" \
    --expected-sha256 "$CAUCE_CURRENT_WRITER_SNAPSHOT_SHA256" >/dev/null || true
  wait_writer_state restored "$expected_candidate_running"
}

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
  local runtime_id=$1 console_id=$2 selected_runtime metrics ingress_service
  local -a selected_ingress_services
  selected_runtime=$(canonical_selector CAUCE_RUNTIME_IMAGE) || return 1
  if [[ $action != console && $selected_runtime == "$target_runtime" ]]; then
    selected=("${bridge_selected[@]}")
    selected_ingress_services=("${bridge_ingress_services[@]}")
    write_release_marker rollback_bridge_degraded 0 0 || return 1
    remove_bridge_mutators || return 1
  else
    selected=("${candidate_selected[@]}")
    selected_ingress_services=("${ingress_services[@]}")
    if [[ $action != console ]]; then
      write_release_marker candidate "$writer_expected_candidate" \
        "$writer_expected_candidate" || return 1
    fi
  fi
  for ingress_service in "${selected_ingress_services[@]}"; do
    append_unique_service "$ingress_service"
  done
  compose_prod up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${selected[@]}" || return 1
  if [[ $action != console && $selected_runtime == "$CAUCE_CURRENT_RUNTIME_IMAGE" ]]; then
    restore_candidate_mode || return 1
    write_release_marker candidate "$writer_expected_candidate" \
      "$writer_expected_candidate" || return 1
    compose_prod up -d --force-recreate --no-build --no-deps \
      --wait --wait-timeout 180 outbox-metrics || return 1
  elif [[ $action != console ]]; then
    wait_writer_state fenced "$expected_bridge_running" absent || return 1
    bridge_mutators_absent || return 1
  fi
  verify_selected "$runtime_id" "$console_id" || return 1
  if [[ $action == console || $selected_runtime == "$CAUCE_CURRENT_RUNTIME_IMAGE" ]]; then
    health_prod || return 1
  else
    compose_prod exec -T gateway node deploy/readiness-probe.mjs \
      http://127.0.0.1:8081/health/ready ready >/dev/null || return 1
    compose_prod exec -T outbox-metrics node deploy/readiness-probe.mjs \
      http://127.0.0.1:8084/health/ready ready >/dev/null || return 1
    compose_prod exec -T console sh -c \
      'test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/' \
      >/dev/null || return 1
    metrics=$(compose_prod exec -T outbox-metrics node -e \
      "fetch('http://127.0.0.1:8084/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))") \
      || return 1
    grep -Eq '^cauce_release_rollback_bridge_degraded(?:\{[^}]*\})? 1$' \
      <<<"$metrics" || return 1
    grep -Eq '^cauce_release_writers_declared(?:\{[^}]*\})? 0$' <<<"$metrics" || return 1
    grep -Eq '^cauce_release_writer_leases_active(?:\{[^}]*\})? 0$' <<<"$metrics" || return 1
  fi
}

# Runtime, console, override manifest path/hash and authenticated rollback
# baseline pointer/hash move in one durable replace. The shared transaction keeps the
# parent flock through recreation/readiness and through the inverse swap plus
# service recovery when target verification fails.
if ! quiesce_external_ingress; then
  printf 'release rollback refused: external ingress could not be proven stopped; restoring exact candidate mode\n' >&2
  if ! restore_candidate_mode; then
    printf 'CRITICAL: partial ingress stop could not be restored exactly\n' >&2
    exit 74
  fi
  printf 'release rollback failed safely before CAS: candidate ingress and writers were restored\n' >&2
  exit 1
fi
if [[ $action != console ]]; then
  if ! quiesce_writers "$expected_quiesced_running"; then
    printf 'release rollback refused: global writers could not be proven stopped; restoring exact candidate mode\n' >&2
    if ! restore_candidate_mode; then
      printf 'CRITICAL: partial rollback writer stop could not be restored exactly\n' >&2
      exit 74
    fi
    printf 'release rollback failed safely before CAS: candidate ingress and writers were restored\n' >&2
    exit 1
  fi
fi
if [[ $action != console ]]; then
  if ! terminal_fence_preflight; then
    printf 'release rollback refused: schema-037 terminal/profile/shadow/publish-journal contracts are not exact or durable work remains; restoring exact candidate writer state\n' >&2
    if ! restore_candidate_mode; then
      printf 'CRITICAL: terminal preflight failed and the quiesced candidate writers could not be restored exactly\n' >&2
      exit 74
    fi
    printf 'release rollback failed safely before CAS: terminal fences were not fully drained\n' >&2
    exit 1
  fi
fi
if execute_release_transition \
  "$CAUCE_CURRENT_RUNTIME_IMAGE" "$target_runtime" \
  "$CAUCE_CURRENT_CONSOLE_IMAGE" "$target_console" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST" "$target_manifest" \
  "$CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256" "$target_manifest_sha256" \
  "$current_runtime_id" "$target_runtime_id" "$current_console_id" "$target_console_id"; then
  printf '%s rollback completed for %s running service(s); all durable release selectors were updated\n' \
    "$action" "${#selected[@]}"
  exit 0
else
  failure=$?
fi
if [[ $CAUCE_RELEASE_TRANSACTION_OUTCOME == selector-swap-failed ]]; then
  if ! restore_candidate_mode; then
    printf 'CRITICAL: selector CAS failed and the quiesced candidate writers could not be restored\n' >&2
    exit 74
  fi
fi
case $CAUCE_RELEASE_TRANSACTION_OUTCOME in
  compensated)
    printf 'release rollback failed safely: prior durable release selectors and running services were restored\n' >&2
    ;;
  compensation-selector-failed)
    printf 'release rollback compensation failed before service recovery; production env requires operator recovery\n' >&2
    ;;
  compensation-quiesce-failed)
    printf 'release rollback compensation left target selectors selected and ingress fail-closed; production requires operator recovery\n' >&2
    ;;
  compensation-deploy-failed)
    printf 'release rollback compensation restored configuration but could not restore every prior service\n' >&2
    ;;
  *)
    printf 'release rollback failed before a verified target release was established\n' >&2
    ;;
esac
exit "$failure"
