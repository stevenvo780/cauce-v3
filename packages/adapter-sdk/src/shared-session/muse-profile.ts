import { lstat, mkdir, realpath } from 'node:fs/promises';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';

export function museEchoProfile(config: string): boolean {
  const directory = join(config, 'muse');
  let descriptor: number | undefined;
  try {
    if (realpathSync(directory) !== directory) throw new Error('noncanonical profile');
    descriptor = openSync(join(directory, 'settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o022) !== 0 || stat.size > 65_536) throw new Error('unsafe profile');
    const bytes = Buffer.alloc(65_537); let length = 0;
    for (;;) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
      if (length === bytes.length) throw new Error('oversized profile');
    }
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || ('provider' in value && typeof value.provider !== 'string')) throw new Error('invalid profile');
    return 'provider' in value && value.provider === 'echo';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Muse shared session cannot read its canonical provider setting');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function secureDirectory(path: string, privateRoot: string): Promise<void> {
  const root = parse(path).root; let current = root;
  for (const segment of path.slice(root.length).split('/')) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || ((current === privateRoot || current.startsWith(`${privateRoot}/`))
        && (entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0))) throw new Error('Muse profile contains an unsafe directory');
  }
  if (await realpath(path) !== path) throw new Error('Muse profile directory changed');
}

export async function prepareMuseProfile(environment: Readonly<Record<string, string>>): Promise<void> {
  const config = environment.XDG_CONFIG_HOME; const data = environment.XDG_DATA_HOME;
  if (config === undefined || data === undefined || [config, data].some(path => !isAbsolute(path) || normalize(path) !== path || path.includes('\0'))
    || dirname(config) === '/' || basename(config) !== 'config' || basename(data) !== 'data' || dirname(config) !== dirname(data)) throw new Error('Muse requires a dedicated profile');
  const profile = dirname(config);
  for (const directory of [profile, config, data, join(data, 'muse')]) await secureDirectory(directory, profile);
}
