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
