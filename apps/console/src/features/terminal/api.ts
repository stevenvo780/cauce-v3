/**
 * PTY data layer for the terminal panel.
 *
 * It deliberately does NOT live in `src/api/client.ts`: the PTY endpoints are optional and
 * feature-scoped, so their absence must degrade this panel only. The request hygiene is a
 * faithful copy of the shared client (same credentials, same headers, same base URL rules,
 * same content-type parsing, same typed error) so the two never drift in what they send.
 *
 * Doctrine: 404 and 501 on optional endpoints are NOT errors, they are a typed UNKNOWN.
 * Absent data is UNKNOWN, never "allowed".
 *
 * 🔴 **LA COPIA SE HABÍA DESVIADO EN LA ÚNICA CABECERA QUE DECIDE SI UNA ESCRITURA ENTRA.**
 * El gateway exige `X-CSRF-Token` a todo `/v3/` que no sea GET/HEAD/OPTIONS y venga con la cookie
 * de consola (`registerPasswordAuth`, gancho `onRequest`). Este módulo copiaba Accept,
 * X-Cauce-Console y Content-Type, y no copiaba esa. Resultado medido contra producción el
 * 2026-08-23: `POST /v3/console/terminal/sessions` = 403 `se requiere un token CSRF válido`, 3 de
 * 3, en dos alias, y la TUI no abría NUNCA. La misma petición con el token = 201 con el grant.
 * El token es el de la sesión, así que sale del cliente compartido: duplicarlo acá sería volver a
 * abrir la misma vía de deriva. La pantalla de acceso promete, con esas palabras, que «toda
 * escritura viaja además con un token CSRF de un solo origen»; ésta no viajaba.
 */
import { ApiError, cauceApi, type CauceApi } from '../../api/client';

export type PtyTargetState = 'online' | 'agent_offline' | 'not_installed' | 'unknown';

