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

  it.each([
    { CAUCE_ACK_DEADLINE_MS: '0' },
    { CAUCE_ACK_DEADLINE_MS: 'invalid' },
    { ACK_TIMEOUT_MS: '-1' },
    { ACK_TIMEOUT_MS: '1.5' },
  ])('rejects invalid positive-integer config %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/positive integer/u);
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

  it('fails on startup if lease cap is shorter than ACK timeout', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '1800000',
      ACK_TIMEOUT_MS: '1800000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '600000',
    })).toThrow(/CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater/u);
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

  it('accepts zero only on interval to disable sweep', () => {
    expect(configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: '0' }).retentionIntervalMs).toBe(0);
    expect(() => configuredDispatcher({ CAUCE_RETENTION_ACK_MS: '0' }))
      .toThrow(/positive integer/u);
    expect(() => configuredDispatcher({ CAUCE_RETENTION_BATCH: '0' }))
      .toThrow(/positive integer/u);
  });

  it('rejects renewal retention window longer than general retention window', () => {
    expect(() => configuredDispatcher({
      CAUCE_RETENTION_ACK_RENEWAL_MS: String(30 * 24 * 60 * 60_000),
      CAUCE_RETENTION_ACK_MS: String(24 * 60 * 60_000),
    })).toThrow(/renewal retention windows/u);
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

  it('can be disabled with 0 without affecting other dispatcher operations', () => {
    expect(configuredDispatcher({ CHAIN_SWEEP_MS: '0' })).toMatchObject({
      chainSweepMs: 0, chainIdleMs: DEFAULT_CHAIN_IDLE_MS,
    });
  });

  it('accepts operator-defined timeouts', () => {
    expect(configuredDispatcher({
      CHAIN_SWEEP_MS: '30000',
      CHAIN_IDLE_MS: '7200000',
      CHAIN_SETTLED_GRACE_MS: '300000',
      CHAIN_MAX_AGE_MS: '86400000',
      CHAIN_SWEEP_LIMIT: '3',
    })).toMatchObject({
      chainSweepMs: 30_000,
      chainIdleMs: 7_200_000,
      chainSettledGraceMs: 300_000,
      chainMaxAgeMs: 86_400_000,
      chainSweepLimit: 3,
    });
  });

  it('fails closed when max age is shorter than idle window', () => {
    expect(() => configuredDispatcher({
      CHAIN_IDLE_MS: '21600000', CHAIN_MAX_AGE_MS: '3600000',
    })).toThrow(/equal to or greater/u);
  });

  it.each([
    { CHAIN_SWEEP_MS: '-1' },
    { CHAIN_SWEEP_MS: '1.5' },
    { CHAIN_SWEEP_MS: 'invalid' },
  ])('rejects invalid sweep interval %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/non-negative integer/u);
  });

  it.each([
    { CHAIN_IDLE_MS: '0' },
    { CHAIN_SETTLED_GRACE_MS: '0' },
    { CHAIN_SWEEP_LIMIT: '0' },
  ])('rejects non-positive deadlines %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/positive integer/u);
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

  it('no arranca el guard cuando la poda está apagada: subir CHAIN_MAX_AGE_MS no tumba nada', () => {
    expect(configuredDispatcher({
      CHAIN_MAX_AGE_MS: String(40 * 24 * 60 * 60_000),
      CAUCE_RETENTION_INTERVAL_MS: '0',
    })).toMatchObject({ retentionIntervalMs: 0, chainMaxAgeMs: 40 * 24 * 60 * 60_000 });
    expect(configuredDispatcher({
      CHAIN_MAX_AGE_MS: String(40 * 24 * 60 * 60_000),
      DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS: '0',
    })).toMatchObject({ retentionMessageAttachmentsIntervalMs: 0 });
  });

  it.each([
    { DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_MS: '0' },
    { DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH: '0' },
    { DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_BATCH: 'invalid' },
  ])('rechaza valores no positivos %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/positive integer/u);
  });

  it.each([
    { DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS: '-1' },
    { DISPATCHER_RETENTION_MESSAGE_ATTACHMENTS_INTERVAL_MS: '1.5' },
  ])('rechaza una cadencia inválida %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/non-negative integer/u);
  });
});
