#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:?usage: compose.sh dev|test|authentic|prod <compose args...>}
shift

case "$target" in
  dev) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/dev.env"}; compose_files=(-f "$ROOT/../deploy/compose.dev.yaml") ;;
  test) env_file=; compose_files=(-f "$ROOT/compose.test.yaml") ;;
  authentic) env_file=; compose_files=(-f "$ROOT/compose.authentic.yaml") ;;
  prod) env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}; compose_files=(-f "$ROOT/../deploy/compose.yaml") ;;
  *) printf 'unsupported compose target: %s\n' "$target" >&2; exit 2 ;;
esac

if [[ -n $env_file ]]; then
  [[ -f $env_file ]] || { printf 'missing private env file: %s (copy the matching .example)\n' "$env_file" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

docker compose version >/dev/null 2>&1 || { printf 'Docker Compose v2 is required\n' >&2; exit 127; }
if [[ $target == prod && ${CAUCE_LOCAL_POSTGRES:-0} == 1 ]]; then
  compose_files+=(-f "$ROOT/../deploy/compose.postgres.yaml")
fi
exec docker compose "${compose_files[@]}" "$@"
