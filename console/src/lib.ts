/**
 * Constants and sentinels for representing absent or not-applicable values in the UI.
 */
export const UNKNOWN = 'sin dato';

/** "This datum is not yet due", which is NOT the same as "I don't know it". */
export const TODAVIA_NO = 'todavía no';

/** "Not applicable to this row". Em dash, never empty: an empty cell is indistinguishable from a render failure. */
export const NO_APLICA = '—';

import type {
  CapabilityState,
  ConsoleAccess,
  ConsolePermission,
  DeliveryState,
  JobLane,
  OriginRelayState,
} from './api/types';
import { randomUuid } from './random-id';

export function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNKNOWN;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return '';
}

/**
 * Formats dates for compact, Spanish-readable display.
 */
export function timestamp(value: unknown): string {
  const date = fecha(value);
  if (!date) return UNKNOWN;
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** The same date down to the second and with timezone, for `title=`. Never what is read at a glance. */
export function timestampExacto(value: unknown): string {
  const date = fecha(value);
  if (!date) return UNKNOWN;
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
}

/** A valid `Date` or `undefined`. An empty or unreadable string is NOT a date. */
export function fecha(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * "3 min ago" / "in 2 h". Where the question is *how long ago*, a wall clock forces a mental
 * subtraction. Returns `undefined` — not a lie — when there is no readable date.
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
 * Formats a duration in seconds as "1h 4m", "3m 12s", or "12s". Negatives (expired deadlines,
 * past resets) are shown with a sign rather than silently flipped: deciding what "expired"
 * means is left to the caller, not this generic formatter. Used by activity (in-flight age)
 * and quotas (time to reset).
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
  return `${prefix}-${randomUuid()}`;
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

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
