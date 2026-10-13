import { ApiError } from './core';
import type { RequestFn } from './system-client';

interface ContextRepositoryCapability {
  readonly state: 'configured' | 'not_configured' | 'not_published';
  readonly instance_id: string | null;
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

export interface ContextRepositoryClient {
  getContextRepository(tenantId: string, alias: string): Promise<ContextRepositoryCapability>;
}

export function contextRepositoryClient(request: RequestFn): ContextRepositoryClient {
  return {
    async getContextRepository(tenantId, alias) {
      let value: unknown;
      try { value = await request(route(tenantId, alias), { cache: 'no-store' }); }
      catch (error) {
        if (error instanceof ApiError && error.status === 501) {
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
  };
}
