import type { RequestFn } from './system-client';

export interface ProviderAuthRequest {
  operation_id: string; expected_operation_version: number; request_id: string;
  provider_id: 'codex' | 'claude' | 'gemini' | 'minimax' | 'grok' | 'feihoa' | 'muse' | 'agy';
  account_id: string; harness_id: string; host_id: string; runtime_user: string; profile_id: string;
}
export type ProviderAuthStatus = 'opening' | 'awaiting_login' | 'verifying' | 'authenticated' | 'cancelled' | 'expired' | 'failed';
export type ProviderAuthCode = 'AUTHORITY_REVOKED' | 'SESSION_CONFLICT' | 'INVALID_REQUEST' | 'HOST_UNAVAILABLE' | 'RUNTIME_DRIFT'
  | 'STOP_UNCONFIRMED' | 'IDENTITY_MISMATCH' | 'FUNCTIONAL_CHECK_FAILED' | 'LOGIN_FAILED' | 'SESSION_EXPIRED';
export type ProviderAuthDriftReason = 'CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT' | 'CONTAINER_RESOURCE_LIMITS_DRIFT' | 'CONTAINER_ISOLATION_DRIFT';
/** Why the provider's identity probe failed (gateway provider-auth.types.ts); bounded and secret-free. */
export type ProviderAuthProbeReason = 'PROBE_TIMEOUT' | 'PROBE_EXIT' | 'PROBE_BAD_JSON' | 'PROBE_NONCE_MISMATCH'
  | 'PROBE_OUTPUT_LIMIT' | 'PROBE_UNAVAILABLE' | 'PROBE_IDENTITY_MISMATCH' | 'PROBE_IDENTITY_UNAVAILABLE'
  | 'PROBE_PROFILE_UNUSABLE' | 'PROBE_VERSION_MISMATCH' | 'PROBE_CONFIG_SCOPE' | 'PROBE_CONTAINER_EXEC_FAILED';
export type ProviderAuthReason = ProviderAuthDriftReason | ProviderAuthProbeReason;
export interface ProviderAuthSnapshot {
  session_id: string; operation_id: string; provider_id: ProviderAuthRequest['provider_id']; account_id: string;
  harness_id: string; host_id: string; runtime_user: string; profile_id: string; method: 'device' | 'terminal';
  status: ProviderAuthStatus; expires_at: string; cleanup_pending: boolean; error: ProviderAuthCode | null; reason?: ProviderAuthReason;
}
export interface ProviderAuthClient {
  resolveProviderAuthOperation(id: string): Promise<ProviderAuthRequest>;
  start(request: ProviderAuthRequest): Promise<ProviderAuthSnapshot>;
  get(id: string): Promise<ProviderAuthSnapshot>;
  verify(id: string): Promise<ProviderAuthSnapshot>;
  cancel(id: string): Promise<ProviderAuthSnapshot>;
  ticket(id: string): Promise<{ ticket: string; expires_at: string }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u;
const PROVIDERS = ['codex', 'claude', 'gemini', 'minimax', 'grok', 'feihoa', 'muse', 'agy'];
const STATUSES = ['opening', 'awaiting_login', 'verifying', 'authenticated', 'cancelled', 'expired', 'failed'];
const CODES = ['AUTHORITY_REVOKED', 'SESSION_CONFLICT', 'INVALID_REQUEST', 'HOST_UNAVAILABLE', 'RUNTIME_DRIFT', 'STOP_UNCONFIRMED',
  'IDENTITY_MISMATCH', 'FUNCTIONAL_CHECK_FAILED', 'LOGIN_FAILED', 'SESSION_EXPIRED'];
const REASONS = ['CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT', 'CONTAINER_RESOURCE_LIMITS_DRIFT', 'CONTAINER_ISOLATION_DRIFT',
  'PROBE_TIMEOUT', 'PROBE_EXIT', 'PROBE_BAD_JSON', 'PROBE_NONCE_MISMATCH', 'PROBE_OUTPUT_LIMIT', 'PROBE_UNAVAILABLE',
  'PROBE_IDENTITY_MISMATCH', 'PROBE_IDENTITY_UNAVAILABLE', 'PROBE_PROFILE_UNUSABLE', 'PROBE_VERSION_MISMATCH', 'PROBE_CONFIG_SCOPE', 'PROBE_CONTAINER_EXEC_FAILED'];
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
  const keys = Object.hasOwn(result, 'reason') ? [...SNAPSHOT_KEYS, 'reason'] : SNAPSHOT_KEYS;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))
      || (Object.hasOwn(result, 'reason') && (typeof result.reason !== 'string' || !REASONS.includes(result.reason)))
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
/** The ticket's expiry is the server's clock: the browser's may differ, so the window is judged with this tolerance. */
export const TICKET_CLOCK_SKEW_MS = 30_000;
export function providerAuthStreamUrl(sessionId: string, origin = globalThis.location.origin): string {
  const url = new URL(`/v3/console/provider-auth/sessions/${id(sessionId)}/stream`, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== globalThis.location.origin) invalid();
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
export function providerAuthClient(request: RequestFn): ProviderAuthClient {
  const path = '/v3/console/provider-auth/sessions';
  const post = <T,>(url: string, body: unknown) => request<T>(url,
    { method: 'POST', body: JSON.stringify(body), cache: 'no-store', keepalive: true, signal: AbortSignal.timeout(360_000) }, { requireCsrf: true });
  return {
    resolveProviderAuthOperation: async operationId => {
      const result = record(await request(`/v3/console/provider-auth/operations/${id(operationId)}/scope`, { cache: 'no-store' }));
      const keys = ['operation_id', 'expected_operation_version', 'request_id', 'provider_id', 'account_id', 'harness_id', 'host_id', 'runtime_user', 'profile_id'];
      if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))
          || result.operation_id !== operationId || !Number.isSafeInteger(result.expected_operation_version)
          || Number(result.expected_operation_version) < 0 || typeof result.request_id !== 'string'
          || !/^[a-zA-Z0-9_-]{8,128}$/u.test(result.request_id) || !PROVIDERS.includes(String(result.provider_id))) invalid();
      for (const key of ['account_id', 'harness_id', 'host_id', 'profile_id']) {
        if (typeof result[key] !== 'string' || !IDENTIFIER.test(result[key])) invalid();
      }
      if (typeof result.runtime_user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(result.runtime_user)) invalid();
      return result as unknown as ProviderAuthRequest;
    },
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
          || Date.parse(result.expires_at) <= Date.now() - TICKET_CLOCK_SKEW_MS
          || Date.parse(result.expires_at) > Date.now() + 10_000 + TICKET_CLOCK_SKEW_MS) invalid();
      return { ticket: result.ticket, expires_at: result.expires_at };
    },
  };
}
