#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
release_target=${1:?usage: build-adapter-release.sh /absolute/new/release}
[[ $release_target == /* && ! -e $release_target ]] || {
  echo 'release destination must be absolute and must not exist' >&2; exit 1;
}
cd "$repo_root"
[[ -z $(git status --porcelain) ]] || {
  echo 'commit the release sources before building' >&2; exit 1;
}
pnpm --filter @cauce/protocol build
pnpm build:adapter
node packages/adapter-sdk/scripts/package-smoke.mjs
pnpm --filter @cauce/adapter-sdk deploy --legacy --prod "$release_target/packages/adapter-sdk"
python3 - "$release_target" <<'PY'
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
package = root / 'packages/adapter-sdk'
self_link = package / 'node_modules/.pnpm/node_modules/@cauce/adapter-sdk'
if self_link.is_symlink():
    self_link.unlink()
    self_link.symlink_to(os.path.relpath(package, self_link.parent))
for entry in root.rglob('*'):
    if entry.is_symlink() and not entry.resolve().is_relative_to(root):
        raise SystemExit(f'bundle link escapes release: {entry.relative_to(root)}')
for harness in ('claude', 'codex', 'openclaw'):
    entry = package / f'dist/src/bin/{harness}.js'
    if not entry.is_file() or not entry.stat().st_mode & 0o111:
        raise SystemExit(f'missing executable: {harness}')
PY
chmod -R a-w "$release_target"
python3 ops/container-runtime/cauce-container-runtime.py bundle-digest "$release_target"
git rev-parse HEAD
