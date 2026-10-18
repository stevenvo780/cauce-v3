import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS, DEFAULT_RETENTION_BATCH,
} from '@cauce/store';
import {
  configuredDispatcher, DEFAULT_ACK_DEADLINE_MS, DEFAULT_CHAIN_IDLE_MS,
  DEFAULT_CHAIN_MAX_AGE_MS, DEFAULT_CHAIN_SETTLED_GRACE_MS, DEFAULT_CHAIN_SWEEP_LIMIT,
  DEFAULT_CHAIN_SWEEP_MS, DEFAULT_RETENTION_INTERVAL_MS,
  DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH, DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS,
  DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS
} from '../src/config.js';

describe('dispatcher delivery deadline configuration', () => {
  it('accepts an ACK timeout equal to or greater than the gateway deadline', () => {
    expect(configuredDispatcher({}).ackDeadlineMs).toBe(DEFAULT_ACK_DEADLINE_MS);
    expect(configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '600000',
    })).toMatchObject({ ackDeadlineMs: 600_000, ackTimeoutMs: 600_000 });
    expect(configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '600001',
    }).ackTimeoutMs).toBe(600_001);
  });

  it('fails closed when dispatcher reaping can precede the claim deadline', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '120000',
    })).toThrow(/equal to or greater/u);
  });
});

describe('total delivery lease cap', () => {
  it('uses conservative defaults and permits environment override', () => {
    expect(configuredDispatcher({})).toMatchObject({
      leaseCapMs: DEFAULT_DELIVERY_LEASE_CAP_MS,
      leaseCapGraceMs: DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
    });
    expect(configuredDispatcher({
      CAUCE_DELIVERY_LEASE_CAP_MS: String(48 * 60 * 60_000),
    }).leaseCapMs).toBe(48 * 60 * 60_000);
  });
});

describe('observability retention', () => {
  it('uses default windows with audit longer than ACK', () => {
    const config = configuredDispatcher({});
    expect(config.retentionAckRenewalMs).toBe(DEFAULT_RETENTION_ACK_RENEWAL_MS);
    expect(config.retentionAckMs).toBe(DEFAULT_RETENTION_ACK_MS);
    expect(config.retentionAuditMs).toBe(DEFAULT_RETENTION_AUDIT_MS);
    expect(config.retentionAuditMs).toBeGreaterThan(config.retentionAckMs);
    expect(config.retentionIntervalMs).toBe(DEFAULT_RETENTION_INTERVAL_MS);
    expect(config.retentionBatch).toBe(DEFAULT_RETENTION_BATCH);
  });
});

describe('silent-chain watchdog (P0-4)', () => {
  it('uses measured defaults', () => {
    expect(configuredDispatcher({})).toMatchObject({
      chainSweepMs: DEFAULT_CHAIN_SWEEP_MS,
      chainIdleMs: DEFAULT_CHAIN_IDLE_MS,
      chainSettledGraceMs: DEFAULT_CHAIN_SETTLED_GRACE_MS,
      chainMaxAgeMs: DEFAULT_CHAIN_MAX_AGE_MS,
      chainSweepLimit: DEFAULT_CHAIN_SWEEP_LIMIT,
    });
    expect(DEFAULT_CHAIN_IDLE_MS).toBe(6 * 60 * 60 * 1_000);
    expect(DEFAULT_CHAIN_SETTLED_GRACE_MS).toBe(15 * 60 * 1_000);
    expect(DEFAULT_CHAIN_MAX_AGE_MS).toBe(48 * 60 * 60 * 1_000);
  });
});

describe('poda de adjuntos del cuerpo (CRED-02)', () => {
  it('trae ventana, cadencia y lote propios, y admite sobreescribir los tres', () => {
    expect(configuredDispatcher({})).toMatchObject({
      retentionMessageAttachmentsMs: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_MS,
      retentionMessageAttachmentsIntervalMs: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS,
      retentionMessageAttachmentsBatch: DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH,
    });
    expect(DEFAULT_RETENTION_MESSAGE_ATTACHMENTS_BATCH).toBe(50);
    expect(configuredDispatcher({
      DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS: '5184000000',
      DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS: '900000',
      DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH: '25',
      CAUCE_RETENTION_BATCH: '5000',
    })).toMatchObject({
      retentionMessageAttachmentsMs: 5_184_000_000,
      retentionMessageAttachmentsIntervalMs: 900_000,
      retentionMessageAttachmentsBatch: 25,
      retentionBatch: 5_000,
    });
  });

  it('falla al arrancar si la ventana no supera el horizonte del barrido de cadenas', () => {
    expect(() => configuredDispatcher({
      DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS: String(48 * 60 * 60_000),
    })).toThrow(/must be greater than CHAIN_MAX_AGE_MS/u);
    expect(() => configuredDispatcher({
      CHAIN_MAX_AGE_MS: String(40 * 24 * 60 * 60_000),
    })).toThrow(/must be greater than CHAIN_MAX_AGE_MS/u);
  });
});

describe('dispatcher tick interval (DISPATCHER_POLL_MS)', () => {
  it('defaults to 250 and honors an environment override', () => {
    expect(configuredDispatcher({}).pollMs).toBe(250);
    expect(configuredDispatcher({ DISPATCHER_POLL_MS: '1000' }).pollMs).toBe(1_000);
  });
});

describe('dispatcher health staleness (CAUCE_DISPATCHER_STALE_MS)', () => {
  it('defaults to max(5000, pollMs*20), tracking the tick interval', () => {
    expect(configuredDispatcher({}).healthStaleMs).toBe(5_000);
    expect(configuredDispatcher({ DISPATCHER_POLL_MS: '100' }).healthStaleMs).toBe(5_000);
    expect(configuredDispatcher({ DISPATCHER_POLL_MS: '1000' }).healthStaleMs).toBe(20_000);
  });
});

describe('retry-started lever (CAUCE_RETRY_STARTED_DELIVERIES)', () => {
  it('defaults to false and enables only on the literal 1', () => {
    expect(configuredDispatcher({}).retryStartedDeliveries).toBe(false);
    expect(
      configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: '1' }).retryStartedDeliveries,
    ).toBe(true);
  });
});
