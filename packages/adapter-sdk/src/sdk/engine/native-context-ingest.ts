import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VersionedContext } from '@cauce/protocol';
import { canonicalVersionedContext } from '../../context/versioned-context-files.js';
import { discoReal } from '../../context/siembra-del-perfil.js';
import type { NativeContextIngest } from '../context-ingest-client.js';
import { AdapterError } from '../errors.js';

export async function readSpaceContextStateVersion(root: string): Promise<number | undefined> {
  const path = join(root, 'config', 'context-state.json');
  try {
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) return undefined;
    const raw = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
    return typeof raw.version === 'number' ? raw.version : undefined;
  } catch { return undefined; }
}

interface TrackedState { readonly version: number; readonly hashes: ReadonlyMap<string, string> }
interface ScannedFile { readonly content: string; readonly sha256: string }

async function readTrackedState(root: string, base: VersionedContext): Promise<TrackedState | undefined> {
  const path = join(root, 'config', 'context-state.json');
  try {
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) return undefined;
    const raw = JSON.parse(await readFile(path, 'utf8')) as { company_id?: unknown; tenant_id?: unknown; alias?: unknown;
      version?: unknown; documents?: unknown };
    if (raw.company_id !== base.company_id || raw.tenant_id !== base.tenant_id || raw.alias !== base.alias
      || typeof raw.version !== 'number' || !Array.isArray(raw.documents)) return undefined;
    const hashes = new Map<string, string>();
    for (const document of raw.documents as { path?: unknown; sha256?: unknown }[]) {
      if (typeof document.path !== 'string' || typeof document.sha256 !== 'string') return undefined;
      if (document.path.startsWith('context/') || document.path.startsWith('directives/')) {
        hashes.set(document.path, document.sha256);
      }
    }
    return { version: raw.version, hashes };
  } catch { return undefined; }
}

async function scanDirectory(root: string, directory: string, into: Map<string, ScannedFile>): Promise<void> {
  const absolute = join(root, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = join(absolute, entry.name); const rel = relative(root, child).split(sep).join('/');
    if (entry.isDirectory()) { await scanDirectory(root, rel, into); continue; }
    const metadata = await lstat(child);
    if (entry.isSymbolicLink() || !metadata.isFile() || await realpath(child) !== child) {
      throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Local context edit cannot be ingested safely', false);
    }
    const bytes = await readFile(child);
    into.set(rel, { content: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}

export async function ingestLocalContextEdits(root: string, base: VersionedContext,
  ingest: NativeContextIngest): Promise<VersionedContext | undefined> {
  const state = await readTrackedState(root, base);
  if (state !== undefined && state.version > base.version) return undefined;
  const disk = new Map<string, ScannedFile>();
  await scanDirectory(root, 'context', disk);
  await scanDirectory(root, 'directives', disk);
  let divergent: boolean;
  let candidateFiles: Map<string, string>;
  if (state !== undefined) {
    divergent = [...state.hashes].some(([path, sha256]) => disk.get(path)?.sha256 !== sha256)
      || [...disk.keys()].some(path => !state.hashes.has(path));
    candidateFiles = new Map([...disk.entries()].map(([path, file]) => [path, file.content]));
  } else {
    candidateFiles = new Map(base.files.map(file => [file.path, file.content]));
    for (const [path, file] of disk) candidateFiles.set(path, file.content);
    divergent = [...disk.entries()].some(([path, file]) =>
      base.files.find(baseFile => baseFile.path === path)?.content !== file.content);
  }
  if (!divergent) return undefined;
  const candidate = [...candidateFiles.entries()].map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  try {
    canonicalVersionedContext({ ...base, files: candidate,
      digest: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') });
  } catch { throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Local context edit cannot be ingested safely', false); }
  const baseVersion = state?.version ?? base.version;
  let result;
  try { result = await ingest.ingest({ base_version: baseVersion, files: candidate }); }
  catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native context ingest could not reach the gateway', true);
  }
  if (result.state === 'conflict') {
    throw new AdapterError('VERSIONED_CONTEXT_CONFLICT',
      `Server context version ${String(result.desired_version)} advanced beyond the locally applied version ${String(baseVersion)}; local edits were preserved`, false);
  }
  const effective = canonicalVersionedContext(result.context);
  if (effective.company_id !== base.company_id || effective.tenant_id !== base.tenant_id || effective.alias !== base.alias) {
    throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Ingested context scope differs', false);
  }
  const writes = effective.files.filter(file => disk.get(file.path)?.content !== file.content)
    .map(file => ({ ruta: join(root, ...file.path.split('/')), contenido: file.content }));
  if (writes.length > 0) discoReal.escribirLote(writes);
  return effective;
}
