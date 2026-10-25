import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const VERSIONABLE_PATH = /^(?:context|directives)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)$/u;
import type { VersionedContext } from '@cauce/protocol';
import { canonicalVersionedContext, deliveredVersionedContext } from '../../context/versioned-context-files.js';
import { discoReal } from '../../context/siembra-del-perfil.js';
import { nativeContextFileBindings } from '../../context/native-context-files.js';
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
interface ScannedFile { readonly content: string; readonly sha256: string; readonly location: string }

async function scanFile(location: string, path: string): Promise<ScannedFile | undefined> {
  let metadata;
  try { metadata = await lstat(location); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 262_144 || await realpath(location) !== location) {
    throw new AdapterError('VERSIONED_CONTEXT_CHANGED', `Local context file ${path} cannot be ingested safely`, false);
  }
  const content = discoReal.leer(location, 262_144);
  return content === undefined ? undefined : { content, sha256: createHash('sha256').update(content).digest('hex'), location };
}

async function readTrackedState(root: string, base: VersionedContext): Promise<TrackedState | undefined> {
  const path = join(root, 'config', 'context-state.json');
  try {
    const content = discoReal.leer(path, 262_144);
    if (content === undefined) return undefined;
    const raw = JSON.parse(content) as { company_id?: unknown; tenant_id?: unknown; alias?: unknown;
      version?: unknown; documents?: unknown };
    if (raw.company_id !== base.company_id || raw.tenant_id !== base.tenant_id || raw.alias !== base.alias
      || typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1
      || !Array.isArray(raw.documents)) throw new Error('invalid or foreign context receipt');
    const hashes = new Map<string, string>();
    for (const document of raw.documents as { path?: unknown; sha256?: unknown }[]) {
      if (typeof document.path !== 'string' || !VERSIONABLE_PATH.test(document.path)
        || typeof document.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(document.sha256)) throw new Error('invalid context receipt hash');
      if (document.path.startsWith('context/') || document.path.startsWith('directives/')) {
        hashes.set(document.path, document.sha256);
      }
    }
    return { version: raw.version, hashes };
  } catch { throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Context receipt is invalid or belongs to another target; native files were preserved', false); }
}

async function scanDirectory(root: string, directory: string, into: Map<string, ScannedFile>, ignored: string[]): Promise<void> {
  const absolute = join(root, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = join(absolute, entry.name); const rel = relative(root, child).split(sep).join('/');
    if (entry.isDirectory()) { await scanDirectory(root, rel, into, ignored); continue; }
    if (!VERSIONABLE_PATH.test(rel)) { ignored.push(rel); continue; }
    const file = await scanFile(child, rel);
    if (file !== undefined) into.set(rel, file);
  }
}

export async function ingestLocalContextEdits(root: string, base: VersionedContext,
  ingest: NativeContextIngest, logIgnored?: (paths: readonly string[]) => void, harness?: string): Promise<VersionedContext | undefined> {
  const state = await readTrackedState(root, base);
  if (state !== undefined && state.version > base.version) return undefined;
  const disk = new Map<string, ScannedFile>(); const ignored: string[] = [];
  await scanDirectory(root, 'context', disk, ignored);
  await scanDirectory(root, 'directives', disk, ignored);
  const observations = [...disk.values()];
  const missingNatives: string[] = [];
  let nativeChanged = false;
  const knownPaths = new Set([...base.files.map(file => file.path), ...state?.hashes.keys() ?? []]);
  const bindings = nativeContextFileBindings(root, harness ?? '', [...knownPaths].map(path => ({ path })));
  for (const binding of bindings) {
    let native: ScannedFile | undefined;
    try { native = await scanFile(binding.nativePath, binding.path); } catch {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native context could not be scanned safely; native files were preserved', true);
    }
    if (native === undefined) {
      if (state?.hashes.has(binding.path)) {
        disk.delete(binding.path);
        missingNatives.push(binding.nativePath);
        nativeChanged = true;
      }
      continue;
    }
    observations.push(native);
    const canonical = disk.get(binding.path);
    const expected = state?.hashes.get(binding.path)
      ?? createHash('sha256').update(base.files.find(file => file.path === binding.path)?.content ?? '').digest('hex');
    nativeChanged ||= native.sha256 !== expected;
    if (canonical !== undefined && canonical.sha256 !== expected && native.sha256 !== expected
      && canonical.sha256 !== native.sha256) {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native and canonical local context edits differ; both files were preserved', true);
    }
    if (state === undefined || canonical === undefined || canonical.sha256 === expected || native.sha256 !== expected) disk.set(binding.path, native);
  }
  if (ignored.length > 0) logIgnored?.(ignored);
  if (disk.size > 100 || [...disk.values()].reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 1_048_576) {
    throw new AdapterError(nativeChanged ? 'VERSIONED_CONTEXT_INGEST_FAILED' : 'VERSIONED_CONTEXT_CHANGED',
      'Local context exceeds the versionable size bounds', nativeChanged);
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
  if (state === undefined && base.version > 1 && nativeChanged) {
    throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native context diverges without a receipt of the server ancestor; native files were preserved', true);
  }
  const candidate = [...candidateFiles.entries()].map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (createHash('sha256').update(JSON.stringify(candidate)).digest('hex') === base.digest) return undefined;
  try {
    canonicalVersionedContext({ ...base, files: candidate,
      digest: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') });
  } catch {
    throw new AdapterError(nativeChanged ? 'VERSIONED_CONTEXT_INGEST_FAILED' : 'VERSIONED_CONTEXT_CHANGED',
      'Local context edit cannot be ingested safely; native files were preserved', nativeChanged);
  }
  const verifyObservations = async (): Promise<void> => {
    for (const path of missingNatives) {
      if (discoReal.leer(path, 262_144) !== undefined) {
        throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'A missing native context file reappeared during ingest', true);
      }
    }
    for (const scanned of observations) {
      let again: string | undefined;
      try { again = (await scanFile(scanned.location, scanned.location))?.sha256; } catch { again = undefined; }
      if (again !== scanned.sha256) {
        throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Local context changed while it was being scanned for ingest', true);
      }
    }
  };
  await verifyObservations();
  const serverUnchanged = state?.hashes.size === base.files.length
    && base.files.every(file => state.hashes.get(file.path) === createHash('sha256').update(file.content).digest('hex'));
  const baseVersion = serverUnchanged ? base.version : state?.version ?? base.version;
  let result;
  try { result = await ingest.ingest({ base_version: baseVersion, files: candidate }); }
  catch (error) {
    if (error instanceof AdapterError) throw error;
    if (error instanceof ContextIngestError && error.code !== 'TRANSPORT') {
      throw new AdapterError(nativeChanged ? 'VERSIONED_CONTEXT_INGEST_FAILED' : 'VERSIONED_CONTEXT_INGEST_REJECTED', error.message, nativeChanged);
    }
    throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Native context ingest could not reach the gateway', true);
  }
  if (result.state === 'conflict') {
    if (nativeChanged && result.desired_version > base.version) {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED',
        'Server context advanced after this delivery was sealed; native files were preserved until the current version is delivered', true);
    }
    throw new AdapterError('VERSIONED_CONTEXT_CONFLICT',
      `Server context version ${String(result.desired_version)} advanced beyond the locally applied version ${String(baseVersion)}; local edits were preserved`, false);
  }
  const effective = deliveredVersionedContext(result.context);
  if (effective.company_id !== base.company_id || effective.tenant_id !== base.tenant_id || effective.alias !== base.alias) {
    throw new AdapterError('INVALID_VERSIONED_CONTEXT', 'Ingested context scope differs', false);
  }
  await verifyObservations();
  const writes = effective.files.flatMap(file => {
    const location = join(root, ...file.path.split('/'));
    const previous = observations.find(file => file.location === location)?.content;
    if (discoReal.leer(location, 262_144) !== previous) {
      throw new AdapterError('VERSIONED_CONTEXT_INGEST_FAILED', 'Canonical context changed after its ingest observation', true);
    }
    return previous === file.content ? [] : [{ ruta: location, contenido: file.content,
      ...(previous === undefined ? {} : { contenidoPrevio: previous }) }];
  });
  for (const binding of nativeContextFileBindings(root, harness ?? '', effective.files)) {
    const file = effective.files.find(file => file.path === binding.path);
    if (file === undefined) throw new Error('native context binding has no versioned file');
    const previous = observations.find(file => file.location === binding.nativePath)?.content;
    if (previous !== undefined && previous !== file.content) {
      writes.push({ ruta: binding.nativePath, contenido: file.content, contenidoPrevio: previous });
    }
  }
  if (writes.length > 0) discoReal.escribirLote(writes);
  return effective;
}

export async function quarantineDivergedContextFiles(root: string, snapshot: VersionedContext, harness?: string): Promise<string[]> {
  const state = await readTrackedState(root, snapshot);
  const server = new Map(snapshot.files.map(file => [file.path, file.content]));
  const candidates = new Set<string>([...server.keys(), ...state?.hashes.keys() ?? []]);
  const quarantined: string[] = [];
  const bindings = new Map(nativeContextFileBindings(root, harness ?? '', [...candidates].map(path => ({ path })))
    .map(file => [file.path, file.nativePath]));
  for (const rel of candidates) {
    if (!VERSIONABLE_PATH.test(rel)) continue;
    const nativePath = bindings.get(rel);
    for (const path of new Set([join(root, ...rel.split('/')), ...nativePath === undefined ? [] : [nativePath]])) {
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
      const targetBase = join(root, 'config', 'conflicts', ...(path === bindings.get(rel) ? ['native'] : []), ...rel.split('/'));
      await mkdir(dirname(targetBase), { recursive: true, mode: 0o700 });
      let target = `${targetBase}.conflict`;
      for (let suffix = 2; suffix <= 100; suffix += 1) {
        try { await lstat(target); target = `${targetBase}.conflict-${String(suffix)}`; } catch { break; }
      }
      await rename(path, target);
      quarantined.push(rel);
    }
  }
  return quarantined;
}
