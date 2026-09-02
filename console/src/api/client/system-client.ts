import type {
  AdapterPage,
  AuditPage,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  ConsoleAccess,
  ObservabilitySnapshot,
  QuotaSnapshot,
  SystemStatus,
  TopologySnapshot,
} from '../types';
import { ApiError, type RequestOptions } from './core';

export type RequestFn = <T>(path: string, init?: RequestInit, options?: RequestOptions) => Promise<T>;

export function getStatus(request: RequestFn): Promise<SystemStatus> {
  return request('/v3/status');
}

export async function getConsoleAccess(request: RequestFn): Promise<ConsoleAccess> {
  try {
    return await request('/v3/console/access');
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
      return { permissions: null, roles: null, reason: 'El gateway no publicó un snapshot RBAC verificable.' };
    }
    if (error instanceof ApiError && error.status === 403) {
      return { permissions: [], roles: [], reason: 'El servidor denegó la consulta RBAC.' };
    }
    throw error;
  }
}

export function getTopology(request: RequestFn): Promise<TopologySnapshot> {
  return request('/v3/console/topology');
}

export function listAdapters(request: RequestFn): Promise<AdapterPage> {
  return request('/v3/console/adapters');
}

export function listAudit(
  request: RequestFn,
  options: { limit?: number; before?: string; signal?: AbortSignal } = {},
): Promise<AuditPage> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('Audit limit must be an integer between 1 and 500');
  }
  if (options.before !== undefined && (
    !/^[1-9][0-9]{0,18}$/u.test(options.before)
    || BigInt(options.before) > 9_223_372_036_854_775_807n
  )) {
    throw new RangeError('Audit cursor must be a canonical positive bigint');
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (options.before !== undefined) query.set('before', options.before);
  return request(`/v3/console/audit?${query.toString()}`, { signal: options.signal });
}

export function getConfiguration(request: RequestFn): Promise<ConfigurationSnapshot> {
  return request('/v3/console/config');
}

export function changeConfiguration(
  request: RequestFn,
  mutation: ConfigMutation,
  options: { dryRun: boolean; expectedRevision?: number },
): Promise<ConfigurationChangeResult> {
  return request('/v3/console/config/changes', {
    method: 'POST',
    body: JSON.stringify({
      dry_run: options.dryRun,
      mutation,
      ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
    }),
  });
}

export function rollbackConfiguration(
  request: RequestFn,
  revisionId: string,
  options: { dryRun: boolean; expectedRevision?: number },
): Promise<ConfigurationChangeResult> {
  return request(`/v3/console/config/revisions/${encodeURIComponent(revisionId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({
      dry_run: options.dryRun,
      ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
    }),
  });
}

export function getObservability(request: RequestFn): Promise<ObservabilitySnapshot> {
  return request('/v3/console/observability');
}

export function getQuotas(request: RequestFn): Promise<QuotaSnapshot> {
  return request('/v3/console/quotas');
}

export interface SystemClient {
  getStatus(): Promise<SystemStatus>;
  getConsoleAccess(): Promise<ConsoleAccess>;
  getTopology(): Promise<TopologySnapshot>;
  listAdapters(): Promise<AdapterPage>;
  listAudit(options?: { limit?: number; before?: string; signal?: AbortSignal }): Promise<AuditPage>;
  getConfiguration(): Promise<ConfigurationSnapshot>;
  changeConfiguration(
    mutation: ConfigMutation,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult>;
  rollbackConfiguration(
    revisionId: string,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult>;
  getObservability(): Promise<ObservabilitySnapshot>;
  getQuotas(): Promise<QuotaSnapshot>;
}

export function systemClient(request: RequestFn): SystemClient {
  return {
    getStatus: () => getStatus(request),
    getConsoleAccess: () => getConsoleAccess(request),
    getTopology: () => getTopology(request),
    listAdapters: () => listAdapters(request),
    listAudit: (options) => listAudit(request, options),
    getConfiguration: () => getConfiguration(request),
    changeConfiguration: (mutation, options) => changeConfiguration(request, mutation, options),
    rollbackConfiguration: (revisionId, options) => rollbackConfiguration(request, revisionId, options),
    getObservability: () => getObservability(request),
    getQuotas: () => getQuotas(request),
  };
}
