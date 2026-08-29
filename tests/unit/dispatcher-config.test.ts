import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_CHAIN_IDLE_MS,
  DEFAULT_CHAIN_MAX_AGE_MS,
  DEFAULT_CHAIN_SETTLED_GRACE_MS,
  DEFAULT_CHAIN_SWEEP_LIMIT,
  DEFAULT_CHAIN_SWEEP_MS,
  DEFAULT_RETENTION_INTERVAL_MS,
  configuredDispatcher,
} from '../../services/dispatcher/src/config.js';

/**
 * Pure-function tests for `services/dispatcher/src/config.ts`.
 *
 * The module exports the `configuredDispatcher(env)` factory and a handful of default
 * constants. Everything is reachable through that one function: the two private helpers
 * `positiveInteger` and `nonNegativeInteger` are reached via the env-driven fields, and the
 * cross-field invariants (ACK_TIMEOUT_MS ≥ CAUCE_ACK_DEADLINE_MS, leaseCapMs ≥ ACK deadline,
 * retention renewal ≤ general window, chainMaxAgeMs ≥ chainIdleMs, healthStaleMs ≥ 5_000,
 * chainSweepMs/retentionIntervalMs admit 0) are encoded as runtime `throw`s inside the same
 * factory. The tests therefore drive each branch through `configuredDispatcher({...})` with a
 * sealed `process.env` so nothing in the surrounding host leaks in.
 */

const ENV_KEYS = [
  'DISPATCHER_POLL_MS',
  'CAUCE_ACK_DEADLINE_MS',
  'ACK_TIMEOUT_MS',
  'CAUCE_DELIVERY_LEASE_CAP_MS',
  'CAUCE_DELIVERY_LEASE_CAP_GRACE_MS',
  'CAUCE_RETENTION_INTERVAL_MS',
  'CAUCE_RETENTION_ACK_RENEWAL_MS',
  'CAUCE_RETENTION_ACK_MS',
  'CAUCE_RETENTION_AUDIT_RENEWAL_MS',
  'CAUCE_RETENTION_AUDIT_MS',
  'CAUCE_RETENTION_BATCH',
  'CAUCE_DISPATCHER_STALE_MS',
  'INTERACTIVE_BURST',
  'JOB_LEASE_MS',
  'CAUCE_RETRY_STARTED_DELIVERIES',
  'CHAIN_SWEEP_MS',
  'CHAIN_IDLE_MS',
  'CHAIN_SETTLED_GRACE_MS',
  'CHAIN_MAX_AGE_MS',
  'CHAIN_SWEEP_LIMIT',
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe('constantes por defecto del dispatcher', () => {
  it('deadline y timeout de ACK arrancan en 30 segundos', () => {
    expect(DEFAULT_ACK_DEADLINE_MS).toBe(30_000);
    expect(DEFAULT_ACK_TIMEOUT_MS).toBe(30_000);
  });

  it('la barredora silenciosa arranca con 60s de intervalo y 6h de idle', () => {
    expect(DEFAULT_CHAIN_SWEEP_MS).toBe(60_000);
    expect(DEFAULT_CHAIN_IDLE_MS).toBe(6 * 60 * 60 * 1_000);
    expect(DEFAULT_CHAIN_SETTLED_GRACE_MS).toBe(15 * 60 * 1_000);
    expect(DEFAULT_CHAIN_MAX_AGE_MS).toBe(48 * 60 * 60 * 1_000);
    expect(DEFAULT_CHAIN_SWEEP_LIMIT).toBe(5);
  });

  it('la barredora de retención arranca con intervalo de 5 minutos', () => {
    expect(DEFAULT_RETENTION_INTERVAL_MS).toBe(5 * 60_000);
  });
});

describe('configuredDispatcher: defaults cuando no hay env', () => {
  it('devuelve todos los defaults coherentes entre sí', () => {
    const cfg = configuredDispatcher({});
    expect(cfg.pollMs).toBe(250);
    expect(cfg.ackDeadlineMs).toBe(DEFAULT_ACK_DEADLINE_MS);
    expect(cfg.ackTimeoutMs).toBe(DEFAULT_ACK_TIMEOUT_MS);
    expect(cfg.interactiveBurst).toBe(3);
    expect(cfg.jobLeaseMs).toBe(30_000);
    expect(cfg.retryStartedDeliveries).toBe(false);
    expect(cfg.chainIdleMs).toBe(DEFAULT_CHAIN_IDLE_MS);
    expect(cfg.chainMaxAgeMs).toBe(DEFAULT_CHAIN_MAX_AGE_MS);
    expect(cfg.chainSweepLimit).toBe(DEFAULT_CHAIN_SWEEP_LIMIT);
    expect(cfg.chainSweepMs).toBe(DEFAULT_CHAIN_SWEEP_MS);
    expect(cfg.chainSettledGraceMs).toBe(DEFAULT_CHAIN_SETTLED_GRACE_MS);
    expect(cfg.retentionIntervalMs).toBe(DEFAULT_RETENTION_INTERVAL_MS);
    expect(cfg.healthStaleMs).toBeGreaterThanOrEqual(5_000);
  });

  it('retryStartedDeliveries sólo se enciende con "1"; vacío, "0", "true" y basura la dejan en false', () => {
    expect(configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: '1' }).retryStartedDeliveries).toBe(true);
    expect(configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: '' }).retryStartedDeliveries).toBe(false);
    expect(configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: '0' }).retryStartedDeliveries).toBe(false);
    expect(configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: 'true' }).retryStartedDeliveries).toBe(false);
    expect(configuredDispatcher({ CAUCE_RETRY_STARTED_DELIVERIES: 'yes' }).retryStartedDeliveries).toBe(false);
  });

  it('healthStaleMs se eleva a max(5_000, pollMs * 20) si pollMs es muy bajo', () => {
    const cfg = configuredDispatcher({ DISPATCHER_POLL_MS: '10' });
    expect(cfg.healthStaleMs).toBe(5_000);
    expect(cfg.pollMs).toBe(10);
  });

  it('healthStaleMs respeta pollMs * 20 cuando supera el piso de 5_000', () => {
    const cfg = configuredDispatcher({ DISPATCHER_POLL_MS: '500' });
    expect(cfg.healthStaleMs).toBe(10_000);
  });
});

