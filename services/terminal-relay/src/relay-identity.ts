import { createHash, randomUUID, X509Certificate } from 'node:crypto';

/** Authenticated relay identity: SHA-256 of the exact DER leaf certificate used toward gateway. */
export const RELAY_INSTANCE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const RELAY_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
