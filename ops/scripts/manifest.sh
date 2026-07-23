#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dir=${1:-"$ROOT/artifacts"}
mkdir -p "$dir"
manifest="$dir/SHA256SUMS"
tmp="$manifest.tmp"
trap 'rm -f "$tmp"' EXIT

(
  cd "$dir"
  files=()
  for file in report.json junit.xml build.json; do
    [[ -f "$file" ]] && files+=("$file")
  done
  ((${#files[@]} > 0)) || { printf 'no QA/build artifacts found\n' >&2; exit 1; }
  sha256sum "${files[@]}"
) >"$tmp"
mv "$tmp" "$manifest"
printf '%s\n' "$manifest"
