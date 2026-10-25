#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf 'adapter-space-launcher: %s\n' "$1" >&2; exit 78; }

[[ $# -ge 4 && ${3:-} == -- ]] \
  || fail 'usage: adapter-space-launcher.sh NODE SPACE_LAYOUT_MODULE -- COMMAND [ARGUMENTS...]'
node_executable=$1
layout_module=$2
shift 3
[[ $node_executable == /* && -f $node_executable && -x $node_executable ]] \
  || fail 'Node must be an absolute executable file'
[[ -n ${CAUCE_STATE_DIR:-} && -n $1 ]] || fail 'CAUCE_STATE_DIR and the original command are required'

"$node_executable" --input-type=module - "$layout_module" "$CAUCE_STATE_DIR" <<'JS' >/dev/null || exit 78
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class LayoutFailure extends Error {}
const [modulePath, stateRoot] = process.argv.slice(2);
const canonical = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/';
async function privateDirectory(path, label, optional = false) {
  let details;
  try { details = await lstat(path); }
  catch (cause) {
    if (optional && cause?.code === 'ENOENT') return;
    throw new LayoutFailure(`${label} is unavailable`);
  }
  if (!details.isDirectory() || details.uid !== process.geteuid() || (details.mode & 0o7777) !== 0o700
      || await realpath(path) !== path) throw new LayoutFailure(`${label} must be a real private directory owned by the runtime user`);
}

try {
  if (!canonical(stateRoot)) throw new LayoutFailure('CAUCE_STATE_DIR must be an absolute canonical directory');
  await privateDirectory(stateRoot, 'state directory');
  if (!canonical(modulePath) || !(await lstat(modulePath)).isFile() || await realpath(modulePath) !== modulePath) {
    throw new LayoutFailure('space layout module must be an absolute canonical regular file');
  }
  const { prepareSpaceLayout, SPACE_DIRECTORIES } = await import(pathToFileURL(modulePath).href);
  if (typeof prepareSpaceLayout !== 'function' || !Array.isArray(SPACE_DIRECTORIES) || SPACE_DIRECTORIES.length !== 7
      || new Set(SPACE_DIRECTORIES).size !== 7 || SPACE_DIRECTORIES.some(name => typeof name !== 'string' || !/^[a-z]+$/u.test(name))) {
    throw new LayoutFailure('compiled SDK space layout contract is unavailable');
  }
  const spaceRoot = join(stateRoot, 'space');
  const paths = [spaceRoot, ...SPACE_DIRECTORIES.map(name => join(spaceRoot, name))];
  for (const path of paths) await privateDirectory(path, 'existing space directory', true);
  const layout = await prepareSpaceLayout(spaceRoot);
  if (!layout || typeof layout !== 'object' || Object.keys(layout).length !== SPACE_DIRECTORIES.length
      || SPACE_DIRECTORIES.some(name => layout[name] !== join(spaceRoot, name))) {
    throw new LayoutFailure('compiled SDK returned a different space layout');
  }
  for (const path of paths) await privateDirectory(path, 'prepared space directory');
} catch (cause) {
  const reason = cause instanceof LayoutFailure ? cause.message : 'standard space preparation or validation failed';
  process.stderr.write(`adapter-space-launcher: ${reason}\n`);
  process.exitCode = 78;
}
JS

export CAUCE_SPACE_ROOT="$CAUCE_STATE_DIR/space"
export TMPDIR="$CAUCE_SPACE_ROOT/tmp"
exec "$@"
