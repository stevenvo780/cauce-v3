#!/usr/bin/env bash
set -euo pipefail
umask 077
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 -I -B "$script_root/limpiar-huerfanos-driver.py" "$@"
