import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';

export function retireSpaceFile(root: string, path: string, expectedSha: string): void {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${root}/`) || !/^[a-f0-9]{64}$/u.test(expectedSha)) throw new Error('invalid context retirement scope');
  let parent = openSync(parse(absolute).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptor: number | undefined;
  try {
    const parts = relative(parse(absolute).root, absolute).split(sep);
    for (const part of parts.slice(0, -1)) {
      const following = openSync(join(`/proc/self/fd/${String(parent)}`, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(parent); parent = following;
    }
    const name = parts.at(-1);
    if (!name) throw new Error('invalid context retirement path');
    const anchored = join(`/proc/self/fd/${String(parent)}`, name);
    try { descriptor = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.nlink !== 1 || state.size > 262_144 || createHash('sha256').update(readFileSync(descriptor)).digest('hex') !== expectedSha) {
      throw new Error('retired context file changed');
    }
    const named = lstatSync(anchored);
    if (named.dev !== state.dev || named.ino !== state.ino) throw new Error('retired context identity changed');
    unlinkSync(anchored);
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parent); }
}
