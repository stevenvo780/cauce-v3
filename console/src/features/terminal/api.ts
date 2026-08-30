/**
 * PTY data layer for the terminal panel.
 *
 * PTY endpoints are optional and feature-scoped, degrading gracefully to UNKNOWN.
 * Ensures strict CSRF token propagation (`X-CSRF-Token`) matching the shared client configuration.
 */
import { ApiError, cauceApi, type CauceApi } from '../../api/client';

type PtyTargetState = 'online' | 'agent_offline' | 'not_installed' | 'unknown';

interface TerminalFleetIdentity {
  tenant_id: string;
  alias: string;
}

/** Server-declared destination. `authorized` is the only per-target authority; the client never infers it. */
export interface TerminalTarget {
  tenant_id: string;
  alias: string;
  container: string | null;
  runtime_user: string | null;
  harness: string | null;
  /** Other agents living in the same container: a shell here reaches all of them. */
  shares_container_with: TerminalFleetIdentity[];
  modes: string[];
  pty_state: PtyTargetState;
  last_seen: string | null;
  authorized: boolean;
  reason: string;
}

export interface TerminalTargetsSnapshot {
  observed_at?: string | null;
  websocket_path?: string | null;
  /** `null` means the gateway does not publish the inventory (UNKNOWN); `[]` means "published, empty". */
  items: TerminalTarget[] | null;
  reason?: string;
}

interface TerminalSessionTargetView {
  tenant_id: string;
  alias: string;
  container: string | null;
  runtime_user: string | null;
  mode: string;
  shares_container_with: TerminalFleetIdentity[];
}

/**
 * Single-use, 30 s grant. It is requested immediately before opening the WebSocket and is
 * never written to localStorage, sessionStorage or the URL.
 */
export interface TerminalSessionGrant {
  session_id: string;
  ticket: string;
  websocket_path: string;
  expires_at: string;
  ttl_seconds: number;
  /** True only when the gateway rebuilt the same lost-201 receipt from its durable reservation. */
  receipt_recovered: boolean;
  /** Stable semantic admission id and the exact in-memory capability required to revoke it. */
  request_id: string;
  owner_generation: string;
  owner_token: string;
  target: TerminalSessionTargetView;
}

export interface CreateTerminalSessionInput {
  tenant_id: string;
  alias: string;
  mode: string;
  /** Hand-written operator justification; audited server-side. */
  reason: string;
  cols: number;
  rows: number;
  /** Stable across retries of one logical tab; new after an explicit close/reopen. */
  request_id: string;
  /** Raw UUIDv4 capability. It is held in memory only; PostgreSQL stores its SHA-256 digest. */
  owner_token: string;
}

export interface TerminalSessionOwner {
  request_id: string;
  owner_generation: string;
  owner_token: string;
}

export class TerminalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TerminalApiError';
  }
}

/** Same generous upper bound as the shared console client, including response-body consumption. */
export const TERMINAL_REQUEST_TIMEOUT_MS = 30_000;

function terminalTimeout(method: string, path: string): TerminalApiError {
  return new TerminalApiError(
    `El plano terminal no contestó en ${String(Math.round(TERMINAL_REQUEST_TIMEOUT_MS / 1000))} s `
      + `y la consola cortó la espera (${method} ${path}). Se puede volver a intentar sin asumir que la operación terminó.`,
    504,
    'timeout',
  );
}

function safeBase(baseUrl: string): string {
  if (!baseUrl) return '';
  const currentOrigin = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://localhost';
  const parsed = new URL(baseUrl, currentOrigin);
  if (parsed.username || parsed.password) {
    throw new Error('VITE_CAUCE_API_BASE must not contain credentials');
  }
  if (import.meta.env.PROD && typeof globalThis.location !== 'undefined' && parsed.origin !== globalThis.location.origin) {
    throw new Error('Production OIDC BFF API base must be same-origin');
  }
  return baseUrl.replace(/\/$/, '');
}

function errorBody(value: unknown): { message?: string; error?: string; reason?: string } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/** Write = whatever the gateway's `onRequest` hook considers unsafe. Same list, same source. */
function esEscritura(method: string | undefined): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes((method ?? 'GET').toUpperCase());
}

