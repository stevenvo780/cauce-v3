import { createHash } from 'node:crypto';
import type { AgentProfile } from '@cauce/protocol';
import { isJournalCursor, type ProfileRevisionEntry } from '@cauce/store';
import { assertContextCommit, ContextGitReader } from './git-reader.js';
import {
  admitContextText, parseContextManifest, parseSourceProfile, requireContext,
  serializeSourceProfile, sourceProfilePath, validateContextScope, type ContextScope, type ContextSourceAgent,
} from './model.js';

export interface ContextSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
}

export interface ContextSourceSnapshot {
  readonly commit: string;
  readonly tree: string;
  readonly scope: ContextScope;
  readonly profile: AgentProfile;
  readonly profileSource: ContextSourceFile;
  readonly sourceAgent: ContextSourceAgent;
  readonly provenanceVerification: 'not_evaluated';
}

export interface ContextSourceChange {
  readonly path: string;
  readonly kind: 'modified';
  readonly before: ContextSourceFile;
  readonly after: ContextSourceFile;
}

export interface ContextRepositoryInspection {
  readonly desired: ContextSourceSnapshot;
  readonly previous: ContextSourceSnapshot | null;
  readonly changes: readonly ContextSourceChange[] | null;
  readonly provenanceChanged: boolean | null;
  readonly sourceState: 'not_observed';
  readonly application: 'not_evaluated';
}

async function readSnapshot(
  reader: ContextGitReader, commit: string, scope: ContextScope,
): Promise<ContextSourceSnapshot> {
  const tree = await reader.tree(commit);
  const manifestEntry = tree.entries.find((entry) => entry.path === 'context.json');
  requireContext(manifestEntry !== undefined, 'missing_manifest');
  const manifest = parseContextManifest(admitContextText(await reader.blob(manifestEntry)));
  requireContext(manifest.instance_id === scope.instance_id, 'scope_unavailable');
  const selected = manifest.agents.find((agent) => agent.tenant_id === scope.tenant_id && agent.alias === scope.alias);
  requireContext(selected !== undefined, 'scope_unavailable');
  const expected = new Set(['context.json']);
  for (const agent of manifest.agents) expected.add(sourceProfilePath(agent));
  requireContext(expected.size === tree.entries.length
    && tree.entries.every((entry) => expected.has(entry.path)), 'unexpected_files');
  const files = new Map<string, ContextSourceFile>();
  for (const entry of tree.entries) {
    if (entry.path === 'context.json') continue;
    const bytes = await reader.blob(entry);
    files.set(entry.path, {
      path: entry.path, bytes: bytes.length, content: admitContextText(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
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
  return {
    commit, tree: tree.oid, scope: { ...scope }, profile,
    profileSource: file(sourceProfilePath(selected)),
    sourceAgent: selected, provenanceVerification: 'not_evaluated',
  };
}

function compareSnapshots(previous: ContextSourceSnapshot, desired: ContextSourceSnapshot): readonly ContextSourceChange[] {
  const before = previous.profileSource;
  const after = desired.profileSource;
  return before.sha256 === after.sha256 ? [] : [{ path: after.path, kind: 'modified', before, after }];
}

export function prepareProfileExport(input: {
  readonly scope: ContextScope;
  readonly snapshot: ProfileRevisionEntry;
}): {
  readonly scope: ContextScope;
  readonly sourceAgent: ContextSourceAgent;
  readonly source: ContextSourceFile;
  readonly state: 'content_review_required';
  readonly application: 'not_evaluated';
} {
  const snapshot = input.snapshot;
  requireContext(isJournalCursor(snapshot.id), 'invalid_journal_id');
  requireContext(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0, 'invalid_revision');
  requireContext(snapshot.operation === 'insert' || snapshot.operation === 'update', 'deleted_profile');
  const content = serializeSourceProfile(snapshot, input.scope);
  return {
    scope: { ...input.scope },
    sourceAgent: {
      tenant_id: snapshot.tenant_id, alias: snapshot.alias,
      source_journal: { id: snapshot.id, revision: snapshot.revision },
    },
    source: {
      path: sourceProfilePath(input.scope), content, bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    },
    state: 'content_review_required', application: 'not_evaluated',
  };
}

export async function inspectContextRepository(input: {
  readonly repositoryPath: string;
  readonly scope: ContextScope;
  readonly commit: string;
  readonly previousCommit?: string;
}): Promise<ContextRepositoryInspection> {
  const scope = { ...input.scope };
  validateContextScope(scope);
  assertContextCommit(input.commit);
  if (input.previousCommit !== undefined) assertContextCommit(input.previousCommit);
  const reader = await ContextGitReader.open(input.repositoryPath);
  const desired = await readSnapshot(reader, input.commit, scope);
  const previous = input.previousCommit === undefined ? null : await readSnapshot(reader, input.previousCommit, scope);
  return {
    desired, previous, changes: previous === null ? null : compareSnapshots(previous, desired),
    provenanceChanged: previous === null ? null
      : previous.sourceAgent.source_journal.id !== desired.sourceAgent.source_journal.id
        || previous.sourceAgent.source_journal.revision !== desired.sourceAgent.source_journal.revision,
    sourceState: 'not_observed', application: 'not_evaluated',
  };
}