describe('configuredDispatcher: lectura del entorno', () => {
  it('lee DISPATCHER_POLL_MS, INTERACTIVE_BURST, JOB_LEASE_MS y CHAIN_SWEEP_LIMIT', () => {
    const cfg = configuredDispatcher({
      DISPATCHER_POLL_MS: '500',
      INTERACTIVE_BURST: '7',
      JOB_LEASE_MS: '45000',
      CHAIN_SWEEP_LIMIT: '12'
    });
    expect(cfg.pollMs).toBe(500);
    expect(cfg.interactiveBurst).toBe(7);
    expect(cfg.jobLeaseMs).toBe(45_000);
    expect(cfg.chainSweepLimit).toBe(12);
  });

  it('lee CAUCE_RETENTION_INTERVAL_MS y admite 0 (apaga la barredora)', () => {
    expect(configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: '0' }).retentionIntervalMs).toBe(0);
    expect(configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: '90000' }).retentionIntervalMs).toBe(90_000);
  });

  it('lee CHAIN_SWEEP_MS y admite 0 (apaga el watchdog)', () => {
    expect(configuredDispatcher({ CHAIN_SWEEP_MS: '0' }).chainSweepMs).toBe(0);
    expect(configuredDispatcher({ CHAIN_SWEEP_MS: '15000' }).chainSweepMs).toBe(15_000);
  });

  it('lee CAUCE_DISPATCHER_STALE_MS cuando supera el piso implícito', () => {
    const cfg = configuredDispatcher({
      DISPATCHER_POLL_MS: '1000',
      CAUCE_DISPATCHER_STALE_MS: '90000'
    });
    expect(cfg.healthStaleMs).toBe(90_000);
  });

  it('lee process.env cuando se llama sin argumento', () => {
    process.env.DISPATCHER_POLL_MS = '777';
    process.env.INTERACTIVE_BURST = '4';
    const cfg = configuredDispatcher();
    expect(cfg.pollMs).toBe(777);
    expect(cfg.interactiveBurst).toBe(4);
  });
});

