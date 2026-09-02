import { describe, expect, it } from 'vitest';
import {
  ALIAS_PATTERN, AliasSchema, CANONICAL_UUID_V4_PATTERN, isAlias, isAnyUuid,
  isCanonicalUuidV4, isRfcUuid, isSha256Hex, isTenant, RFC_UUID_PATTERN,
  SHA256_HEX_PATTERN, Sha256HexSchema, TENANT_PATTERN, TenantSchema, UUID_ANY_PATTERN,
} from '../src/index.js';

const TERMINAL_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CANONICAL_V4 = '10000000-0000-4000-8000-00000000000a';

describe('shared wire patterns', () => {
  it('keeps the permissive terminal session notion alive', () => {
    expect(isAnyUuid(TERMINAL_SESSION_ID)).toBe(true);
    expect(isRfcUuid(TERMINAL_SESSION_ID)).toBe(false);
    expect(isCanonicalUuidV4(TERMINAL_SESSION_ID)).toBe(false);
  });

  it('accepts a canonical v4 under all three notions', () => {
    expect(isCanonicalUuidV4(CANONICAL_V4)).toBe(true);
    expect(isRfcUuid(CANONICAL_V4)).toBe(true);
    expect(isAnyUuid(CANONICAL_V4)).toBe(true);
  });

  it('only the canonical notion is case sensitive', () => {
    const upper = CANONICAL_V4.toUpperCase();
    expect(isAnyUuid(upper)).toBe(true);
    expect(isRfcUuid(upper)).toBe(true);
    expect(isCanonicalUuidV4(upper)).toBe(false);
  });

  it.each([undefined, null, 42, '', 'not-a-uuid'])('rejects a non-string uuid %j', (value) => {
    expect(isAnyUuid(value)).toBe(false);
    expect(isRfcUuid(value)).toBe(false);
    expect(isCanonicalUuidV4(value)).toBe(false);
  });

  it.each(['argos', 'a', 'a-b_c', 'Argos', '', '1abc', 'a'.repeat(64), 'a'.repeat(65)])(
    'alias %j agrees with AliasSchema',
    (value) => {
      expect(isAlias(value)).toBe(AliasSchema.safeParse(value).success);
      expect(ALIAS_PATTERN.test(value)).toBe(AliasSchema.safeParse(value).success);
    },
  );

  it.each(['Steven', 'a', 'A-b_9', '', '9tenant', '-tenant', 'A'.repeat(65)])(
    'tenant %j agrees with TenantSchema',
    (value) => {
      expect(isTenant(value)).toBe(TenantSchema.safeParse(value).success);
      expect(TENANT_PATTERN.test(value)).toBe(TenantSchema.safeParse(value).success);
    },
  );

  it.each(['a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), '', 'g'.repeat(64)])(
    'sha256 hex %j agrees with Sha256HexSchema',
    (value) => {
      expect(isSha256Hex(value)).toBe(Sha256HexSchema.safeParse(value).success);
      expect(SHA256_HEX_PATTERN.test(value)).toBe(Sha256HexSchema.safeParse(value).success);
    },
  );

  it('exposes anchored patterns', () => {
    for (const pattern of [
      ALIAS_PATTERN, TENANT_PATTERN, SHA256_HEX_PATTERN, CANONICAL_UUID_V4_PATTERN,
      RFC_UUID_PATTERN, UUID_ANY_PATTERN,
    ]) {
      expect(pattern.source.startsWith('^')).toBe(true);
      expect(pattern.source.endsWith('$')).toBe(true);
      expect(pattern.global).toBe(false);
    }
  });
});
