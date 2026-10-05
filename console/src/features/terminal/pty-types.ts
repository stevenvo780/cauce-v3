import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export type PtyChannelState = 'connecting' | 'attaching' | 'open' | 'closed' | 'error';

export interface PtyNotice {
  level: string;
  message: string;
}

/** Immutable snapshot consumed by React through `useSyncExternalStore`. */
export interface PtySessionView {
  state: PtyChannelState;
  message?: string;
  closeCode?: number;
  notices: PtyNotice[];
  /** The DOM renderer refused to start (headless/jsdom); the channel may still be live. */
  renderError?: string;
  /** `false` when the operator scrolled up to read and new output arrived below. */
  seguirAlFinal: boolean;
  /** Columns that actually fit on this screen. */
  columnas?: number;
  columnasRemotas?: number;
  /** Spent single-use ticket. Never returns to false: a reconnection resumes the same PTY. */
  ticketConsumido?: boolean;
}

export interface PtySessionOptions {
  sessionId: string;
  websocketPath: string;
  ticket: string;
  authorityProof: string;
  readOnly?: boolean;
  onClosed?: (view: PtySessionView) => void;
}

const MAX_AUTHORITY_RESUME_BYTES = 8_192;
const MAX_LEGACY_RESUME_BYTES = 1_024;

