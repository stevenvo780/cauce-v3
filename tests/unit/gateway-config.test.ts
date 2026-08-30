import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HUMAN_RESERVED_DELIVERIES,
  DEFAULT_MAX_INFLIGHT_DELIVERIES,
  configuredAckDeadlineMs,
  configuredDeliveryAdmission,
  configuredDeliveryLeaseCap,
  validateAckDeadlineMs,
  validateDeliveryAdmission,
  type DeliveryAdmissionConfig,
} from '../../services/gateway/src/config.js';

/**
 * Pure-function tests for `services/gateway/src/config.ts`.
 *
 * The module has two clusters of configuration:
 *   * ACK deadline + delivery lease cap — what the gateway enforces per attempt.
 *   * Delivery admission — slots that bound how many deliveries can run per adapter.
 *
 * The intent here is to keep the tests hermetic: every branch of every exported
 * pure function is exercised, without booting Fastify or touching the database.
 * The internal helper `nonNegativeInteger` is reached through `configuredDeliveryAdmission`.
 */

const ENV_KEYS = [
  'CAUCE_ACK_DEADLINE_MS',
  'CAUCE_DELIVERY_LEASE_CAP_MS',
  'CAUCE_DELIVERY_LEASE_CAP_GRACE_MS',
  'CAUCE_MAX_INFLIGHT_DELIVERIES',
  'CAUCE_HUMAN_RESERVED_DELIVERIES',
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe('constantes por defecto del gateway', () => {
  it('el deadline de ACK por defecto es 30 segundos', () => {
    expect(DEFAULT_ACK_DEADLINE_MS).toBe(30_000);
  });

  it('los topes por defecto de admisión son 2 entregas en vuelo y 2 reservadas para humanos', () => {
    expect(DEFAULT_MAX_INFLIGHT_DELIVERIES).toBe(2);
    expect(DEFAULT_HUMAN_RESERVED_DELIVERIES).toBe(2);
  });
});

describe('validateAckDeadlineMs', () => {
  it('devuelve el valor cuando es un entero positivo', () => {
    expect(validateAckDeadlineMs(1)).toBe(1);
    expect(validateAckDeadlineMs(60_000)).toBe(60_000);
    expect(validateAckDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rechaza cero y los negativos con un mensaje que nombra la variable', () => {
    expect(() => validateAckDeadlineMs(0)).toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
    expect(() => validateAckDeadlineMs(-1)).toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  });

  it('rechaza lo que no es entero seguro: fraccionarios, NaN, Infinity, fuera del rango', () => {
    expect(() => validateAckDeadlineMs(1.5)).toThrow('positive integer');
    expect(() => validateAckDeadlineMs(Number.NaN)).toThrow('positive integer');
    expect(() => validateAckDeadlineMs(Number.POSITIVE_INFINITY)).toThrow('positive integer');
    expect(() => validateAckDeadlineMs(Number.MAX_SAFE_INTEGER + 1)).toThrow('positive integer');
  });
});

describe('configuredAckDeadlineMs', () => {
  it('usa el valor por defecto cuando la variable de entorno no está definida', () => {
    expect(configuredAckDeadlineMs({})).toBe(DEFAULT_ACK_DEADLINE_MS);
  });

  it('lee CAUCE_ACK_DEADLINE_MS del entorno cuando está presente', () => {
    expect(configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '45000' })).toBe(45_000);
  });

  it('tira si la variable del entorno no es un entero positivo', () => {
    expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '0' }))
      .toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
    expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '-5' }))
      .toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
    expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: 'no-es-numero' }))
      .toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  });

  it('cuando se llama sin argumento, toma el valor de process.env', () => {
    process.env.CAUCE_ACK_DEADLINE_MS = '75000';
    expect(configuredAckDeadlineMs()).toBe(75_000);
  });
});

