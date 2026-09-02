import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
} from '@cauce/store';

export const DEFAULT_ACK_DEADLINE_MS = 30_000;

export function validateAckDeadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  }
  return value;
}

export function configuredAckDeadlineMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return validateAckDeadlineMs(Number(
    environment.CAUCE_ACK_DEADLINE_MS ?? DEFAULT_ACK_DEADLINE_MS,
  ));
}

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
 * Total lifetime cap of a delivery attempt.
 * Gateway and dispatcher share this configuration to synchronize
 * lease-cap expiration and avoid discrepancies in delivery renewals.
 */
export function configuredDeliveryLeaseCap(
  environment: NodeJS.ProcessEnv = process.env,
): { leaseCapMs: number; leaseCapGraceMs: number } {
  const leaseCapMs = Number(
    environment.CAUCE_DELIVERY_LEASE_CAP_MS ?? DEFAULT_DELIVERY_LEASE_CAP_MS,
  );
  if (!Number.isSafeInteger(leaseCapMs) || leaseCapMs <= 0) {
    throw new Error('CAUCE_DELIVERY_LEASE_CAP_MS must be a positive integer');
  }
  const leaseCapGraceMs = Number(
    environment.CAUCE_DELIVERY_LEASE_CAP_GRACE_MS ?? DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
  );
  if (!Number.isSafeInteger(leaseCapGraceMs) || leaseCapGraceMs <= 0) {
    throw new Error('CAUCE_DELIVERY_LEASE_CAP_GRACE_MS must be a positive integer');
  }
  if (leaseCapMs < configuredAckDeadlineMs(environment)) {
    throw new Error(
      'CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS',
    );
  }
  return { leaseCapMs, leaseCapGraceMs };
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

function nonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
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
    maxInflightDeliveries: nonNegativeInteger(
      'CAUCE_MAX_INFLIGHT_DELIVERIES',
      environment.CAUCE_MAX_INFLIGHT_DELIVERIES,
      DEFAULT_MAX_INFLIGHT_DELIVERIES,
    ),
    humanReservedDeliveries: nonNegativeInteger(
      'CAUCE_HUMAN_RESERVED_DELIVERIES',
      environment.CAUCE_HUMAN_RESERVED_DELIVERIES,
      DEFAULT_HUMAN_RESERVED_DELIVERIES,
    ),
  });
}
