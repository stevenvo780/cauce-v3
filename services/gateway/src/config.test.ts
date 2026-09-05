import { describe, expect, it } from 'vitest';
import {
  configuredAckDeadlineMs, configuredDeliveryAdmission, configuredLeaseTtlMs, DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_LEASE_TTL_MS, DEFAULT_MAX_INFLIGHT_DELIVERIES, MIN_LEASE_TTL_MS
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

describe('gateway lease ttl configuration', () => {
  it('defaults to the production trigger value and honors an environment override', () => {
    expect(configuredLeaseTtlMs({})).toBe(DEFAULT_LEASE_TTL_MS);
    expect(configuredLeaseTtlMs({ CAUCE_LEASE_TTL_MS: '90000' })).toBe(90_000);
    expect(configuredLeaseTtlMs({ CAUCE_LEASE_TTL_MS: String(MIN_LEASE_TTL_MS) })).toBe(MIN_LEASE_TTL_MS);
  });

  it.each(['0', '1000', '29999', '-1', '1.5', 'not-a-number'])(
    'fails closed for CAUCE_LEASE_TTL_MS=%j below twice the heartbeat cadence',
    (value) => {
      expect(() => configuredLeaseTtlMs({ CAUCE_LEASE_TTL_MS: value })).toThrow(
        /CAUCE_LEASE_TTL_MS must be a safe integer of at least 30000/u,
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
    // Legitimate configuration for a pure assistant: it takes no inter-agent work, but its owner
    // keeps it available at all times.
    expect(configuredDeliveryAdmission({
      CAUCE_MAX_INFLIGHT_DELIVERIES: '0',
      CAUCE_HUMAN_RESERVED_DELIVERIES: '2',
    })).toEqual({ maxInflightDeliveries: 0, humanReservedDeliveries: 2 });
  });

  it('refuses a configuration where no delivery could ever be claimed', () => {
    // A connected adapter that never receives anything looks identical to a broken one, and
    // distinguishing the two cases already cost a week. It must blow up at startup.
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

describe('gateway blob store configuration', () => {
  it('defaults to the production directory and the protocol default cap', async () => {
    const { configuredBlobStore, DEFAULT_BLOB_DIRECTORY } = await import('./config.js');
    const { DEFAULT_BLOB_MAX_BYTES } = await import('@cauce/protocol');
    expect(configuredBlobStore({})).toEqual({ directory: DEFAULT_BLOB_DIRECTORY, maxBytes: DEFAULT_BLOB_MAX_BYTES });
    expect(DEFAULT_BLOB_DIRECTORY).toBe('/var/lib/cauce-v3/blobs');
  });

  it('honors an absolute directory and an integer cap from the environment', async () => {
    const { configuredBlobStore } = await import('./config.js');
    expect(configuredBlobStore({ CAUCE_BLOB_DIR: '/srv/blobs', CAUCE_BLOB_MAX_BYTES: '3221225472' }))
      .toEqual({ directory: '/srv/blobs', maxBytes: 3_221_225_472 });
  });

  it.each(['0', '-1', '1.5', 'x', String(32 * 1024 ** 3)])('fails closed for CAUCE_BLOB_MAX_BYTES=%j', async (value) => {
    const { configuredBlobStore } = await import('./config.js');
    expect(() => configuredBlobStore({ CAUCE_BLOB_MAX_BYTES: value })).toThrow(/CAUCE_BLOB_MAX_BYTES/u);
  });

  it('fails closed for a relative CAUCE_BLOB_DIR', async () => {
    const { configuredBlobStore } = await import('./config.js');
    expect(() => configuredBlobStore({ CAUCE_BLOB_DIR: 'blobs' })).toThrow(/CAUCE_BLOB_DIR/u);
  });
});
