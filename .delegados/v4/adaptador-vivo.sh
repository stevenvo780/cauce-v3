#!/usr/bin/env bash
set -euo pipefail
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 -I -B "$script_directory/live_adapter.py" "$@"