describe('configuredDispatcher: validaciones de positiveInteger', () => {
  it('rechaza DISPATCHER_POLL_MS con 0', () => {
    expect(() => configuredDispatcher({ DISPATCHER_POLL_MS: '0' }))
      .toThrow('DISPATCHER_POLL_MS must be a positive integer');
  });

  it('rechaza DISPATCHER_POLL_MS con valor no numérico', () => {
    expect(() => configuredDispatcher({ DISPATCHER_POLL_MS: 'lento' }))
      .toThrow('DISPATCHER_POLL_MS must be a positive integer');
  });

  it('rechaza DISPATCHER_POLL_MS con NaN (variable vacía)', () => {
    expect(() => configuredDispatcher({ DISPATCHER_POLL_MS: '' }))
      .toThrow('DISPATCHER_POLL_MS must be a positive integer');
  });

  it('rechaza INTERACTIVE_BURST negativo', () => {
    expect(() => configuredDispatcher({ INTERACTIVE_BURST: '-1' }))
      .toThrow('INTERACTIVE_BURST must be a positive integer');
  });

  it('rechaza JOB_LEASE_MS fraccionario', () => {
    expect(() => configuredDispatcher({ JOB_LEASE_MS: '30.5' }))
      .toThrow('JOB_LEASE_MS must be a positive integer');
  });
});

describe('configuredDispatcher: validaciones de nonNegativeInteger', () => {
  it('rechaza CAUCE_RETENTION_INTERVAL_MS negativo', () => {
    expect(() => configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: '-1' }))
      .toThrow('CAUCE_RETENTION_INTERVAL_MS must be a non-negative integer');
  });

  it('rechaza CAUCE_RETENTION_INTERVAL_MS no entero', () => {
    expect(() => configuredDispatcher({ CAUCE_RETENTION_INTERVAL_MS: 'no-numero' }))
      .toThrow('CAUCE_RETENTION_INTERVAL_MS must be a non-negative integer');
  });

  it('rechaza CHAIN_SWEEP_MS fraccionario', () => {
    expect(() => configuredDispatcher({ CHAIN_SWEEP_MS: '60.5' }))
      .toThrow('CHAIN_SWEEP_MS must be a non-negative integer');
  });
});

describe('configuredDispatcher: invariantes cruzadas entre campos', () => {
  it('rechaza ACK_TIMEOUT_MS < CAUCE_ACK_DEADLINE_MS', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '60000',
      ACK_TIMEOUT_MS: '30000'
    })).toThrow('ACK_TIMEOUT_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  });

  it('acepta ACK_TIMEOUT_MS exactamente igual al deadline (control negativo del umbral)', () => {
    const cfg = configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '30000',
      ACK_TIMEOUT_MS: '30000'
    });
    expect(cfg.ackTimeoutMs).toBe(30_000);
    expect(cfg.ackDeadlineMs).toBe(30_000);
  });

  it('rechaza CAUCE_DELIVERY_LEASE_CAP_MS < CAUCE_ACK_DEADLINE_MS', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '60000',
      ACK_TIMEOUT_MS: '120000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '30000'
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  });

  it('rechaza CAUCE_RETENTION_ACK_RENEWAL_MS > CAUCE_RETENTION_ACK_MS', () => {
    expect(() => configuredDispatcher({
      CAUCE_RETENTION_ACK_RENEWAL_MS: '90000',
      CAUCE_RETENTION_ACK_MS: '60000'
    })).toThrow('renewal retention windows must be shorter than or equal to the general retention windows');
  });

  it('rechaza CAUCE_RETENTION_AUDIT_RENEWAL_MS > CAUCE_RETENTION_AUDIT_MS', () => {
    expect(() => configuredDispatcher({
      CAUCE_RETENTION_AUDIT_RENEWAL_MS: '90000',
      CAUCE_RETENTION_AUDIT_MS: '60000'
    })).toThrow('renewal retention windows must be shorter than or equal to the general retention windows');
  });

  it('rechaza CHAIN_MAX_AGE_MS < CHAIN_IDLE_MS', () => {
    expect(() => configuredDispatcher({
      CHAIN_IDLE_MS: '86400000',
      CHAIN_MAX_AGE_MS: '3600000'
    })).toThrow('CHAIN_MAX_AGE_MS must be equal to or greater than CHAIN_IDLE_MS');
  });
});