import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
} from './repository/observability/policy.js';

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
