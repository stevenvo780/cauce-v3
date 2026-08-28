/**
 * Constantes y centinelas para la representación de valores ausentes o no aplicables en la interfaz.
 */
export const UNKNOWN = 'sin dato';

/** «Este dato aún no toca», que NO es lo mismo que «no lo sé». */
export const TODAVIA_NO = 'todavía no';

/** «No aplica a esta fila». Guión, nunca vacío: una celda vacía no distingue de un fallo de render. */
export const NO_APLICA = '—';

import type {
  CapabilityState,
  ConsoleAccess,
  ConsolePermission,
  DeliveryState,
  JobLane,
  OriginRelayState,
} from './api/types';

export function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNKNOWN;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return '';
}

/**
 * Formatea fechas para visualización compacta y legible en español.
 */
export function timestamp(value: unknown): string {
  const date = fecha(value);
  if (!date) return UNKNOWN;
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** La misma fecha al segundo y con zona, para el `title=`. Nunca es lo que se lee de un vistazo. */
export function timestampExacto(value: unknown): string {
  const date = fecha(value);
  if (!date) return UNKNOWN;
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
}

/** `Date` válido o `undefined`. Un texto vacío o ilegible NO es una fecha. */
export function fecha(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * «hace 3 min» / «en 2 h». Donde la pregunta es *cuánto hace*, un reloj de pared obliga a restar
 * de cabeza. Devuelve `undefined` —no una mentira— cuando no hay fecha legible.
 */
export function haceCuanto(value: unknown, now = Date.now()): string | undefined {
  const date = fecha(value);
  if (!date) return undefined;
  const segundos = (date.getTime() - now) / 1000;
  const magnitud = Math.abs(segundos);
  if (magnitud < 45) return segundos <= 0 ? 'hace instantes' : 'en instantes';
  const texto = formatDurationSeconds(magnitud);
  return segundos <= 0 ? `hace ${texto}` : `en ${texto}`;
}

export type LeaseState = 'online' | 'expired' | 'unknown';

export function leaseState(expiresAt: unknown, now = Date.now()): LeaseState {
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') return 'unknown';
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return 'unknown';
  return expiry > now ? 'online' : 'expired';
}

export function leaseExpiry(record: { lease_expires_at?: string | null; lease_until?: string | null }): string | null | undefined {
  return record.lease_expires_at ?? record.lease_until;
}

/**
 * Formatea una duración en segundos como "1h 4m", "3m 12s" o "12s". Negativos (deadlines
 * vencidos, resets ya pasados) se muestran con signo en vez de invertirse en silencio: decidir
 * qué significa "vencido" queda para quien llama, no para este formateador genérico. Usado por
 * activity (antigüedad en vuelo) y quotas (tiempo a reset).
 */
export function formatDurationSeconds(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return UNKNOWN;
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.round(Math.abs(seconds));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  if (hours > 0) return `${sign}${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${sign}${String(minutes)}m ${String(secs)}s`;
  return `${sign}${String(secs)}s`;
}

export function compactId(value: unknown): string {
  const text = display(value);
  return text === UNKNOWN || text.length <= 18 ? text : `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function createId(prefix: string): string {
  const id = globalThis.crypto.randomUUID();
  return `${prefix}-${id}`;
}

export type PermissionState = 'allowed' | 'denied' | 'unknown';

export function permissionState(access: ConsoleAccess | null | undefined, permission: ConsolePermission): PermissionState {
  if (!Array.isArray(access?.permissions)) return 'unknown';
  return access.permissions.includes(permission) ? 'allowed' : 'denied';
}

export function safeDeliveryState(value: unknown): DeliveryState | undefined {
  return oneOf(value, ['pending', 'leased', 'accepted', 'started', 'done', 'failed', 'retry', 'dead'] as const);
}

export function safeJobLane(value: unknown): JobLane | undefined {
  return oneOf(value, ['interactive', 'batch'] as const);
}

export function safeCapabilityState(value: unknown): CapabilityState | undefined {
  return oneOf(value, ['available', 'degraded', 'unavailable', 'unknown'] as const);
}

export function safeOriginRelayState(value: unknown): OriginRelayState | undefined {
  return oneOf(value, ['pending', 'processing', 'sent', 'failed'] as const);
}

export function safeAuditDecision(value: unknown): 'allow' | 'deny' | 'info' | undefined {
  return oneOf(value, ['allow', 'deny', 'info'] as const);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}
