import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const VERSIONABLE_PATH = /^(?:context|directives)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)$/u;
import type { VersionedContext } from '@cauce/protocol';
import { canonicalVersionedContext, deliveredVersionedContext } from '../../context/versioned-context-files.js';
import { discoReal } from '../../context/siembra-del-perfil.js';
import { ContextIngestError, type NativeContextIngest } from '../context-ingest-client.js';
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

async function scanDirectory(root: string, directory: string, into: Map<string, ScannedFile>, ignored: string[]): Promise<void> {
  const absolute = join(root, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = join(absolute, entry.name); const rel = relative(root, child).split(sep).join('/');
    if (entry.isDirectory()) { await scanDirectory(root, rel, into, ignored); continue; }
    if (!VERSIONABLE_PATH.test(rel)) { ignored.push(rel); continue; }
    const metadata = await lstat(child);
    if (entry.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > 262_144
      || await realpath(child) !== child) {
      throw new AdapterError('VERSIONED_CONTEXT_CHANGED', `Local context file ${rel} cannot be ingested safely`, false);
    }
    const bytes = await readFile(child);
    into.set(rel, { content: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}

export async function ingestLocalContextEdits(root: string, base: VersionedContext,
  ingest: NativeContextIngest, logIgnored?: (paths: readonly string[]) => void): Promise<VersionedContext | undefined> {
  const state = await readTrackedState(root, base);
  if (state !== undefined && state.version > base.version) return undefined;
  const disk = new Map<string, ScannedFile>(); const ignored: string[] = [];
  await scanDirectory(root, 'context', disk, ignored);
  await scanDirectory(root, 'directives', disk, ignored);
  if (ignored.length > 0) logIgnored?.(ignored);
  if (disk.size > 100 || [...disk.values()].reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 1_048_576) {
    throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Local context exceeds the versionable size bounds', false);
  }
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
  if (createHash('sha256').update(JSON.stringify(candidate)).digest('hex') === base.digest) return undefined;
  try {
    canonicalVersionedContext({ ...base, files: candidate,
      digest: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') });
  } catch { throw new AdapterError('VERSIONED_CONTEXT_CHANGED', 'Local context edit cannot be ingested safely', false); }
  for (const file of candidate) {
    const scanned = disk.get(file.path);
    if (scanned === undefined) continue;
    let again: string | undefined;
    try { again = createHash('sha256').update(await readFile(join(root, ...file.path.split('/')))).digest('hex'); } catch { again = undefined; }
    if (again !== scanned.sha256) {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Local context changed while it was being scanned for ingest', true);
    }
  }
  const baseVersion = state?.version ?? base.version;
  let result;
  try { result = await ingest.ingest({ base_version: baseVersion, files: candidate }); }
  catch (error) {
    if (error instanceof AdapterError) throw error;
    if (error instanceof ContextIngestError && error.code !== 'TRANSPORT') {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_REJECTED', error.message, false);
    }
    throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native context ingest could not reach the gateway', true);
  }
  if (result.state === 'conflict') {
    throw new AdapterError('VERSIONED_CONTEXT_CONFLICT',
      `Server context version ${String(result.desired_version)} advanced beyond the locally applied version ${String(baseVersion)}; local edits were preserved`, false);
  }
  const effective = deliveredVersionedContext(result.context);
  if (effective.company_id !== base.company_id || effective.tenant_id !== base.tenant_id || effective.alias !== base.alias) {
    throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Ingested context scope differs', false);
  }
  const writes = effective.files.filter(file => disk.get(file.path)?.content !== file.content)
    .map(file => ({ ruta: join(root, ...file.path.split('/')), contenido: file.content }));
  if (writes.length > 0) discoReal.escribirLote(writes);
  return effective;
}

export async function quarantineDivergedContextFiles(root: string, snapshot: VersionedContext): Promise<string[]> {
  const state = await readTrackedState(root, snapshot);
  const server = new Map(snapshot.files.map(file => [file.path, file.content]));
  const candidates = new Set<string>([...server.keys(), ...state?.hashes.keys() ?? []]);
  const quarantined: string[] = [];
  for (const rel of candidates) {
    if (!VERSIONABLE_PATH.test(rel)) continue;
    const path = join(root, ...rel.split('/'));
    let diverged = false;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) diverged = true;
      else {
        const bytes = await readFile(path);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        diverged = bytes.toString('utf8') !== server.get(rel) && sha256 !== state?.hashes.get(rel);
      }
    } catch { continue; }
    if (!diverged) continue;
    const targetBase = join(root, 'config', 'conflicts', ...rel.split('/'));
    await mkdir(dirname(targetBase), { recursive: true, mode: 0o700 });
    let target = `${targetBase}.conflict`;
    for (let suffix = 2; suffix <= 100; suffix += 1) {
      try { await lstat(target); target = `${targetBase}.conflict-${String(suffix)}`; } catch { break; }
    }
    await rename(path, target);
    quarantined.push(rel);
  }
  return quarantined;
}
