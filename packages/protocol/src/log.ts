/**
 * Structured, deliberately poor logging: alias, session id, counters, close codes and
 * truncated fingerprints only. Tickets, PTY bytes, tokens and certificate material are
 * never accepted here — the helpers below take scalars so there is nothing to leak.
 */

export type LogField = string | number | boolean | null | undefined;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEventOptions {
  readonly level?: LogLevel;
  readonly traceId?: string;
}

export function logEvent(
  event: string,
  fields: Readonly<Record<string, LogField>> = {},
  options: LogEventOptions = {},
): void {
  const level: LogLevel = options.level ?? 'error';
  const record: Record<string, LogField> = {
    level,
    event,
    trace_id: options.traceId,
    ...fields,
  };
  console.error(JSON.stringify(record));
}

/** Certificate fingerprints are correlation handles, not secrets, but 16 hex is plenty. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase().slice(0, 16);
}

/** Turns anything thrown into a short, non-sensitive label for a log line. */
export function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return 'unknown_error';
}
