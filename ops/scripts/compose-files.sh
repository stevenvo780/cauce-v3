#!/usr/bin/env bash
# Emit the one authoritative, ordered Compose file set for every operation.
#
# Production overrides are never discovered with a glob.  If they are needed,
# CAUCE_COMPOSE_OVERRIDE_MANIFEST must point to a regular manifest next to the
# YAML files.  Every first-level *.yaml must be declared exactly once as either:
#
#   active   <sha256>  <basename.yaml>
#   inactive <sha256>  <basename.yaml>
#
# Active entries are emitted in manifest order; inactive entries are retained
# and authenticated but cannot silently re-enter the stack.  A missing,
# changed, duplicate, unlisted or symlinked file fails closed before Docker is
# invoked.
set -euo pipefail

OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(cd "$OPS/.." && pwd)
overrides_dir=${CAUCE_COMPOSE_OVERRIDES_DIR:-/etc/cauce-v3/compose-overrides}
manifest=${CAUCE_COMPOSE_OVERRIDE_MANIFEST:-}
manifest_sha256=${CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256:-}

fail() {
  printf 'compose-files: %s\n' "$*" >&2
  exit 3
}

list_overrides() {
  local manifest_dir line state digest filename extra path actual found manifest_actual
  local -a active=() discovered=()
  local -A declared=()

  if [[ -z $manifest ]]; then
    [[ -z $manifest_sha256 ]] || fail 'manifest SHA-256 is set while CAUCE_COMPOSE_OVERRIDE_MANIFEST is unset'
    if [[ -e $overrides_dir ]]; then
      [[ -d $overrides_dir && -r $overrides_dir && -x $overrides_dir ]] ||
        fail "$overrides_dir exists but cannot be enumerated"
      mapfile -t discovered < <(
        find "$overrides_dir" -maxdepth 1 \( -type f -o -type l \) -name '*.yaml' -print | LC_ALL=C sort
      )
      ((${#discovered[@]} == 0)) ||
        fail "${#discovered[@]} production override(s) exist but CAUCE_COMPOSE_OVERRIDE_MANIFEST is unset"
    fi
    return 0
  fi

  [[ $manifest = /* ]] || fail 'CAUCE_COMPOSE_OVERRIDE_MANIFEST must be an absolute path'
  [[ $manifest_sha256 =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail 'CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256 must be an explicit sha256 digest'
  [[ -f $manifest && -r $manifest && ! -L $manifest ]] ||
    fail "override manifest is missing, unreadable or a symlink: $manifest"
  manifest_actual="sha256:$(sha256sum "$manifest" | cut -d' ' -f1)"
  [[ $manifest_actual == "$manifest_sha256" ]] || fail 'override manifest differs from its selected SHA-256'
  manifest_dir=$(cd "$(dirname "$manifest")" && pwd -P)

  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ -z $line || $line == \#* ]] && continue
    read -r state digest filename extra <<<"$line"
    [[ -z ${extra:-} && ${state:-} =~ ^(active|inactive)$ &&
       ${digest:-} =~ ^[0-9a-f]{64}$ && ${filename:-} =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] ||
      fail "invalid manifest entry (expected: active|inactive SHA256 basename.yaml)"
    [[ $filename != */* && $filename != .* && $filename != *..* ]] ||
      fail "unsafe override basename: $filename"
    [[ -z ${declared[$filename]+x} ]] || fail "override declared more than once: $filename"
    path="$manifest_dir/$filename"
    [[ -f $path && -r $path && ! -L $path ]] ||
      fail "declared override is missing, unreadable or a symlink: $filename"
    actual=$(sha256sum "$path" | cut -d' ' -f1)
    [[ $actual == "$digest" ]] || fail "SHA-256 mismatch for override: $filename"
    declared[$filename]=$state
    [[ $state == active ]] && active+=("$path")
  done <"$manifest"

  mapfile -t discovered < <(
    find "$manifest_dir" -maxdepth 1 \( -type f -o -type l \) -name '*.yaml' -print | LC_ALL=C sort
  )
  for path in "${discovered[@]}"; do
    filename=${path##*/}
    [[ -n ${declared[$filename]+x} ]] || fail "override is present but absent from manifest: $filename"
  done
  for filename in "${!declared[@]}"; do
    found=0
    for path in "${discovered[@]}"; do [[ ${path##*/} == "$filename" ]] && found=1; done
    ((found == 1)) || fail "manifest entry escaped directory inventory: $filename"
  done

  manifest_actual="sha256:$(sha256sum "$manifest" | cut -d' ' -f1)"
  [[ $manifest_actual == "$manifest_sha256" ]] || fail 'override manifest changed while resolving Compose files'

  ((${#active[@]} == 0)) || printf '%s\n' "${active[@]}"
}

target=${1:?usage: compose-files.sh dev|test|prod|overrides}
case "$target" in
  dev) printf '%s\n' "$REPO/deploy/compose.dev.yaml" ;;
  test) printf '%s\n' "$OPS/compose.test.yaml" ;;
  overrides) list_overrides ;;
  prod)
    printf '%s\n' "$REPO/deploy/compose.yaml"
    [[ ${CAUCE_LOCAL_POSTGRES:-0} == 0 ]] || {
      [[ ${CAUCE_LOCAL_POSTGRES:-0} == 1 ]] || fail 'CAUCE_LOCAL_POSTGRES must be 0 or 1'
      printf '%s\n' "$REPO/deploy/compose.postgres.yaml"
    }
    list_overrides
    ;;
  *) printf 'compose-files: unsupported target: %s\n' "$target" >&2; exit 2 ;;
esac
