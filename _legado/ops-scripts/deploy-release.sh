#!/bin/bash
# Canonical forward release transaction for Cauce V3 production.
#
# This driver deliberately owns the whole transition under the authenticated
# pin-production-release lock: old-state admission, eight-selector CAS, one-shot
# migrator, exact Compose recreation, health/final evidence and compensation.
# It never sources the secret-bearing env and never performs alias cutover.
set -euo pipefail

# Resolve every host-side executable from a fixed system path before reading any
# caller-controlled input. The private Compose env is data, never executable or
# Docker/Compose control-plane authority.
system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly system_path
PATH=$system_path
export PATH
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT NODE_OPTIONS

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-help}
shift || true

maintenance=0
if (($#)); then
  [[ $# == 1 && $1 == --maintenance-offline-zeus \
     && $action =~ ^(preflight|dry-run|deploy|bootstrap-production-legacy)$ ]] || {
    printf 'usage: %s preflight|dry-run|deploy|bootstrap-production-legacy [--maintenance-offline-zeus] | rotate-writer-snapshot | prod-up | prod-down | migrate\n' "$0" >&2
    exit 2
  }
  maintenance=1
fi
case $action in
  preflight|dry-run) action=preflight ;;
  deploy|bootstrap-production-legacy|rotate-writer-snapshot|prod-up|prod-down|migrate) ;;
  help|-h|--help)
    printf 'usage: %s preflight|dry-run|deploy|bootstrap-production-legacy [--maintenance-offline-zeus] | rotate-writer-snapshot | prod-up | prod-down | migrate\n' "$0"
    exit 0
    ;;
  *)
    printf 'usage: %s preflight|dry-run|deploy|bootstrap-production-legacy [--maintenance-offline-zeus] | rotate-writer-snapshot | prod-up | prod-down | migrate\n' "$0" >&2
    exit 2
    ;;
esac

: "${CAUCE_ENV_FILE:?set the absolute private production env file}"
if [[ $action == preflight || $action == deploy ]]; then
  : "${CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST:?set the absolute target override manifest}"
  : "${CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256:?set the target override manifest SHA-256}"
  : "${CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE:?set the absolute target rollback baseline}"
  : "${CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256:?set the target rollback baseline SHA-256}"
  : "${CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE:?set the absolute target writer snapshot}"
  : "${CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256:?set the target writer snapshot SHA-256}"
fi
if [[ $action == bootstrap-production-legacy ]]; then
  : "${CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256:?set the authenticated two-selector env SHA-256}"
  : "${CAUCE_BOOTSTRAP_RUNTIME_IMAGE:?set the normalized legacy runtime RepoDigest}"
  : "${CAUCE_BOOTSTRAP_CONSOLE_IMAGE:?set the normalized legacy console RepoDigest}"
  : "${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST:?set the initial authenticated override manifest}"
  : "${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256:?set the initial override manifest SHA-256}"
  : "${CAUCE_BOOTSTRAP_LEGACY_FLEET_SNAPSHOT_FILE:?set the durable legacy fleet snapshot path}"
  : "${CAUCE_BOOTSTRAP_ROLLBACK_BASELINE:?set the durable legacy baseline path}"
  : "${CAUCE_BOOTSTRAP_BACKUP_ENV_FILE:?set the create-only legacy env backup path}"
  : "${CAUCE_BOOTSTRAP_FORWARD_RELEASE_ID:?set the non-secret legacy release ID}"
  : "${CAUCE_RELEASE_WRITER_SNAPSHOT_FILE:?set the durable writer snapshot path}"
fi
if ((maintenance == 1)); then
  : "${CAUCE_CHANGE_ID:?set the non-secret maintenance change ID}"
  : "${CAUCE_MAINTENANCE_CONFIRM:?set the exact Zeus maintenance confirmation}"
  [[ $CAUCE_CHANGE_ID =~ ^[A-Za-z0-9._-]+$ \
     && $CAUCE_MAINTENANCE_CONFIRM == "offline:Steven:zeus:$CAUCE_CHANGE_ID" ]] || {
    printf 'release deploy refused: Zeus maintenance authority is invalid\n' >&2
    exit 2
  }
fi
if [[ $action == rotate-writer-snapshot ]]; then
  : "${CAUCE_CHANGE_ID:?set the non-secret writer-rotation change ID}"
  : "${CAUCE_WRITER_ROTATION_FILE:?set the absolute destination for the Zeus-active writer snapshot}"
  : "${CAUCE_WRITER_ROTATION_CONFIRM:?set the exact Zeus-active writer-rotation confirmation}"
  [[ $CAUCE_CHANGE_ID =~ ^[A-Za-z0-9._-]+$ \
     && $CAUCE_WRITER_ROTATION_CONFIRM == "active:Steven:zeus:$CAUCE_CHANGE_ID" ]] || {
    printf 'release writer rotation refused: Zeus-active authority is invalid\n' >&2
    exit 2
  }
fi

pin_helper="$ROOT/scripts/pin-production-release.py"
baseline_helper="$ROOT/scripts/rollback-baseline.py"
compose_helper="$ROOT/scripts/compose.sh"
compose_files_helper="$ROOT/scripts/compose-files.sh"
health_helper="$ROOT/scripts/stack-health.sh"
release_gate="$ROOT/scripts/release-gate.sh"
release_candidate="$ROOT/scripts/release-candidate.py"
release_evidence_validator="$ROOT/scripts/validate-release-evidence.py"
writer_state_helper="$ROOT/scripts/release-writer-state.py"
capture_writer_helper="$ROOT/scripts/capture-release-writer-snapshot.sh"
build_dir="$ROOT/artifacts/release"
build_evidence="$build_dir/build.json"
build_schema="$ROOT/schemas/build-evidence.schema.json"

for executable in \
  "$pin_helper" "$baseline_helper" "$compose_helper" "$compose_files_helper" \
  "$health_helper" "$release_gate" "$release_candidate" "$release_evidence_validator" \
  "$writer_state_helper" "$ROOT/scripts/verify-manifest.sh"; do
  [[ -x $executable ]] || {
    printf 'release deploy refused: a canonical helper is absent or not executable\n' >&2
    exit 2
  }
done
if [[ $action == bootstrap-production-legacy && ! -x $capture_writer_helper ]]; then
  printf 'production legacy bootstrap refused: canonical writer capture helper is absent\n' >&2
  exit 2
