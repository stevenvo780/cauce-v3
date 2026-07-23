#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dir=${1:-"$ROOT/artifacts"}
[[ -f "$dir/SHA256SUMS" ]] || { printf 'missing %s/SHA256SUMS\n' "$dir" >&2; exit 2; }
(cd "$dir" && sha256sum -c SHA256SUMS)
