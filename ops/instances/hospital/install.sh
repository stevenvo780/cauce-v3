#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 || "$2" != --descriptor || ! "$1" =~ ^(plan|install|update|status)$ ]]; then
  printf '%s\n' 'Uso: install.sh {plan|install|update|status} --descriptor ARCHIVO' >&2
  exit 64
fi
HERE=$(cd "$(dirname "$0")" && pwd)
exec python3 "$HERE/install-profile.py" "$@"
