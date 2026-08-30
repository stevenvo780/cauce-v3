/** Persisted boolean authority is granted only by literal true. */
export function isLiteralTrue(value: unknown): boolean {
  return value === true;
}

/** Abort state is sampled again after awaited work because it can change concurrently. */
export function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Callback-owned state is sampled again after awaited work. */
export function readMutableBoolean(value: boolean): boolean {
  return value;
}

/** Persisted roots must be narrowed before they authorize downstream work. */
export function persistedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function postgresBigintString(value: unknown): string {
  return String(value);
}
