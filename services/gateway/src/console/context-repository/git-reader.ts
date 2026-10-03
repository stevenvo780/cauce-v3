import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';
import { hasUnsafeTextCodePoint, isValidUtf8Text } from '@cauce/protocol';
import { CONTEXT_REPOSITORY_LIMITS, ContextRepositoryError, requireContext } from './model.js';

const decompress = promisify(inflate);
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PROFILE_PATH = /^tenants\/[A-Za-z][A-Za-z0-9_-]{0,63}\/agents\/[a-z][a-z0-9_-]{0,63}\/profile\.json$/u;

const NATIVE_MANUAL_PATH = /^tenants\/[A-Za-z][A-Za-z0-9_-]{0,63}\/agents\/[a-z][a-z0-9_-]{0,63}\/native\/(?:claude\/CLAUDE\.md|(?:codex|openclaw)\/AGENTS\.md)$/u;
export type ContextGitPathPolicy = 'profiles' | 'native-inspection';

export interface ContextGitEntry {
  readonly path: string;
  readonly oid: string;
  readonly bytes: number;
}

interface LooseObject {
  readonly type: string;
  readonly body: Buffer;
}

export function assertContextCommit(value: string): void {
  requireContext(OID.test(value), 'invalid_commit');
}

async function requireDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  requireContext(stat.isDirectory() && await realpath(path) === path, 'unsupported_object_storage');
}

