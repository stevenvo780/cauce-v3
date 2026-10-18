import { ApiError } from '../api/client/core';

/** 409s the console client raises before a write is sent: the draft was not rejected by another person. */
export const SESSION_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'company_switch_in_flight', 'company_scope_unverified', 'session_changed',
]);

/** A CAS clash: the write carried a version or revision that another save has already moved past. */
export function isCasConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && !SESSION_CONFLICT_CODES.has(cause.code ?? '');
}

export interface ConflictFieldDiff { key: string; label: string; mine: string; theirs: string }

const MAX_VALUE_LENGTH = 240;

export function formatConflictValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return value.length ? value.map((entry) => formatConflictValue(entry)).join(', ') : '—';
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return '—';
  }
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  return clean.length > MAX_VALUE_LENGTH ? `${clean.slice(0, MAX_VALUE_LENGTH)}…` : clean || '—';
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Fields where the draft and the freshly read record disagree, in the order the caller lists them. */
export function diffConflictFields(
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  labels: Record<string, string> = {},
  keys?: readonly string[],
): ConflictFieldDiff[] {
  const ordered = keys ?? [...Object.keys(mine), ...Object.keys(theirs).filter((key) => !Object.hasOwn(mine, key))];
  return ordered.flatMap((key) => {
    if (sameValue(mine[key], theirs[key])) return [];
    return [{ key, label: labels[key] ?? key, mine: formatConflictValue(mine[key]), theirs: formatConflictValue(theirs[key]) }];
  });
}
