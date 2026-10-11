import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';

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
