import type { AgentPerfilValor } from '../types';
import { CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO } from '../../features/live/perfil';
import { ApiError } from './core';
import type { RequestFn } from './system-client';

export interface NativeSourceFile { readonly path: string; readonly bytes: number; readonly sha256: string; readonly content: string }
export interface NativeSourceSnapshot {
  readonly commit: string; readonly tree: string;
  readonly scope: { instance_id: string; tenant_id: string; alias: string };
  readonly profile: AgentPerfilValor;
  readonly profileSource: NativeSourceFile; readonly manualSource: NativeSourceFile;
  readonly sourceAgent: { tenant_id: string; alias: string; source_journal: null; native_manual: { harness: 'claude' | 'codex' | 'openclaw' } };
}
export interface NativeSourceChange { readonly path: string; readonly kind: 'modified' | 'added' | 'removed'; readonly before: NativeSourceFile | null; readonly after: NativeSourceFile | null }
export interface NativeContextRepositoryInspection {
  readonly desired: NativeSourceSnapshot; readonly previous: NativeSourceSnapshot | null;
  readonly changes: readonly NativeSourceChange[] | null;
  readonly sourceState: 'not_observed'; readonly application: 'not_evaluated'; readonly applySupported: false;
}
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
function malformed(): never { throw new ApiError('La respuesta del manual Git no coincide con el ámbito solicitado.', 502, 'invalid_native_context_repository'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) malformed();
  return row;
}
function identity(row: Record<string, unknown>, tenantId: string, alias: string) {
  if (row.tenant_id !== tenantId || row.alias !== alias) malformed();
}
function file(value: unknown, path: string): NativeSourceFile {
  const row = record(value, ['path', 'bytes', 'sha256', 'content']);
  if (row.path !== path || typeof row.content !== 'string' || typeof row.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes)
    || Number(row.bytes) > 128 * 1024 || row.bytes !== new TextEncoder().encode(row.content).length) return malformed();
  return { path, bytes: row.bytes, content: row.content, sha256: row.sha256 };
}
function snapshot(value: unknown, tenantId: string, alias: string, instanceId: string, commit: string): NativeSourceSnapshot {
  const row = record(value, ['scope', 'commit', 'tree', 'profile', 'profileSource', 'manualSource', 'sourceAgent']);
  const scope = record(row.scope, ['tenant_id', 'alias', 'instance_id']);
  identity(scope, tenantId, alias);
  if (scope.instance_id !== instanceId || row.commit !== commit || typeof row.tree !== 'string' || !OID.test(row.tree)) malformed();
  const agent = record(row.sourceAgent, ['tenant_id', 'alias', 'source_journal', 'native_manual']);
  identity(agent, tenantId, alias);
  const manual = record(agent.native_manual, ['harness']);
  const harness = manual.harness;
  if (agent.source_journal !== null || (harness !== 'claude' && harness !== 'codex' && harness !== 'openclaw')) return malformed();
  const profile = record(row.profile, ['tenant_id', 'alias', ...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA]);
  identity(profile, tenantId, alias);
  for (const key of CAMPOS_DE_TEXTO) if (profile[key] !== null && typeof profile[key] !== 'string') malformed();
  for (const key of CAMPOS_DE_LISTA) if (!Array.isArray(profile[key]) || !profile[key].every((item: unknown) => typeof item === 'string')) malformed();
  const root = `tenants/${tenantId}/agents/${alias}`;
  return { scope: { tenant_id: tenantId, alias, instance_id: instanceId }, commit, tree: row.tree,
    profile: Object.fromEntries([...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA].map((key) => [key, profile[key]])) as unknown as AgentPerfilValor,
    sourceAgent: { tenant_id: tenantId, alias, source_journal: null, native_manual: { harness } },
    profileSource: file(row.profileSource, `${root}/profile.json`),
    manualSource: file(row.manualSource, `${root}/native/${harness}/${harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`) };
}
function changes(value: unknown, previous: NativeSourceSnapshot | null, desired: NativeSourceSnapshot): readonly NativeSourceChange[] | null {
  if (previous === null) { if (value !== null) malformed(); return null; }
  if (!Array.isArray(value)) return malformed();
  const before = new Map([previous.profileSource, previous.manualSource].map((item) => [item.path, item]));
  const after = new Map([desired.profileSource, desired.manualSource].map((item) => [item.path, item]));
  const expected = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path)?.sha256 !== after.get(path)?.sha256);
  if (value.length !== expected.length) malformed();
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const row = record(item, ['path', 'kind', 'before', 'after']);
    if (typeof row.path !== 'string' || !expected.includes(row.path) || seen.has(row.path)) return malformed();
    seen.add(row.path);
    const old = before.get(row.path) ?? null;
    const next = after.get(row.path) ?? null;
    const kind = old === null ? 'added' : next === null ? 'removed' : 'modified';
    if (row.kind !== kind) malformed();
    for (const [raw, source] of [[row.before, old], [row.after, next]] as const) {
      if (source === null) { if (raw !== null) malformed(); }
      else if (JSON.stringify(file(raw, source.path)) !== JSON.stringify(source)) malformed();
    }
    return { path: row.path, kind, before: old, after: next };
  });
}
export interface NativeContextRepositoryClient {
  inspectNativeContextRepository(tenantId: string, alias: string, instanceId: string, commit: string, previousCommit?: string): Promise<NativeContextRepositoryInspection>;
}
export function nativeContextRepositoryClient(request: RequestFn): NativeContextRepositoryClient {
  return { async inspectNativeContextRepository(tenantId, alias, instanceId, commit, previousCommit) {
    if (!OID.test(commit) || (previousCommit !== undefined && !OID.test(previousCommit))) malformed();
    const query = new URLSearchParams({ commit });
    if (previousCommit !== undefined) query.set('previous_commit', previousCommit);
    const row = record(await request(`/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/context/repository/native-inspect?${query.toString()}`,
      { method: 'GET', cache: 'no-store' }), ['tenant_id', 'alias', 'desired', 'previous', 'changes', 'sourceState', 'application', 'applySupported']);
    identity(row, tenantId, alias);
    if (row.sourceState !== 'not_observed' || row.application !== 'not_evaluated' || row.applySupported !== false) malformed();
    const desired = snapshot(row.desired, tenantId, alias, instanceId, commit);
    if (previousCommit === undefined && row.previous !== null) malformed();
    const previous = previousCommit === undefined ? null : snapshot(row.previous, tenantId, alias, instanceId, previousCommit);
    return { desired, previous, changes: changes(row.changes, previous, desired), sourceState: 'not_observed', application: 'not_evaluated', applySupported: false };
  } };
}