/**
 * The minimum this module needs from the session. It is a `Pick`, not the whole `CauceApi`, so a
 * component or test can pass its own without building the full client.
 */
type SesionConToken = Pick<CauceApi, 'csrfForMutation'>;

/**
 * The token that opens the CSRF door, fetched from the session because it belongs to the SESSION,
 * not the module. Fetched only on writes: on a read the gateway does not require it, and fetching
 * it would cost an extra round-trip to `/v3/auth/session` for every target-list refresh.
 *
 * A session failure surfaces as `TerminalApiError`, not `ApiError`: callers of this module branch
 * on it, and letting another type through would turn a readable 401 into a loose error that the
 * panel paints as an unknown failure.
 */
async function csrfParaEscritura(session: SesionConToken): Promise<string | undefined> {
  try {
    return await session.csrfForMutation();
  } catch (error) {
    if (error instanceof ApiError) throw new TerminalApiError(error.message, error.status, error.code);
    throw error;
  }
}

/**
 * `session` is the session that holds the CSRF token in memory. The shared one by default; the
 * components pass their own (`useApi()`) so a console with two clients —tests, for one— does not
 * write with the other's token.
 */
async function terminalResponse(
  path: string,
  init: RequestInit = {},
  session: SesionConToken = cauceApi,
): Promise<{ status: number; body: unknown }> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const controller = new AbortController();
  const onExternalAbort = () => { controller.abort(init.signal?.reason); };
  if (init.signal?.aborted) onExternalAbort();
  else init.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(terminalTimeout(method, path));
    }, TERMINAL_REQUEST_TIMEOUT_MS);
  });

  const operation = async (): Promise<{ status: number; body: unknown }> => {
    const csrf = esEscritura(init.method) ? await csrfParaEscritura(session) : undefined;
    const requestHeaders: Record<string, string> = {
      Accept: 'application/json',
      'X-Cauce-Console': '1',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((val, key) => { requestHeaders[key] = val; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) requestHeaders[k] = v;
      } else {
        Object.assign(requestHeaders, init.headers);
      }
    }
    const response = await fetch(`${safeBase(import.meta.env.VITE_CAUCE_API_BASE ?? '')}${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
      headers: requestHeaders,
    });

    // The deadline intentionally remains armed while consuming the body. A proxy can deliver
    // headers and then stall the JSON stream forever; headers alone are not a completed request.
    const contentType = response.headers.get('content-type') ?? '';
    const body: unknown = response.status === 204
      ? undefined
      : contentType.includes('application/json')
        ? await response.json()
        : await response.text();

    if (!response.ok) {
      const detail = errorBody(body);
      // 403/409 carry their operator-facing explanation in `reason`; keep it instead of the status text.
      const message = detail.message ?? detail.reason ?? (response.statusText ? response.statusText : 'Terminal API request failed');
      throw new TerminalApiError(message, response.status, detail.error);
    }
    return { status: response.status, body };
  };

  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    init.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function terminalRequest<T>(
  path: string,
  init: RequestInit = {},
  session: SesionConToken = cauceApi,
): Promise<T> {
  return (await terminalResponse(path, init, session)).body as T;
}

function exactTargetState(value: unknown): PtyTargetState | undefined {
  return value === 'online' || value === 'agent_offline' || value === 'not_installed' || value === 'unknown'
    ? value
    : undefined;
}

function exactStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item || seen.has(item)) return undefined;
    seen.add(item);
    values.push(item);
  }
  return values;
}

function exactIdentityList(value: unknown, legacyTenant: string): TerminalFleetIdentity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identities: TerminalFleetIdentity[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    // Rolling compatibility with the old gateway, whose cohort was a bare alias list.
    let identity: TerminalFleetIdentity;
    if (typeof item === 'string' && item.trim()) {
      identity = { tenant_id: legacyTenant, alias: item };
    } else {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      if (!exactKeys(record, ['tenant_id', 'alias'])
          || typeof record.tenant_id !== 'string' || typeof record.alias !== 'string'
          || !record.tenant_id.trim() || !record.alias.trim()) return undefined;
      identity = { tenant_id: record.tenant_id, alias: record.alias };
    }
    const key = `${identity.tenant_id}\u0000${identity.alias}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    identities.push(identity);
  }
  return identities;
}

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Normalises one server target. Anything missing or malformed collapses to UNKNOWN / not authorized. */
export function readTerminalTarget(value: unknown): TerminalTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.tenant_id !== 'string' || typeof record.alias !== 'string') return undefined;
  if (!record.tenant_id.trim() || !record.alias.trim()) return undefined;
  const cohort = exactIdentityList(record.shares_container_with, record.tenant_id);
  const modes = exactStringList(record.modes);
  const ptyState = exactTargetState(record.pty_state);
  if (cohort === undefined || modes === undefined || ptyState === undefined
      || typeof record.authorized !== 'boolean'
      || typeof record.reason !== 'string' || !record.reason.trim()
      || cohort.some((member) => member.tenant_id === record.tenant_id && member.alias === record.alias)) {
    return undefined;
  }
  return {
    tenant_id: record.tenant_id,
    alias: record.alias,
    container: safeText(record.container),
    runtime_user: safeText(record.runtime_user),
    harness: safeText(record.harness),
    shares_container_with: cohort,
    modes,
    pty_state: ptyState,
    last_seen: safeText(record.last_seen),
    // Fail closed: only an explicit boolean true authorises a destination.
    authorized: record.authorized,
    reason: record.reason,
  };
}

