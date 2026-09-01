const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V1_TO_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;

export function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_V4.test(value);
}

/** Operational incident identifiers historically accept UUID versions 1 through 8, in either case. */
export function isUuidV1ToV8(value: unknown): value is string {
  return typeof value === 'string' && UUID_V1_TO_V8.test(value);
}

/** Caller-owned request ids additionally admit the two protocol sentinel UUIDs. */
export function isRequestUuid(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_UUID.test(value);
}

export function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_SHA256.test(value);
}

export function isBoundedKey(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}
