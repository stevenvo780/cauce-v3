import { createHash } from 'node:crypto';
import type { AgentProfile, ContextoDeAlias } from '@cauce/protocol';
import { isJournalCursor, type AgentProfileSourceGuard, type ProfileRevisionEntry } from '@cauce/store';
import type { DocumentOperator } from '../agent-documents.routes.js';
import type { AgentProfileDeps, ProfileRuntimePreflight } from '../agent-profile.routes.js';
import { veredictoDeContaminacion } from '../agent-profile/write-gates.js';
import { validateContextRepositoryBinding, type ContextRepositoryBinding } from './binding.js';
import { inspectContextRepository } from './inspect.js';
import { requireContext, serializeSourceProfile } from './model.js';

interface ContextSourceIdentity {
  readonly instance_id: string;
  readonly commit: string;
  readonly tree: string;
  readonly profile_sha256: string;
  readonly expected_journal_id: string;
  readonly runtime_fingerprint: string;
}

type ContextSourceProvenance =
  | { readonly source_kind?: never; readonly source_journal_id: string; readonly source_revision: number }
  | { readonly source_kind: 'git_authored'; readonly source_journal_id?: never; readonly source_revision?: never };
type ContextSourceFields = ContextSourceIdentity & ContextSourceProvenance;
export type ContextSourceConfirmation = ContextSourceFields & { readonly application_id: string };

export interface ContextSourceDeps {
  readonly binding?: ContextRepositoryBinding;
  readonly profile: AgentProfileDeps;
  readonly readProfileRevision: (tenantId: string, alias: string, revision: number) => Promise<ProfileRevisionEntry | undefined>;
}

export function snapshotContextSourceDeps(deps: ContextSourceDeps): ContextSourceDeps {
  return Object.freeze({ ...deps, ...(deps.binding === undefined
    ? {} : { binding: validateContextRepositoryBinding(deps.binding) }) });
}

interface Caller {
  readonly actor: { readonly tenant_id: string; readonly alias: string };
  readonly operator: DocumentOperator;
  readonly tenantId: string;
  readonly alias: string;
  readonly reason: string;
}

export function parseSourceConfirmation(value: unknown): ContextSourceConfirmation {
  requireContext(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_confirmation');
  const row = value as Record<string, unknown>;
  const authored = row.source_kind === 'git_authored';
  const keys = ['instance_id', 'commit', 'tree', 'profile_sha256',
    'expected_journal_id', 'runtime_fingerprint', 'application_id',
    ...(authored ? ['source_kind'] : ['source_journal_id', 'source_revision'])];
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const sha = /^[a-f0-9]{64}$/u;
  requireContext(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key))
    && typeof row.instance_id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.instance_id)
    && typeof row.commit === 'string' && oid.test(row.commit)
    && typeof row.tree === 'string' && oid.test(row.tree)
    && typeof row.profile_sha256 === 'string' && sha.test(row.profile_sha256)
    && isJournalCursor(row.expected_journal_id)
    && (authored || (isJournalCursor(row.source_journal_id)
      && typeof row.source_revision === 'number' && Number.isSafeInteger(row.source_revision) && row.source_revision > 0))
    && typeof row.runtime_fingerprint === 'string' && sha.test(row.runtime_fingerprint)
    && typeof row.application_id === 'string' && sha.test(row.application_id), 'invalid_confirmation');
  const provenance = authored ? { source_kind: 'git_authored' as const }
    : { source_journal_id: row.source_journal_id as string, source_revision: row.source_revision as number };
  return { instance_id: row.instance_id, commit: row.commit, tree: row.tree, profile_sha256: row.profile_sha256,
    ...provenance, expected_journal_id: row.expected_journal_id, runtime_fingerprint: row.runtime_fingerprint,
    application_id: row.application_id };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sourceApplicationId(source: ContextSourceFields, caller: Caller, revision: number): string {
  return hash({ source, tenant_id: caller.tenantId, alias: caller.alias,
    actor: caller.actor, operator: caller.operator.operator_id, reason: caller.reason, expected_revision: revision });
}

export function assertSourceApplication(source: ContextSourceConfirmation, caller: Caller, revision: number | null): void {
  const { application_id, ...fields } = source;
  requireContext(revision !== null && sourceApplicationId(fields, caller, revision) === application_id, 'confirmation_changed');
}