/** Inventory of PTY destinations. A gateway without the endpoint yields UNKNOWN, never an empty allow-list. */
export async function listTerminalTargets(): Promise<TerminalTargetsSnapshot> {
  try {
    const payload = await terminalRequest<Record<string, unknown>>('/v3/console/terminal/targets');
    let items: TerminalTarget[] | null = null;
    let invalidInventory = false;
    if (Array.isArray(payload.items)) {
      const parsed: TerminalTarget[] = [];
      const seen = new Set<string>();
      for (const item of payload.items) {
        const target = readTerminalTarget(item);
        const key = target === undefined ? undefined : `${target.tenant_id}\u0000${target.alias}`;
        if (target === undefined || key === undefined || seen.has(key)) {
          // Hiding only the broken row would fabricate a partial inventory that looks complete.
          // For PTY authority, partial is UNKNOWN: no destination is enabled or counted.
          invalidInventory = true;
          break;
        }
        seen.add(key);
        parsed.push(target);
      }
      if (!invalidInventory) items = parsed;
    }
    return {
      observed_at: safeText(payload.observed_at),
      websocket_path: safeText(payload.websocket_path),
      items,
      ...(items ? {} : {
        reason: invalidInventory
          ? 'El gateway publicó un inventario PTY parcial, duplicado o mal formado; no se asumió autoridad sobre ningún destino.'
          : 'El gateway no publicó una lista de targets verificable.',
      }),
    };
  } catch (error) {
    if (error instanceof TerminalApiError && (error.status === 404 || error.status === 501)) {
      return { items: null, reason: 'El gateway no expone el inventario de targets PTY.' };
    }
    throw error;
  }
}

/**
 * Requests the single-use ticket. Errors are surfaced verbatim: 403 means the server refused
 * the destination and 409 means the container/agent cannot take the session right now.
 */
export function createTerminalSession(
  input: CreateTerminalSessionInput,
  session?: SesionConToken,
): Promise<TerminalSessionGrant> {
  const payload: CreateTerminalSessionInput = {
    tenant_id: input.tenant_id,
    alias: input.alias,
    mode: input.mode,
    reason: input.reason,
    cols: input.cols,
    rows: input.rows,
    request_id: input.request_id,
    owner_token: input.owner_token,
  };
  return terminalResponse(
    '/v3/console/terminal/sessions',
    { method: 'POST', body: JSON.stringify(payload) },
    session,
  ).then(({ status, body: value }) => {
    const grant = status === 201 ? exactTerminalSessionGrant(value, payload) : undefined;
    if (grant) return grant;

    // The INSERT may have committed even though the JSON was truncated, but a `session_id` inside
    // that malformed receipt has no causal authority to revoke anything: it might belong to
    // another tab or be outright hostile. The UI re-reads the exact operator inventory and only
    // exposes an explicit DELETE on a visible row; we never revoke blindly here.
    throw new TerminalApiError(
      'El gateway devolvió un grant PTY incompleto. No se usó su session_id para revocar nada; se debe conciliar contra el inventario exacto de sesiones visibles.',
      409,
      'invalid_grant_receipt',
    );
  });
}

