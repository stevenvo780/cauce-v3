#!/usr/bin/env bash
# Capture a sanitized production registry snapshot and compare it with the release inventory.
# The query runs in the immutable runtime image, so this works with both the optional local
# PostgreSQL Compose service and an external TLS PostgreSQL endpoint.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
snapshot=$(mktemp)
trap 'rm -f "$snapshot"' EXIT
parity_args=()

if [[ -n ${CAUCE_FLEET_SNAPSHOT_FILE:-} ]]; then
  [[ ${CAUCE_FLEET_TEST_MODE:-0} == 1 && ${NODE_ENV:-} == test ]] || {
    printf 'fleet parity: supplied snapshots are accepted only in explicit test mode\n' >&2
    exit 2
  }
  [[ -f $CAUCE_FLEET_SNAPSHOT_FILE && -r $CAUCE_FLEET_SNAPSHOT_FILE && ! -L $CAUCE_FLEET_SNAPSHOT_FILE ]] || {
    printf 'fleet parity: CAUCE_FLEET_SNAPSHOT_FILE must be a readable regular non-symlink file\n' >&2
    exit 2
  }
  cp -- "$CAUCE_FLEET_SNAPSHOT_FILE" "$snapshot"
else
  case ${CAUCE_BOOTSTRAP_LEGACY_FLEET_PROBE:-0} in
    0)
      CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod run --rm --no-deps -T migrator \
        node deploy/fleet-snapshot.mjs >"$snapshot"
      ;;
    1)
      [[ ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-} =~ ^[0-9]+$ \
         && ${CAUCE_RELEASE_TRANSITION_LOCK_FD:-0} -ge 3 \
         && ${CAUCE_RELEASE_TRANSITION_LOCK_TOKEN:-} =~ ^[a-f0-9]{64}$ ]] || {
        printf 'fleet parity: bootstrap probe requires the authenticated release lock\n' >&2
        exit 2
      }
      fleet_probe="$ROOT/../deploy/fleet-snapshot.mjs"
      read -r probe_mode probe_links probe_owner < <(stat -c '%a %h %u' -- "$fleet_probe") || exit 1
      [[ -f $fleet_probe && ! -L $fleet_probe && $probe_links == 1 \
         && ( $probe_owner == 0 || $probe_owner == "$(id -u)" ) \
         && $((8#$probe_mode & 0022)) == 0 ]] || {
        printf 'fleet parity: versioned bootstrap fleet probe is unsafe\n' >&2
        exit 2
      }
      CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod run --rm --no-deps -T \
        migrator /bin/sh -ceu \
        'probe_dir=$(mktemp -d /tmp/cauce-fleet-snapshot.XXXXXX); probe=$probe_dir/probe.mjs; trap '\''rm -f -- "$probe"; rmdir -- "$probe_dir"'\'' EXIT HUP INT TERM; cat >"$probe"; chmod 0600 "$probe"; node "$probe"' \
        <"$fleet_probe" >"$snapshot"
      ;;
    *)
      printf 'fleet parity: invalid bootstrap legacy probe selector\n' >&2
      exit 2
      ;;
  esac
fi

args=()
while (($#)); do
  case "$1" in
    --legacy-pre-migration)
      parity_args+=(--legacy-pre-migration)
      shift
      ;;
    --expect-offline|--allow-extra-lease)
      (($# >= 2)) || { printf 'fleet parity: %s requires TENANT:ALIAS\n' "$1" >&2; exit 2; }
      args+=("$1" "$2")
      shift 2
      ;;
    *) printf 'fleet parity: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/fleet-parity.py" \
  --ops-root "$ROOT" --snapshot "$snapshot" "${parity_args[@]}" "${args[@]}"
