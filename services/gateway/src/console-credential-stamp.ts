import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAnyUuid } from '@cauce/protocol';
import type { ConsoleCredentialSnapshot } from '@cauce/store';
export type { ConsoleCredentialSnapshot } from '@cauce/store';

const DOMAIN = 'cauce-v3/console-credential-stamp/v1\0';
const STAMP = /^[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP_MICROSECONDS = /^-?(?:0|[1-9][0-9]{0,19})$/u;

function canonicalPayload(snapshot: ConsoleCredentialSnapshot): string {
  if (!isAnyUuid(snapshot.userId) || snapshot.passwordHash.length === 0 || snapshot.passwordHash.length > 512
      || !TIMESTAMP_MICROSECONDS.test(snapshot.passwordChangedAtUs)) {
    throw new TypeError('invalid console credential snapshot');
  }
  return JSON.stringify([
    'v1', snapshot.userId.toLowerCase(), snapshot.passwordHash, snapshot.passwordChangedAtUs,
  ]);
}

function signingKeyBytes(signingKey: Uint8Array): Buffer {
  if (signingKey.byteLength < 32) throw new TypeError('console credential stamp key is too short');
  return Buffer.from(signingKey);
}

export function createConsoleCredentialStamp(
  signingKey: Uint8Array,
  snapshot: ConsoleCredentialSnapshot,
): string {
  return createHmac('sha256', signingKeyBytes(signingKey))
    .update(DOMAIN + canonicalPayload(snapshot), 'utf8')
    .digest('base64url');
}

export function verifyConsoleCredentialStamp(
  signingKey: Uint8Array,
  stamp: string,
  snapshot: ConsoleCredentialSnapshot,
): boolean {
  if (typeof stamp !== 'string' || !STAMP.test(stamp)) return false;
  try {
    const expected = Buffer.from(createConsoleCredentialStamp(signingKey, snapshot), 'base64url');
    const presented = Buffer.from(stamp, 'base64url');
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  } catch {
    return false;
  }
}
