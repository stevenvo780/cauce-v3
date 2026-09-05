import { DEFAULT_BLOB_MAX_BYTES, MAX_BLOB_BYTES } from '@cauce/protocol';
import { integerEnv } from '@cauce/protocol';

export {
  configuredAckDeadlineMs, configuredDeliveryLeaseCap, DEFAULT_ACK_DEADLINE_MS, validateAckDeadlineMs,
} from '@cauce/store';

export const DEFAULT_LEASE_TTL_MS = 180_000;
export const MIN_LEASE_TTL_MS = 30_000;

export function validateLeaseTtlMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_TTL_MS) {
    throw new Error(`CAUCE_LEASE_TTL_MS must be a safe integer of at least ${String(MIN_LEASE_TTL_MS)}`);
  }
  return value;
}

export function configuredLeaseTtlMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return validateLeaseTtlMs(Number(
    environment.CAUCE_LEASE_TTL_MS ?? DEFAULT_LEASE_TTL_MS,
  ));
}

/**
 * Default cap on concurrent in-flight deliveries per adapter.
 * Keeps a conservative cap to avoid accumulating timeouts in local queues.
 */
export const DEFAULT_MAX_INFLIGHT_DELIVERIES = 2;

/**
 * Additional reserved slot for non agent-to-agent deliveries (human traffic),
 * so long-running tasks do not block interactive traffic.
 */
export const DEFAULT_HUMAN_RESERVED_DELIVERIES = 2;

export interface DeliveryAdmissionConfig {
  /** General slot: any delivery can take it, including agent-to-agent work. */
  readonly maxInflightDeliveries: number;
  /** Extra slot only human traffic can take. */
  readonly humanReservedDeliveries: number;
}

export function validateDeliveryAdmission(value: DeliveryAdmissionConfig): DeliveryAdmissionConfig {
  if (!Number.isSafeInteger(value.maxInflightDeliveries) || value.maxInflightDeliveries < 0) {
    throw new Error('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
  }
  if (!Number.isSafeInteger(value.humanReservedDeliveries) || value.humanReservedDeliveries < 0) {
    throw new Error('CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer');
  }
  // At least one admission slot must be greater than zero to allow claiming deliveries.
  if (value.maxInflightDeliveries + value.humanReservedDeliveries < 1) {
    throw new Error(
      'CAUCE_MAX_INFLIGHT_DELIVERIES and CAUCE_HUMAN_RESERVED_DELIVERIES cannot both be zero',
    );
  }
  return value;
}

export function configuredDeliveryAdmission(
  environment: NodeJS.ProcessEnv = process.env,
): DeliveryAdmissionConfig {
  return validateDeliveryAdmission({
    maxInflightDeliveries: integerEnv(environment, 'CAUCE_MAX_INFLIGHT_DELIVERIES', {
      fallback: DEFAULT_MAX_INFLIGHT_DELIVERIES, min: 0,
    }),
    humanReservedDeliveries: integerEnv(environment, 'CAUCE_HUMAN_RESERVED_DELIVERIES', {
      fallback: DEFAULT_HUMAN_RESERVED_DELIVERIES, min: 0,
    }),
  });
}

export const DEFAULT_BLOB_DIRECTORY = '/var/lib/cauce-v3/blobs';

export interface BlobStoreConfig {
  readonly directory: string;
  readonly maxBytes: number;
}

/* Files too large to ride inline. The cap is bounded by the protocol ceiling: a larger value would
   admit an upload the wire schema then refuses, a file the person would never see arrive. */
export function configuredBlobStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BlobStoreConfig {
  const directory = env.CAUCE_BLOB_DIR ?? DEFAULT_BLOB_DIRECTORY;
  if (!directory.startsWith('/')) throw new Error('CAUCE_BLOB_DIR must be an absolute path');
  const raw = env.CAUCE_BLOB_MAX_BYTES;
  if (raw === undefined) return { directory, maxBytes: DEFAULT_BLOB_MAX_BYTES };
  const maxBytes = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BLOB_BYTES) {
    throw new Error(`CAUCE_BLOB_MAX_BYTES must be an integer between 1 and ${String(MAX_BLOB_BYTES)}`);
  }
  return { directory, maxBytes };
}
