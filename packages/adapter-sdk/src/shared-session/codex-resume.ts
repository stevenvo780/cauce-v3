import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { readSessionsSecure } from '../sdk/durable-store/session-file.js';
import type { ResumeLaunchPlan } from './types.js';

interface Binding { stateDirectory: string; configDirectory: string; namespace: string; workspace: string }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

async function secureDirectory(path: string): Promise<boolean> {
  const info = await stat(path);
  return normalize(path) === path && await realpath(path) === path && info.isDirectory()
    && info.uid === process.geteuid?.() && (info.mode & 0o022) === 0;
}

export async function exactCodexLaunch(input: Binding, allowNew = false): Promise<ResumeLaunchPlan> {
  const blocked: ResumeLaunchPlan = { state: 'blocked', detail: 'No se acreditó la conversación exacta de Codex.' };
  if (!await secureDirectory(input.stateDirectory) || !await secureDirectory(input.configDirectory)) return blocked;
  const store = await readSessionsSecure(join(input.stateDirectory, 'sessions.json'));
  const pointer = store.sessions[`codex:${input.namespace}:shared:${input.namespace}`];
  if (pointer === undefined && allowNew) {
    try {
      const names = await readdir(join(input.configDirectory, 'sessions'), { recursive: true });
      if (names.length > 20_000 || names.some(name => name.endsWith('.jsonl'))) return blocked;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return blocked;
    }
    return { state: 'launch', args: [], resumed: false };
  }
  if (pointer?.initialized !== true || !uuid.test(pointer.native_id)) return blocked;
  const root = join(input.configDirectory, 'sessions');
  if (!await secureDirectory(root)) return blocked;
  const names = await readdir(root, { recursive: true });
  if (names.length > 20_000) return blocked;
  const candidates = names.filter(name => name.endsWith(`-${pointer.native_id}.jsonl`));
  if (candidates.length !== 1 || candidates[0] === undefined) return blocked;
  const file = join(root, candidates[0]);
  if (await realpath(file) !== file || !await secureDirectory(dirname(file))) return blocked;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.nlink !== 1 || (info.mode & 0o022) !== 0) return blocked;
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return blocked;
    const value: unknown = JSON.parse(text.slice(0, end));
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'session_meta'
        || !('payload' in value) || typeof value.payload !== 'object' || value.payload === null) return blocked;
    const meta = value.payload;
    if (!('id' in meta) || meta.id !== pointer.native_id || !('source' in meta) || meta.source !== 'cli'
        || !('cwd' in meta) || meta.cwd !== input.workspace) return blocked;
    return { state: 'launch', args: ['resume', pointer.native_id], resumed: true };
  } finally { await handle.close(); }
}