async function readBoundedObject(path: string): Promise<Buffer> {
  const cap = CONTEXT_REPOSITORY_LIMITS.blobBytes + 65536;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireContext(stat.isFile(), 'unsupported_object_storage');
    requireContext(stat.size <= cap, 'size_limit');
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    requireContext(bytesRead <= cap, 'size_limit');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function requireAbsent(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  requireContext(stat === null, 'unsupported_object_storage');
}

export class ContextGitReader {
  private readonly cache = new Map<string, LooseObject>();
  private readBytes = 0;

  private constructor(private readonly objectsPath: string, private readonly pathPolicy: ContextGitPathPolicy) {}

  static async open(repositoryPath: string, pathPolicy: ContextGitPathPolicy = 'profiles'): Promise<ContextGitReader> {
    requireContext(['profiles', 'native-inspection'].includes(pathPolicy), 'invalid_path_policy');
    requireContext(isAbsolute(repositoryPath), 'invalid_repository_root');
    try {
      const root = await realpath(repositoryPath);
      requireContext(root === resolve(repositoryPath), 'invalid_repository_root');
      const metadata = join(root, '.git');
      await requireDirectory(metadata);
      const objects = join(metadata, 'objects');
      await requireDirectory(objects);
      await requireDirectory(join(objects, 'info'));
      await requireDirectory(join(objects, 'pack'));
      await requireAbsent(join(objects, 'info', 'alternates'));
      await requireAbsent(join(objects, 'info', 'http-alternates'));
      const pack = await opendir(join(objects, 'pack'));
      try {
        requireContext(await pack.read() === null, 'unsupported_object_storage');
      } finally {
        await pack.close();
      }
      return new ContextGitReader(objects, pathPolicy);
    } catch (error) {
      if (error instanceof ContextRepositoryError) throw error;
      throw new ContextRepositoryError('invalid_repository_root');
    }
  }

  private async object(oid: string): Promise<LooseObject> {
    assertContextCommit(oid);
    const cached = this.cache.get(oid);
    if (cached !== undefined) return cached;
    try {
      await requireDirectory(this.objectsPath);
      const directory = join(this.objectsPath, oid.slice(0, 2));
      await requireDirectory(directory);
      const compressed = await readBoundedObject(join(directory, oid.slice(2)));
      const raw = await decompress(compressed, { maxOutputLength: CONTEXT_REPOSITORY_LIMITS.blobBytes + 64 });
      requireContext(createHash(oid.length === 40 ? 'sha1' : 'sha256').update(raw).digest('hex') === oid, 'invalid_object');
      const end = raw.indexOf(0);
      requireContext(end > 0 && end < 64, 'invalid_object');
      const header = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/u.exec(raw.subarray(0, end).toString('utf8'));
      requireContext(header?.[1] !== undefined, 'invalid_object');
      const body = raw.subarray(end + 1);
      requireContext(Number(header[2]) === body.length, 'invalid_object');
      requireContext(body.length <= CONTEXT_REPOSITORY_LIMITS.blobBytes, 'size_limit');
      this.readBytes += raw.length;
      requireContext(this.readBytes <= 2 * (CONTEXT_REPOSITORY_LIMITS.totalBytes
        + CONTEXT_REPOSITORY_LIMITS.blobBytes), 'size_limit');
      const object = { type: header[1], body };
      this.cache.set(oid, object);
      return object;
    } catch (error) {
      if (error instanceof ContextRepositoryError) throw error;
      throw new ContextRepositoryError('object_unavailable');
    }
  }

  async tree(commit: string): Promise<{ readonly oid: string; readonly entries: readonly ContextGitEntry[] }> {
    const object = await this.object(commit);
    requireContext(object.type === 'commit', 'invalid_commit');
    const firstLine = object.body.subarray(0, object.body.indexOf(10)).toString('utf8');
    const oid = firstLine.startsWith('tree ') ? firstLine.slice(5) : '';
    requireContext(OID.test(oid) && oid.length === commit.length, 'invalid_commit');
    const entries: ContextGitEntry[] = [];
    const pending = [{ oid, path: '', depth: 0 }];
    let nodes = 0;
    let bytes = 0;
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      nodes += 1;
      requireContext(nodes <= CONTEXT_REPOSITORY_LIMITS.files * 4 && next.depth <= 16, 'size_limit');
      const tree = await this.object(next.oid);
      requireContext(tree.type === 'tree', 'invalid_tree');
      const names = new Set<string>();
      for (let offset = 0; offset < tree.body.length;) {
        const space = tree.body.indexOf(32, offset);
        const end = tree.body.indexOf(0, space + 1);
        const width = oid.length / 2;
        requireContext(space > offset && end > space && end + 1 + width <= tree.body.length, 'invalid_tree');
        const mode = tree.body.subarray(offset, space).toString('utf8');
        const nameBytes = tree.body.subarray(space + 1, end);
        requireContext(isValidUtf8Text(nameBytes), 'invalid_tree');
        const name = nameBytes.toString('utf8');
        requireContext(name !== '.' && name !== '..' && name.length <= 255
          && !name.includes('/') && !name.includes('\\') && !hasUnsafeTextCodePoint(name)
          && !names.has(name), 'invalid_tree');
        names.add(name);
        const objectId = tree.body.subarray(end + 1, end + 1 + width).toString('hex');
        const path = `${next.path}${name}`;
        offset = end + 1 + width;
        requireContext(mode === '40000' || mode === '100644', 'unsupported_entry');
        if (mode === '40000') {
          pending.push({ oid: objectId, path: `${path}/`, depth: next.depth + 1 });
          requireContext(pending.length <= CONTEXT_REPOSITORY_LIMITS.files * 4, 'size_limit');
        } else {
          requireContext(entries.length < CONTEXT_REPOSITORY_LIMITS.files, 'size_limit');
          requireContext(path === 'context.json' || PROFILE_PATH.test(path)
            || (this.pathPolicy === 'native-inspection' && NATIVE_MANUAL_PATH.test(path)), 'unexpected_files');
          const blob = await this.object(objectId);
          requireContext(blob.type === 'blob', 'invalid_blob');
          bytes += blob.body.length;
          requireContext(bytes <= CONTEXT_REPOSITORY_LIMITS.totalBytes, 'size_limit');
          entries.push({ path, oid: objectId, bytes: blob.body.length });
        }
      }
    }
    return { oid, entries };
  }

  async blob(entry: ContextGitEntry): Promise<Buffer> {
    const object = await this.object(entry.oid);
    requireContext(object.type === 'blob' && object.body.length === entry.bytes, 'invalid_blob');
    requireContext(isValidUtf8Text(object.body), 'invalid_text');
    return object.body;
  }
}