describe('configuredDeliveryLeaseCap', () => {
  it('devuelve los topes por defecto cuando no hay variables de entorno', () => {
    const cap = configuredDeliveryLeaseCap({});
    expect(cap.leaseCapMs).toBeGreaterThanOrEqual(DEFAULT_ACK_DEADLINE_MS);
    expect(cap.leaseCapGraceMs).toBeGreaterThan(0);
    expect(cap.leaseCapMs).toBe(12 * 60 * 60_000);
    expect(cap.leaseCapGraceMs).toBe(30 * 60_000);
  });

  it('lee ambas variables del entorno cuando están presentes', () => {
    const cap = configuredDeliveryLeaseCap({
      CAUCE_ACK_DEADLINE_MS: '1000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '5000',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '500',
    });
    expect(cap).toEqual({ leaseCapMs: 5_000, leaseCapGraceMs: 500 });
  });

  it('rechaza un leaseCapMs que no es entero positivo', () => {
    expect(() => configuredDeliveryLeaseCap({
      CAUCE_DELIVERY_LEASE_CAP_MS: '0',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '30000',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_MS must be a positive integer');

    expect(() => configuredDeliveryLeaseCap({
      CAUCE_DELIVERY_LEASE_CAP_MS: 'no',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '30000',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_MS must be a positive integer');
  });

  it('rechaza un leaseCapGraceMs que no es entero positivo', () => {
    expect(() => configuredDeliveryLeaseCap({
      CAUCE_DELIVERY_LEASE_CAP_MS: '5000',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '-1',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_GRACE_MS must be a positive integer');

    expect(() => configuredDeliveryLeaseCap({
      CAUCE_DELIVERY_LEASE_CAP_MS: '5000',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: 'nope',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_GRACE_MS must be a positive integer');
  });

  it('rechaza un leaseCapMs estrictamente menor que el deadline de ACK', () => {
    expect(() => configuredDeliveryLeaseCap({
      CAUCE_ACK_DEADLINE_MS: '60000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '30000',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '500',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  });

  it('acepta leaseCapMs exactamente igual al deadline de ACK (control negativo del umbral)', () => {
    const cap = configuredDeliveryLeaseCap({
      CAUCE_ACK_DEADLINE_MS: '30000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '30000',
      CAUCE_DELIVERY_LEASE_CAP_GRACE_MS: '500',
    });
    expect(cap).toEqual({ leaseCapMs: 30_000, leaseCapGraceMs: 500 });
  });
});

describe('validateDeliveryAdmission', () => {
  it('devuelve la misma configuración cuando ambos campos son enteros no negativos', () => {
    const input: DeliveryAdmissionConfig = { maxInflightDeliveries: 4, humanReservedDeliveries: 1 };
    expect(validateDeliveryAdmission(input)).toBe(input);
  });

  it('admite cero en un campo siempre que el otro permita al menos un slot', () => {
    expect(validateDeliveryAdmission({ maxInflightDeliveries: 0, humanReservedDeliveries: 3 }))
      .toEqual({ maxInflightDeliveries: 0, humanReservedDeliveries: 3 });
    expect(validateDeliveryAdmission({ maxInflightDeliveries: 5, humanReservedDeliveries: 0 }))
      .toEqual({ maxInflightDeliveries: 5, humanReservedDeliveries: 0 });
  });

  it('rechaza maxInflightDeliveries negativo o no entero', () => {
    expect(() => validateDeliveryAdmission({ maxInflightDeliveries: -1, humanReservedDeliveries: 1 }))
      .toThrow('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
    expect(() => validateDeliveryAdmission({ maxInflightDeliveries: 1.5, humanReservedDeliveries: 1 }))
      .toThrow('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
  });

  it('rechaza humanReservedDeliveries negativo o no entero', () => {
    expect(() => validateDeliveryAdmission({ maxInflightDeliveries: 1, humanReservedDeliveries: -2 }))
      .toThrow('CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer');
    expect(() => validateDeliveryAdmission({ maxInflightDeliveries: 1, humanReservedDeliveries: Number.NaN }))
      .toThrow('CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer');
  });

  it('rechaza la combinación con ambos slots en cero (no quedaría ningún slot para reclamar)', () => {
    expect(() => validateDeliveryAdmission({ maxInflightDeliveries: 0, humanReservedDeliveries: 0 }))
      .toThrow('cannot both be zero');
  });
});

describe('configuredDeliveryAdmission', () => {
  it('devuelve los valores por defecto cuando no hay variables de entorno', () => {
    expect(configuredDeliveryAdmission({})).toEqual({
      maxInflightDeliveries: DEFAULT_MAX_INFLIGHT_DELIVERIES,
      humanReservedDeliveries: DEFAULT_HUMAN_RESERVED_DELIVERIES,
    });
  });

  it('lee ambas variables del entorno cuando están presentes', () => {
    expect(configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '8',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '4',
    })).toEqual({ maxInflightDeliveries: 8, humanReservedDeliveries: 4 });
  });

  it('usa el fallback cuando la variable del entorno está ausente (rama undefined del ?? interno)', () => {
    expect(configuredDeliveryAdmission({ CAUCE_MAX_INFLIGHT_DELIVERIES: '6' }))
      .toEqual({ maxInflightDeliveries: 6, humanReservedDeliveries: DEFAULT_HUMAN_RESERVED_DELIVERIES });
    expect(configuredDeliveryAdmission({ CAUCE_HUMAN_RESERVED_DELIVERIES: '1' }))
      .toEqual({ maxInflightDeliveries: DEFAULT_MAX_INFLIGHT_DELIVERIES, humanReservedDeliveries: 1 });
  });

  it('rechaza un valor del entorno que no es entero no negativo', () => {
    expect(() => configuredDeliveryAdmission({ CAUCE_MAX_INFLIGHT_DELIVERIES: '-1' }))
      .toThrow('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
    expect(() => configuredDeliveryAdmission({ CAUCE_HUMAN_RESERVED_DELIVERIES: '2.5' }))
      .toThrow('CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer');
    expect(() => configuredDeliveryAdmission({ CAUCE_MAX_INFLIGHT_DELIVERIES: 'foo' }))
      .toThrow('CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer');
  });

  it('rechaza la combinación del entorno que deja ambos slots en cero', () => {
    expect(() => configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '0',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '0',
    })).toThrow('cannot both be zero');
  });

  it('cuando se llama sin argumento, lee process.env', () => {
    process.env.CAUCE_MAX_INFLIGHT_DELIVERIES = '9';
    process.env.CAUCE_HUMAN_RESERVED_DELIVERIES = '3';
    expect(configuredDeliveryAdmission()).toEqual({ maxInflightDeliveries: 9, humanReservedDeliveries: 3 });
  });
});
