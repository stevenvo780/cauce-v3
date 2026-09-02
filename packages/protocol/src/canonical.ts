import { createHash } from 'node:crypto';

/* Bytes already persisted in `idempotency_keys.request_hash` and in the console intent nonce
   hashes come from exactly this encoding: changing it turns a valid retry into a 409. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

export function canonicallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

/* A string is hashed as its own bytes, never re-encoded as JSON. */
export function sha256Hex(value: unknown): string {
  const encoded = typeof value === 'string'
    ? value
    : JSON.stringify(canonicalJson(value)) ?? 'undefined'; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- Runtime values can make JSON.stringify return undefined.
  return createHash('sha256').update(encoded).digest('hex');
}
