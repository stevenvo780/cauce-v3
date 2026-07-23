export const UNKNOWN = 'UNKNOWN';

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
  if (typeof value === 'number' && !Number.isFinite(value)) return UNKNOWN;
  return String(value);
}

export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return UNKNOWN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNKNOWN;
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
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

export function compactId(value: unknown): string {
  const text = display(value);
  return text === UNKNOWN || text.length <= 18 ? text : `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function createId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

export function safeJobState(value: unknown): 'queued' | 'running' | 'done' | 'failed' | 'dead' | undefined {
  return oneOf(value, ['queued', 'running', 'done', 'failed', 'dead'] as const);
}

export function safeCapabilityState(value: unknown): CapabilityState | undefined {
  return oneOf(value, ['available', 'degraded', 'unavailable', 'unknown'] as const);
}

export function safeOriginRelayState(value: unknown): OriginRelayState | undefined {
  return oneOf(value, ['pending', 'processing', 'sent', 'failed'] as const);
}

export function safeAuditDecision(value: unknown): 'allow' | 'deny' | undefined {
  return oneOf(value, ['allow', 'deny'] as const);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T[number] : undefined;
}