function boundedOpaque(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return undefined;
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code <= 31 || code === 127) return undefined;
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_BIGINT = /^[1-9][0-9]{0,18}$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function canonicalUuidV4(value: unknown): string | undefined {
  return typeof value === 'string' && CANONICAL_UUID_V4.test(value) ? value : undefined;
}

function positiveBigint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !POSITIVE_BIGINT.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}

function canonicalBase64urlBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = globalThis.atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}${padding}`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = globalThis.btoa(String.fromCharCode(...bytes))
      .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

interface BrowserTicketClaims {
  sid: string;
  tenant: string;
  alias: string;
  container: string;
  runtimeUser: string;
  mode: string;
  expiresAtSeconds: number;
  ttlSeconds: number;
}

/**
 * The browser does not possess the per-alias HMAC key, so the relay remains the signature
 * authority. It can still reject an internally contradictory 201 before opening a socket: the
 * signed payload must be the exact v1 shape and must name the same session and target as the JSON
 * projection next to it.
 */
function exactBrowserTicketClaims(ticket: string): BrowserTicketClaims | undefined {
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  const payloadBytes = canonicalBase64urlBytes(parts[1] ?? '');
  const signatureBytes = canonicalBase64urlBytes(parts[2] ?? '');
  if (!payloadBytes || signatureBytes?.byteLength !== 32) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['v', 'sid', 'op', 'sub', 'tgt', 'mode', 'iat', 'exp']) || row.v !== 1
      || !Number.isSafeInteger(row.iat) || !Number.isSafeInteger(row.exp)
      || Number(row.exp) <= Number(row.iat)) return undefined;
  const sid = boundedOpaque(row.sid, 256);
  const operator = boundedOpaque(row.op, 256);
  const subject = boundedOpaque(row.sub, 256);
  const mode = boundedOpaque(row.mode, 64);
  if (!sid || !operator || !subject || !mode
      || row.tgt === null || typeof row.tgt !== 'object' || Array.isArray(row.tgt)) return undefined;
  const target = row.tgt as Record<string, unknown>;
  if (!exactKeys(target, ['tenant', 'alias', 'container', 'generation', 'image', 'uid', 'user'])
      || !Number.isSafeInteger(target.uid)) return undefined;
  const tenant = boundedOpaque(target.tenant, 64);
  const alias = boundedOpaque(target.alias, 64);
  const container = boundedOpaque(target.container, 256);
  const generation = boundedOpaque(target.generation, 256);
  const image = boundedOpaque(target.image, 512);
  const runtimeUser = boundedOpaque(target.user, 128);
  if (!tenant || !alias || !container || !generation || !image || !runtimeUser) return undefined;
  return {
    sid,
    tenant,
    alias,
    container,
    runtimeUser,
    mode,
    expiresAtSeconds: Number(row.exp),
    ttlSeconds: Number(row.exp) - Number(row.iat),
  };
}

function exactGrantCohort(value: unknown, target: CreateTerminalSessionInput): TerminalFleetIdentity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cohort: TerminalFleetIdentity[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    if (!exactKeys(row, ['tenant_id', 'alias'])) return undefined;
    const tenantId = boundedOpaque(row.tenant_id, 64);
    const alias = boundedOpaque(row.alias, 64);
    if (!tenantId || !alias || (tenantId === target.tenant_id && alias === target.alias)) return undefined;
    const key = `${tenantId}\u0000${alias}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    cohort.push({ tenant_id: tenantId, alias });
  }
  return cohort;
}

