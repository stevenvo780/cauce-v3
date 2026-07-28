import { describe, expect, it } from 'vitest';
import {
  configuredAckDeadlineMs, configuredDeliveryAdmission, DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES
} from './config.js';

describe('gateway delivery deadline configuration', () => {
  it('uses the bounded positive delivery deadline from the environment', () => {
    expect(configuredAckDeadlineMs({})).toBe(DEFAULT_ACK_DEADLINE_MS);
    expect(configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '600000' })).toBe(600_000);
  });

  it.each(['', '0', '-1', '1.5', 'not-a-number'])(
    'fails closed for invalid CAUCE_ACK_DEADLINE_MS=%j',
    (value) => {
      expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: value })).toThrow(
        /CAUCE_ACK_DEADLINE_MS must be a positive integer/u,
      );
    },
  );
});

describe('gateway delivery admission configuration', () => {
  it('defaults to a conservative in-flight budget plus a reserve for humans', () => {
    expect(configuredDeliveryAdmission({})).toEqual({
      maxInflightDeliveries: DEFAULT_MAX_INFLIGHT_DELIVERIES,
      humanReservedDeliveries: DEFAULT_HUMAN_RESERVED_DELIVERIES,
    });
    expect(configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '4',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '1',
    })).toEqual({ maxInflightDeliveries: 4, humanReservedDeliveries: 1 });
  });

  it('allows a zero general budget as long as the human reserve survives', () => {
    // Configuración legítima para un asistente puro: no toma trabajo entre agentes, pero su
    // dueño lo sigue teniendo disponible siempre.
    expect(configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '0',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '2',
    })).toEqual({ maxInflightDeliveries: 0, humanReservedDeliveries: 2 });
  });

  it('refuses a configuration where no delivery could ever be claimed', () => {
    // Un adaptador conectado que nunca recibe nada se ve idéntico a uno roto, y distinguir
    // esos dos casos ya costó una semana. Tiene que reventar al arrancar.
    expect(() => configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '0',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '0',
    })).toThrow(/cannot both be zero/u);
  });

  it.each(['-1', '1.5', 'not-a-number'])(
    'fails closed for invalid CAUCE_MAX_INFLIGHT_DELIVERIES=%j',
    (value) => {
      expect(() => configuredDeliveryAdmission({ CAUCE_MAX_INFLIGHT_DELIVERIES: value })).toThrow(
        /CAUCE_MAX_INFLIGHT_DELIVERIES must be a non-negative integer/u,
      );
    },
  );

  it.each(['-1', '1.5', 'not-a-number'])(
    'fails closed for invalid CAUCE_HUMAN_RESERVED_DELIVERIES=%j',
    (value) => {
      expect(() => configuredDeliveryAdmission({ CAUCE_HUMAN_RESERVED_DELIVERIES: value })).toThrow(
        /CAUCE_HUMAN_RESERVED_DELIVERIES must be a non-negative integer/u,
      );
    },
  );
});