function canonicalBase64urlBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const binary = globalThis.atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}${padding}`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = globalThis.btoa(String.fromCharCode(...bytes))
      .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function validLegacyResumeToken(value: unknown, sessionId: string): value is string {
  if (typeof value !== 'string' || value.length < 80 || value.length > MAX_LEGACY_RESUME_BYTES) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [version, encoded, signature] = parts;
  if (version !== 'r1' || !encoded || !signature) return false;
  const bytes = canonicalBase64urlBytes(encoded);
  const signed = canonicalBase64urlBytes(signature);
  if (!bytes || signed?.byteLength !== 32) return false;
  let source: string;
  let payload: unknown;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    payload = JSON.parse(source) as unknown;
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  const keys = Object.keys(row);
  return keys.join(',') === 'v,sid,op,iat,exp,nonce'
    && row.v === 1 && row.sid === sessionId
    && typeof row.op === 'string' && row.op.length > 0 && row.op.length <= 256
    && typeof row.iat === 'number' && Number.isSafeInteger(row.iat)
    && typeof row.exp === 'number' && Number.isSafeInteger(row.exp) && row.exp > row.iat
    && typeof row.nonce === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(row.nonce)
    && JSON.stringify(payload) === source;
}

export function resumeTokenMatchesAuthorityProof(
  value: unknown,
  sessionId: string,
  authorityProof: string,
): value is string {
  if (typeof value !== 'string' || value.length > MAX_AUTHORITY_RESUME_BYTES) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [version, encoded] = parts;
  if (version !== 'r2' || !encoded) return false;
  const bytes = canonicalBase64urlBytes(encoded);
  if (!bytes) return false;
  let source: string;
  let envelope: unknown;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    envelope = JSON.parse(source) as unknown;
  } catch {
    return false;
  }
  return Array.isArray(envelope) && envelope.length === 2
    && typeof envelope[1] === 'string' && envelope[1] === authorityProof
    && validLegacyResumeToken(envelope[0], sessionId)
    && JSON.stringify(envelope) === source;
}

/** Server close codes translated to plain Spanish for the operator. */
export const PTY_CLOSE_MESSAGES: Readonly<Record<number, string>> = {
  1011: 'Error interno del relay.',
  4400: 'Error de protocolo en el canal PTY.',
  4401: 'Ticket inválido o vencido; hay que pedir una sesión nueva.',
  4403: 'Permiso revocado durante la sesión.',
  4404: 'El agente PTY no está conectado.',
  4408: 'Sesión cerrada por inactividad.',
  4409: 'Ya hay una sesión abierta en ese contenedor.',
  4410: 'El control de la TUI dejó de ser tuyo: el arriendo se soltó y el bus volvió a entregarle a este alias.',
  4413: 'Sesión cortada por exceso de salida.',
  4414: 'Sesión cerrada por exceso de entrada.',
  4415: 'El navegador no alcanzó a consumir la salida del terminal.',
  4423: 'Venció el tiempo máximo de sesión.',
};

const MOTIVOS_DE_ENTRADA_RECHAZADA: Readonly<Record<string, string>> = {
  governance_write_in_flight: 'No se envió: el agente está reescribiendo sus ficheros de gobierno y retiene el teclado hasta terminar.',
  pane_input_barrier: 'No se envió: hay una pegada en vuelo en el panel del alias; reintentá cuando termine.',
  tmux_prefix: 'No se envió: la ráfaga llevaba el prefijo de tmux del alias y el agente no lo deja pasar.',
};

export function avisoDeEntradaRechazada(reason: unknown): string {
  const motivo = typeof reason === 'string' ? reason : '';
  return MOTIVOS_DE_ENTRADA_RECHAZADA[motivo]
    ?? `No se envió: el agente PTY retiene el teclado${motivo ? ` (${motivo})` : ''}. La sesión sigue abierta.`;
}

export function ptyCloseMessage(code?: number, reason?: string | null): string {
  const mapped = code === undefined ? undefined : PTY_CLOSE_MESSAGES[code];
  if (mapped) return mapped;
  if (code === 1000) return 'Canal PTY cerrado.';
  const detail = typeof reason === 'string' && reason.trim() ? ` · ${reason.trim()}` : '';
  return `El servidor cerró el canal PTY${code === undefined ? ' sin decir con qué código' : ` con el código ${String(code)}`}${detail}.`;
}

/** Same-origin validation kept from the original component: no credentials, no query, no fragment. */
export function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  if (url.host !== window.location.host) throw new Error('PTY WebSocket must be same-origin');
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid PTY WebSocket protocol');
  if (url.username || url.password || url.search || url.hash) throw new Error('PTY WebSocket must not contain credentials, query parameters or fragments');
  return url.toString();
}

const MAX_RESPUESTA_TECNICA = 256;
const DA_PRIMARIA = '\x1b[?1;2c';
const DA_SECUNDARIA = '\x1b[>0;276;0c';
const DSR_ESTADO = '\x1b[0n';
const MAX_FILAS_REMOTAS = 200;
const MAX_COLUMNAS_REMOTAS = 500;
export const MAX_INPUT_FRAME_BYTES = 16 * 1024;
export const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_CLAIM_LEASE_MS = 300_000;
const MAX_POSTGRES_BIGINT = '9223372036854775807';
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PTY_VIEWER_HEARTBEAT_MS = 30_000;
/** Browser TCP/TLS/upgrade deadline. The relay attach deadline starts only after `open`. */
export const PTY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const PTY_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
export const UTF8_ENCODER = new TextEncoder();

export function geometriaRemota(payload: Readonly<Record<string, unknown>>): { cols: number; rows: number } | undefined {
  const { cols, rows } = payload;
  if (typeof cols !== 'number' || !Number.isSafeInteger(cols) || cols < 1 || cols > MAX_COLUMNAS_REMOTAS) return undefined;
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_FILAS_REMOTAS) return undefined;
  return { cols, rows };
}

function decimalPositivo(value: string): boolean {
  if (value.length === 0 || value.length > 3 || value.startsWith('0')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/** Length of the initial CPR/DECXCPR, or zero if the prefix is not exactly a DSR response. */
function longitudRespuestaDeCursor(data: string): number {
  if (!data.startsWith('\x1b[')) return 0;
  let start = 2;
  if (data[start] === '?') start += 1;
  const separator = data.indexOf(';', start);
  if (separator < 0) return 0;
  const end = data.indexOf('R', separator + 1);
  if (end < 0) return 0;
  const row = data.slice(start, separator);
  const col = data.slice(separator + 1, end);
  if (!decimalPositivo(row) || !decimalPositivo(col)) return 0;
  if (Number(row) > MAX_FILAS_REMOTAS || Number(col) > MAX_COLUMNAS_REMOTAS) return 0;
  return end + 1;
}

/** Exported so the negative boundary of the console can be tested without opening a session. */
export function esRespuestaTecnicaDelTerminal(data: string): boolean {
  if (data.length === 0 || data.length > MAX_RESPUESTA_TECNICA) return false;
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) > 0x7f) return false;
  }
  let pendiente = data;
  while (pendiente.length > 0) {
    if (pendiente.startsWith(DA_PRIMARIA)) {
      pendiente = pendiente.slice(DA_PRIMARIA.length);
      continue;
    }
    if (pendiente.startsWith(DA_SECUNDARIA)) {
      pendiente = pendiente.slice(DA_SECUNDARIA.length);
      continue;
    }
    if (pendiente.startsWith(DSR_ESTADO)) {
      pendiente = pendiente.slice(DSR_ESTADO.length);
      continue;
    }
    const longitud = longitudRespuestaDeCursor(pendiente);
    if (longitud === 0) return false;
    pendiente = pendiente.slice(longitud);
  }
  return true;
}

/** Positive PostgreSQL `bigint`, kept as text so no bits are lost in JavaScript. */
function claimEpochCanonico(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false;
  if (value.length !== MAX_POSTGRES_BIGINT.length) return value.length < MAX_POSTGRES_BIGINT.length;
  return value <= MAX_POSTGRES_BIGINT;
}

export function claimReady(
  payload: Readonly<Record<string, unknown>>,
): { claimToken: string; claimEpoch: string; claimLeaseMs: number } | undefined {
  const claimToken = payload.claim_token;
  const claimEpoch = payload.claim_epoch;
  const claimLeaseMs = payload.claim_lease_ms;
  if (typeof claimToken !== 'string' || !UUID_CANONICO.test(claimToken) ||
      !claimEpochCanonico(claimEpoch) || typeof claimLeaseMs !== 'number' ||
      !Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1 || claimLeaseMs > MAX_CLAIM_LEASE_MS) {
    return undefined;
  }
  return { claimToken, claimEpoch, claimLeaseMs };
}

export interface PtyEntry {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  socket?: WebSocket;
  worker?: Worker;
  decoder?: TextDecoder;
  view: PtySessionView;
  readOnly: boolean;
  inputChunks: string[];
  inputBytes: number;
  inputTimer?: number;
  heartbeatTimer?: number;
  resizeObserver?: ResizeObserver;
  geometriaDicha?: { cols: number; rows: number };
  columnasRemotas?: number;
  bloqueoEntrada?: () => void;
  pegadoAbajo: boolean;
  disposers: (() => void)[];
  onClosed?: (view: PtySessionView) => void;
  closed: boolean;
  outputFinished: boolean;
  resumeToken?: string;
  claimToken?: string;
  claimEpoch?: string;
  claimLeaseMs?: number;
  outputBytes: number;
  reconnectAttempt: number;
  reconnectTimer?: number;
  handshakeTimer?: number;
  options: PtySessionOptions;
}
