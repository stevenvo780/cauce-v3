import type { RequestFn } from './system-client';

export interface ProviderAuthRequest {
  operation_id: string; expected_operation_version: number; request_id: string;
  provider_id: 'codex' | 'claude' | 'gemini' | 'minimax' | 'grok' | 'feihoa';
  account_id: string; harness_id: string; host_id: string; runtime_user: string; profile_id: string;
}
export type ProviderAuthStatus = 'opening' | 'awaiting_login' | 'verifying' | 'authenticated' | 'cancelled' | 'expired' | 'failed';
export interface ProviderAuthSnapshot {
  session_id: string; operation_id: string; provider_id: ProviderAuthRequest['provider_id']; account_id: string;
  harness_id: string; host_id: string; runtime_user: string; profile_id: string; method: 'device' | 'terminal';
  status: ProviderAuthStatus; expires_at: string; cleanup_pending: boolean; error: string | null;
}
export interface ProviderAuthClient {
  start(request: ProviderAuthRequest): Promise<ProviderAuthSnapshot>;
  get(id: string): Promise<ProviderAuthSnapshot>;
  verify(id: string): Promise<ProviderAuthSnapshot>;
  cancel(id: string): Promise<ProviderAuthSnapshot>;
  ticket(id: string): Promise<{ ticket: string; expires_at: string }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u;
const PROVIDERS = ['codex', 'claude', 'gemini', 'minimax', 'grok', 'feihoa'];
const STATUSES = ['opening', 'awaiting_login', 'verifying', 'authenticated', 'cancelled', 'expired', 'failed'];
const CODES = ['AUTHORITY_REVOKED', 'SESSION_CONFLICT', 'INVALID_REQUEST', 'HOST_UNAVAILABLE', 'STOP_UNCONFIRMED',
  'IDENTITY_MISMATCH', 'FUNCTIONAL_CHECK_FAILED', 'LOGIN_FAILED', 'SESSION_EXPIRED'];
const SNAPSHOT_KEYS = ['session_id', 'operation_id', 'provider_id', 'account_id', 'harness_id', 'host_id', 'runtime_user',
  'profile_id', 'method', 'status', 'expires_at', 'cleanup_pending', 'error'];
function invalid(): never { throw new Error('El servidor no acreditó esta conexión.'); }
function id(value: string): string { if (!UUID.test(value)) invalid(); return value; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function snapshot(value: unknown, expectedId?: string): ProviderAuthSnapshot {
  const result = record(value);
  if (Object.keys(result).length !== SNAPSHOT_KEYS.length || Object.keys(result).some(key => !SNAPSHOT_KEYS.includes(key))
      || typeof result.session_id !== 'string' || !UUID.test(result.session_id)
      || (expectedId !== undefined && result.session_id !== expectedId)
      || typeof result.operation_id !== 'string' || !UUID.test(result.operation_id)
      || typeof result.provider_id !== 'string' || !PROVIDERS.includes(result.provider_id)
      || typeof result.status !== 'string' || !STATUSES.includes(result.status)
      || typeof result.method !== 'string' || !['device', 'terminal'].includes(result.method)
      || typeof result.cleanup_pending !== 'boolean' || (result.error !== null && (typeof result.error !== 'string' || !CODES.includes(result.error)))
      || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) invalid();
  for (const key of ['account_id', 'harness_id', 'host_id', 'profile_id']) {
    if (typeof result[key] !== 'string' || !IDENTIFIER.test(result[key])) invalid();
  }
  if (typeof result.runtime_user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(result.runtime_user)
      || (result.status === 'authenticated' && (result.cleanup_pending || result.error !== null))) invalid();
  return result as unknown as ProviderAuthSnapshot;
}
export function assertProviderAuthTarget(value: ProviderAuthSnapshot, expected: ProviderAuthRequest): void {
  for (const key of ['operation_id', 'provider_id', 'account_id', 'harness_id', 'host_id', 'runtime_user', 'profile_id'] as const) {
    if (value[key] !== expected[key]) invalid();
  }
}
export function providerAuthStreamUrl(sessionId: string, origin = globalThis.location.origin): string {
  const url = new URL(`/v3/console/provider-auth/sessions/${id(sessionId)}/stream`, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== globalThis.location.origin) invalid();
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
export function providerAuthClient(request: RequestFn): ProviderAuthClient {
  const path = '/v3/console/provider-auth/sessions';
  const post = <T,>(url: string, body: unknown) => request<T>(url,
    { method: 'POST', body: JSON.stringify(body), cache: 'no-store', keepalive: true }, { requireCsrf: true });
  return {
    start: async input => {
      id(input.operation_id);
      if (!Number.isSafeInteger(input.expected_operation_version) || input.expected_operation_version < 0) invalid();
      const result = snapshot(await post(path, input)); assertProviderAuthTarget(result, input); return result;
    },
    get: async value => snapshot(await request(`${path}/${id(value)}`, { cache: 'no-store' }), value),
    verify: async value => snapshot(await post(`${path}/${id(value)}/verify`, {}), value),
    cancel: async value => snapshot(await post(`${path}/${id(value)}/cancel`, {}), value),
    ticket: async value => {
      const result = record(await post(`${path}/${id(value)}/ticket`, {}));
      if (Object.keys(result).length !== 2 || typeof result.ticket !== 'string' || !UUID.test(result.ticket)
          || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))
          || Date.parse(result.expires_at) <= Date.now() || Date.parse(result.expires_at) > Date.now() + 10_000) invalid();
      return { ticket: result.ticket, expires_at: result.expires_at };
    },
  };
}
