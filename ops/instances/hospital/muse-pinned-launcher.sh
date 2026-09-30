#!/usr/bin/env bash
set -euo pipefail
binary="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/muse-bin-1.4.1-R4503.1"
[[ -x "$binary" ]] || { echo 'Muse 1.4.1-R4503.1 is missing from the pinned mount' >&2; exit 2; }
exec "$binary" "$@"