function runtimeFingerprint(preflight: ProfileRuntimePreflight, revision: number): string {
  const prepared = preflight.materialize(revision);
  requireContext(prepared.revision === revision && prepared.verification.generation !== null
    && Number.isSafeInteger(revision) && revision > 0
    && prepared.verification.documents.length > 0, 'runtime_unverified');
  requireContext(prepared.verification.documents.every((document) =>
    !['MEMORY.md', 'HEARTBEAT.md'].includes(document.name)
    || (document.observed_sha !== null && document.expected_sha === document.observed_sha
      && document.expected_bytes === document.observed_bytes)), 'agent_memory_not_preserved');
  return hash({ harness: prepared.harness, generation: prepared.verification.generation,
    container_id: prepared.verification.container_id,
    documents: prepared.verification.documents.map(({ name, path, expected_sha, observed_sha, expected_bytes, observed_bytes }) =>
      ({ name, path, expected_sha, observed_sha, expected_bytes, observed_bytes })),
    preview: prepared.preview,
  });
}

export async function prepareContextSource(
  deps: ContextSourceDeps, caller: Caller, commit: string,
  existing?: { current: Awaited<ReturnType<AgentProfileDeps['readContext']>>; preflight: ProfileRuntimePreflight },
) {
  const binding = deps.binding;
  requireContext(binding !== undefined, 'repository_not_configured');
  const { desired } = await inspectContextRepository({ repositoryPath: binding.repositoryPath, commit,
    scope: { instance_id: binding.instance_id, tenant_id: caller.tenantId, alias: caller.alias } });
  const journal = desired.sourceAgent.source_journal;
  let provenance: ContextSourceProvenance = { source_kind: 'git_authored' };
  if (journal !== null) {
    const sourceJournal = await deps.readProfileRevision(caller.tenantId, caller.alias, journal.revision);
    requireContext(sourceJournal?.id === journal.id && sourceJournal.revision === journal.revision
      && (sourceJournal.operation === 'insert' || sourceJournal.operation === 'update')
      && serializeSourceProfile(sourceJournal, desired.scope) === serializeSourceProfile(desired.profile, desired.scope), 'source_journal_unverified');
    provenance = { source_journal_id: sourceJournal.id, source_revision: sourceJournal.revision };
  }
  const current = existing?.current ?? await deps.profile.readContext(caller.tenantId, caller.alias);
  requireContext(current.exists && current.revision !== null, 'profile_absent');
  requireContext(serializeSourceProfile(current.contexto.perfil, desired.scope)
    !== serializeSourceProfile(desired.profile, desired.scope), 'profile_already_current');
  const currentJournal = await deps.readProfileRevision(caller.tenantId, caller.alias, current.revision);
  requireContext(currentJournal !== undefined && isJournalCursor(currentJournal.id) && currentJournal.revision === current.revision
    && (currentJournal.operation === 'insert' || currentJournal.operation === 'update')
    && serializeSourceProfile(currentJournal, desired.scope) === serializeSourceProfile(current.contexto.perfil, desired.scope), 'current_journal_unverified');
  const contamination = await veredictoDeContaminacion(deps.profile.measureContext, deps.profile.readRuntimeExpectation,
    caller.tenantId, caller.alias);
  requireContext(!contamination.contaminated, 'context_contaminated');
  requireContext(deps.profile.prepareRuntime !== undefined, 'profile_write_unavailable');
  const context: ContextoDeAlias = { perfil: desired.profile, hechos: current.contexto.hechos };
  const preflight = existing?.preflight ?? await deps.profile.prepareRuntime(caller.tenantId, caller.alias, context);
  const fields: ContextSourceFields = { instance_id: binding.instance_id, commit: desired.commit, tree: desired.tree,
    profile_sha256: desired.profileSource.sha256, ...provenance,
    expected_journal_id: currentJournal.id, runtime_fingerprint: runtimeFingerprint(preflight, current.revision + 1) };
  const confirmation: ContextSourceConfirmation = { ...fields, application_id: sourceApplicationId(fields, caller, current.revision) };
  return { tenant_id: caller.tenantId, alias: caller.alias, expected_revision: current.revision,
    before: current.contexto.perfil, profile: desired.profile, context_source: confirmation,
    ficheros: preflight.materialize(current.revision + 1).preview, application: 'not_applied' as const,
    sourceState: 'not_observed' as const };
}

export async function confirmContextSource(
  deps: ContextSourceDeps, caller: Caller,
  source: ContextSourceConfirmation, profile: AgentProfile,
  current: Awaited<ReturnType<AgentProfileDeps['readContext']>>, preflight: ProfileRuntimePreflight,
): Promise<AgentProfileSourceGuard> {
  assertSourceApplication(source, caller, current.revision);
  const preview = await prepareContextSource(deps, caller, source.commit, { current, preflight });
  requireContext(JSON.stringify(preview.context_source) === JSON.stringify(source), 'confirmation_changed');
  const scope = { instance_id: source.instance_id, tenant_id: caller.tenantId, alias: caller.alias };
  requireContext(serializeSourceProfile(profile, scope) === serializeSourceProfile(preview.profile, scope), 'confirmation_changed');
  const { runtime_fingerprint: _fingerprint, ...guard } = source;
  return { ...guard, operator_id: caller.operator.operator_id };
}