fi
[[ $CAUCE_ENV_FILE = /* ]] || {
  printf 'release deploy refused: production env path must be absolute\n' >&2
  exit 2
}
if [[ $action == preflight || $action == deploy ]]; then
  [[ $CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST = /* \
     && $CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE = /* \
     && $CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE = /* ]] || {
    printf 'release deploy refused: production selector paths must be absolute\n' >&2
    exit 2
  }
  [[ $CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256 =~ ^sha256:[a-f0-9]{64}$ \
     && $CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256 =~ ^sha256:[a-f0-9]{64}$ \
     && $CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256 =~ ^sha256:[a-f0-9]{64}$ ]] || {
    printf 'release deploy refused: target manifest/baseline/writer snapshot SHA-256 is invalid\n' >&2
    exit 2
  }
fi

# The parent helper writes and owns one authenticated lock capability. Every
# selector read/check/swap below reuses that descriptor; no phase releases it.
if [[ -z ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-} ]]; then
  lock_args=("$action")
  ((maintenance == 0)) || lock_args+=(--maintenance-offline-zeus)
  outer_env=(
    /usr/bin/env -i
    "PATH=$system_path"
    'LC_ALL=C'
    'PYTHONDONTWRITEBYTECODE=1'
    "CAUCE_ENV_FILE=$CAUCE_ENV_FILE"
  )
  for allowed in \
    CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST \
    CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256 \
    CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE \
    CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256 \
    CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE \
    CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256 \
    CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE CAUCE_DEPLOY_CONFIRM \
    CAUCE_CHANGE_ID CAUCE_MAINTENANCE_CONFIRM \
    CAUCE_WRITER_ROTATION_FILE CAUCE_WRITER_ROTATION_CONFIRM; do
    if [[ -v $allowed ]]; then
      outer_env+=("$allowed=${!allowed}")
    fi
  done
  if [[ $action == bootstrap-production-legacy ]]; then
    for allowed in \
      CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256 CAUCE_BOOTSTRAP_RUNTIME_IMAGE \
      CAUCE_BOOTSTRAP_CONSOLE_IMAGE CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST \
      CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256 \
      CAUCE_BOOTSTRAP_LEGACY_FLEET_SNAPSHOT_FILE \
      CAUCE_BOOTSTRAP_ROLLBACK_BASELINE CAUCE_BOOTSTRAP_BACKUP_ENV_FILE \
      CAUCE_BOOTSTRAP_FORWARD_RELEASE_ID CAUCE_RELEASE_WRITER_SNAPSHOT_FILE; do
      outer_env+=("$allowed=${!allowed}")
    done
  fi
  exec "${outer_env[@]}" "$pin_helper" locked-exec \
    --env-file "$CAUCE_ENV_FILE" -- "$0" "${lock_args[@]}"
fi
[[ $CAUCE_RELEASE_TRANSITION_LOCK_FD =~ ^[0-9]+$ \
   && $CAUCE_RELEASE_TRANSITION_LOCK_FD -ge 3 \
   && ${CAUCE_RELEASE_TRANSITION_LOCK_TOKEN:-} =~ ^[a-f0-9]{64}$ ]] || {
  printf 'release deploy refused: inherited transition lock capability is invalid\n' >&2
  exit 2
}
transition_lock_fd=$CAUCE_RELEASE_TRANSITION_LOCK_FD

# A second controller on a remote fleet host must not be able to restore an
# external writer between the fenced-state gate and the migration boundary.
# The helper keeps one SSH/flock session per declared remote systemd manager
# alive for this entire child transaction and aborts the child if any session
# is lost. The local production selector lock remains held by the parent.
if [[ $action =~ ^(deploy|bootstrap-production-legacy|rotate-writer-snapshot|prod-up|prod-down)$ \
   && -z ${CAUCE_WRITER_REMOTE_GUARD_FD:-} ]]; then
  guarded_command=("$ROOT/scripts/deploy-release.sh" "$action")
  ((maintenance == 0)) || guarded_command+=(--maintenance-offline-zeus)
  exec "$writer_state_helper" --ops-root "$ROOT" guarded-exec -- "${guarded_command[@]}"
fi

# Schema 036 requires stop -> drain -> migrate -> restore/bridge compensation.
# The direct migrator shortcut cannot prove or compensate that interlock, so it
# remains an explicit tombstone.  Production schema changes must use `deploy`,
# which owns the complete transaction below.
if [[ $action == migrate ]]; then
  printf 'direct production migration is disabled: use deploy-release.sh deploy for the stop/drain/migrate/restore transaction\n' >&2
  exit 2
fi

# Treat the private env as interpolation data, never as a source of Docker/Compose
# control-plane authority. Ambient variables are also discarded: a caller cannot
# redirect this transaction to another project, profile set, context or daemon.
compose_profiles=$(python3 - "$CAUCE_ENV_FILE" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
allowed_profiles = ("origin-relay", "telegram", "terminal", "shadow", "observability")
denied = {
    "COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES",
    "COMPOSE_DISABLE_ENV_FILE", "COMPOSE_IGNORE_ORPHANS", "COMPOSE_REMOVE_ORPHANS",
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS",
    "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
}
values = {}
for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
    if not raw or raw.startswith("#"):
        continue
    if "=" not in raw:
        raise SystemExit(f"invalid production env line {number}")
    key, value = raw.split("=", 1)
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None:
        raise SystemExit(f"invalid production env key at line {number}")
    if key in values:
        raise SystemExit(f"duplicate production env key: {key}")
    values[key] = value
if values.get("COMPOSE_PROJECT_NAME") != "cauce-v3-prod":
    raise SystemExit("COMPOSE_PROJECT_NAME must be exactly cauce-v3-prod")
present_denied = sorted(denied.intersection(values))
if present_denied:
    raise SystemExit("production env contains forbidden Docker/Compose controls")
raw_profiles = values.get("COMPOSE_PROFILES", "")
profiles = [item.strip() for item in raw_profiles.split(",") if item.strip()]
if len(profiles) != len(set(profiles)) or any(item not in allowed_profiles for item in profiles):
    raise SystemExit("COMPOSE_PROFILES contains duplicates or an unsupported profile")
print(",".join(item for item in allowed_profiles if item in profiles))
PY
) || {
  printf 'release deploy refused: production Docker/Compose controls are ambiguous or unsafe\n' >&2
  exit 2
}
trusted_home=$(getent passwd "$(id -u)" | cut -d: -f6)
[[ $trusted_home = /* && -d $trusted_home && ! -L $trusted_home ]] || {
  printf 'release deploy refused: invoking account has no trusted home directory\n' >&2
  exit 2
}
trusted_user=$(id -un)
canonical_env=(
  env -i
  "PATH=$system_path"
  "HOME=$trusted_home"
  "USER=$trusted_user"
  "LOGNAME=$trusted_user"
  'LC_ALL=C'
  'PYTHONDONTWRITEBYTECODE=1'
  'DOCKER_HOST=unix:///var/run/docker.sock'
  "DOCKER_CONFIG=$trusted_home/.docker"
  'COMPOSE_PROJECT_NAME=cauce-v3-prod'
  "COMPOSE_PROFILES=$compose_profiles"
  "CAUCE_ENV_FILE=$CAUCE_ENV_FILE"
  "CAUCE_RELEASE_TRANSITION_LOCK_FD=$CAUCE_RELEASE_TRANSITION_LOCK_FD"
  "CAUCE_RELEASE_TRANSITION_LOCK_TOKEN=$CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"
)
if [[ -n ${CAUCE_WRITER_REMOTE_GUARD_FD:-} ]]; then
  canonical_env+=(
    "CAUCE_WRITER_REMOTE_GUARD_FD=$CAUCE_WRITER_REMOTE_GUARD_FD"
    "CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256=$CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256"
    "CAUCE_WRITER_REMOTE_GUARDS=$CAUCE_WRITER_REMOTE_GUARDS"
  )
fi
if ((maintenance == 1)); then
  canonical_env+=(
    "CAUCE_CHANGE_ID=$CAUCE_CHANGE_ID"
    "CAUCE_MAINTENANCE_CONFIRM=$CAUCE_MAINTENANCE_CONFIRM"
  )
fi

if [[ $action == bootstrap-production-legacy ]]; then
  legacy_runtime=$CAUCE_BOOTSTRAP_RUNTIME_IMAGE
  legacy_console=$CAUCE_BOOTSTRAP_CONSOLE_IMAGE
  legacy_manifest=$CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST
  legacy_manifest_sha=$CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256
  legacy_fleet=$CAUCE_BOOTSTRAP_LEGACY_FLEET_SNAPSHOT_FILE
  legacy_baseline=$CAUCE_BOOTSTRAP_ROLLBACK_BASELINE
  legacy_backup=$CAUCE_BOOTSTRAP_BACKUP_ENV_FILE
  legacy_writer=$CAUCE_RELEASE_WRITER_SNAPSHOT_FILE
  [[ $CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256 =~ ^sha256:[a-f0-9]{64}$ \
     && $legacy_runtime =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ \
     && $legacy_console =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ \
     && $legacy_manifest = /* && $legacy_manifest_sha =~ ^sha256:[a-f0-9]{64}$ \
     && $legacy_fleet = /* && $legacy_baseline = /* && $legacy_backup = /* \
     && $legacy_writer = /* \
     && $CAUCE_BOOTSTRAP_FORWARD_RELEASE_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
    printf 'production legacy bootstrap refused: inputs are not canonical\n' >&2
    exit 2
  }
  already_complete=0
  if selected_writer=$("$pin_helper" field --env-file "$CAUCE_ENV_FILE" \
      --name CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE --lock-fd "$transition_lock_fd" \
      2>/dev/null); then
    selected_writer_sha=$("$pin_helper" field --env-file "$CAUCE_ENV_FILE" \
      --name CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256 --lock-fd "$transition_lock_fd")
    [[ $selected_writer == "$legacy_writer" ]] || {
      printf 'production legacy bootstrap refused: completed selector uses another writer snapshot\n' >&2
      exit 1
    }
    already_complete=1
  fi

  legacy_fleet_sha=$("$pin_helper" capture-production-legacy \
    --env-file "$CAUCE_ENV_FILE" \
    --expected-env-sha256 "$CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256" \
    --runtime-image "$legacy_runtime" --console-image "$legacy_console" \
    --override-manifest "$legacy_manifest" \
    --override-manifest-sha256 "$legacy_manifest_sha" \
    --output "$legacy_fleet" --backup-env-file "$legacy_backup" \
    --lock-fd "$transition_lock_fd") || {
    printf 'production legacy bootstrap refused: physical fleet capture failed\n' >&2
    exit 1
  }
  legacy_baseline_sha=$("${canonical_env[@]}" "$baseline_helper" create-legacy \
    --output "$legacy_baseline" \
    --forward-release-commit "$CAUCE_BOOTSTRAP_FORWARD_RELEASE_ID" \
    --forward-runtime-image "$legacy_runtime" --console-image "$legacy_console" \
    --override-manifest "$legacy_manifest" \
    --legacy-fleet-snapshot "$legacy_fleet" \
    --legacy-fleet-snapshot-sha256 "$legacy_fleet_sha") || {
    printf 'production legacy bootstrap refused: authenticated legacy baseline failed\n' >&2
    exit 1
  }

  if ((already_complete == 0)); then
    "$pin_helper" bootstrap-production-legacy \
      --env-file "$CAUCE_ENV_FILE" \
      --expected-env-sha256 "$CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256" \
      --runtime-image "$legacy_runtime" --console-image "$legacy_console" \
      --override-manifest "$legacy_manifest" \
      --override-manifest-sha256 "$legacy_manifest_sha" \
      --rollback-baseline "$legacy_baseline" \
      --rollback-baseline-sha256 "$legacy_baseline_sha" \
      --legacy-fleet-snapshot "$legacy_fleet" \
      --legacy-fleet-snapshot-sha256 "$legacy_fleet_sha" \
      --backup-env-file "$legacy_backup" --lock-fd "$transition_lock_fd" >/dev/null || {
      printf 'production legacy bootstrap refused: selector promotion failed\n' >&2
      exit 1
    }
  fi

  bootstrap_capture_args=("$legacy_writer")
  ((maintenance == 0)) || bootstrap_capture_args+=(--maintenance-offline-zeus)
  bootstrap_capture_env=("${canonical_env[@]}"
    "CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_FILE=$legacy_fleet"
    "CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_SHA256=$legacy_fleet_sha")
  set +e
  "${bootstrap_capture_env[@]}" "$capture_writer_helper" "${bootstrap_capture_args[@]}"
  capture_status=$?
  set -e
  if ((capture_status == 0)); then
    legacy_writer_sha="sha256:$(sha256sum "$legacy_writer" | cut -d' ' -f1)"
    six_selector_sha=$(python3 - "$CAUCE_ENV_FILE" <<'PY'
import hashlib
import pathlib
import sys

content = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
lines = [line for line in content.splitlines(keepends=True)
         if not line.startswith("CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=")
         and not line.startswith("CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=")]
print("sha256:" + hashlib.sha256("".join(lines).encode()).hexdigest())
PY
    )
    set +e
    "$pin_helper" bootstrap-writer-snapshot --env-file "$CAUCE_ENV_FILE" \
      --expected-env-sha256 "$six_selector_sha" \
      --writer-snapshot "$legacy_writer" \
      --writer-snapshot-sha256 "$legacy_writer_sha" \
      --lock-fd "$transition_lock_fd" >/dev/null
    capture_status=$?
    set -e
  else
    legacy_writer_sha=${selected_writer_sha:-sha256:$(printf absent | sha256sum | cut -d' ' -f1)}
  fi
  if ((capture_status != 0)); then
    if ((already_complete == 0)); then
      if ! "$pin_helper" restore-production-legacy \
        --env-file "$CAUCE_ENV_FILE" \
        --expected-env-sha256 "$CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256" \
        --runtime-image "$legacy_runtime" --console-image "$legacy_console" \
        --override-manifest "$legacy_manifest" \
        --override-manifest-sha256 "$legacy_manifest_sha" \
        --rollback-baseline "$legacy_baseline" \
        --rollback-baseline-sha256 "$legacy_baseline_sha" \
        --writer-snapshot "$legacy_writer" \
        --writer-snapshot-sha256 "$legacy_writer_sha" \
        --backup-env-file "$legacy_backup" --lock-fd "$transition_lock_fd" >/dev/null; then
        printf 'CRITICAL: production legacy bootstrap failed and exact two-selector compensation failed\n' >&2
        exit 74
      fi
      printf 'production legacy bootstrap failed safely; exact two-selector env restored\n' >&2
    fi
    exit "$capture_status"
  fi
  final_writer=$("$pin_helper" field --env-file "$CAUCE_ENV_FILE" \
    --name CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE --lock-fd "$transition_lock_fd")
  final_writer_sha=$("$pin_helper" field --env-file "$CAUCE_ENV_FILE" \
    --name CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256 --lock-fd "$transition_lock_fd")
  [[ $final_writer == "$legacy_writer" && $final_writer_sha == "$legacy_writer_sha" ]] || {
    printf 'CRITICAL: production legacy bootstrap final eight-selector read-back failed\n' >&2
    exit 74
  }
  printf 'production legacy bootstrap committed an authenticated eight-selector pre-migration state\n'
  exit 0
fi

selector() {
  "$pin_helper" field \
    --env-file "$CAUCE_ENV_FILE" --name "$1" --lock-fd "$transition_lock_fd"
}

current_runtime=$(selector CAUCE_RUNTIME_IMAGE)
current_console=$(selector CAUCE_CONSOLE_IMAGE)
current_manifest=$(selector CAUCE_COMPOSE_OVERRIDE_MANIFEST)
current_manifest_sha=$(selector CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256)
current_baseline=$(selector CAUCE_ROLLBACK_BASELINE_FILE)
current_baseline_sha=$(selector CAUCE_ROLLBACK_BASELINE_SHA256)
current_writer_snapshot=$(selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE)
current_writer_snapshot_sha=$(selector CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256)

private_selector_file() {
  local path=$1 label=$2 mode links owner
  [[ -f $path && ! -L $path ]] || {
    printf 'release deploy refused: %s is not a regular non-symlink file\n' "$label" >&2
    return 1
  }
  read -r mode links owner < <(stat -c '%a %h %u' -- "$path") || return 1
  [[ $mode == 600 && $links == 1 && ( $owner == 0 || $owner == "$(id -u)" ) ]] || {
    printf 'release deploy refused: %s is not a private single-link owned file\n' "$label" >&2
    return 1
  }
}
private_selector_file "$current_manifest" 'current override manifest'
private_selector_file "$current_baseline" 'current rollback baseline'
private_selector_file "$current_writer_snapshot" 'current rollback writer snapshot'

manifest_digest() {
  "$pin_helper" manifest --env-file "$CAUCE_ENV_FILE" --path "$1" \
    --lock-fd "$transition_lock_fd" "${@:2}"
}
[[ $current_manifest_sha =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf 'release deploy refused: selected override manifest SHA-256 is invalid\n' >&2
  exit 2
}
manifest_check() {
  local path=$1 digest=$2 selected=${3:-0}
  local -a selected_arg=()
  [[ $selected == 0 ]] || selected_arg+=(--require-selected)
  manifest_digest "$path" --expected-sha256 "$digest" "${selected_arg[@]}" >/dev/null
}
manifest_check "$current_manifest" "$current_manifest_sha" 1
active_manifest=$current_manifest
active_manifest_sha=$current_manifest_sha
active_writer_snapshot=$current_writer_snapshot
active_writer_snapshot_sha=$current_writer_snapshot_sha

writer_snapshot_check() {
  "$writer_state_helper" --ops-root "$ROOT" validate \
    --snapshot "$1" --expected-sha256 "$2" >/dev/null
}
writer_snapshot_check "$current_writer_snapshot" "$current_writer_snapshot_sha"

compose_current() {
  local result
  manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  writer_snapshot_check "$active_writer_snapshot" "$active_writer_snapshot_sha" || return 1
  set +e
  "${canonical_env[@]}" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE="$active_writer_snapshot" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256="$active_writer_snapshot_sha" \
    "$compose_helper" prod "$@"
  result=$?
  set -e
  manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  writer_snapshot_check "$active_writer_snapshot" "$active_writer_snapshot_sha" || return 1
  return "$result"
}
health_current() {
  local result
  health_args=(prod)
  if [[ ${active_baseline_kind:-} == legacy-pre-migration ]]; then
    ((maintenance == 1)) || {
      printf 'release deploy refused: legacy pre-migration health requires bounded Zeus maintenance\n' >&2
      return 1
    }
    health_args+=(--bootstrap-legacy)
  elif ((maintenance == 1)); then
    health_args+=(--maintenance-offline-zeus)
  fi
  manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  set +e
  "${canonical_env[@]}" "$health_helper" "${health_args[@]}"
  result=$?
  set -e
  manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  return "$result"
}
docker_cli() {
  "${canonical_env[@]}" docker "$@"
}

baseline_field() {
  local baseline=$1 digest=$2 name=$3
  "$baseline_helper" field --baseline "$baseline" \
    --expected-baseline-sha256 "$digest" --name "$name"
}
active_baseline_kind=$(baseline_field "$current_baseline" "$current_baseline_sha" baseline-kind)

writer_snapshot_count() {
  python3 - "$1" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))[
    "writersExpectedCandidate"
]
if type(value) is not int or value < 0:
    raise SystemExit(1)
print(value)
PY
}

marker_write() {
  local snapshot=$1 digest=$2 release_id=$3 mode=$4 expected=$5 observed=$6
  writer_snapshot_check "$snapshot" "$digest" || return 1
  "$writer_state_helper" --ops-root "$ROOT" marker \
    --snapshot "$snapshot" --expected-sha256 "$digest" \
    --path "${snapshot}.state.json" --release-id "$release_id" --mode "$mode" \
    --writers-expected "$expected" --writers-observed "$observed" >/dev/null || return 1
  "$writer_state_helper" --ops-root "$ROOT" marker-check \
    --snapshot "$snapshot" --expected-sha256 "$digest" \
    --path "${snapshot}.state.json" --release-id "$release_id" --mode "$mode" \
    --writers-expected "$expected" --writers-observed "$observed" >/dev/null
}

marker_check() {
  local snapshot=$1 digest=$2 release_id=$3 mode=$4 expected=$5 observed=$6
  "$writer_state_helper" --ops-root "$ROOT" marker-check \
    --snapshot "$snapshot" --expected-sha256 "$digest" \
    --path "${snapshot}.state.json" --release-id "$release_id" --mode "$mode" \
    --writers-expected "$expected" --writers-observed "$observed" >/dev/null
}

pin_transition() {
  local operation=$1 expected_runtime=$2 next_runtime=$3 expected_console=$4 next_console=$5
  local expected_manifest=$6 next_manifest=$7 expected_manifest_sha=$8 next_manifest_sha=$9
  local expected_baseline=${10} next_baseline=${11}
  local expected_baseline_sha=${12} next_baseline_sha=${13}
  local expected_writer_snapshot=${14} next_writer_snapshot=${15}
  local expected_writer_snapshot_sha=${16} next_writer_snapshot_sha=${17}
  local forward_commit=${18} forward_runtime=${19} forward_source=${20}
  "$pin_helper" "$operation" \
    --env-file "$CAUCE_ENV_FILE" \
    --expected-runtime-image "$expected_runtime" --target-runtime-image "$next_runtime" \
    --expected-console-image "$expected_console" --target-console-image "$next_console" \
    --expected-override-manifest "$expected_manifest" --target-override-manifest "$next_manifest" \
    --expected-override-manifest-sha256 "$expected_manifest_sha" \
    --target-override-manifest-sha256 "$next_manifest_sha" \
    --expected-rollback-baseline "$expected_baseline" --target-rollback-baseline "$next_baseline" \
    --expected-rollback-baseline-sha256 "$expected_baseline_sha" \
    --target-rollback-baseline-sha256 "$next_baseline_sha" \
    --expected-writer-snapshot "$expected_writer_snapshot" \
    --target-writer-snapshot "$next_writer_snapshot" \
    --expected-writer-snapshot-sha256 "$expected_writer_snapshot_sha" \
    --target-writer-snapshot-sha256 "$next_writer_snapshot_sha" \
    --baseline-forward-release-commit "$forward_commit" \
    --baseline-forward-runtime-image "$forward_runtime" \
    --baseline-forward-runtime-source-digest "$forward_source" \
    --lock-fd "$transition_lock_fd"
}

# Transitional admission accepts a stopped dispatcher long enough to remove it.
# The established bridge requires absence, because a retained restart:always
# container from an older release could revive before Compose reconciles policy.
service_process_absent() {
  local service=$1 container_id
  container_id=$(compose_current ps -q "$service") || return 1
  [[ -z $container_id ]]
}

if [[ $action =~ ^(prod-up|prod-down)$ ]]; then
  current_forward_commit=$(
    "$baseline_helper" field --baseline "$current_baseline" \
      --expected-baseline-sha256 "$current_baseline_sha" --name forward-release-commit
  )
  current_forward_runtime=$(
    "$baseline_helper" field --baseline "$current_baseline" \
      --expected-baseline-sha256 "$current_baseline_sha" --name forward-runtime-image
  )
  current_bridge_runtime=$(
    "$baseline_helper" field --baseline "$current_baseline" \
      --expected-baseline-sha256 "$current_baseline_sha" --name bridge-runtime-image
  )
  current_writer_expected=$(python3 - "$current_writer_snapshot" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["writersExpectedCandidate"])
PY
  )
  direct_model=$(compose_current config --format json | "$writer_state_helper" \
    --ops-root "$ROOT" compose-model \
    --runtime-image "$current_runtime" --console-image "$current_console") || {
    printf 'production mutation refused: selected Compose model is not canonical\n' >&2
    exit 1
  }
  direct_bridge=0
  direct_writer_services=()
  direct_long_lived_services=()
  while IFS=$'\t' read -r direct_role direct_service _direct_image; do
    [[ $direct_role == migrator ]] || direct_long_lived_services+=("$direct_service")
    [[ $direct_role != writer ]] || direct_writer_services+=("$direct_service")
  done <<<"$direct_model"
  if [[ $current_runtime == "$current_bridge_runtime" ]]; then
    direct_bridge=1
    "$writer_state_helper" --ops-root "$ROOT" marker-check \
      --snapshot "$current_writer_snapshot" --expected-sha256 "$current_writer_snapshot_sha" \
      --path "${current_writer_snapshot}.state.json" --release-id "$current_forward_commit" \
      --mode rollback_bridge_degraded --writers-expected 0 --writers-observed 0 >/dev/null
    "$writer_state_helper" --ops-root "$ROOT" fence \
      --snapshot "$current_writer_snapshot" \
      --expected-sha256 "$current_writer_snapshot_sha" >/dev/null || true
    direct_mutators=(dispatcher "${direct_writer_services[@]}")
    compose_current stop --timeout 45 "${direct_mutators[@]}" || true
    compose_current rm -f "${direct_mutators[@]}"
    for direct_service in "${direct_mutators[@]}"; do
      service_process_absent "$direct_service"
    done
  elif [[ $current_runtime == "$current_forward_runtime" ]]; then
    "$writer_state_helper" --ops-root "$ROOT" marker-check \
      --snapshot "$current_writer_snapshot" --expected-sha256 "$current_writer_snapshot_sha" \
      --path "${current_writer_snapshot}.state.json" --release-id "$current_forward_commit" \
      --mode candidate --writers-expected "$current_writer_expected" \
      --writers-observed "$current_writer_expected" >/dev/null
  else
    printf 'production mutation refused: runtime selector belongs to neither baseline mode\n' >&2
    exit 1
  fi
  case $action in
    prod-up)
      if ((direct_bridge == 1)); then
        mapfile -t direct_safe_services < <(
          awk -F '\t' \
            '$1 != "migrator" && $1 != "writer" && $2 != "dispatcher" {print $2}' \
            <<<"$direct_model"
        )
        compose_current up -d --no-build --no-deps --wait "${direct_safe_services[@]}"
      else
        compose_current up -d --no-build --no-deps --wait "${direct_long_lived_services[@]}"
      fi
      if ((direct_bridge == 1)); then
        direct_fleet=$(compose_current run --rm --no-deps -T migrator \
          node deploy/fleet-snapshot.mjs)
        direct_writer_args=(
          --ops-root "$ROOT" check --snapshot "$current_writer_snapshot"
          --expected-sha256 "$current_writer_snapshot_sha" --mode fenced --fleet-stdin
        )
        for direct_service in "${direct_writer_services[@]}"; do
          direct_writer_args+=(--compose-writer "$direct_service")
        done
        printf '%s' "$direct_fleet" | "$writer_state_helper" \
          "${direct_writer_args[@]}" >/dev/null
        service_process_absent dispatcher
        compose_current exec -T gateway node deploy/readiness-probe.mjs \
          http://127.0.0.1:8081/health/ready ready >/dev/null
        compose_current exec -T outbox-metrics node deploy/readiness-probe.mjs \
          http://127.0.0.1:8084/health/ready ready >/dev/null
        direct_metrics=$(compose_current exec -T outbox-metrics node -e \
          "fetch('http://127.0.0.1:8084/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))")
        grep -Eq '^cauce_release_rollback_bridge_degraded(\{[^}]*\})? 1$' \
          <<<"$direct_metrics"
        grep -Eq '^cauce_release_writers_declared(\{[^}]*\})? 0$' <<<"$direct_metrics"
        grep -Eq '^cauce_release_writer_leases_active(\{[^}]*\})? 0$' <<<"$direct_metrics"
      else
        health_current
      fi
      printf 'production Compose start completed under the authenticated release lock\n'
      ;;
    prod-down)
      compose_current down
      printf 'production Compose stop completed under the authenticated release lock\n'
      ;;
  esac
  exit 0
fi

if [[ $action == rotate-writer-snapshot ]]; then
  rotation_snapshot=$CAUCE_WRITER_ROTATION_FILE
  [[ $rotation_snapshot = /* \
     && $(dirname -- "$rotation_snapshot") == "$(dirname -- "$current_baseline")" \
     && $(dirname -- "$current_writer_snapshot") == "$(dirname -- "$current_baseline")" \
     && $rotation_snapshot != "$CAUCE_ENV_FILE" \
     && $rotation_snapshot != "$current_manifest" \
     && $rotation_snapshot != "$current_baseline" ]] || {
    printf 'release writer rotation refused: destination is outside the selected durable release directory or aliases a selector input\n' >&2
    exit 2
  }

  rotation_release_id=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" forward-release-commit)
  rotation_forward_runtime=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" forward-runtime-image)
  rotation_forward_source=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" forward-runtime-source-digest)
  rotation_console=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" console-image)
  rotation_manifest=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" override-manifest)
  rotation_manifest_sha=$(baseline_field \
    "$current_baseline" "$current_baseline_sha" override-manifest-sha256)
  [[ $current_runtime == "$rotation_forward_runtime" \
     && $current_console == "$rotation_console" \
     && $current_manifest == "$rotation_manifest" \
     && $current_manifest_sha == "$rotation_manifest_sha" ]] || {
    printf 'release writer rotation refused: the eight selected fields are not the exact current candidate state\n' >&2
    exit 1
  }

  rotation_current_count=$(writer_snapshot_count "$current_writer_snapshot") || {
    printf 'release writer rotation refused: selected writer count is invalid\n' >&2
    exit 1
  }
  marker_check "$current_writer_snapshot" "$current_writer_snapshot_sha" \
    "$rotation_release_id" candidate \
    "$rotation_current_count" "$rotation_current_count" || {
    printf 'release writer rotation refused: selected candidate marker is invalid\n' >&2
    exit 1
  }
  rotation_current_state=(
    "$current_runtime" "$current_runtime" "$current_console" "$current_console"
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
    "$current_baseline" "$current_baseline"
    "$current_baseline_sha" "$current_baseline_sha"
    "$current_writer_snapshot" "$current_writer_snapshot"
    "$current_writer_snapshot_sha" "$current_writer_snapshot_sha"
    "$rotation_release_id" "$rotation_forward_runtime" "$rotation_forward_source"
  )
  pin_transition check "${rotation_current_state[@]}" >/dev/null || {
    printf 'release writer rotation refused: current eight-selector candidate admission failed\n' >&2
    exit 1
  }

  rotation_model=$(compose_current config --format json | \
    "$writer_state_helper" --ops-root "$ROOT" compose-model \
      --runtime-image "$current_runtime" --console-image "$current_console") || {
    printf 'release writer rotation refused: current candidate Compose model is invalid\n' >&2
    exit 1
  }
  rotation_compose_writers=()
  rotation_has_migrator=0
  rotation_has_outbox=0
  while IFS=$'\t' read -r rotation_role rotation_service _rotation_image; do
    [[ $rotation_role != writer ]] || rotation_compose_writers+=("$rotation_service")
    [[ $rotation_role != migrator || $rotation_service != migrator ]] || rotation_has_migrator=1
    [[ $rotation_service != outbox-metrics ]] || rotation_has_outbox=1
  done <<<"$rotation_model"
  ((rotation_has_migrator == 1 && rotation_has_outbox == 1)) || {
    printf 'release writer rotation refused: canonical migrator/outbox services are absent\n' >&2
    exit 1
  }

  rotation_writer_args=()
  for rotation_service in "${rotation_compose_writers[@]}"; do
    rotation_writer_args+=(--compose-writer "$rotation_service")
  done
  rotation_live_check() {
    local snapshot=$1 digest=$2 fleet
    fleet=$(compose_current run --rm --no-deps -T migrator \
      node deploy/fleet-snapshot.mjs) || return 1
    printf '%s' "$fleet" | "$writer_state_helper" --ops-root "$ROOT" check \
      --snapshot "$snapshot" --expected-sha256 "$digest" --mode restored \
      --fleet-stdin "${rotation_writer_args[@]}" >/dev/null
  }
  rotation_recreate_outbox() {
    local snapshot=$1 digest=$2 expected=$3 strict_metrics=${4:-1} metrics
    active_writer_snapshot=$snapshot
    active_writer_snapshot_sha=$digest
    marker_check "$snapshot" "$digest" "$rotation_release_id" candidate \
      "$expected" "$expected" || return 1
    compose_current up -d --force-recreate --no-build --no-deps \
      --wait --wait-timeout 180 outbox-metrics || return 1
    compose_current exec -T outbox-metrics node deploy/readiness-probe.mjs \
      http://127.0.0.1:8084/health/ready ready >/dev/null || return 1
    ((strict_metrics == 0)) && return 0
    metrics=$(compose_current exec -T outbox-metrics node -e \
      "fetch('http://127.0.0.1:8084/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))") \
      || return 1
    rotation_metric_exact "$metrics" cauce_release_rollback_bridge_degraded 0 \
      && rotation_metric_exact "$metrics" cauce_release_writers_expected "$expected" \
      && rotation_metric_exact "$metrics" cauce_release_writers_declared "$expected" \
      && rotation_metric_exact "$metrics" cauce_release_writer_leases_active "$expected"
  }

  rotation_metric_exact() {
    local metrics=$1 name=$2 expected=$3
    awk -v name="$name" -v expected="$expected" '
      $1 == name || index($1, name "{") == 1 {
        seen += 1
        if (NF != 2 || $0 != name " " expected) invalid = 1
      }
      END { exit !(seen == 1 && invalid == 0) }
    ' <<<"$metrics"
  }

  # A completed rotation is a safe, exact retry: no old selector is guessed.
  # Re-observe the selected active snapshot, refresh its sole marker consumer,
  # and repeat the strict host gate and final eight-field admission.
  if [[ $current_writer_snapshot == "$rotation_snapshot" ]]; then
    "$writer_state_helper" --ops-root "$ROOT" rotation-check \
      --new-snapshot "$current_writer_snapshot" \
      --new-sha256 "$current_writer_snapshot_sha" >/dev/null || {
      printf 'release writer rotation retry refused: selected snapshot does not prove Zeus active\n' >&2
      exit 1
    }
    rotation_live_check "$current_writer_snapshot" "$current_writer_snapshot_sha" || {
      printf 'release writer rotation retry refused: selected snapshot differs from live units or leases\n' >&2
      exit 1
    }
    rotation_recreate_outbox "$current_writer_snapshot" \
      "$current_writer_snapshot_sha" "$rotation_current_count" || {
      printf 'release writer rotation retry failed: outbox marker consumer is not coherent\n' >&2
      exit 1
    }
    "${canonical_env[@]}" "$release_candidate" --release-host-ready || {
      printf 'release writer rotation retry failed: strict release-host-ready did not pass\n' >&2
      exit 1
    }
    pin_transition check "${rotation_current_state[@]}" >/dev/null || {
      printf 'release writer rotation retry failed: final selector admission drifted\n' >&2
      exit 1
    }
    printf 'release writer snapshot rotation already committed and reverified\n'
    exit 0
  fi

  rotation_fleet=$(compose_current run --rm --no-deps -T migrator \
    node deploy/fleet-snapshot.mjs) || {
    printf 'release writer rotation refused: live writer leases cannot be captured\n' >&2
    exit 1
  }
  rotation_snapshot_json=$(printf '%s' "$rotation_fleet" | \
    "$writer_state_helper" --ops-root "$ROOT" capture \
      "${rotation_writer_args[@]}") || {
    printf 'release writer rotation refused: Zeus-active unit/lease snapshot cannot be captured\n' >&2
    exit 1
  }
  rotation_snapshot_sha=$(printf '%s\n' "$rotation_snapshot_json" | \
    "$writer_state_helper" --ops-root "$ROOT" publish \
      --path "$rotation_snapshot" --allow-identical) || {
    printf 'release writer rotation refused: create-only snapshot publication failed\n' >&2
    exit 1
  }
  [[ $rotation_snapshot_sha =~ ^sha256:[a-f0-9]{64}$ ]] || {
    printf 'release writer rotation refused: published snapshot digest is invalid\n' >&2
    exit 1
  }
  "$writer_state_helper" --ops-root "$ROOT" rotation-check \
    --old-snapshot "$current_writer_snapshot" \
    --old-sha256 "$current_writer_snapshot_sha" \
    --new-snapshot "$rotation_snapshot" \
    --new-sha256 "$rotation_snapshot_sha" >/dev/null || {
    printf 'release writer rotation refused: active set changed by anything other than Zeus\n' >&2
    exit 1
  }
  rotation_live_check "$rotation_snapshot" "$rotation_snapshot_sha" || {
    printf 'release writer rotation refused: new snapshot differs from live units or leases\n' >&2
    exit 1
  }
  rotation_new_count=$(writer_snapshot_count "$rotation_snapshot") || exit 1

  rotation_target_state=(
    "$current_runtime" "$current_runtime" "$current_console" "$current_console"
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
    "$current_baseline" "$current_baseline"
    "$current_baseline_sha" "$current_baseline_sha"
    "$rotation_snapshot" "$rotation_snapshot"
    "$rotation_snapshot_sha" "$rotation_snapshot_sha"
    "$rotation_release_id" "$rotation_forward_runtime" "$rotation_forward_source"
  )
  rotation_forward_transition=(
    "$current_runtime" "$current_runtime" "$current_console" "$current_console"
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
    "$current_baseline" "$current_baseline"
    "$current_baseline_sha" "$current_baseline_sha"
    "$current_writer_snapshot" "$rotation_snapshot"
    "$current_writer_snapshot_sha" "$rotation_snapshot_sha"
    "$rotation_release_id" "$rotation_forward_runtime" "$rotation_forward_source"
  )
  rotation_inverse_transition=(
    "$current_runtime" "$current_runtime" "$current_console" "$current_console"
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
    "$current_baseline" "$current_baseline"
    "$current_baseline_sha" "$current_baseline_sha"
    "$rotation_snapshot" "$current_writer_snapshot"
    "$rotation_snapshot_sha" "$current_writer_snapshot_sha"
    "$rotation_release_id" "$rotation_forward_runtime" "$rotation_forward_source"
  )

  rotation_guard_enabled=0
  rotation_committed=0
  rotation_ambiguous=0
  rotation_compensate() {
    local selector_ok=0 marker_ok=0 outbox_ok=0
    set +e
    if pin_transition check "${rotation_target_state[@]}" >/dev/null 2>&1; then
      if pin_transition swap "${rotation_inverse_transition[@]}" >/dev/null; then
        selector_ok=1
      elif pin_transition check "${rotation_current_state[@]}" >/dev/null 2>&1; then
        printf 'release writer rotation compensation observed a lost inverse-CAS response\n' >&2
        selector_ok=1
      fi
    elif pin_transition check "${rotation_current_state[@]}" >/dev/null 2>&1; then
      selector_ok=1
    fi
    active_writer_snapshot=$current_writer_snapshot
    active_writer_snapshot_sha=$current_writer_snapshot_sha
    if marker_write "$current_writer_snapshot" "$current_writer_snapshot_sha" \
        "$rotation_release_id" candidate \
        "$rotation_current_count" "$rotation_current_count"; then
      marker_ok=1
    fi
    if ((selector_ok == 1 && marker_ok == 1)) \
       && rotation_recreate_outbox "$current_writer_snapshot" \
          "$current_writer_snapshot_sha" "$rotation_current_count" 0; then
      outbox_ok=1
    fi
    set -e
    ((selector_ok == 1 && marker_ok == 1 && outbox_ok == 1))
  }
  rotation_exit_guard() {
    local status=$1
    trap - EXIT
    if ((rotation_guard_enabled == 1 && rotation_committed == 0)); then
      printf 'release writer rotation failed; compensating old selector, marker and outbox consumer\n' >&2
      if ! rotation_compensate; then
        printf 'CRITICAL: release writer rotation could not restore the exact old selector/marker consumer\n' >&2
        ((rotation_ambiguous == 0)) || exit 75
        exit 74
      fi
      printf 'release writer rotation failed safely with the old selector and marker consumer restored\n' >&2
    fi
    exit "$status"
  }
  trap 'rotation_exit_guard "$?"' EXIT
  rotation_guard_enabled=1

  marker_write "$rotation_snapshot" "$rotation_snapshot_sha" \
    "$rotation_release_id" candidate \
    "$rotation_new_count" "$rotation_new_count" || {
    printf 'release writer rotation failed: Zeus-active marker publication failed\n' >&2
    exit 1
  }
  rotation_recreate_outbox "$rotation_snapshot" "$rotation_snapshot_sha" \
    "$rotation_new_count" || {
    printf 'release writer rotation failed: Zeus-active marker/outbox could not be proven before CAS\n' >&2
    exit 1
  }
  rotation_live_check "$rotation_snapshot" "$rotation_snapshot_sha" || {
    printf 'release writer rotation failed: live writer state drifted before CAS\n' >&2
    exit 1
  }
  pin_transition check "${rotation_forward_transition[@]}" >/dev/null || {
    printf 'release writer rotation failed: final pre-CAS eight-selector admission drifted\n' >&2
    exit 1
  }
  if ! pin_transition swap "${rotation_forward_transition[@]}" >/dev/null; then
    if pin_transition check "${rotation_target_state[@]}" >/dev/null 2>&1; then
      printf 'release writer rotation observed a lost forward-CAS response; continuing exact verification\n' >&2
    elif pin_transition check "${rotation_current_state[@]}" >/dev/null 2>&1; then
      printf 'release writer rotation CAS failed before selecting the new snapshot\n' >&2
      exit 1
    else
      rotation_ambiguous=1
      printf 'CRITICAL: release writer rotation CAS left neither exact old nor exact new selectors\n' >&2
      exit 75
    fi
  fi
  active_writer_snapshot=$rotation_snapshot
  active_writer_snapshot_sha=$rotation_snapshot_sha
  rotation_live_check "$rotation_snapshot" "$rotation_snapshot_sha" || {
    printf 'release writer rotation failed: selected snapshot differs from live writers after CAS\n' >&2
    exit 1
  }
  "${canonical_env[@]}" "$release_candidate" --release-host-ready || {
    printf 'release writer rotation failed: strict release-host-ready did not pass\n' >&2
    exit 1
  }
  pin_transition check "${rotation_target_state[@]}" >/dev/null || {
    printf 'release writer rotation failed: final eight-selector admission drifted\n' >&2
    exit 1
  }
  marker_check "$rotation_snapshot" "$rotation_snapshot_sha" \
    "$rotation_release_id" candidate "$rotation_new_count" "$rotation_new_count" || {
    printf 'release writer rotation failed: final selected marker drifted\n' >&2
    exit 1
  }
  rotation_committed=1
  trap - EXIT
  printf 'release writer snapshot rotation committed with strict release-host-ready evidence\n'
  exit 0
fi

target_manifest=$CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST
target_manifest_sha=$CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256
target_baseline=$CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE
target_baseline_sha=$CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256
target_writer_snapshot=$CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE
target_writer_snapshot_sha=$CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256
private_selector_file "$target_manifest" 'target override manifest'
private_selector_file "$target_baseline" 'target rollback baseline'
private_selector_file "$target_writer_snapshot" 'target rollback writer snapshot'
manifest_check "$target_manifest" "$target_manifest_sha"
writer_snapshot_check "$target_writer_snapshot" "$target_writer_snapshot_sha"
[[ $(dirname -- "$target_writer_snapshot") == "$(dirname -- "$target_baseline")" ]] || {
  printf 'release deploy refused: target writer snapshot is outside the durable release artifact directory\n' >&2
  exit 2
}

[[ -f $build_evidence && ! -L $build_evidence && -f $build_schema && ! -L $build_schema ]] || {
  printf 'release deploy refused: canonical build evidence or schema is unavailable\n' >&2
  exit 2
}
"$ROOT/scripts/verify-manifest.sh" "$build_dir" >/dev/null || {
  printf 'release deploy refused: build evidence manifest is invalid\n' >&2
  exit 1
}
"${canonical_env[@]}" "$release_evidence_validator" >/dev/null || {
  printf 'release deploy refused: canonical release evidence failed semantic validation\n' >&2
  exit 1
}
build_output=$(python3 - "$build_evidence" "$build_schema" <<'PY'
import json
import pathlib
import stat
import sys

from jsonschema import Draft202012Validator

evidence_path = pathlib.Path(sys.argv[1])
schema_path = pathlib.Path(sys.argv[2])
metadata = evidence_path.lstat()
if not stat.S_ISREG(metadata.st_mode) or evidence_path.is_symlink() or metadata.st_nlink != 1:
    raise SystemExit(1)
evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
schema = json.loads(schema_path.read_text(encoding="utf-8"))
errors = sorted(Draft202012Validator(schema).iter_errors(evidence), key=lambda item: list(item.path))
if errors:
    raise SystemExit(1)
values = (
    evidence["runtime"]["repositoryDigest"],
    evidence["runtime"]["imageId"],
    evidence["console"]["repositoryDigest"],
    evidence["console"]["imageId"],
    evidence["sourceRevision"]["commit"],
    evidence["sourceDigest"],
    evidence["schemaCompatibility"]["compatibleThrough"],
)
if any(not isinstance(value, str) or "\n" in value or "\r" in value for value in values):
    raise SystemExit(1)
print(*values, sep="\n")
PY
) || {
  printf 'release deploy refused: build evidence failed schema validation\n' >&2
  exit 1
}
mapfile -t build_fields <<<"$build_output"
[[ ${#build_fields[@]} == 7 ]] || {
  printf 'release deploy refused: build evidence selector set is incomplete\n' >&2
  exit 1
}
target_runtime=${build_fields[0]}
target_runtime_id=${build_fields[1]}
target_console=${build_fields[2]}
target_console_id=${build_fields[3]}
target_commit=${build_fields[4]}
target_source_digest=${build_fields[5]}
target_schema=${build_fields[6]}
[[ $target_schema =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || {
  printf 'release deploy refused: build evidence has an invalid target schema contract\n' >&2
  exit 1
}

current_baseline_kind=$active_baseline_kind
current_forward_commit=$(baseline_field "$current_baseline" "$current_baseline_sha" forward-release-commit)
current_forward_runtime=$(baseline_field "$current_baseline" "$current_baseline_sha" forward-runtime-image)
current_forward_source=$(baseline_field "$current_baseline" "$current_baseline_sha" forward-runtime-source-digest)
if [[ $current_baseline_kind == legacy-pre-migration ]]; then
  current_bridge_runtime=$current_forward_runtime
elif [[ $current_baseline_kind == canonical-bridge ]]; then
  current_bridge_runtime=$(baseline_field "$current_baseline" "$current_baseline_sha" bridge-runtime-image)
else
  printf 'release deploy refused: current rollback baseline kind is unsupported\n' >&2
  exit 1
fi
target_baseline_kind=$(baseline_field "$target_baseline" "$target_baseline_sha" baseline-kind)
[[ $target_baseline_kind == canonical-bridge ]] || {
  printf 'release deploy refused: target baseline must contain an accredited rollback bridge\n' >&2
  exit 1
}
target_forward_commit=$(baseline_field "$target_baseline" "$target_baseline_sha" forward-release-commit)
target_forward_runtime=$(baseline_field "$target_baseline" "$target_baseline_sha" forward-runtime-image)
target_forward_source=$(baseline_field "$target_baseline" "$target_baseline_sha" forward-runtime-source-digest)
target_rollback_runtime=$(baseline_field "$target_baseline" "$target_baseline_sha" bridge-runtime-image)
target_rollback_runtime_id=$(baseline_field "$target_baseline" "$target_baseline_sha" bridge-runtime-image-id)
target_rollback_console=$(baseline_field "$target_baseline" "$target_baseline_sha" console-image)
target_rollback_console_id=$(baseline_field "$target_baseline" "$target_baseline_sha" console-image-id)
target_rollback_manifest=$(baseline_field "$target_baseline" "$target_baseline_sha" override-manifest)
target_rollback_manifest_sha=$(baseline_field "$target_baseline" "$target_baseline_sha" override-manifest-sha256)
target_bridge_evidence=$(baseline_field "$target_baseline" "$target_baseline_sha" bridge-evidence)
target_bridge_evidence_sha=$(baseline_field "$target_baseline" "$target_baseline_sha" bridge-evidence-sha256)

current_is_bridge=0
if [[ $current_forward_runtime == "$current_runtime" ]]; then
  :
elif [[ $current_bridge_runtime == "$current_runtime" ]]; then
  current_is_bridge=1
else
  printf 'release deploy refused: current baseline belongs to neither the selected forward runtime nor its bridge\n' >&2
  exit 1
fi
[[ $target_forward_commit == "$target_commit" \
   && $target_forward_runtime == "$target_runtime" \
   && $target_forward_source == "$target_source_digest" ]] || {
  printf 'release deploy refused: target baseline does not belong to build evidence\n' >&2
  exit 1
}
# The console and manifest can return byte-for-byte to expected-old. Runtime is
# deliberately different when the target schema requires the independently exercised
# bridge; its RepoDigest/ID/evidence are authenticated by the target baseline.
[[ $target_rollback_console == "$current_console" \
   && $target_rollback_manifest == "$current_manifest" \
   && $target_rollback_manifest_sha == "$current_manifest_sha" ]] || {
  printf 'release deploy refused: target baseline does not encode the exact current console/manifest rollback state\n' >&2
  exit 1
}
if ((current_is_bridge == 1)); then
  [[ $target_writer_snapshot == "$current_writer_snapshot" \
     && $target_writer_snapshot_sha == "$current_writer_snapshot_sha" ]] || {
    printf 'release deploy refused: bridge-to-candidate resume must retain the selected writer recovery snapshot\n' >&2
    exit 1
  }
fi

manifest_check "$target_manifest" "$target_manifest_sha"
active_overrides=$("${canonical_env[@]}" \
  CAUCE_COMPOSE_OVERRIDE_MANIFEST="$target_manifest" \
  CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256="$target_manifest_sha" \
  "$compose_files_helper" overrides) || {
  printf 'release deploy refused: target override manifest is invalid\n' >&2
  exit 1
}
[[ -z $active_overrides ]] || {
  printf 'release deploy refused: target release still activates historical Compose overrides\n' >&2
  exit 1
}
manifest_check "$target_manifest" "$target_manifest_sha"

compose_target_preview() {
  local result
  manifest_check "$target_manifest" "$target_manifest_sha" || return 1
  set +e
  "${canonical_env[@]}" \
    CAUCE_RUNTIME_IMAGE="$target_runtime" \
    CAUCE_CONSOLE_IMAGE="$target_console" \
    CAUCE_COMPOSE_OVERRIDE_MANIFEST="$target_manifest" \
    CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256="$target_manifest_sha" \
    CAUCE_ROLLBACK_BASELINE_FILE="$target_baseline" \
    CAUCE_ROLLBACK_BASELINE_SHA256="$target_baseline_sha" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE="$target_writer_snapshot" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256="$target_writer_snapshot_sha" \
    "$compose_helper" prod "$@"
  result=$?
  set -e
  manifest_check "$target_manifest" "$target_manifest_sha" || return 1
  return "$result"
}
compose_bridge_preview() {
  local result
  manifest_check "$current_manifest" "$current_manifest_sha" || return 1
  set +e
  "${canonical_env[@]}" \
    CAUCE_RUNTIME_IMAGE="$target_rollback_runtime" \
    CAUCE_CONSOLE_IMAGE="$current_console" \
    CAUCE_COMPOSE_OVERRIDE_MANIFEST="$current_manifest" \
    CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256="$current_manifest_sha" \
    CAUCE_ROLLBACK_BASELINE_FILE="$target_baseline" \
    CAUCE_ROLLBACK_BASELINE_SHA256="$target_baseline_sha" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE="$target_writer_snapshot" \
    CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256="$target_writer_snapshot_sha" \
    "$compose_helper" prod "$@"
  result=$?
  set -e
  manifest_check "$current_manifest" "$current_manifest_sha" || return 1
  return "$result"
}

classify_model() {
  local runtime=$1 console=$2
  "$writer_state_helper" --ops-root "$ROOT" compose-model \
    --runtime-image "$runtime" --console-image "$console"
}
current_model=$(compose_current config --format json | classify_model "$current_runtime" "$current_console") || {
  printf 'release deploy refused: current canonical Compose model is invalid\n' >&2
  exit 1
}
target_model=$(compose_target_preview config --format json | classify_model "$target_runtime" "$target_console") || {
  printf 'release deploy refused: target canonical Compose model is invalid\n' >&2
  exit 1
}
bridge_model=$(compose_bridge_preview config --format json | classify_model \
  "$target_rollback_runtime" "$current_console") || {
  printf 'release deploy refused: rollback bridge Compose model is invalid\n' >&2
  exit 1
}
current_topology=$(cut -f1,2 <<<"$current_model")
target_topology=$(cut -f1,2 <<<"$target_model")
bridge_topology=$(cut -f1,2 <<<"$bridge_model")
[[ $current_topology == "$target_topology" && $target_topology == "$bridge_topology" ]] || {
  printf 'release deploy refused: forward release changes the configured service/image-role topology\n' >&2
  exit 1
}

release_services=()
configured_services=()
release_plane_services=()
bridge_core_services=()
bridge_writer_services=()
bridge_observability_services=()
bridge_infrastructure_services=()
declare -A current_service_images=() target_service_images=()
while IFS=$'\t' read -r kind service reference; do
  configured_services+=("$service")
  current_service_images[$service]=$reference
  case $kind in
    core)
      release_services+=("$service")
      release_plane_services+=("$service")
      [[ $service == dispatcher ]] || bridge_core_services+=("$service")
      ;;
    writer)
      release_services+=("$service")
      bridge_writer_services+=("$service")
      ;;
    console)
      release_services+=("$service")
      release_plane_services+=("$service")
      bridge_core_services+=("$service")
      ;;
    observability) bridge_observability_services+=("$service") ;;
    infrastructure) bridge_infrastructure_services+=("$service") ;;
  esac
done <<<"$current_model"
while IFS=$'\t' read -r _kind service reference; do
  target_service_images[$service]=$reference
done <<<"$target_model"
for required in gateway dispatcher outbox-metrics console; do
  [[ " ${release_services[*]} " == *" $required "* ]] || {
    printf 'release deploy refused: canonical release service set is incomplete\n' >&2
    exit 1
  }
done
[[ $target_model == *$'migrator\tmigrator\t'* ]] || {
  printf 'release deploy refused: canonical one-shot migrator is absent\n' >&2
  exit 1
}

running=$(compose_current ps --services --status running) || {
  printf 'release deploy refused: current running-service inventory failed\n' >&2
  exit 1
}
materialized=$(compose_current ps --all --services) || {
  printf 'release deploy refused: current materialized-service inventory failed\n' >&2
  exit 1
}
normalize_inventory() {
  python3 -c '
import re, sys
values = [line.strip() for line in sys.stdin if line.strip()]
if len(values) != len(set(values)) or any(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", value) is None for value in values):
    raise SystemExit(1)
print("\n".join(sorted(values)))
'
}
running_normalized=$(normalize_inventory <<<"$running") || {
  printf 'release deploy refused: running-service inventory is invalid or duplicated\n' >&2
  exit 1
}
materialized_normalized=$(normalize_inventory <<<"$materialized") || {
  printf 'release deploy refused: materialized-service inventory is invalid or duplicated\n' >&2
  exit 1
}
expected_long_lived=$(printf '%s\n' "${configured_services[@]}" | grep -Fvx migrator | LC_ALL=C sort)
expected_materialized=$(printf '%s\n' "$expected_long_lived" migrator | LC_ALL=C sort)
bridge_expected_running=$(printf '%s\n' "$expected_long_lived" \
  | LC_ALL=C sort)
bridge_stopped_services=(dispatcher "${bridge_writer_services[@]}")
if ((${#bridge_stopped_services[@]})); then
  bridge_expected_running=$(printf '%s\n' "$expected_long_lived" \
    | grep -Fvx -f <(printf '%s\n' "${bridge_stopped_services[@]}") | LC_ALL=C sort)
fi
quiesced_expected_running=$(
  { printf '%s\n' "$expected_long_lived" \
      | grep -Fvx -f <(printf '%s\n' "${release_services[@]}") || true; } \
    | LC_ALL=C sort
)
expected_running=$expected_long_lived
((current_is_bridge == 0)) || expected_running=$bridge_expected_running
materialized_is_valid_for_mode() {
  local wanted_running=$1 observed_materialized=$2
  if [[ $wanted_running == "$bridge_expected_running" \
     || $wanted_running == "$quiesced_expected_running" ]]; then
    # Admission may observe retained stopped containers only before the durable
    # bridge fence removes them.  The established bridge is verified separately
    # as exact safe-only materialization; partial sets remain ambiguous.
    bridge_materialized=$(printf '%s\n' "$bridge_expected_running" migrator | LC_ALL=C sort)
    [[ $observed_materialized == "$expected_materialized" \
       || $observed_materialized == "$bridge_materialized" ]]
  else
    [[ $observed_materialized == "$expected_materialized" ]]
  fi
}
[[ -n $expected_running && $running_normalized == "$expected_running" ]] \
  && materialized_is_valid_for_mode "$expected_running" "$materialized_normalized" || {
  printf 'release deploy refused: running/materialized services differ from the exact selected release mode\n' >&2
  exit 1
}
migrator_container=$(compose_current ps --all -q migrator) || exit 1
[[ -n $migrator_container && $migrator_container != *$'\n'* ]] || {
  printf 'release deploy refused: materialized migrator identity is ambiguous\n' >&2
  exit 1
}
migrator_state=$(docker_cli inspect --format '{{.State.Status}} {{.State.ExitCode}}' \
  "$migrator_container") || exit 1
[[ $migrator_state == 'exited 0' ]] || {
  printf 'release deploy refused: materialized migrator is not exited/0\n' >&2
  exit 1
}

local_image_id() {
  local reference=$1 output digests
  output=$(docker_cli image inspect --format '{{.Id}}' "$reference") || return 1
  [[ $output =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  digests=$(docker_cli image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reference") || return 1
  grep -Fqx -- "$reference" <<<"$digests" || return 1
  printf '%s\n' "$output"
}
physical_image_binding() {
  local reference=$1 running_id=$2 preferred=$3 output digests candidate count=0
  output=$(docker_cli image inspect --format '{{.Id}}' "$reference") || return 1
  [[ $output == "$running_id" && $output =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  digests=$(docker_cli image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$reference") || return 1
  if grep -Fqx -- "$preferred" <<<"$digests"; then
    candidate=$preferred
  elif [[ $reference =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ ]] \
       && grep -Fqx -- "$reference" <<<"$digests"; then
    candidate=$reference
  else
    while IFS= read -r digest; do
      [[ $digest =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$ ]] || continue
      candidate=$digest
      ((count += 1))
    done <<<"$digests"
    ((count == 1)) || return 1
  fi
  printf '%s\t%s\n' "$output" "$candidate"
}
current_runtime_id=$(local_image_id "$current_runtime") || {
  printf 'release deploy refused: current runtime selector is not locally bound to its RepoDigest\n' >&2
  exit 1
}
current_console_id=$(local_image_id "$current_console") || {
  printf 'release deploy refused: current console selector is not locally bound to its RepoDigest\n' >&2
  exit 1
}
declare -A current_image_ids=() observed_service_images=() observed_service_recovery_images=() observed_service_ids=()
declare -A observed_service_config_hashes=() observed_service_containers=()
declare -A canonical_service_config_hashes=()
current_image_ids[$current_runtime]=$current_runtime_id
current_image_ids[$current_console]=$current_console_id
fragmented_legacy=0
for service in ${expected_long_lived}; do
  if ((current_is_bridge == 1)) \
     && [[ " ${bridge_stopped_services[*]} " == *" $service "* ]]; then
    continue
  fi
  expected_reference=${current_service_images[$service]}
  if [[ -z ${current_image_ids[$expected_reference]+x} ]]; then
    current_image_ids[$expected_reference]=$(local_image_id "$expected_reference") || {
      printf 'release deploy refused: a configured service image is not locally bound to its RepoDigest\n' >&2
      exit 1
    }
  fi
  expected_id=${current_image_ids[$expected_reference]}
  container_id=$(compose_current ps -q "$service") || exit 1
  [[ -n $container_id && $container_id != *$'\n'* ]] || {
    printf 'release deploy refused: a configured service has an ambiguous container identity\n' >&2
    exit 1
  }
  running_id=$(docker_cli inspect --format '{{.Image}}' "$container_id") || exit 1
  configured_reference=$(docker_cli inspect --format '{{.Config.Image}}' "$container_id") || exit 1
  running_config_hash=$(docker_cli inspect \
    --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$container_id") || exit 1
  config_hash_line=$(compose_current config --hash "$service") || exit 1
  read -r config_hash_service expected_config_hash extra <<<"$config_hash_line"
  [[ $config_hash_service == "$service" && -z ${extra:-} \
     && $expected_config_hash =~ ^[a-f0-9]{64}$ \
     && $running_config_hash =~ ^[a-f0-9]{64}$ \
     && -n $configured_reference && $configured_reference != *$'\t'* ]] || {
    printf 'release deploy refused: running service identity/config evidence is invalid\n' >&2
    exit 1
  }
  physical_binding=$(physical_image_binding \
    "$configured_reference" "$running_id" "$expected_reference") || {
    printf 'release deploy refused: a running service image is not bound to one recoverable RepoDigest\n' >&2
    exit 1
  }
  IFS=$'\t' read -r observed_id recovery_reference physical_extra <<<"$physical_binding"
  [[ $running_id == "$observed_id" && -n $recovery_reference && -z ${physical_extra:-} ]] || {
    printf 'release deploy refused: a running service ID differs from its recoverable image binding\n' >&2
    exit 1
  }
  observed_service_images[$service]=$configured_reference
  observed_service_recovery_images[$service]=$recovery_reference
  observed_service_ids[$service]=$running_id
  observed_service_config_hashes[$service]=$running_config_hash
  observed_service_containers[$service]=$container_id
  canonical_service_config_hashes[$service]=$expected_config_hash
  if [[ $running_id != "$expected_id" || $configured_reference != "$expected_reference" \
     || $running_config_hash != "$expected_config_hash" ]]; then
    if [[ " ${release_services[*]} " != *" $service "* ]]; then
      printf 'release deploy refused: a non-release service differs from the canonical model\n' >&2
      exit 1
    fi
    fragmented_legacy=1
  fi
  if [[ " ${release_services[*]} " != *" $service "* ]]; then
    target_hash_line=$(compose_target_preview config --hash "$service") || exit 1
    read -r target_hash_service target_config_hash target_extra <<<"$target_hash_line"
    [[ ${target_service_images[$service]} == "$expected_reference" \
       && $target_hash_service == "$service" && -z ${target_extra:-} \
       && $target_config_hash == "$expected_config_hash" ]] || {
      printf 'release deploy refused: target changes a non-release service that the transaction cannot recreate\n' >&2
      exit 1
    }
  fi
done

fragment_snapshot_path=
fragment_snapshot_sha=
fragment_snapshot_content=
fragment_compose_yaml=
if ((fragmented_legacy == 1)); then
  fragment_snapshot_path=${CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE:-}
  [[ $fragment_snapshot_path = /* ]] || {
    printf 'release deploy refused: fragmented expected-old requires CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE\n' >&2
    exit 2
  }
  "${canonical_env[@]}" python3 - "$fragment_snapshot_path" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
parent = path.parent
if path.exists() or path.is_symlink():
    raise SystemExit("legacy snapshot destination already exists")
try:
    metadata = parent.lstat()
except OSError as error:
    raise SystemExit("legacy snapshot parent is unavailable") from error
try:
    resolved_parent = parent.resolve(strict=True)
except OSError as error:
    raise SystemExit("legacy snapshot parent cannot be resolved safely") from error
if (not path.is_absolute() or resolved_parent != parent or parent.is_symlink()
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid not in {0, os.geteuid()} or stat.S_IMODE(metadata.st_mode) & 0o022):
    raise SystemExit("legacy snapshot parent is not an owned non-writable-by-others directory")
PY
  fragment_records=$(for service in ${expected_long_lived}; do
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$service" "${observed_service_images[$service]}" "${observed_service_ids[$service]}" \
      "${observed_service_config_hashes[$service]}" "${current_service_images[$service]}" \
      "${observed_service_containers[$service]}" \
      "${observed_service_recovery_images[$service]}"
  done)
  fragment_compose_yaml=$(printf '%s\n' "$fragment_records" | "${canonical_env[@]}" \
    python3 -c '
import json, sys
services = {}
for raw in sys.stdin:
    raw = raw.rstrip("\n")
    if not raw:
        continue
    name, image, *_rest = raw.split("\t")
    services[name] = {"image": image}
print(json.dumps({"services": services}, sort_keys=True, separators=(",", ":")))
') || {
    printf 'release deploy refused: fragmented Compose override serialization failed\n' >&2
    exit 1
  }
  fragment_compose_yaml+=$'\n'

  compose_fragment_preview() {
    local result
    manifest_check "$current_manifest" "$current_manifest_sha" 1 || return 1
    set +e
    printf '%s' "$fragment_compose_yaml" | "${canonical_env[@]}" \
      "$compose_helper" prod -f - "$@"
    result=$?
    set -e
    manifest_check "$current_manifest" "$current_manifest_sha" 1 || return 1
    return "$result"
  }
  for service in ${expected_long_lived}; do
    fragment_hash_line=$(compose_fragment_preview config --hash "$service") || exit 1
    read -r fragment_hash_service fragment_config_hash fragment_extra <<<"$fragment_hash_line"
    [[ $fragment_hash_service == "$service" && -z ${fragment_extra:-} \
       && $fragment_config_hash == "${observed_service_config_hashes[$service]}" ]] || {
      printf 'release deploy refused: fragmented service config cannot be reconstructed exactly\n' >&2
      exit 1
    }
  done

  fragment_snapshot_json=$(printf '%s\n' "$fragment_records" | "${canonical_env[@]}" \
    SNAPSHOT_RUNTIME="$current_runtime" SNAPSHOT_CONSOLE="$current_console" \
    SNAPSHOT_MANIFEST="$current_manifest" SNAPSHOT_MANIFEST_SHA="$current_manifest_sha" \
    SNAPSHOT_BASELINE="$current_baseline" SNAPSHOT_BASELINE_SHA="$current_baseline_sha" \
    SNAPSHOT_WRITERS="$current_writer_snapshot" SNAPSHOT_WRITERS_SHA="$current_writer_snapshot_sha" \
    python3 -c '
import json, os, sys
services = []
for raw in sys.stdin:
    raw = raw.rstrip("\n")
    if not raw:
        continue
    name, image, image_id, config_hash, canonical_image, container_id, recovery_image = raw.split("\t")
    services.append({"canonicalImage": canonical_image, "configHash": config_hash,
                     "containerIdBefore": container_id, "image": image,
                     "imageId": image_id, "recoveryImage": recovery_image,
                     "service": name})
report = {
    "kind": "cauce-v3-fragmented-legacy-release-snapshot",
    "schemaVersion": 1,
    "selectors": {
        "baseline": os.environ["SNAPSHOT_BASELINE"],
        "baselineSha256": os.environ["SNAPSHOT_BASELINE_SHA"],
        "console": os.environ["SNAPSHOT_CONSOLE"],
        "manifest": os.environ["SNAPSHOT_MANIFEST"],
        "manifestSha256": os.environ["SNAPSHOT_MANIFEST_SHA"],
        "runtime": os.environ["SNAPSHOT_RUNTIME"],
        "writerSnapshot": os.environ["SNAPSHOT_WRITERS"],
        "writerSnapshotSha256": os.environ["SNAPSHOT_WRITERS_SHA"],
    },
    "services": services,
}
print(json.dumps(report, sort_keys=True, separators=(",", ":")))
') || {
    printf 'release deploy refused: fragmented snapshot serialization failed\n' >&2
    exit 1
  }
  fragment_snapshot_content="${fragment_snapshot_json}"$'\n'
  fragment_snapshot_sha="sha256:$(printf '%s' "$fragment_snapshot_content" | sha256sum | cut -d' ' -f1)"
fi
writer_check_args=(
  --ops-root "$ROOT" check --snapshot "$target_writer_snapshot"
  --expected-sha256 "$target_writer_snapshot_sha"
)
[[ $current_baseline_kind != legacy-pre-migration ]] \
  || writer_check_args+=(--legacy-pre-migration)
for service in "${bridge_writer_services[@]}"; do
  writer_check_args+=(--compose-writer "$service")
done
fleet_snapshot=$(compose_target_preview run --rm --no-deps -T migrator \
  node deploy/fleet-snapshot.mjs) || {
  printf 'release deploy refused: external writer leases cannot be inventoried\n' >&2
  exit 1
}
writer_mode=captured
((current_is_bridge == 0)) || writer_mode=fenced
printf '%s' "$fleet_snapshot" | "$writer_state_helper" "${writer_check_args[@]}" \
  --mode "$writer_mode" --fleet-stdin >/dev/null || {
  printf 'release deploy refused: selected writer recovery snapshot differs from units, leases or Compose writers\n' >&2
  exit 1
}
writer_expected_candidate=$(python3 - "$target_writer_snapshot" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["writersExpectedCandidate"])
PY
)
current_writer_expected_candidate=$(python3 - "$current_writer_snapshot" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["writersExpectedCandidate"])
PY
)

if ((current_is_bridge == 0)); then
  marker_check "$target_writer_snapshot" "$target_writer_snapshot_sha" \
    "$current_forward_commit" candidate \
    "$writer_expected_candidate" "$writer_expected_candidate" || {
    printf 'release deploy refused: target recovery snapshot marker is not bound to the current candidate state\n' >&2
    exit 1
  }
fi

bridge_health() {
  local release_id=$1 metrics
  service_process_absent dispatcher || return 1
  compose_current exec -T gateway \
    node deploy/readiness-probe.mjs http://127.0.0.1:8081/health/ready ready >/dev/null || return 1
  compose_current exec -T outbox-metrics \
    node deploy/readiness-probe.mjs http://127.0.0.1:8084/health/ready ready >/dev/null || return 1
  compose_current exec -T console sh -c \
    'test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/' \
    >/dev/null || return 1
  metrics=$(compose_current exec -T outbox-metrics node -e \
    "fetch('http://127.0.0.1:8084/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))") \
    || return 1
  grep -Eq '^cauce_release_rollback_bridge_degraded(\{[^}]*\})? 1$' <<<"$metrics" || return 1
  grep -Eq '^cauce_release_writers_declared(\{[^}]*\})? 0$' <<<"$metrics" || return 1
  grep -Eq '^cauce_release_writer_leases_active(\{[^}]*\})? 0$' <<<"$metrics" || return 1
  "$writer_state_helper" --ops-root "$ROOT" marker-check \
    --snapshot "$active_writer_snapshot" --expected-sha256 "$active_writer_snapshot_sha" \
    --path "${active_writer_snapshot}.state.json" --release-id "$release_id" \
    --mode rollback_bridge_degraded --writers-expected 0 --writers-observed 0 >/dev/null
}

if ((current_is_bridge == 0)); then
  marker_check "$current_writer_snapshot" "$current_writer_snapshot_sha" \
    "$current_forward_commit" candidate \
    "$current_writer_expected_candidate" "$current_writer_expected_candidate" || {
    printf 'release deploy refused: current candidate marker is absent or inconsistent\n' >&2
    exit 1
  }
fi
if ((current_is_bridge == 0)); then
  health_current >/dev/null || current_health_failed=1
else
  bridge_health "$current_forward_commit" >/dev/null || current_health_failed=1
fi
if [[ ${current_health_failed:-0} == 1 ]]; then
  printf 'release deploy refused: current release is not healthy enough to compensate safely\n' >&2
  exit 1
fi

transition_payload="${maintenance}:${current_runtime}|${current_console}|${current_manifest}|${current_manifest_sha}|${current_baseline}|${current_baseline_sha}|${current_writer_snapshot}|${current_writer_snapshot_sha}->${target_runtime}|${target_console}|${target_manifest}|${target_manifest_sha}|${target_baseline}|${target_baseline_sha}|${target_writer_snapshot}|${target_writer_snapshot_sha}|fragment=${fragment_snapshot_path}|${fragment_snapshot_sha}"
transition_sha=$(printf '%s' "$transition_payload" | sha256sum | cut -d' ' -f1)
expected_confirmation="deploy-release:sha256:${transition_sha}"

if [[ $action == preflight ]]; then
  printf 'release preflight passed read-only under the transition lock (%s release services)\n' "${#release_services[@]}"
  printf 'set CAUCE_DEPLOY_CONFIRM=%s for this exact old-to-target transition\n' "$expected_confirmation"
  exit 0
fi
[[ ${CAUCE_DEPLOY_CONFIRM:-} == "$expected_confirmation" ]] || {
  printf 'release deploy refused: CAUCE_DEPLOY_CONFIRM does not authorize this exact old-to-target transition\n' >&2
  exit 2
}
[[ $current_runtime != "$target_runtime" || $current_console != "$target_console" \
   || $current_manifest != "$target_manifest" || $current_manifest_sha != "$target_manifest_sha" \
   || $current_baseline != "$target_baseline" \
   || $current_baseline_sha != "$target_baseline_sha" \
   || $current_writer_snapshot != "$target_writer_snapshot" \
   || $current_writer_snapshot_sha != "$target_writer_snapshot_sha" ]] || {
  printf 'release deploy refused: target release is already selected\n' >&2
  exit 2
}

pull_and_resolve() {
  local reference=$1 output digests
  docker_cli pull "$reference" >/dev/null || {
    printf 'release deploy failed: immutable registry image could not be recovered\n' >&2
    return 1
  }
  output=$(docker_cli image inspect --format '{{.Id}}' "$reference") || return 1
  [[ $output =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  digests=$(docker_cli image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reference") || return 1
  grep -Fqx -- "$reference" <<<"$digests" || {
    printf 'release deploy failed: recovered image is not bound to the requested RepoDigest\n' >&2
    return 1
  }
  printf '%s\n' "$output"
}

recovered_current_runtime_id=$(pull_and_resolve "$current_runtime")
recovered_current_console_id=$(pull_and_resolve "$current_console")
recovered_target_runtime_id=$(pull_and_resolve "$target_runtime")
recovered_target_console_id=$(pull_and_resolve "$target_console")
recovered_bridge_runtime_id=$(pull_and_resolve "$target_rollback_runtime")
[[ $recovered_current_runtime_id == "$current_runtime_id" \
   && $recovered_current_console_id == "$current_console_id" \
   && $recovered_target_runtime_id == "$target_runtime_id" \
   && $recovered_target_console_id == "$target_console_id" \
   && $recovered_bridge_runtime_id == "$target_rollback_runtime_id" \
   && $target_rollback_console_id == "$current_console_id" ]] || {
  printf 'release deploy failed: registry recovered IDs differ from build evidence\n' >&2
  exit 1
}
if ((fragmented_legacy == 1)); then
  for service in ${expected_long_lived}; do
    recovered_fragment_id=$(pull_and_resolve \
      "${observed_service_recovery_images[$service]}") || exit 1
    [[ $recovered_fragment_id == "${observed_service_ids[$service]}" ]] || {
      printf 'release deploy failed: a fragmented snapshot image cannot be recovered by its exact RepoDigest/ID\n' >&2
      exit 1
    }
  done
fi

validate_built_image() {
  local kind=$1 reference=$2 inspected
  inspected=$(docker_cli image inspect --format '{{json .}}' "$reference") || return 1
  IMAGE_INSPECT="$inspected" python3 - \
    "$build_evidence" "$kind" "$reference" "$target_schema" <<'PY'
import json
import os
import pathlib
import sys

manifest_types = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
build = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
kind = sys.argv[2]
reference = sys.argv[3]
target_schema = sys.argv[4]
image = json.loads(os.environ["IMAGE_INSPECT"])
evidence = build[kind]
descriptor = image["Descriptor"]
labels = image["Config"]["Labels"]
assert image["Id"] == evidence["imageId"]
assert image["Os"] == "linux" and image["Architecture"] == "amd64"
assert descriptor["digest"] == evidence["manifestDigest"] == reference.rsplit("@", 1)[1]
assert descriptor["mediaType"] == evidence["mediaType"] in manifest_types
assert reference in image["RepoDigests"]
assert labels["io.cauce.source.digest"] == evidence["sourceDigest"]
assert labels["org.opencontainers.image.revision"] == build["sourceRevision"]["commit"]
assert labels["io.cauce.target-platform"] == "linux/amd64"
bases = build["baseImages"]
if kind == "runtime":
    assert labels["org.opencontainers.image.base.name"] == bases["node"]["repositoryDigest"]
    assert labels["io.cauce.base.node.repository-digest"] == bases["node"]["repositoryDigest"]
    assert labels["io.cauce.base.python.repository-digest"] == bases["python"]["repositoryDigest"]
    assert build["schemaCompatibility"]["compatibleThrough"] == target_schema
    assert labels["io.cauce.schema.compatible-through"] == target_schema
else:
    assert labels["org.opencontainers.image.base.name"] == bases["nginx"]["repositoryDigest"]
    assert labels["io.cauce.base.nginx.repository-digest"] == bases["nginx"]["repositoryDigest"]
    assert labels["io.cauce.console.publish-journal"] == "multi-intent-v1"
    assert evidence["publishJournalCapability"] == "multi-intent-v1"
PY
}
validate_built_image runtime "$target_runtime" || {
  printf 'release deploy failed before CAS: target runtime descriptor/labels differ from build evidence\n' >&2
  exit 1
}
validate_built_image console "$target_console" || {
  printf 'release deploy failed before CAS: target console descriptor/labels differ from build evidence\n' >&2
  exit 1
}
bridge_inspected=$(docker_cli image inspect --format '{{json .}}' "$target_rollback_runtime") || exit 1
BRIDGE_INSPECT="$bridge_inspected" python3 - \
  "$target_rollback_runtime" "$target_rollback_runtime_id" "$target_schema" <<'PY' || {
import json
import os
import sys

reference = sys.argv[1]
expected_id = sys.argv[2]
target_schema = sys.argv[3]
image = json.loads(os.environ["BRIDGE_INSPECT"])
descriptor = image["Descriptor"]
labels = image["Config"]["Labels"]
assert image["Id"] == expected_id
assert image["Os"] == "linux" and image["Architecture"] == "amd64"
assert reference in image["RepoDigests"]
assert descriptor["digest"] == reference.rsplit("@", 1)[1]
assert labels["io.cauce.schema.compatible-through"] == target_schema
assert labels["io.cauce.rollback-bridge.read-only"] == "server-v2"
PY
  printf 'release deploy failed before CAS: rollback bridge image is not accredited through the target schema\n' >&2
  exit 1
}

"$baseline_helper" check \
  --baseline "$current_baseline" --expected-baseline-sha256 "$current_baseline_sha" \
  --expected-forward-release-commit "$current_forward_commit" \
  --expected-forward-runtime-image "$current_forward_runtime" \
  --expected-forward-runtime-source-digest "$current_forward_source" >/dev/null || {
  printf 'release deploy failed: current rollback baseline is not recoverable\n' >&2
  exit 1
}
"$baseline_helper" check \
  --baseline "$target_baseline" --expected-baseline-sha256 "$target_baseline_sha" \
  --expected-forward-release-commit "$target_commit" \
  --expected-forward-runtime-image "$target_runtime" \
  --expected-forward-runtime-image-id "$target_runtime_id" \
  --expected-forward-runtime-source-digest "$target_source_digest" \
  --expected-runtime-image "$target_rollback_runtime" \
  --expected-console-image "$current_console" \
  --expected-override-manifest "$current_manifest" \
  --expected-bridge-evidence "$target_bridge_evidence" \
  --expected-bridge-evidence-sha256 "$target_bridge_evidence_sha" >/dev/null || {
  printf 'release deploy failed: target rollback baseline is not recoverable\n' >&2
  exit 1
}
manifest_check "$current_manifest" "$current_manifest_sha" 1
manifest_check "$target_manifest" "$target_manifest_sha"
"${canonical_env[@]}" "$release_candidate" >/dev/null || {
  printf 'release deploy failed before CAS: release-candidate evidence is not admissible\n' >&2
  exit 1
}
candidate_database_preflight() {
  # The candidate reader is a one-shot container and performs no SQL mutation,
  # but it still runs only after every externally reachable release process is
  # durably stopped. This makes the admission/CAS/migration interval one
  # continuous fail-closed critical section.
  compose_target_preview run --rm --no-deps -T migrator \
    node deploy/migration-integrity.mjs pre >/dev/null || {
    printf 'release deploy failed before CAS: candidate cannot admit current migration integrity\n' >&2
    return 1
  }
  manifest_check "$current_manifest" "$current_manifest_sha" 1 || return 1
  manifest_check "$target_manifest" "$target_manifest_sha" || return 1
  pre_migration_schema=$(compose_target_preview run --rm --no-deps -T migrator \
    node deploy/schema-version.mjs) || {
    printf 'release deploy failed before CAS: current database schema cannot be measured by the candidate\n' >&2
    return 1
  }
  pre_migration_schema=${pre_migration_schema%$'\r'}
  [[ $pre_migration_schema != *$'\n'* \
     && $pre_migration_schema =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || {
    printf 'release deploy failed before CAS: current database schema is outside the candidate contract\n' >&2
    return 1
  }
}

forward_transition=(
  "$current_runtime" "$target_runtime" "$current_console" "$target_console"
  "$current_manifest" "$target_manifest" "$current_manifest_sha" "$target_manifest_sha"
  "$current_baseline" "$target_baseline"
  "$current_baseline_sha" "$target_baseline_sha"
  "$current_writer_snapshot" "$target_writer_snapshot"
  "$current_writer_snapshot_sha" "$target_writer_snapshot_sha"
  "$target_commit" "$target_runtime" "$target_source_digest"
)
inverse_transition=(
  "$target_runtime" "$current_runtime" "$target_console" "$current_console"
  "$target_manifest" "$current_manifest" "$target_manifest_sha" "$current_manifest_sha"
  "$target_baseline" "$current_baseline"
  "$target_baseline_sha" "$current_baseline_sha"
  "$target_writer_snapshot" "$current_writer_snapshot"
  "$target_writer_snapshot_sha" "$current_writer_snapshot_sha"
  "$current_forward_commit" "$current_forward_runtime" "$current_forward_source"
)
bridge_transition=(
  "$target_runtime" "$target_rollback_runtime" "$target_console" "$current_console"
  "$target_manifest" "$current_manifest" "$target_manifest_sha" "$current_manifest_sha"
  "$target_baseline" "$target_baseline"
  "$target_baseline_sha" "$target_baseline_sha"
  "$target_writer_snapshot" "$target_writer_snapshot"
  "$target_writer_snapshot_sha" "$target_writer_snapshot_sha"
  "$target_commit" "$target_runtime" "$target_source_digest"
)
current_state_transition=(
  "$current_runtime" "$current_runtime" "$current_console" "$current_console"
  "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
  "$current_baseline" "$current_baseline"
  "$current_baseline_sha" "$current_baseline_sha"
  "$current_writer_snapshot" "$current_writer_snapshot"
  "$current_writer_snapshot_sha" "$current_writer_snapshot_sha"
  "$current_forward_commit" "$current_forward_runtime" "$current_forward_source"
)
target_state_transition=(
  "$target_runtime" "$target_runtime" "$target_console" "$target_console"
  "$target_manifest" "$target_manifest" "$target_manifest_sha" "$target_manifest_sha"
  "$target_baseline" "$target_baseline"
  "$target_baseline_sha" "$target_baseline_sha"
  "$target_writer_snapshot" "$target_writer_snapshot"
  "$target_writer_snapshot_sha" "$target_writer_snapshot_sha"
  "$target_commit" "$target_runtime" "$target_source_digest"
)
bridge_state_transition=(
  "$target_rollback_runtime" "$target_rollback_runtime"
  "$current_console" "$current_console"
  "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha"
  "$target_baseline" "$target_baseline"
  "$target_baseline_sha" "$target_baseline_sha"
  "$target_writer_snapshot" "$target_writer_snapshot"
  "$target_writer_snapshot_sha" "$target_writer_snapshot_sha"
  "$target_commit" "$target_runtime" "$target_source_digest"
)
pin_transition check "${forward_transition[@]}" >/dev/null || {
  printf 'release deploy failed: complete expected-old to target CAS admission failed\n' >&2
  exit 1
}

verify_service_set() {
  local runtime_id=$1 console_id=$2 runtime_reference=$3 console_reference=$4
  shift 4
  local -a services=("$@")
  local service container_id running_id configured_reference running_config_hash
  local config_hash_line config_hash_service expected_config_hash extra expected_id expected_reference
  for service in "${services[@]}"; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ -n $container_id && $container_id != *$'\n'* ]] || return 1
    running_id=$(docker_cli inspect --format '{{.Image}}' "$container_id") || return 1
    configured_reference=$(docker_cli inspect --format '{{.Config.Image}}' "$container_id") || return 1
    running_config_hash=$(docker_cli inspect \
      --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$container_id") || return 1
    config_hash_line=$(compose_current config --hash "$service") || return 1
    read -r config_hash_service expected_config_hash extra <<<"$config_hash_line"
    expected_id=$runtime_id
    expected_reference=$runtime_reference
    if [[ $service == console ]]; then
      expected_id=$console_id
      expected_reference=$console_reference
    fi
    [[ $running_id == "$expected_id" && $configured_reference == "$expected_reference" \
       && $config_hash_service == "$service" && -z ${extra:-} \
       && $expected_config_hash =~ ^[a-f0-9]{64}$ \
       && $running_config_hash == "$expected_config_hash" ]] || return 1
  done
}

verify_release_services() {
  verify_service_set "$1" "$2" "$3" "$4" "${release_services[@]}"
}

current_fleet_snapshot() {
  compose_current run --rm --no-deps -T migrator node deploy/fleet-snapshot.mjs
}

writer_state_check_active() {
  local mode=$1 fleet
  fleet=$(current_fleet_snapshot) || return 1
  local -a args=(
    --ops-root "$ROOT" check --snapshot "$active_writer_snapshot"
    --expected-sha256 "$active_writer_snapshot_sha" --mode "$mode" --fleet-stdin
  )
  local service
  for service in "${bridge_writer_services[@]}"; do
    args+=(--compose-writer "$service")
  done
  printf '%s' "$fleet" | "$writer_state_helper" "${args[@]}" >/dev/null
}

inventory_matches() {
  local wanted_running=$1 running_now materialized_now normalized_running normalized_materialized
  running_now=$(compose_current ps --services --status running) || return 1
  materialized_now=$(compose_current ps --all --services) || return 1
  normalized_running=$(normalize_inventory <<<"$running_now") || return 1
  normalized_materialized=$(normalize_inventory <<<"$materialized_now") || return 1
  last_wanted_inventory=$wanted_running
  last_running_inventory=$normalized_running
  last_materialized_inventory=$normalized_materialized
  [[ $normalized_running == "$wanted_running" ]] \
    && materialized_is_valid_for_mode "$wanted_running" "$normalized_materialized"
}

compose_writers_are_stopped() {
  local service container_id state_line running_state pid extra
  for service in "${bridge_writer_services[@]}"; do
    container_id=$(compose_current ps -q "$service") || return 1
    # Pre-bridge quiesce may still have a stopped container. The established
    # restart-safe bridge removes it and verifies exact absence separately.
    [[ $container_id != *$'\n'* ]] || return 1
    [[ -n $container_id ]] || continue
    state_line=$(docker_cli inspect --format '{{.State.Running}} {{.State.Pid}}' "$container_id") \
      || return 1
    read -r running_state pid extra <<<"$state_line"
    [[ $running_state == false && $pid == 0 && -z ${extra:-} ]] || return 1
  done
}

bridge_mutators_are_absent() {
  local service
  for service in dispatcher "${bridge_writer_services[@]}"; do
    service_process_absent "$service" || return 1
  done
}

remove_bridge_mutators() {
  local -a mutators=(dispatcher "${bridge_writer_services[@]}")
  compose_current stop --timeout 45 "${mutators[@]}" || true
  compose_current rm -f "${mutators[@]}" || return 1
  bridge_mutators_are_absent
}

wait_writer_state() {
  local mode=$1 wanted_running=$2 attempt writer_ok inventory_ok processes_ok
  for attempt in $(seq 1 20); do
    writer_ok=0
    inventory_ok=0
    processes_ok=0
    writer_state_check_active "$mode" && writer_ok=1
    inventory_matches "$wanted_running" && inventory_ok=1
    { [[ $mode != stopped ]] || compose_writers_are_stopped; } && processes_ok=1
    if ((writer_ok == 1 && inventory_ok == 1 && processes_ok == 1)); then
      return 0
    fi
    sleep 2
  done
  printf 'release writer-state convergence failed: marker=%s inventory=%s processes=%s\n' \
    "$writer_ok" "$inventory_ok" "$processes_ok" >&2
  printf 'release writer-state inventories: wanted=%q running=%q materialized=%q\n' \
    "${last_wanted_inventory:-}" "${last_running_inventory:-}" \
    "${last_materialized_inventory:-}" >&2
  return 1
}

quiesce_all_writers() {
  # An empty string is a valid exact inventory when every long-lived service
  # belongs to the closed release plane. Default only when no argument exists.
  local wanted_running=${1-$bridge_expected_running}
  writer_state_check_active restored || writer_state_check_active fenced || return 1
  if ((${#bridge_writer_services[@]})); then
    compose_current stop --timeout 45 "${bridge_writer_services[@]}" || true
  fi
  "$writer_state_helper" --ops-root "$ROOT" fence \
    --snapshot "$active_writer_snapshot" \
    --expected-sha256 "$active_writer_snapshot_sha" >/dev/null || true
  wait_writer_state fenced "$wanted_running"
}

restore_all_writers() {
  if ((${#bridge_writer_services[@]})); then
    compose_current up -d --force-recreate --no-build --no-deps \
      --wait --wait-timeout 180 "${bridge_writer_services[@]}" || return 1
  fi
  "$writer_state_helper" --ops-root "$ROOT" restore \
    --snapshot "$active_writer_snapshot" \
    --expected-sha256 "$active_writer_snapshot_sha" >/dev/null || true
  wait_writer_state restored "$expected_long_lived"
}

restore_external_writer_units() {
  "$writer_state_helper" --ops-root "$ROOT" restore \
    --snapshot "$active_writer_snapshot" \
    --expected-sha256 "$active_writer_snapshot_sha" >/dev/null || true
  wait_writer_state restored "$expected_long_lived"
}

release_plane_is_stopped() {
  local service container_id state_line running_state pid extra
  for service in "${release_plane_services[@]}"; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ $container_id != *$'\n'* ]] || return 1
    [[ -n $container_id ]] || continue
    state_line=$(docker_cli inspect --format '{{.State.Running}} {{.State.Pid}}' "$container_id") \
      || return 1
    read -r running_state pid extra <<<"$state_line"
    [[ $running_state == false && $pid == 0 && -z ${extra:-} ]] || return 1
  done
}

quiesce_release_plane() {
  compose_current stop --timeout 45 "${release_plane_services[@]}" || true
  release_plane_is_stopped || return 1
  printf 'release mutation gate CLOSED: gateway, console, dispatcher and central services are stopped\n' >&2
}

release_abort_requested=0
release_abort_signal=
transition_ingress_quiesced=0

record_release_signal() {
  release_abort_requested=1
  release_abort_signal=$1
  printf 'release signal %s received; the transaction will compensate at the next bounded phase boundary\n' \
    "$release_abort_signal" >&2
}

abort_if_requested() {
  ((release_abort_requested == 0)) || {
    printf 'release deploy aborting safely on signal %s\n' "$release_abort_signal" >&2
    return 130
  }
}

release_exit_guard() {
  local status=$1
  trap - EXIT
  if ((status != 0 && transition_ingress_quiesced == 1)); then
    printf 'release ingress gate remains CLOSED after an incomplete or ambiguous transaction\n' >&2
  fi
  return "$status"
}

verify_nonrelease_containers_unchanged() {
  local service container_id running_id configured_reference running_config_hash
  for service in "${bridge_observability_services[@]}" "${bridge_infrastructure_services[@]}"; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ $container_id == "${observed_service_containers[$service]}" ]] || return 1
    running_id=$(docker_cli inspect --format '{{.Image}}' "$container_id") || return 1
    configured_reference=$(docker_cli inspect --format '{{.Config.Image}}' "$container_id") || return 1
    running_config_hash=$(docker_cli inspect \
      --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$container_id") || return 1
    [[ $running_id == "${observed_service_ids[$service]}" \
       && $configured_reference == "${observed_service_images[$service]}" \
       && $running_config_hash == "${observed_service_config_hashes[$service]}" ]] || return 1
  done
}

publish_fragment_snapshot() {
  ((fragmented_legacy == 1)) || return 0
  printf '%s' "$fragment_snapshot_content" | "${canonical_env[@]}" \
    python3 -c '
import hashlib
import os
import pathlib
import secrets
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
data = sys.stdin.buffer.read()
observed = "sha256:" + hashlib.sha256(data).hexdigest()
if observed != expected:
    raise SystemExit("legacy snapshot digest changed before publication")
parent = path.parent
name = path.name
if not path.is_absolute() or not name or name in {".", ".."}:
    raise SystemExit("legacy snapshot destination is invalid")
directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
temporary = f".{name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
linked = False
published = False
try:
    metadata = os.fstat(directory)
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid not in {0, os.geteuid()}
            or stat.S_IMODE(metadata.st_mode) & 0o022):
        raise SystemExit("legacy snapshot parent changed before publication")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(
            temporary,
            name,
            src_dir_fd=directory,
            dst_dir_fd=directory,
            follow_symlinks=False,
        )
        linked = True
        os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
        published = True
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        if linked and not published:
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.fsync(directory)
finally:
    os.close(directory)
' "$fragment_snapshot_path" "$fragment_snapshot_sha"
}

fragment_snapshot_check() {
  ((fragmented_legacy == 1)) || return 0
  private_selector_file "$fragment_snapshot_path" 'fragmented legacy snapshot' || return 1
  "${canonical_env[@]}" python3 - "$fragment_snapshot_path" "$fragment_snapshot_sha" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
observed = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
if observed != expected:
    raise SystemExit("fragmented legacy snapshot digest changed")
PY
}

compose_fragment() {
  local result
  manifest_check "$current_manifest" "$current_manifest_sha" 1 || return 1
  set +e
  printf '%s' "$fragment_compose_yaml" | "${canonical_env[@]}" \
    "$compose_helper" prod -f - "$@"
  result=$?
  set -e
  manifest_check "$current_manifest" "$current_manifest_sha" 1 || return 1
  return "$result"
}

verify_fragment_services() {
  local service container_id running_id configured_reference running_config_hash
  local fragment_hash_line fragment_hash_service fragment_config_hash fragment_extra
  local running_now materialized_now running_normalized_now materialized_normalized_now
  running_now=$(compose_current ps --services --status running) || return 1
  materialized_now=$(compose_current ps --all --services) || return 1
  running_normalized_now=$(normalize_inventory <<<"$running_now") || return 1
  materialized_normalized_now=$(normalize_inventory <<<"$materialized_now") || return 1
  [[ $running_normalized_now == "$expected_long_lived" \
     && $materialized_normalized_now == "$expected_materialized" ]] || return 1
  for service in ${expected_long_lived}; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ -n $container_id && $container_id != *$'\n'* ]] || return 1
    running_id=$(docker_cli inspect --format '{{.Image}}' "$container_id") || return 1
    configured_reference=$(docker_cli inspect --format '{{.Config.Image}}' "$container_id") || return 1
    running_config_hash=$(docker_cli inspect \
      --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$container_id") || return 1
    fragment_hash_line=$(compose_fragment config --hash "$service") || return 1
    read -r fragment_hash_service fragment_config_hash fragment_extra <<<"$fragment_hash_line"
    [[ $running_id == "${observed_service_ids[$service]}" \
       && $configured_reference == "${observed_service_images[$service]}" \
       && $running_config_hash == "${observed_service_config_hashes[$service]}" \
       && $fragment_hash_service == "$service" && -z ${fragment_extra:-} \
       && $fragment_config_hash == "${observed_service_config_hashes[$service]}" ]] || return 1
  done
  health_current || return 1
}

verify_fragment_capture_unchanged() {
  ((fragmented_legacy == 1)) || return 0
  verify_fragment_services || return 1
  local service container_id
  for service in ${expected_long_lived}; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ $container_id == "${observed_service_containers[$service]}" ]] || return 1
  done
}

verify_current_canonical_fleet() {
  local service container_id running_id configured_reference running_config_hash
  local config_hash_line config_hash_service expected_config_hash config_extra
  local running_now materialized_now running_normalized_now materialized_normalized_now
  running_now=$(compose_current ps --services --status running) || return 1
  materialized_now=$(compose_current ps --all --services) || return 1
  running_normalized_now=$(normalize_inventory <<<"$running_now") || return 1
  materialized_normalized_now=$(normalize_inventory <<<"$materialized_now") || return 1
  [[ $running_normalized_now == "$expected_long_lived" \
     && $materialized_normalized_now == "$expected_materialized" ]] || return 1
  for service in ${expected_long_lived}; do
    container_id=$(compose_current ps -q "$service") || return 1
    [[ -n $container_id && $container_id != *$'\n'* ]] || return 1
    running_id=$(docker_cli inspect --format '{{.Image}}' "$container_id") || return 1
    configured_reference=$(docker_cli inspect --format '{{.Config.Image}}' "$container_id") || return 1
    running_config_hash=$(docker_cli inspect \
      --format '{{ index .Config.Labels "com.docker.compose.config-hash" }}' "$container_id") || return 1
    config_hash_line=$(compose_current config --hash "$service") || return 1
    read -r config_hash_service expected_config_hash config_extra <<<"$config_hash_line"
    [[ $running_id == "${current_image_ids[${current_service_images[$service]}]}" \
       && $configured_reference == "${current_service_images[$service]}" \
       && $config_hash_service == "$service" && -z ${config_extra:-} \
       && $running_config_hash == "$expected_config_hash" \
       && $expected_config_hash == "${canonical_service_config_hashes[$service]}" ]] || return 1
  done
  health_current || return 1
}

restore_fragment() {
  fragment_snapshot_check || return 1
  pin_transition check "${current_state_transition[@]}" >/dev/null || return 1
  compose_fragment up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${release_services[@]}" || return 1
  restore_external_writer_units || return 1
  verify_fragment_services || return 1
}

normalize_fragment() {
  compose_current up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${release_services[@]}" || return 1
  verify_current_canonical_fleet || return 1
}

deploy_target() {
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=migrator
  compose_current run --rm --no-deps -T migrator || return 1
  migration_durable=1
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=schema-verification
  migrated_schema=$(compose_current run --rm --no-deps -T migrator \
    node deploy/schema-version.mjs) || return 1
  migrated_schema=${migrated_schema%$'\r'}
  [[ $migrated_schema == "$target_schema" ]] || return 1
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=migration-integrity-post
  compose_current run --rm --no-deps -T migrator \
    node deploy/migration-integrity.mjs post >/dev/null || return 1
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=go-recreate
  printf 'release GO BEGIN: target ingress is reopening only after CAS, migration and post-integrity passed\n' >&2
  compose_current up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${release_services[@]}" || return 1
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=restore-external-writers
  restore_external_writer_units || return 1
  CAUCE_DEPLOY_STAGE=publish-candidate-marker
  marker_write "$target_writer_snapshot" "$target_writer_snapshot_sha" \
    "$target_commit" candidate \
    "$writer_expected_candidate" "$writer_expected_candidate" || return 1
  CAUCE_DEPLOY_STAGE=recreate-marker-consumer
  compose_current up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 outbox-metrics || return 1
  abort_if_requested || return 130
  CAUCE_DEPLOY_STAGE=image-verification
  verify_release_services \
    "$target_runtime_id" "$target_console_id" "$target_runtime" "$target_console" || return 1
  CAUCE_DEPLOY_STAGE=health
  health_current || return 1
  abort_if_requested || return 130
  if ((maintenance == 1)); then
    CAUCE_DEPLOY_STAGE=maintenance-release-gate
    manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
    "${canonical_env[@]}" "$release_gate" --maintenance-offline-zeus || return 1
    manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  else
    CAUCE_DEPLOY_STAGE=release-host-ready
    manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
    "${canonical_env[@]}" "$release_candidate" --release-host-ready || return 1
    manifest_check "$active_manifest" "$active_manifest_sha" 1 || return 1
  fi
  CAUCE_DEPLOY_STAGE=final-selector-check
  pin_transition check \
    "$target_runtime" "$target_runtime" "$target_console" "$target_console" \
    "$target_manifest" "$target_manifest" "$target_manifest_sha" "$target_manifest_sha" \
    "$target_baseline" "$target_baseline" \
    "$target_baseline_sha" "$target_baseline_sha" \
    "$target_writer_snapshot" "$target_writer_snapshot" \
    "$target_writer_snapshot_sha" "$target_writer_snapshot_sha" \
    "$target_commit" "$target_runtime" "$target_source_digest" >/dev/null || return 1
  transition_ingress_quiesced=0
  printf 'release GO COMMITTED: target ingress, writers, health and final selector checks are complete\n' >&2
}

restore_current() {
  if ((current_is_bridge == 1)); then
    marker_write "$current_writer_snapshot" "$current_writer_snapshot_sha" \
      "$current_forward_commit" rollback_bridge_degraded 0 0 || return 1
    "$writer_state_helper" --ops-root "$ROOT" fence \
      --snapshot "$current_writer_snapshot" \
      --expected-sha256 "$current_writer_snapshot_sha" >/dev/null || true
    remove_bridge_mutators || return 1
    compose_current up -d --force-recreate --no-build --no-deps \
      --wait --wait-timeout 180 "${bridge_core_services[@]}" || return 1
    wait_writer_state fenced "$bridge_expected_running" || return 1
    bridge_mutators_are_absent || return 1
    verify_service_set \
      "$current_runtime_id" "$current_console_id" "$current_runtime" "$current_console" \
      "${bridge_core_services[@]}" || return 1
    bridge_health "$current_forward_commit" || return 1
    pin_transition check "${current_state_transition[@]}" >/dev/null
    return
  fi
  marker_write "$current_writer_snapshot" "$current_writer_snapshot_sha" \
    "$current_forward_commit" candidate \
    "$current_writer_expected_candidate" "$current_writer_expected_candidate" || return 1
  if ((fragmented_legacy == 1)); then
    restore_fragment || return 1
  else
    compose_current up -d --force-recreate --no-build --no-deps \
      --wait --wait-timeout 180 "${release_services[@]}" || return 1
    restore_external_writer_units || return 1
    verify_release_services \
      "$current_runtime_id" "$current_console_id" "$current_runtime" "$current_console" || return 1
    health_current || return 1
  fi
  pin_transition check \
    "$current_runtime" "$current_runtime" "$current_console" "$current_console" \
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha" \
    "$current_baseline" "$current_baseline" \
    "$current_baseline_sha" "$current_baseline_sha" \
    "$current_writer_snapshot" "$current_writer_snapshot" \
    "$current_writer_snapshot_sha" "$current_writer_snapshot_sha" \
    "$current_forward_commit" "$current_forward_runtime" "$current_forward_source" >/dev/null || return 1
}

restore_bridge() {
  marker_write "$target_writer_snapshot" "$target_writer_snapshot_sha" \
    "$target_commit" rollback_bridge_degraded 0 0 || return 1
  "$writer_state_helper" --ops-root "$ROOT" fence \
    --snapshot "$target_writer_snapshot" \
    --expected-sha256 "$target_writer_snapshot_sha" >/dev/null || true
  remove_bridge_mutators || return 1
  compose_current up -d --force-recreate --no-build --no-deps \
    --wait --wait-timeout 180 "${bridge_core_services[@]}" || return 1
  wait_writer_state fenced "$bridge_expected_running" || return 1
  bridge_mutators_are_absent || return 1
  verify_service_set \
    "$target_rollback_runtime_id" "$current_console_id" \
    "$target_rollback_runtime" "$current_console" "${bridge_core_services[@]}" || return 1
  verify_nonrelease_containers_unchanged || return 1
  bridge_health "$target_commit" || return 1
  bridge_schema=$(compose_current run --rm --no-deps -T migrator \
    node deploy/schema-version.mjs) || return 1
  bridge_schema=${bridge_schema%$'\r'}
  [[ $bridge_schema == "$target_schema" ]] || return 1
  pin_transition check \
    "$target_rollback_runtime" "$target_rollback_runtime" \
    "$current_console" "$current_console" \
    "$current_manifest" "$current_manifest" "$current_manifest_sha" "$current_manifest_sha" \
    "$target_baseline" "$target_baseline" \
    "$target_baseline_sha" "$target_baseline_sha" \
    "$target_writer_snapshot" "$target_writer_snapshot" \
    "$target_writer_snapshot_sha" "$target_writer_snapshot_sha" \
    "$target_commit" "$target_runtime" "$target_source_digest" >/dev/null || return 1
}

if ((fragmented_legacy == 1)); then
  if ! verify_fragment_capture_unchanged; then
    printf 'release deploy refused: fragmented physical fleet changed before evidence publication\n' >&2
    exit 1
  fi
  publish_fragment_snapshot || {
    printf 'release deploy failed: fragmented legacy snapshot was not published atomically\n' >&2
    exit 1
  }
  fragment_snapshot_check || {
    printf 'CRITICAL: fragmented legacy snapshot changed immediately after atomic publication\n' >&2
    exit 74
  }
  if ! verify_fragment_capture_unchanged; then
    printf 'release deploy refused: fragmented physical fleet changed after evidence publication and before normalization\n' >&2
    exit 1
  fi
  if ! normalize_fragment; then
    printf 'release deploy failed while normalizing the fragmented expected-old fleet; restoring its exact snapshot\n' >&2
    if ! restore_fragment; then
      printf 'CRITICAL: fragmented expected-old normalization failed and its exact service/config/image snapshot could not be restored\n' >&2
      exit 74
    fi
    printf 'release deploy failed safely before CAS: the exact fragmented expected-old fleet and health were restored\n' >&2
    exit 1
  fi
  if ! fragment_snapshot_check \
     || ! manifest_check "$current_manifest" "$current_manifest_sha" 1 \
     || ! manifest_check "$target_manifest" "$target_manifest_sha" \
     || ! pin_transition check "${forward_transition[@]}" >/dev/null \
     || ! verify_current_canonical_fleet; then
    printf 'release deploy refused: state changed after legacy normalization and before CAS; restoring the exact fragmented snapshot\n' >&2
    if ! restore_fragment; then
      printf 'CRITICAL: post-normalization admission drifted and the exact fragmented fleet could not be restored\n' >&2
      exit 74
    fi
    printf 'release deploy failed safely before CAS: post-normalization drift was rejected and the exact fragmented fleet was restored\n' >&2
    exit 1
  fi
fi

trap 'record_release_signal HUP' HUP
trap 'record_release_signal INT' INT
trap 'record_release_signal TERM' TERM
trap 'record_release_signal QUIT' QUIT
trap 'release_exit_guard "$?"' EXIT

# Close every externally reachable release process before the selector CAS.
# The stopped container state is durable across a shell crash/SIGKILL; a later
# operator cannot mistake it for an admitted target because the provisional
# writer marker remains rollback_bridge_degraded until GO begins.
if ! quiesce_release_plane; then
  printf 'release deploy refused: central ingress could not be proven stopped; restoring expected-old mode\n' >&2
  if ! restore_current; then
    printf 'CRITICAL: partial ingress stop could not be restored exactly\n' >&2
    transition_ingress_quiesced=1
    exit 74
  fi
  printf 'release deploy failed safely before CAS: exact expected-old ingress was restored\n' >&2
  exit 1
fi
transition_ingress_quiesced=1
if ! quiesce_all_writers "$quiesced_expected_running"; then
  printf 'release deploy refused: all writers could not be proven stopped; restoring expected-old mode\n' >&2
  if ! restore_current; then
    printf 'CRITICAL: partial writer/ingress stop could not be restored exactly\n' >&2
    exit 74
  fi
  transition_ingress_quiesced=0
  printf 'release deploy failed safely before CAS: exact expected-old services were restored\n' >&2
  exit 1
fi
if ! candidate_database_preflight; then
  if ! restore_current; then
    printf 'CRITICAL: candidate database preflight failed and exact expected-old mode could not be restored\n' >&2
    exit 74
  fi
  transition_ingress_quiesced=0
  printf 'release deploy failed safely before CAS: candidate database preflight was rejected under closed ingress\n' >&2
  exit 1
fi
if ! abort_if_requested; then
  if ! restore_current; then
    printf 'CRITICAL: signalled pre-CAS transaction could not restore expected-old mode\n' >&2
    exit 74
  fi
  transition_ingress_quiesced=0
  exit 130
fi
if ! pin_transition swap "${forward_transition[@]}" >/dev/null; then
  if pin_transition check "${target_state_transition[@]}" >/dev/null; then
    printf 'release deploy detected a lost forward-CAS response after selectors changed; compensating\n' >&2
    if ! pin_transition swap "${inverse_transition[@]}" >/dev/null; then
      printf 'CRITICAL: lost forward-CAS response selected target state and inverse selector CAS failed\n' >&2
      exit 70
    fi
    active_manifest=$current_manifest
    active_manifest_sha=$current_manifest_sha
    active_writer_snapshot=$current_writer_snapshot
    active_writer_snapshot_sha=$current_writer_snapshot_sha
    active_baseline_kind=$current_baseline_kind
  elif pin_transition check "${current_state_transition[@]}" >/dev/null; then
    active_manifest=$current_manifest
    active_manifest_sha=$current_manifest_sha
    active_writer_snapshot=$current_writer_snapshot
    active_writer_snapshot_sha=$current_writer_snapshot_sha
    active_baseline_kind=$current_baseline_kind
  else
    printf 'CRITICAL: forward CAS failed with selectors in neither exact old nor exact target state\n' >&2
    exit 75
  fi
  if ! restore_current; then
    printf 'CRITICAL: forward CAS failure could not restore the exact expected-old services\n' >&2
    exit 71
  fi
  transition_ingress_quiesced=0
  printf 'release deploy failed safely before migration; exact expected-old selectors and services were restored\n' >&2
  exit 1
fi
active_manifest=$target_manifest
active_manifest_sha=$target_manifest_sha
active_writer_snapshot=$target_writer_snapshot
active_writer_snapshot_sha=$target_writer_snapshot_sha
active_baseline_kind=$target_baseline_kind

failure=0
migration_durable=0
CAUCE_DEPLOY_STAGE=publish-provisional-read-only-marker
if ! marker_write "$target_writer_snapshot" "$target_writer_snapshot_sha" \
    "$target_commit" rollback_bridge_degraded 0 0; then
  failure=1
elif deploy_target; then
  if ((maintenance == 1)); then
    printf 'release deploy committed under bounded Zeus maintenance; strict release-host-ready remains fail-closed\n'
  else
    printf 'release deploy committed with strict release-host-ready evidence\n'
  fi
  exit 0
else
  failure=$?
fi

printf 'release deploy failed during %s; compensating the complete selector and service transaction\n' \
  "${CAUCE_DEPLOY_STAGE:-unknown}" >&2
if ((migration_durable == 0)) && [[ ${CAUCE_DEPLOY_STAGE:-} == migrator ]]; then
  # The migration runner is one PostgreSQL transaction, but a lost client can report failure
  # after COMMIT. Measure the durable schema before deciding whether the old runtime is safe.
  if observed_schema=$(compose_current run --rm --no-deps -T migrator \
      node deploy/schema-version.mjs); then
    observed_schema=${observed_schema%$'\r'}
    if [[ $observed_schema == "$target_schema" \
       && $observed_schema != "$pre_migration_schema" ]]; then
      migration_durable=1
    elif [[ $observed_schema != "$pre_migration_schema" ]]; then
      printf 'CRITICAL: migration outcome changed the database to an unaccredited schema; automatic compensation refused\n' >&2
      exit 72
    fi
  else
    printf 'CRITICAL: migration outcome is ambiguous and database schema cannot be measured; automatic compensation refused\n' >&2
    exit 72
  fi
fi

if ((migration_durable == 1)); then
  CAUCE_DEPLOY_STAGE=close-ingress-for-bridge
  if ! quiesce_release_plane; then
    printf 'CRITICAL: target schema is durable and central ingress could not be proven closed before bridge selection\n' >&2
    exit 74
  fi
  transition_ingress_quiesced=1
  CAUCE_DEPLOY_STAGE=quiesce-writers-for-bridge
  if ! quiesce_all_writers "$quiesced_expected_running"; then
    printf 'CRITICAL: target schema is durable but global writers could not be proven stopped; ingress remains closed\n' >&2
    exit 73
  fi
  if ! pin_transition swap "${bridge_transition[@]}" >/dev/null; then
    if ! pin_transition check "${bridge_state_transition[@]}" >/dev/null; then
      printf 'CRITICAL: post-migration compensation could not select the accredited target-schema bridge; ingress remains closed\n' >&2
      exit 70
    fi
    printf 'release deploy detected a lost bridge-CAS response after bridge selectors became durable; continuing verification\n' >&2
  fi
  active_manifest=$current_manifest
  active_manifest_sha=$current_manifest_sha
  active_writer_snapshot=$target_writer_snapshot
  active_writer_snapshot_sha=$target_writer_snapshot_sha
  active_baseline_kind=$target_baseline_kind
  if ! restore_bridge; then
    printf 'CRITICAL: post-migration compensation selected bridge selectors but did not restore healthy target-schema services\n' >&2
    exit 71
  fi
  transition_ingress_quiesced=0
  printf 'release deploy failed safely after durable migration: accredited target-schema bridge, prior console/manifest and health were restored\n' >&2
else
  if ! pin_transition swap "${inverse_transition[@]}" >/dev/null; then
    if ! pin_transition check "${current_state_transition[@]}" >/dev/null; then
      printf 'CRITICAL: pre-migration compensation could not restore the prior eight selectors\n' >&2
      exit 70
    fi
    printf 'release deploy detected a lost inverse-CAS response after prior selectors became durable; continuing verification\n' >&2
  fi
  active_manifest=$current_manifest
  active_manifest_sha=$current_manifest_sha
  active_writer_snapshot=$current_writer_snapshot
  active_writer_snapshot_sha=$current_writer_snapshot_sha
  active_baseline_kind=$current_baseline_kind
  if ! restore_current; then
    printf 'CRITICAL: pre-migration compensation restored selectors but not the prior healthy services\n' >&2
    exit 71
  fi
  transition_ingress_quiesced=0
  printf 'release deploy failed safely before durable migration: exact prior selectors, images and health were restored\n' >&2
fi
exit "$failure"
