import { redactSecrets } from '@cauce/protocol';
import { redactExecutorStderr } from '../../services/gateway/src/fleet/host-stderr.js';

const MAX_DETAIL_CHARACTERS = 4_000;
const MAX_STDERR_CHARACTERS = 1_024;
const MAX_DEPTH = 8;

function sanitize(text: string): string {
  return redactExecutorStderr(redactSecrets(text, { enabled: true }).value);
}

function describeOne(error: object): string {
  const parts = [error instanceof Error ? `${error.name}: ${error.message}` : Object.prototype.toString.call(error)];
  if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) parts.push(`code=${String(error.code)}`);
  if ('signal' in error && typeof error.signal === 'string') parts.push(`signal=${error.signal}`);
  if ('stderr' in error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '';
    if (stderr.trim()) parts.push(`stderr=${stderr.trim().slice(-MAX_STDERR_CHARACTERS)}`);
  }
  return parts.join(' ');
}

function collect(error: unknown, depth: number, seen: Set<unknown>, out: string[]): void {
  if (depth > MAX_DEPTH || error === undefined || error === null || seen.has(error)) return;
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    out.push(String(error));
    return;
  }
  if (typeof error !== 'object') return;
  seen.add(error);
  out.push(describeOne(error));
  if (error instanceof AggregateError) for (const nested of error.errors) collect(nested, depth + 1, seen, out);
  if ('cause' in error) collect(error.cause, depth + 1, seen, out);
}

/** Every message, code and stderr tail under the failures, causes and nested aggregates included, with secrets redacted. */
export function describeCleanupFailures(errors: readonly unknown[]): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  for (const error of errors) collect(error, 0, seen, lines);
  const detail = sanitize(lines.join(' | '));
  return detail.length > MAX_DETAIL_CHARACTERS ? `${detail.slice(0, MAX_DETAIL_CHARACTERS)}…` : detail;
}

/** Vitest prints only an AggregateError's own message, so the causes have to travel in it. */
export function cleanupAggregate(errors: readonly unknown[], summary: string): AggregateError {
  return new AggregateError([...errors], `${summary}; causes: ${describeCleanupFailures(errors)}`);
}