export interface TerminalFleetIdentity {
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

export interface TerminalSessionTargetView {
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

function safeBase(baseUrl: string): string {
  if (!baseUrl) return '';
  const parsed = new URL(baseUrl, globalThis.location?.origin ?? 'http://localhost');
  if (parsed.username || parsed.password) {
    throw new Error('VITE_CAUCE_API_BASE must not contain credentials');
  }
  if (import.meta.env.PROD && globalThis.location?.origin && parsed.origin !== globalThis.location.origin) {
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

/** Escritura = lo que el gancho `onRequest` del gateway considera inseguro. Misma lista, misma fuente. */
function esEscritura(method: string | undefined): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes((method ?? 'GET').toUpperCase());
}

/**
 * Lo mínimo que este módulo necesita de la sesión. Es un `Pick` y no `CauceApi` entero para que un
 * componente o un test pueda pasar el suyo sin construir el cliente completo.
 */
type SesionConToken = Pick<CauceApi, 'csrfForMutation'>;

/**
 * El token que abre la puerta CSRF, pedido a la sesión porque es de la SESIÓN, no del módulo. Sólo
 * se pide en las escrituras: en una lectura el gateway no lo exige y pedirlo costaría un viaje de
 * más contra `/v3/auth/session` por cada refresco de la lista de destinos.
 *
 * Un fallo de sesión sale como `TerminalApiError` y no como `ApiError`: quien llama a este módulo
 * ramifica por `TerminalApiError`, y dejar escapar otro tipo convertiría un 401 legible en un
 * error suelto que el panel pinta como fallo desconocido.
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
 * `session` es la sesión que tiene el token CSRF en memoria. Por defecto la compartida; los
 * componentes pasan la suya (`useApi()`) para que una consola con dos clientes —los tests, sin ir
 * más lejos— no escriba con el token del otro.
 */
export async function terminalRequest<T>(
  path: string,
  init: RequestInit = {},
  session: SesionConToken = cauceApi,
): Promise<T> {
  const csrf = esEscritura(init.method) ? await csrfParaEscritura(session) : undefined;
  const response = await fetch(`${safeBase(import.meta.env.VITE_CAUCE_API_BASE ?? '')}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Cauce-Console': '1',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = response.status === 204
    ? undefined
    : contentType.includes('application/json')
      ? await response.json()
      : await response.text();

  if (!response.ok) {
    const detail = errorBody(body);
    // 403/409 carry their operator-facing explanation in `reason`; keep it instead of the status text.
    const message = detail.message ?? detail.reason ?? response.statusText ?? 'Terminal API request failed';
    throw new TerminalApiError(message, response.status, detail.error);
  }
  return body as T;
}

function safeTargetState(value: unknown): PtyTargetState {
  return value === 'online' || value === 'agent_offline' || value === 'not_installed' ? value : 'unknown';
}

function safeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeIdentityList(value: unknown, legacyTenant: string): TerminalFleetIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    // Rolling compatibility with the old gateway, whose cohort was a bare alias list.
    if (typeof item === 'string' && item.trim()) return [{ tenant_id: legacyTenant, alias: item }];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.tenant_id !== 'string' || typeof record.alias !== 'string' ||
        !record.tenant_id.trim() || !record.alias.trim()) return [];
    return [{ tenant_id: record.tenant_id, alias: record.alias }];
  });
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
  return {
    tenant_id: record.tenant_id,
    alias: record.alias,
    container: safeText(record.container),
    runtime_user: safeText(record.runtime_user),
    harness: safeText(record.harness),
    shares_container_with: safeIdentityList(record.shares_container_with, record.tenant_id),
    modes: safeStringList(record.modes),
    pty_state: safeTargetState(record.pty_state),
    last_seen: safeText(record.last_seen),
    // Fail closed: only an explicit boolean true authorises a destination.
    authorized: record.authorized === true,
    reason: typeof record.reason === 'string' && record.reason.trim()
      ? record.reason
      : 'El servidor no informó un motivo para este destino.',
  };
}

/** Inventory of PTY destinations. A gateway without the endpoint yields UNKNOWN, never an empty allow-list. */
export async function listTerminalTargets(): Promise<TerminalTargetsSnapshot> {
  try {
    const payload = await terminalRequest<Record<string, unknown>>('/v3/console/terminal/targets');
    const items = Array.isArray(payload?.items)
      ? payload.items.flatMap((item) => {
        const target = readTerminalTarget(item);
        return target ? [target] : [];
      })
      : null;
    return {
      observed_at: safeText(payload?.observed_at),
      websocket_path: safeText(payload?.websocket_path),
      items,
      ...(items ? {} : { reason: 'El gateway no publicó una lista de targets verificable.' }),
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
  };
  return terminalRequest('/v3/console/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) }, session);
}

export function deleteTerminalSession(
  sessionId: string,
  session?: SesionConToken,
): Promise<void> {
  return terminalRequest(
    `/v3/console/terminal/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    session,
  );
}

/**
 * Una sesión de terminal tal como la lista el gateway para ESTE operador.
 *
 * `expires_at` no es decorativo: es el mismo instante con el que el servidor decide si la sesión
 * sigue ocupando una de las plazas del operador (`openPredicate` en el plugin del gateway). Sin
 * ese campo la consola no puede distinguir una sesión que ocupa plaza de un ticket que caducó
 * hace horas, y las dos llegan con `state` distinto de `closed`.
 */
export interface TerminalSessionListItem {
  session_id: string;
  tenant_id: string;
  alias: string;
  mode: string;
  opened_at: string;
  expires_at: string;
  state: 'issued' | 'active' | 'closed';
}

/**
 * Las sesiones del operador. Es la ÚNICA salida de la trampa que dejó sordo a Ultimate Terminal:
 * el tope del gateway es por operador, las sesiones sobreviven a la vista que las abrió, y sin
 * este listado el operador recibe «cerrá alguna de las sesiones que tenés abiertas» sin tener a
 * la vista ni una sola sesión que cerrar.
 */
export async function listTerminalSessions(session?: SesionConToken): Promise<TerminalSessionListItem[]> {
  const payload = await terminalRequest<Record<string, unknown>>('/v3/console/terminal/sessions', {}, session);
  if (!Array.isArray(payload?.items)) return [];
  return payload.items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.session_id !== 'string' || typeof record.alias !== 'string') return [];
    const state = record.state === 'active' || record.state === 'issued' ? record.state : 'closed';
    return [{
      session_id: record.session_id,
      tenant_id: typeof record.tenant_id === 'string' ? record.tenant_id : '',
      alias: record.alias,
      mode: typeof record.mode === 'string' ? record.mode : '',
      opened_at: typeof record.opened_at === 'string' ? record.opened_at : '',
      expires_at: typeof record.expires_at === 'string' ? record.expires_at : '',
      state,
    }];
  });
}
