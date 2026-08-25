#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:?usage: compose.sh dev|test|authentic|prod <compose args...>}
shift

case "$target" in
  dev) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/dev.env"} ;;
  test) env_file= ;;
  authentic) env_file= ;;
  prod) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"} ;;
  *) printf 'unsupported compose target: %s\n' "$target" >&2; exit 2 ;;
esac

env_args=()
if [[ -n $env_file ]]; then
  [[ -f $env_file ]] || { printf 'missing private env file: %s (copy the matching .example)\n' "$env_file" >&2; exit 2; }
  env_args=(--env-file "$env_file")

  # Only these non-secret control values are needed before Compose starts.
  # Parse them as data instead of sourcing the whole env file as shell code;
  # an already-exported caller value retains Docker Compose's normal precedence.
  for control in CAUCE_LOCAL_POSTGRES CAUCE_COMPOSE_OVERRIDE_MANIFEST CAUCE_COMPOSE_OVERRIDES_DIR; do
    [[ -v $control ]] && continue
    mapfile -t matches < <(sed -n "/^${control}=/p" "$env_file")
    ((${#matches[@]} <= 1)) || { printf 'duplicate %s in %s\n' "$control" "$env_file" >&2; exit 2; }
    if ((${#matches[@]} == 1)); then
      value=${matches[0]#*=}; value=${value%$'\r'}
      [[ $value != *$'\n'* ]] || { printf 'invalid newline in %s\n' "$control" >&2; exit 2; }
      printf -v "$control" '%s' "$value"
      export "$control"
    fi
  done
fi

docker compose version >/dev/null 2>&1 || { printf 'Docker Compose v2 is required\n' >&2; exit 127; }
list=$("$ROOT/scripts/compose-files.sh" "$target") || {
  rc=$?
  printf 'compose.sh: refusing to continue with an incomplete Compose file set (rc=%s)\n' "$rc" >&2
  exit "$rc"
}
compose_files=()
while IFS= read -r file; do
  [[ -n $file ]] || continue
  [[ -f $file && -r $file ]] || { printf 'compose file is unreadable: %s\n' "$file" >&2; exit 3; }
  compose_files+=(-f "$file")
done <<<"$list"
((${#compose_files[@]} > 0)) || { printf 'compose file set is empty\n' >&2; exit 3; }
exec docker compose "${env_args[@]}" "${compose_files[@]}" "$@"
