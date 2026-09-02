import { describe, expect, it } from 'vitest';
import { ackFailureBackoffSeconds, jobRetryBackoffSeconds } from '../src/repository/observability/policy.js';
import { configuredAckDeadlineMs, configuredDeliveryLeaseCap, DEFAULT_ACK_DEADLINE_MS } from '../src/index.js';

describe('named backoff schedules', () => {
  it('doubles a declared ACK failure from one second and caps at sixty', () => {
    expect(ackFailureBackoffSeconds(1)).toBe(1);
    expect(ackFailureBackoffSeconds(2)).toBe(2);
    expect(ackFailureBackoffSeconds(7)).toBe(60);
    expect(ackFailureBackoffSeconds(40)).toBe(60);
    expect(ackFailureBackoffSeconds(0)).toBe(1);
  });

  it('doubles a job retry from one second and caps at five minutes', () => {
    expect(jobRetryBackoffSeconds(1)).toBe(1);
    expect(jobRetryBackoffSeconds(9)).toBe(256);
    expect(jobRetryBackoffSeconds(10)).toBe(300);
    expect(jobRetryBackoffSeconds(-3)).toBe(1);
  });
});

describe('delivery timing configuration', () => {
  it('rejects an empty ACK deadline instead of reading it as zero', () => {
    expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '' }))
      .toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
    expect(configuredAckDeadlineMs({})).toBe(DEFAULT_ACK_DEADLINE_MS);
  });

  it('keeps the lease cap at or above the ACK deadline', () => {
    expect(() => configuredDeliveryLeaseCap({
      CAUCE_ACK_DEADLINE_MS: '60000',
      CAUCE_DELIVERY_LEASE_CAP_MS: '1000',
    })).toThrow('CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
    expect(configuredDeliveryLeaseCap({ CAUCE_DELIVERY_LEASE_CAP_MS: '60000' }).leaseCapMs).toBe(60_000);
  });
});
