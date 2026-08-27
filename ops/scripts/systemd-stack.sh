#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# == 2 ]] || { printf 'usage: %s dev|test start|reload|stop\n' "$0" >&2; exit 64; }
target=$1
operation=$2

case "$target:$operation" in
  dev:start|dev:reload|test:start|test:reload)
    exec "$ROOT/scripts/compose.sh" "$target" up -d --wait
    ;;
  dev:stop|test:stop)
    exec "$ROOT/scripts/compose.sh" "$target" down
    ;;
  *)
    printf 'unsupported systemd stack transition\n' >&2
    exit 64
    ;;
esac
