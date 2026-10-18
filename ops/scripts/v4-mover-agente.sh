#!/usr/bin/env bash
set -euo pipefail
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
exec python3 -I -B "$here/v4_mover_agente.py" "$@"