/** Exact causal projection of a newly inserted PTY reservation; tickets remain memory-only. */
function exactTerminalSessionGrant(
  value: unknown,
  requested: CreateTerminalSessionInput,
): TerminalSessionGrant | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'session_id', 'ticket', 'websocket_path', 'expires_at', 'ttl_seconds',
    'receipt_recovered', 'request_id', 'owner_generation', 'target',
  ])) return undefined;
  const target = record.target;
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const targetRow = target as Record<string, unknown>;
  if (!exactKeys(targetRow, [
    'tenant_id', 'alias', 'container', 'runtime_user', 'mode', 'shares_container_with',
  ])) return undefined;
  const sessionId = boundedOpaque(record.session_id, 256);
  const ticket = boundedOpaque(record.ticket, 4_096);
  const websocketPath = boundedOpaque(record.websocket_path, 256);
  const expiresAt = boundedOpaque(record.expires_at, 64);
  const expiry = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  const ttl = record.ttl_seconds;
  const requestId = canonicalUuidV4(record.request_id);
  const ownerGeneration = positiveBigint(record.owner_generation);
  const ticketClaims = ticket === undefined ? undefined : exactBrowserTicketClaims(ticket);
  const cohort = exactGrantCohort(targetRow.shares_container_with, requested);
  const container = targetRow.container === null ? null : boundedOpaque(targetRow.container, 256);
  const runtimeUser = targetRow.runtime_user === null ? null : boundedOpaque(targetRow.runtime_user, 128);
  if (!sessionId || !ticket || !websocketPath || !/^\/[A-Za-z0-9/_-]+$/u.test(websocketPath)
      // The gateway is the authoritative clock for the ticket. The browser only requires a valid
      // ISO: with clock skew or a slow network, deciding locally that it already expired would
      // close a session the server can still accept (the WebSocket checks it when redeeming).
      || !expiresAt || !Number.isFinite(expiry)
      || !Number.isSafeInteger(ttl) || Number(ttl) < 1 || Number(ttl) > 120
      || typeof record.receipt_recovered !== 'boolean'
      || requestId !== requested.request_id
      || ownerGeneration === undefined
      || targetRow.tenant_id !== requested.tenant_id
      || targetRow.alias !== requested.alias
      || targetRow.mode !== requested.mode
      || container === undefined || runtimeUser === undefined || cohort === undefined
      || ticketClaims?.sid !== sessionId
      || ticketClaims.tenant !== requested.tenant_id
      || ticketClaims.alias !== requested.alias
      || ticketClaims.container !== container
      || ticketClaims.runtimeUser !== runtimeUser
      || ticketClaims.mode !== requested.mode
      || ticketClaims.expiresAtSeconds !== Math.floor(expiry / 1_000)
      || ticketClaims.ttlSeconds !== Number(ttl)) {
    return undefined;
  }
  return {
    session_id: sessionId,
    ticket,
    websocket_path: websocketPath,
    expires_at: expiresAt,
    ttl_seconds: Number(ttl),
    receipt_recovered: record.receipt_recovered,
    request_id: requestId,
    owner_generation: ownerGeneration,
    owner_token: requested.owner_token,
    target: {
      tenant_id: requested.tenant_id,
      alias: requested.alias,
      container,
      runtime_user: runtimeUser,
      mode: requested.mode,
      shares_container_with: cohort,
    },
  };
}

