/* Identity wrappers: they keep `no-unnecessary-condition` from narrowing a value the runtime
   can still change (a flag read twice, a signal aborted between checks). */
export function isLiteralTrue(value: unknown): boolean {
  return value === true;
}

export function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function readMutableBoolean(value: boolean): boolean {
  return value;
}

export function persistedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const VISIBLE_TEXT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;

export function visibleText(value: unknown): string {
  if (typeof value !== 'string' || !VISIBLE_TEXT_PATTERN.test(value)) return '';
  return value.trim();
}

export function hasVisibleText(value: unknown): value is string {
  return typeof value === 'string' && VISIBLE_TEXT_PATTERN.test(value);
}
