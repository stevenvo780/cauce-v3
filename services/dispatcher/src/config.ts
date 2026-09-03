import { booleanEnv, integerEnv } from '@cauce/protocol';
import {
  configuredDeliveryLeaseCap, DEFAULT_ACK_DEADLINE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS, DEFAULT_RETENTION_AUDIT_RENEWAL_MS,
  DEFAULT_RETENTION_BATCH,
} from '@cauce/store';

export { DEFAULT_ACK_DEADLINE_MS };
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Observability retention sweep interval in ms. 0 disables the sweep. */
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60_000;
/** CRED-02 — window, cadence and bound of the attachment-byte strip inside `messages.body`. */
export const DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH = 50;
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
  retentionMessageAttachmentsMs: number;
  retentionMessageAttachmentsIntervalMs: number;
  retentionMessageAttachmentsBatch: number;
  retentionBatch: number;
  chainSweepMs: number;
  chainIdleMs: number;
  chainSettledGraceMs: number;
  chainMaxAgeMs: number;
  chainSweepLimit: number;
}

export function configuredDispatcher(environment: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const pollMs = integerEnv(environment, 'DISPATCHER_POLL_MS', { fallback: 250 });
  const ackDeadlineMs = integerEnv(
    environment, 'CAUCE_ACK_DEADLINE_MS', { fallback: DEFAULT_ACK_DEADLINE_MS },
  );
  const ackTimeoutMs = integerEnv(
    environment, 'ACK_TIMEOUT_MS', { fallback: DEFAULT_ACK_TIMEOUT_MS },
  );
  if (ackTimeoutMs < ackDeadlineMs) {
    throw new Error('ACK_TIMEOUT_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  }
  const { leaseCapMs, leaseCapGraceMs } = configuredDeliveryLeaseCap(environment);
  const retentionAckRenewalMs = integerEnv(
    environment, 'CAUCE_RETENTION_ACK_RENEWAL_MS', { fallback: DEFAULT_RETENTION_ACK_RENEWAL_MS },
  );
  const retentionAckMs = integerEnv(
    environment, 'CAUCE_RETENTION_ACK_MS', { fallback: DEFAULT_RETENTION_ACK_MS },
  );
  const retentionAuditRenewalMs = integerEnv(
    environment, 'CAUCE_RETENTION_AUDIT_RENEWAL_MS', { fallback: DEFAULT_RETENTION_AUDIT_RENEWAL_MS },
  );
  const retentionAuditMs = integerEnv(
    environment, 'CAUCE_RETENTION_AUDIT_MS', { fallback: DEFAULT_RETENTION_AUDIT_MS },
  );
  if (retentionAckRenewalMs > retentionAckMs || retentionAuditRenewalMs > retentionAuditMs) {
    throw new Error(
      'renewal retention windows must be shorter than or equal to the general retention windows',
    );
  }
  const chainIdleMs = integerEnv(
    environment, 'CHAIN_IDLE_MS', { fallback: DEFAULT_CHAIN_IDLE_MS },
  );
  const chainMaxAgeMs = integerEnv(
    environment, 'CHAIN_MAX_AGE_MS', { fallback: DEFAULT_CHAIN_MAX_AGE_MS },
  );
  // A sweep window shorter than the idle window guarantees a hole: the root ages out of the
  // sweep before it can be reaped, and the silence returns.
  if (chainMaxAgeMs < chainIdleMs) {
    throw new Error('CHAIN_MAX_AGE_MS must be equal to or greater than CHAIN_IDLE_MS');
  }
  const retentionIntervalMs = integerEnv(
    environment, 'CAUCE_RETENTION_INTERVAL_MS', { fallback: DEFAULT_RETENTION_INTERVAL_MS, min: 0 },
  );
  const retentionMessageAttachmentsMs = integerEnv(
    environment,
    'DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS',
    { fallback: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS },
  );
  const retentionMessageAttachmentsIntervalMs = integerEnv(
    environment,
    'DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS',
    { fallback: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS, min: 0 },
  );
  const messageAttachmentsSweepEnabled = retentionIntervalMs > 0
    && retentionMessageAttachmentsIntervalMs > 0;
  // Stripping the files of a chain the watchdog can still reopen loses branch context weeks later and
  // without a trace, so the window has to outlive the sweep horizon, never merely match it — but only
  // while the strip runs: raising CHAIN_MAX_AGE_MS must not brick a dispatcher that sweeps nothing.
  if (messageAttachmentsSweepEnabled && retentionMessageAttachmentsMs <= chainMaxAgeMs) {
    throw new Error(
      'DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS must be greater than CHAIN_MAX_AGE_MS',
    );
  }
  return {
    pollMs,
    healthStaleMs: integerEnv(
      environment, 'CAUCE_DISPATCHER_STALE_MS', { fallback: Math.max(5_000, pollMs * 20) },
    ),
    ackDeadlineMs,
    ackTimeoutMs,
    interactiveBurst: integerEnv(environment, 'INTERACTIVE_BURST', { fallback: 3 }),
    jobLeaseMs: integerEnv(environment, 'JOB_LEASE_MS', { fallback: 30_000 }),
    retryStartedDeliveries: booleanEnv(environment, 'CAUCE_RETRY_STARTED_DELIVERIES'),
    leaseCapMs,
    leaseCapGraceMs,
    retentionIntervalMs,
    retentionAckRenewalMs,
    retentionAckMs,
    retentionAuditRenewalMs,
    retentionAuditMs,
    retentionMessageAttachmentsMs,
    retentionMessageAttachmentsIntervalMs,
    retentionMessageAttachmentsBatch: integerEnv(
      environment,
      'DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH',
      { fallback: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH },
    ),
    retentionBatch: integerEnv(
      environment, 'CAUCE_RETENTION_BATCH', { fallback: DEFAULT_RETENTION_BATCH },
    ),
    chainSweepMs: integerEnv(
      environment, 'CHAIN_SWEEP_MS', { fallback: DEFAULT_CHAIN_SWEEP_MS, min: 0 },
    ),
    chainIdleMs,
    chainSettledGraceMs: integerEnv(
      environment, 'CHAIN_SETTLED_GRACE_MS', { fallback: DEFAULT_CHAIN_SETTLED_GRACE_MS },
    ),
    chainMaxAgeMs,
    chainSweepLimit: integerEnv(
      environment, 'CHAIN_SWEEP_LIMIT', { fallback: DEFAULT_CHAIN_SWEEP_LIMIT },
    ),
  };
}
