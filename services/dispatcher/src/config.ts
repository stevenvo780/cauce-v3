import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS, DEFAULT_RETENTION_AUDIT_RENEWAL_MS,
  DEFAULT_RETENTION_BATCH,
} from '@cauce/store';

export const DEFAULT_ACK_DEADLINE_MS = 30_000;
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Observability retention sweep interval in ms. 0 disables the sweep. */
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60_000;
/** P0-4 — silent-chain watchdog. */
export const DEFAULT_CHAIN_SWEEP_MS = 60_000;
export const DEFAULT_CHAIN_IDLE_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_CHAIN_SETTLED_GRACE_MS = 15 * 60 * 1_000;
export const DEFAULT_CHAIN_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_CHAIN_SWEEP_LIMIT = 5;

export interface DispatcherConfig {
  pollMs: number;
  healthStaleMs: number;
  ackDeadlineMs: number;
  ackTimeoutMs: number;
  interactiveBurst: number;
  jobLeaseMs: number;
  /**
   * When true, retries deliveries that already started executing after the ACK deadline expired.
   * Default false to avoid duplicate re-execution.
   */
  retryStartedDeliveries: boolean;
  /** Total lease cap per attempt. See `DEFAULT_DELIVERY_LEASE_CAP_MS` in the store. */
  leaseCapMs: number;
  leaseCapGraceMs: number;
  retentionIntervalMs: number;
  retentionAckRenewalMs: number;
  retentionAckMs: number;
  retentionAuditRenewalMs: number;
  retentionAuditMs: number;
  retentionBatch: number;
  chainSweepMs: number;
  chainIdleMs: number;
  chainSettledGraceMs: number;
  chainMaxAgeMs: number;
  chainSweepLimit: number;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Like `positiveInteger` but allows 0 — the value that turns the watchdog off. */
function nonNegativeInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function configuredDispatcher(environment: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const pollMs = positiveInteger(environment, 'DISPATCHER_POLL_MS', 250);
  const ackDeadlineMs = positiveInteger(
    environment,
    'CAUCE_ACK_DEADLINE_MS',
    DEFAULT_ACK_DEADLINE_MS,
  );
  const ackTimeoutMs = positiveInteger(environment, 'ACK_TIMEOUT_MS', DEFAULT_ACK_TIMEOUT_MS);
  if (ackTimeoutMs < ackDeadlineMs) {
    throw new Error('ACK_TIMEOUT_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  }
  const leaseCapMs = positiveInteger(
    environment, 'CAUCE_DELIVERY_LEASE_CAP_MS', DEFAULT_DELIVERY_LEASE_CAP_MS,
  );
  // Lease cap MUST be >= ACK deadline so at least one renewal fits.
  if (leaseCapMs < ackDeadlineMs) {
    throw new Error(
      'CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS',
    );
  }
  const retentionAckRenewalMs = positiveInteger(
    environment, 'CAUCE_RETENTION_ACK_RENEWAL_MS', DEFAULT_RETENTION_ACK_RENEWAL_MS,
  );
  const retentionAckMs = positiveInteger(
    environment, 'CAUCE_RETENTION_ACK_MS', DEFAULT_RETENTION_ACK_MS,
  );
  const retentionAuditRenewalMs = positiveInteger(
    environment, 'CAUCE_RETENTION_AUDIT_RENEWAL_MS', DEFAULT_RETENTION_AUDIT_RENEWAL_MS,
  );
  const retentionAuditMs = positiveInteger(
    environment, 'CAUCE_RETENTION_AUDIT_MS', DEFAULT_RETENTION_AUDIT_MS,
  );
  if (retentionAckRenewalMs > retentionAckMs || retentionAuditRenewalMs > retentionAuditMs) {
    throw new Error(
      'renewal retention windows must be shorter than or equal to the general retention windows',
    );
  }
  const chainIdleMs = positiveInteger(environment, 'CHAIN_IDLE_MS', DEFAULT_CHAIN_IDLE_MS);
  const chainMaxAgeMs = positiveInteger(environment, 'CHAIN_MAX_AGE_MS', DEFAULT_CHAIN_MAX_AGE_MS);
  // A sweep window shorter than the idle window guarantees a hole: the root ages out of the
  // sweep before it can be reaped, and the silence returns.
  if (chainMaxAgeMs < chainIdleMs) {
    throw new Error('CHAIN_MAX_AGE_MS must be equal to or greater than CHAIN_IDLE_MS');
  }
  return {
    pollMs,
    healthStaleMs: positiveInteger(
      environment, 'CAUCE_DISPATCHER_STALE_MS', Math.max(5_000, pollMs * 20)
    ),
    ackDeadlineMs,
    ackTimeoutMs,
    interactiveBurst: positiveInteger(environment, 'INTERACTIVE_BURST', 3),
    jobLeaseMs: positiveInteger(environment, 'JOB_LEASE_MS', 30_000),
    // Only the explicit '1' enables it. Anything else (empty, '0', garbage) keeps the safe
    // behavior — the one that preserves quota.
    retryStartedDeliveries: environment.CAUCE_RETRY_STARTED_DELIVERIES === '1',
    leaseCapMs,
    leaseCapGraceMs: positiveInteger(
      environment, 'CAUCE_DELIVERY_LEASE_CAP_GRACE_MS', DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
    ),
    retentionIntervalMs: nonNegativeInteger(
      environment, 'CAUCE_RETENTION_INTERVAL_MS', DEFAULT_RETENTION_INTERVAL_MS,
    ),
    retentionAckRenewalMs,
    retentionAckMs,
    retentionAuditRenewalMs,
    retentionAuditMs,
    retentionBatch: positiveInteger(
      environment, 'CAUCE_RETENTION_BATCH', DEFAULT_RETENTION_BATCH,
    ),
    chainSweepMs: nonNegativeInteger(environment, 'CHAIN_SWEEP_MS', DEFAULT_CHAIN_SWEEP_MS),
    chainIdleMs,
    chainSettledGraceMs: positiveInteger(
      environment, 'CHAIN_SETTLED_GRACE_MS', DEFAULT_CHAIN_SETTLED_GRACE_MS
    ),
    chainMaxAgeMs,
    chainSweepLimit: positiveInteger(environment, 'CHAIN_SWEEP_LIMIT', DEFAULT_CHAIN_SWEEP_LIMIT),
  };
}
