#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
release_target=${1:?usage: build-adapter-release.sh /absolute/new/release [ /absolute/approved-descriptors.json ]}
descriptor_approvals=${2:-}
[[ $release_target == /* && ! -e $release_target ]] || {
  echo 'release destination must be absolute and must not exist' >&2; exit 1;
}
[[ -z $descriptor_approvals || ( $descriptor_approvals == /* && -f $descriptor_approvals && ! -L $descriptor_approvals ) ]] || {
  echo 'descriptor approval map must be an absolute regular file' >&2; exit 1;
}
cd "$repo_root"
[[ -z $(git status --porcelain) ]] || {
  echo 'commit the release sources before building' >&2; exit 1;
}
pnpm --filter @cauce/protocol build
pnpm build:adapter
node packages/adapter-sdk/scripts/package-smoke.mjs
pnpm --filter @cauce/adapter-sdk deploy --legacy --prod "$release_target/packages/adapter-sdk"
python3 - "$release_target" "$descriptor_approvals" "$repo_root" <<'PY'
import json
import os
import pathlib
import shutil
import stat
import sys
import tempfile

root = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(pathlib.Path(sys.argv[3]) / 'ops/cli'))
approvals = json.loads(pathlib.Path(sys.argv[2]).read_text()) if sys.argv[2] else {}
if not isinstance(approvals, dict):
    raise SystemExit('descriptor approvals must be a harness-to-sha256 object')
package = root / 'packages/adapter-sdk'
self_link = package / 'node_modules/.pnpm/node_modules/@cauce/adapter-sdk'
if self_link.is_symlink():
    self_link.unlink()
    self_link.symlink_to(os.path.relpath(package, self_link.parent))
for entry in root.rglob('*'):
    if entry.is_symlink() and not entry.resolve().is_relative_to(root):
        raise SystemExit(f'bundle link escapes release: {entry.relative_to(root)}')
private_files = {}
for entry in list(root.rglob('*')):
    details = entry.lstat()
    if not stat.S_ISREG(details.st_mode):
        continue
    identity = (details.st_dev, details.st_ino)
    previous = private_files.get(identity)
    if previous is None and details.st_nlink == 1:
        continue
    descriptor, temporary = tempfile.mkstemp(prefix='.bundle-private-', dir=entry.parent)
    os.close(descriptor)
    try:
        if previous is None:
            shutil.copy2(entry, temporary, follow_symlinks=False)
        else:
            os.unlink(temporary)
            os.link(previous, temporary)
        os.replace(temporary, entry)
        private_files.setdefault(identity, entry)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
descriptors = package / 'dist/descriptors'
harnesses = sorted(path.stem for path in descriptors.glob('*.json')) if descriptors.is_dir() else []
if not harnesses:
    raise SystemExit('release carries no harness descriptors')
for harness in harnesses:
    entry = package / f'dist/src/bin/{harness}.js'
    if not entry.is_file() or not entry.stat().st_mode & 0o111:
        raise SystemExit(f'missing executable: {harness}')
for harness, pin in approvals.items():
    from harness_operations import HarnessOperationFailure, read_descriptor

    if harness not in harnesses or not isinstance(pin, str) or len(pin) != 64 or any(char not in '0123456789abcdef' for char in pin):
        raise SystemExit(f'invalid explicit descriptor approval: {harness}')
    try:
        _descriptor, fingerprint = read_descriptor(str(root), harness)
    except HarnessOperationFailure as error:
        raise SystemExit(f'explicit descriptor approval differs: {harness}: {error}') from None
    if fingerprint != pin:
        raise SystemExit(f'explicit descriptor approval differs: {harness}')
(package / 'dist/descriptor-approvals.json').write_text(json.dumps(approvals, sort_keys=True, indent=2) + '\n')
PY
chmod -R u=rX,go=rX "$release_target"
python3 ops/container-runtime/cauce-container-runtime.py bundle-digest "$release_target"
git rev-parse HEAD
