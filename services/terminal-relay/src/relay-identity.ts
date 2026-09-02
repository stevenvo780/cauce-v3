import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { CANONICAL_UUID_V4_PATTERN } from '@cauce/protocol';

/** Authenticated relay identity: SHA-256 of the exact DER leaf certificate used toward gateway. */
export const RELAY_INSTANCE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const RELAY_BOOT_ID_PATTERN = CANONICAL_UUID_V4_PATTERN;

export interface RelayProcessIdentity {
  readonly relayInstanceId: string;
  /** Distinguishes accidental concurrent processes sharing one certificate. */
  readonly relayBootId: string;
}

export function isRelayInstanceId(value: unknown): value is string {
  return typeof value === 'string' && RELAY_INSTANCE_ID_PATTERN.test(value);
}

export function isRelayBootId(value: unknown): value is string {
  return typeof value === 'string' && RELAY_BOOT_ID_PATTERN.test(value);
}

export function relayInstanceIdFromCertificate(certificate: Buffer | string): string {
  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificate);
  } catch (error) {
    throw new Error('terminal relay gateway client certificate is invalid', { cause: error });
  }
  return createHash('sha256').update(parsed.raw).digest('hex');
}

export function relayProcessIdentity(certificate: Buffer | string): RelayProcessIdentity {
  return {
    relayInstanceId: relayInstanceIdFromCertificate(certificate),
    relayBootId: randomUUID(),
  };
}
