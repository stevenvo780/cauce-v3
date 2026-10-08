import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export interface CommandPins { readonly command: string; readonly sha256: string; readonly files: Readonly<Record<string, string>> }
const HASH = /^[a-f0-9]{64}$/u;
function checkedPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || /[\p{Cc}]/u.test(value)) throw new Error('invalid pinned command path');
  return value;
}
export function commandPinsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CommandPins | undefined {
  const command = environment.CAUCE_HARNESS_COMMAND; const sha256 = environment.CAUCE_HARNESS_COMMAND_SHA256;
  const raw = environment.CAUCE_HARNESS_COMMAND_FILES;
  if (sha256 === undefined && raw === undefined) {
    if (environment.CAUCE_FLEET_OPERATION_ID !== undefined) throw new Error('fleet runtime requires a pinned harness command');
    return undefined;
  }
  checkedPath(command);
  if (sha256 === undefined || !HASH.test(sha256)) throw new Error('invalid harness command pin');
  if (raw !== undefined && raw.length > 131_072) throw new Error('harness file pins exceed their limit');
  const files: unknown = raw === undefined ? {} : JSON.parse(raw);
  if (files === null || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 32) throw new Error('invalid harness file pins');
  for (const [filename, hash] of Object.entries(files)) {
    checkedPath(filename);
    if (typeof hash !== 'string' || !HASH.test(hash) || (filename === command && hash !== sha256)) throw new Error('invalid harness file pin');
  }
  return { command: checkedPath(command), sha256, files: files as Record<string, string> };
}
async function fileDigest(filename: string): Promise<string> {
  const parts = checkedPath(filename).split('/').slice(1); const name = parts.pop();
  if (name === undefined || name === '') throw new Error('pinned command must be a file');
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const next = await open(`/proc/self/fd/${String(directory.fd)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const file = await open(`/proc/self/fd/${String(directory.fd)}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || ![0, process.geteuid?.()].includes(stat.uid) || (stat.mode & 0o022) !== 0 || stat.size > 268_435_456) {
        throw new Error('pinned harness file ownership or mode changed');
      }
      const hash = createHash('sha256'); const buffer = Buffer.alloc(65_536); let total = 0;
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null); if (read.bytesRead === 0) break;
        total += read.bytesRead; if (total > 268_435_456) throw new Error('pinned harness file exceeds its limit');
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      return hash.digest('hex');
    } finally { await file.close(); }
  } finally { await directory.close(); }
}
export async function assertCommandPins(command: string, pins: CommandPins | undefined): Promise<string | undefined> {
  if (pins === undefined) return undefined;
  if (command !== pins.command || !HASH.test(pins.sha256)) throw new Error('harness command differs from its pinned binding');
  const files = { ...pins.files, [pins.command]: pins.sha256 };
  for (const [filename, expected] of Object.entries(files)) if (!HASH.test(expected) || await fileDigest(filename) !== expected) {
    throw new Error('pinned harness file changed');
  }
  return pins.sha256;
}