export function deleteTerminalSession(
  sessionId: string,
  owner: TerminalSessionOwner,
  session?: SesionConToken,
): Promise<void> {
  return terminalResponse(
    `/v3/console/terminal/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        request_id: owner.request_id,
        owner_generation: owner.owner_generation,
        owner_token: owner.owner_token,
      }),
    },
    session,
  ).then(({ status, body }) => {
    if (status !== 204 || body !== undefined) {
      throw new TerminalApiError(
        'El gateway no devolvió el recibo vacío 204 que acredita la liberación de la sesión PTY.',
        409,
        'invalid_release_receipt',
      );
    }
  });
}

/** Explicit operator takeover for an orphan visible in the exact session inventory. */
export function rotateTerminalSessionOwner(
  sessionId: string,
  current: Pick<TerminalSessionOwner, 'request_id' | 'owner_generation'>,
  ownerToken: string,
  session?: SesionConToken,
): Promise<TerminalSessionOwner> {
  return terminalResponse(
    `/v3/console/terminal/sessions/${encodeURIComponent(sessionId)}/owner`,
    {
      method: 'POST',
      body: JSON.stringify({
        request_id: current.request_id,
        expected_owner_generation: current.owner_generation,
        owner_token: ownerToken,
      }),
    },
    session,
  ).then(({ status, body }) => {
    if (status !== 200 || body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new TerminalApiError('El gateway no acreditó el takeover de la sesión PTY.', 409, 'invalid_owner_receipt');
    }
    const record = body as Record<string, unknown>;
    const generation = positiveBigint(record.owner_generation);
    const expected = positiveBigint(current.owner_generation);
    if (!exactKeys(record, ['owner_generation', 'request_id', 'session_id'])
        || record.session_id !== sessionId
        || record.request_id !== current.request_id
        || generation === undefined
        || expected === undefined
        || BigInt(generation) !== BigInt(expected) + 1n) {
      throw new TerminalApiError('El gateway devolvió un takeover PTY ambiguo.', 409, 'invalid_owner_receipt');
    }
    return { request_id: current.request_id, owner_generation: generation, owner_token: ownerToken };
  });
}

/**
 * A terminal session as listed by the gateway for THIS operator.
 *
 * `expires_at` is not decorative: it is the same instant the server uses to decide whether the
 * session still occupies one of the operator's slots (`openPredicate` in the gateway plugin).
 * Without this field the console cannot tell apart a session that is occupying a slot from a
 * ticket that expired hours ago, and both arrive with a `state` other than `closed`.
 */
export interface TerminalSessionListItem {
  session_id: string;
  tenant_id: string;
  alias: string;
  mode: string;
  opened_at: string;
  expires_at: string;
  state: 'issued' | 'active' | 'closed';
  request_id: string;
  owner_generation: string;
}

/**
 * Lists the operator's active sessions to reconcile the concurrent session budget.
 */
export async function listTerminalSessions(session?: SesionConToken): Promise<TerminalSessionListItem[]> {
  const payload = await terminalRequest<unknown>('/v3/console/terminal/sessions', {}, session);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || !exactKeys(payload as Record<string, unknown>, ['items'])
      || !Array.isArray((payload as Record<string, unknown>).items)) {
    throw new TerminalApiError(
      'El gateway no devolvió un inventario verificable de sesiones PTY.', 409, 'invalid_sessions_receipt',
    );
  }
  const result: TerminalSessionListItem[] = [];
  const seen = new Set<string>();
  for (const item of (payload as Record<string, unknown>).items as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TerminalApiError(
        'El gateway devolvió una sesión PTY mal formada.', 409, 'invalid_sessions_receipt',
      );
    }
    const record = item as Record<string, unknown>;
    if (!exactKeys(record, [
      'session_id', 'tenant_id', 'alias', 'mode', 'opened_at', 'expires_at', 'state',
      'request_id', 'owner_generation',
    ])) {
      throw new TerminalApiError(
        'El gateway devolvió una sesión PTY mal formada.', 409, 'invalid_sessions_receipt',
      );
    }
    const sessionId = boundedOpaque(record.session_id, 256);
    const tenantId = boundedOpaque(record.tenant_id, 64);
    const alias = boundedOpaque(record.alias, 64);
    const mode = boundedOpaque(record.mode, 64);
    const openedAt = boundedOpaque(record.opened_at, 64);
    const expiresAt = boundedOpaque(record.expires_at, 64);
    const state = record.state;
    const requestId = canonicalUuidV4(record.request_id);
    const ownerGeneration = positiveBigint(record.owner_generation);
    if (!sessionId || !tenantId || !alias || !mode || !openedAt || !expiresAt
        || !Number.isFinite(Date.parse(openedAt)) || !Number.isFinite(Date.parse(expiresAt))
        || (state !== 'issued' && state !== 'active' && state !== 'closed')
        || !requestId || ownerGeneration === undefined || seen.has(sessionId)) {
      throw new TerminalApiError(
        'El gateway devolvió una sesión PTY mal formada.', 409, 'invalid_sessions_receipt',
      );
    }
    seen.add(sessionId);
    result.push({
      session_id: sessionId,
      tenant_id: tenantId,
      alias,
      mode,
      opened_at: openedAt,
      expires_at: expiresAt,
      state,
      request_id: requestId,
      owner_generation: ownerGeneration,
    });
  }
  return result;
}
