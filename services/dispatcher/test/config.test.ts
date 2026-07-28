import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS, DEFAULT_RETENTION_BATCH,
} from '@cauce/store';
import {
  configuredDispatcher, DEFAULT_ACK_DEADLINE_MS, DEFAULT_RETENTION_INTERVAL_MS,
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

describe('techo de vida total de una entrega', () => {
  it('usa un default conservador y lo deja mover por entorno', () => {
    expect(configuredDispatcher({})).toMatchObject({
      leaseCapMs: DEFAULT_DELIVERY_LEASE_CAP_MS,
      leaseCapGraceMs: DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
    });
    // La salida para el trabajo legitimamente larguisimo que no declara timeout_ms: subir el
    // techo por entorno, sin redeploy de codigo.
    expect(configuredDispatcher({
      CAUCE_DELIVERY_LEASE_CAP_MS: String(48 * 60 * 60_000),
    }).leaseCapMs).toBe(48 * 60 * 60_000);
  });

  /**
   * Un techo por debajo del plazo de ACK mataria TODA entrega antes de su primera renovacion y
   * el sintoma pareceria un bug del guarda nuevo en vez de una configuracion mal puesta.
   */
  it('falla al arrancar si el techo es menor que el plazo de ACK', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '1800000',
      ACK_TIMEOUT_MS: '1800000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '600000',
    })).toThrow(/CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater/u);
  });
});

describe('retencion de la observabilidad', () => {
  it('trae ventanas por defecto y audit mas larga que los ACK', () => {
    const config = configuredDispatcher({});
    expect(config.retentionAckRenewalMs).toBe(DEFAULT_RETENTION_ACK_RENEWAL_MS);
    expect(config.retentionAckMs).toBe(DEFAULT_RETENTION_ACK_MS);
    expect(config.retentionAuditMs).toBe(DEFAULT_RETENTION_AUDIT_MS);
    expect(config.retentionAuditMs).toBeGreaterThan(config.retentionAckMs);
    expect(config.retentionIntervalMs).toBe(DEFAULT_RETENTION_INTERVAL_MS);
    expect(config.retentionBatch).toBe(DEFAULT_RETENTION_BATCH);
  });

  it('acepta el cero SOLO en el intervalo, que es la palanca de apagado', () => {
    expect(configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: '0' }).retentionIntervalMs).toBe(0);
    expect(() => configuredDispatcher({ CAUCE_RETENTION_ACK_MS: '0' }))
      .toThrow(/positive integer/u);
    expect(() => configuredDispatcher({ CAUCE_RETENTION_BATCH: '0' }))
      .toThrow(/positive integer/u);
  });

  it('rechaza una ventana de renovaciones mas larga que la general', () => {
    expect(() => configuredDispatcher({
      CAUCE_RETENTION_ACK_RENEWAL_MS: String(30 * 24 * 60 * 60_000),
      CAUCE_RETENTION_ACK_MS: String(24 * 60 * 60_000),
    })).toThrow(/renewal retention windows/u);
  });
});
