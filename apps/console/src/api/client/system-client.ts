import type {
  AdapterPage,
  AuditPage,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  ConsoleAccess,
  ConsoleAuthState,
  ObservabilitySnapshot,
  QuotaSnapshot,
  SystemStatus,
  TopologySnapshot,
} from '../types';
import { ApiError, type RequestOptions } from './core';

export type RequestFn = <T>(path: string, init?: RequestInit, options?: RequestOptions) => Promise<T>;

export async function login(
  request: RequestFn,
  email: string,
  password: string,
  callbacks: { setBffSessionSupported: (val: boolean) => void; setCsrfToken: (val?: string) => void },
): Promise<ConsoleAuthState> {
  const state = await request<ConsoleAuthState>('/v3/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, { requireCsrf: false });
  callbacks.setBffSessionSupported(true);
  callbacks.setCsrfToken(typeof state.csrf_token === 'string' ? state.csrf_token : undefined);
  return state;
}

export async function getAuthSession(
  request: RequestFn,
  callbacks: { setBffSessionSupported: (val: boolean) => void; setCsrfToken: (val?: string) => void },
): Promise<ConsoleAuthState> {
  try {
    const state = await request<ConsoleAuthState>('/v3/auth/session');
    callbacks.setBffSessionSupported(true);
    callbacks.setCsrfToken(state.authenticated && typeof state.csrf_token === 'string' ? state.csrf_token : undefined);
    return state;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
      callbacks.setBffSessionSupported(false);
      return { authenticated: null, reason: 'El gateway usa autenticación no-BFF.' };
    }
    throw error;
  }
}

export async function logout(
  request: RequestFn,
  callbacks: { setCsrfToken: (val?: string) => void },
): Promise<void> {
  await request<void>('/v3/auth/logout', { method: 'POST' });
  callbacks.setCsrfToken(undefined);
}

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
