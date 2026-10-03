import { createHash } from 'node:crypto';
import type { AgentProfile } from '@cauce/protocol';
import { assertContextCommit, ContextGitReader } from './git-reader.js';
import type { ContextSourceFile } from './inspect.js';
import {
  admitContextText, parseSourceProfile, requireContext, sourceProfilePath, validateContextScope, type ContextScope,
} from './model.js';
import { parseNativeContextManifest, sourceNativeManualPath, type NativeContextSourceAgent } from './native-model.js';

export interface NativeContextSourceSnapshot {
  readonly commit: string;
  readonly tree: string;
  readonly scope: ContextScope;
  readonly profile: AgentProfile;
  readonly profileSource: ContextSourceFile;
  readonly manualSource: ContextSourceFile;
  readonly sourceAgent: NativeContextSourceAgent;
}

export interface NativeContextSourceChange {
  readonly path: string;
  readonly kind: 'modified' | 'added' | 'removed';
  readonly before: ContextSourceFile | null;
  readonly after: ContextSourceFile | null;
}

export interface NativeContextRepositoryInspection {
  readonly desired: NativeContextSourceSnapshot;
  readonly previous: NativeContextSourceSnapshot | null;
  readonly changes: readonly NativeContextSourceChange[] | null;
  readonly sourceState: 'not_observed';
  readonly application: 'not_evaluated';
  readonly applySupported: false;
}

async function readSnapshot(
  reader: ContextGitReader, commit: string, scope: ContextScope,
): Promise<NativeContextSourceSnapshot> {
  const tree = await reader.tree(commit);
  const manifestEntry = tree.entries.find((entry) => entry.path === 'context.json');
  requireContext(manifestEntry !== undefined, 'missing_manifest');
  const manifest = parseNativeContextManifest(admitContextText(await reader.blob(manifestEntry)));
  requireContext(manifest.instance_id === scope.instance_id, 'scope_unavailable');
  const selected = manifest.agents.find((agent) => agent.tenant_id === scope.tenant_id && agent.alias === scope.alias);
  requireContext(selected !== undefined, 'scope_unavailable');
  const expected = new Set(['context.json']);
  for (const agent of manifest.agents) {
    expected.add(sourceProfilePath(agent));
    expected.add(sourceNativeManualPath(agent));
  }
  requireContext(expected.size === tree.entries.length
    && tree.entries.every((entry) => expected.has(entry.path)), 'unexpected_files');
  const files = new Map<string, ContextSourceFile>();
  for (const entry of tree.entries) {
    if (entry.path === 'context.json') continue;
    const bytes = await reader.blob(entry);
    files.set(entry.path, { path: entry.path, bytes: bytes.length, content: admitContextText(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const file = (path: string): ContextSourceFile => {
    const found = files.get(path);
    requireContext(found !== undefined, 'missing_file');
    return found;
  };
  let profile: AgentProfile | undefined;
  for (const agent of manifest.agents) {
    const parsed = parseSourceProfile(file(sourceProfilePath(agent)).content, agent);
    if (agent === selected) profile = parsed;
  }
  requireContext(profile !== undefined, 'scope_unavailable');
  return { commit, tree: tree.oid, scope: { ...scope }, profile,
    profileSource: file(sourceProfilePath(selected)), manualSource: file(sourceNativeManualPath(selected)), sourceAgent: selected };
}

function compareSnapshots(
  previous: NativeContextSourceSnapshot, desired: NativeContextSourceSnapshot,
): readonly NativeContextSourceChange[] {
  const before = new Map([previous.profileSource, previous.manualSource].map((file) => [file.path, file]));
  const after = new Map([desired.profileSource, desired.manualSource].map((file) => [file.path, file]));
  const changes: NativeContextSourceChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path) ?? null;
    const next = after.get(path) ?? null;
    if (old?.sha256 === next?.sha256) continue;
    changes.push({ path, kind: old === null ? 'added' : next === null ? 'removed' : 'modified', before: old, after: next });
  }
  return changes;
}

export async function inspectNativeContextRepository(input: {
  readonly repositoryPath: string;
  readonly scope: ContextScope;
  readonly commit: string;
  readonly previousCommit?: string;
}): Promise<NativeContextRepositoryInspection> {
  const scope = { ...input.scope };
  validateContextScope(scope);
  assertContextCommit(input.commit);
  if (input.previousCommit !== undefined) assertContextCommit(input.previousCommit);
  const reader = await ContextGitReader.open(input.repositoryPath, 'native-inspection');
  const desired = await readSnapshot(reader, input.commit, scope);
  const previous = input.previousCommit === undefined ? null : await readSnapshot(reader, input.previousCommit, scope);
  return { desired, previous, changes: previous === null ? null : compareSnapshots(previous, desired),
    sourceState: 'not_observed', application: 'not_evaluated', applySupported: false };
}
