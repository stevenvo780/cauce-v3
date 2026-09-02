import { describe, expect, it } from 'vitest';
import {
  hasExactKeys, isBoundedKey, isCanonicalUuidV4, isLowercaseSha256, isRequestUuid, isUuidV1ToV8,
} from './contract-guards';

describe('strict API contract primitives', () => {
  it('requires the exact own-key set', () => {
    expect(hasExactKeys({ b: 2, a: 1 }, ['b', 'a'])).toBe(true);
    expect(hasExactKeys({ a: 1, b: 2, extra: true }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys(Object.create({ a: 1 }), ['a'])).toBe(false);
    expect(hasExactKeys([], [])).toBe(false);
  });

  it('distinguishes durable UUIDv4 ids from broader operational and request ids', () => {
    const v4 = 'a0000000-0000-4000-8000-000000000001';
    expect(isCanonicalUuidV4(v4)).toBe(true);
    expect(isCanonicalUuidV4(v4.toUpperCase())).toBe(false);
    expect(isCanonicalUuidV4(v4.replace('-4', '-7'))).toBe(false);
    expect(isUuidV1ToV8(v4.replace('-4', '-7').toUpperCase())).toBe(true);
    expect(isRequestUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isRequestUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
    expect(isUuidV1ToV8('not-a-uuid')).toBe(false);
  });

  it('accepts only lowercase SHA-256 and bounded non-empty keys', () => {
    expect(isLowercaseSha256('a'.repeat(64))).toBe(true);
    expect(isLowercaseSha256('A'.repeat(64))).toBe(false);
    expect(isLowercaseSha256('a'.repeat(63))).toBe(false);
    expect(isBoundedKey('intent:1')).toBe(true);
    expect(isBoundedKey('')).toBe(false);
    expect(isBoundedKey('x'.repeat(201))).toBe(false);
  });
});
