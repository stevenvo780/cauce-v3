#!/usr/bin/env bash
set -euo pipefail
exec python3 -I -B "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/v4-cli-cross-machine.lab.py" "$@"
