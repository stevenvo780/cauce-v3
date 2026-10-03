import type { AgentPerfilValor } from '../types';
import { CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO } from '../../features/live/perfil';
import { ApiError } from './core';
import type { RequestFn } from './system-client';

export type JournalVerification = 'journal_match' | 'journal_mismatch' | 'journal_unavailable';
export interface ContextRepositoryCapability {
  readonly state: 'configured' | 'not_configured' | 'not_published';
  readonly instance_id: string | null;
}
export interface ContextRepositoryInspection {
  readonly commit: string;
  readonly previousCommit: string | null;
  readonly profile: AgentPerfilValor;
  readonly previousProfile: AgentPerfilValor | null;
  readonly journal: JournalVerification;
  readonly previousJournal: JournalVerification | null;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

function malformed(): never {
  throw new ApiError('La respuesta Git no coincide con el agente, instancia o commit solicitado.', 502, 'invalid_context_repository');
}

function route(tenantId: string, alias: string): string {
  return `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/context/repository`;
}

function validateIdentity(value: Record<string, unknown>, tenantId: string, alias: string): void {
  if (value.tenant_id !== tenantId || value.alias !== alias) malformed();
}

function profile(value: unknown, tenantId: string, alias: string): AgentPerfilValor {
  const row = record(value);
  validateIdentity(row, tenantId, alias);
  for (const key of CAMPOS_DE_TEXTO) if (row[key] !== null && typeof row[key] !== 'string') malformed();
  for (const key of CAMPOS_DE_LISTA) {
    const list = row[key];
    if (!Array.isArray(list) || !list.every((item: unknown) => typeof item === 'string')) malformed();
  }
  return Object.fromEntries([...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA].map((key) => [key, row[key]])) as unknown as AgentPerfilValor;
}

function journal(value: unknown): JournalVerification {
  if (value !== 'journal_match' && value !== 'journal_mismatch' && value !== 'journal_unavailable') return malformed();
  return value;
}

function snapshot(value: unknown, tenantId: string, alias: string, instanceId: string, commit: string): AgentPerfilValor {
  const row = record(value);
  const scope = record(row.scope);
  validateIdentity(scope, tenantId, alias);
  if (scope.instance_id !== instanceId || row.commit !== commit || row.provenanceVerification !== 'not_evaluated') malformed();
  return profile(row.profile, tenantId, alias);
}

export interface ContextRepositoryClient {
  getContextRepository(tenantId: string, alias: string): Promise<ContextRepositoryCapability>;
  inspectContextRepository(tenantId: string, alias: string, instanceId: string, commit: string,
    previousCommit?: string): Promise<ContextRepositoryInspection>;
}

export function contextRepositoryClient(request: RequestFn): ContextRepositoryClient {
  return {
    async getContextRepository(tenantId, alias) {
      let value: unknown;
      try { value = await request(route(tenantId, alias), { cache: 'no-store' }); }
      catch (error) {
        if (error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
          return { state: 'not_published', instance_id: null };
        }
        throw error;
      }
      const row = record(value);
      validateIdentity(row, tenantId, alias);
      if (row.storage !== 'loose_objects_only' || row.sourceState !== 'not_observed' || row.application !== 'not_evaluated') malformed();
      if (row.state === 'not_configured' && row.instance_id === null) return { state: 'not_configured', instance_id: null };
      if (row.state !== 'configured' || typeof row.instance_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.instance_id)) return malformed();
      return { state: 'configured', instance_id: row.instance_id };
    },
    async inspectContextRepository(tenantId, alias, instanceId, commit, previousCommit) {
      const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
      if (!oid.test(commit) || (previousCommit !== undefined && !oid.test(previousCommit))) malformed();
      const query = new URLSearchParams({ commit });
      if (previousCommit !== undefined) query.set('previous_commit', previousCommit);
      const row = record(await request(`${route(tenantId, alias)}/inspect?${query.toString()}`, { cache: 'no-store' }));
      validateIdentity(row, tenantId, alias);
      if (row.sourceState !== 'not_observed' || row.application !== 'not_evaluated') malformed();
      const verification = record(row.journalVerification);
      if (previousCommit === undefined && (row.previous !== null || verification.previous !== null)) malformed();
      return {
        commit, previousCommit: previousCommit ?? null,
        profile: snapshot(row.desired, tenantId, alias, instanceId, commit),
        previousProfile: previousCommit === undefined ? null : snapshot(row.previous, tenantId, alias, instanceId, previousCommit),
        journal: journal(verification.desired), previousJournal: previousCommit === undefined ? null : journal(verification.previous),
      };
    },
  };
}
