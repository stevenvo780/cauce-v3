import { describe, expect, it } from 'vitest';
import {
  createConsoleCredentialStamp,
  verifyConsoleCredentialStamp,
  type ConsoleCredentialSnapshot,
} from './console-credential-stamp.js';

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const snapshot: ConsoleCredentialSnapshot = {
  userId: '11111111-2222-4333-8444-555555555555',
  passwordHash: '$scrypt$fixture-hash',
  passwordChangedAtUs: '1786017600000000',
};

describe('console credential snapshot stamp', () => {
  it('produces a stable domain-separated HMAC for the verified snapshot', () => {
    expect(createConsoleCredentialStamp(key, snapshot))
      .toBe('nbuY1dkw6lTRkEmTw2Znv9KVgpIrseLfHDsdOuuuvok');
  });

  it('rejects a different password hash even when the timestamp is in the same millisecond', () => {
    const stamp = createConsoleCredentialStamp(key, snapshot);
    expect(verifyConsoleCredentialStamp(key, stamp, {
      ...snapshot,
      passwordHash: '$scrypt$replacement-hash',
    })).toBe(false);
  });

  it('rejects changed timestamp and malformed stamp values', () => {
    const stamp = createConsoleCredentialStamp(key, snapshot);
    expect(verifyConsoleCredentialStamp(key, stamp, {
      ...snapshot,
      passwordChangedAtUs: '1786017600000001',
    })).toBe(false);
    expect(verifyConsoleCredentialStamp(key, `${stamp}=`, snapshot)).toBe(false);
  });

  it('rejects invalid snapshots and signing keys', () => {
    expect(() => createConsoleCredentialStamp(Buffer.alloc(31), snapshot)).toThrow();
    expect(() => createConsoleCredentialStamp(key, {
      ...snapshot,
      userId: 'not-a-uuid',
    })).toThrow();
  });
});
