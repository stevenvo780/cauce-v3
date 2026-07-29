import type { DatabasePool } from '@cauce/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobHandlerRegistry } from '../src/handlers.js';

const storeMocks = vi.hoisted(() => ({
  retryStaleDeliveries: vi.fn(async () => ({ retried: 0, dead: 0 })),
  retryExpiredJobs: vi.fn(async () => 0),
  claimFairJobs: vi.fn(async () => []),
}));

vi.mock('@cauce/store', () => ({
  CauceRepository: class {
    retryStaleDeliveries = storeMocks.retryStaleDeliveries;
    retryExpiredJobs = storeMocks.retryExpiredJobs;
    claimFairJobs = storeMocks.claimFairJobs;
  },
}));

import { runDispatcher } from '../src/index.js';

describe('dispatcher stale-delivery guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'fails closed for invalid staleAckMs=%s',
    (staleAckMs) => {
      expect(() => runDispatcher({} as DatabasePool, {
        staleAckMs,
        pollMs: 60_000,
        handlers: new JobHandlerRegistry(),
      })).toThrow(/positive integer/u);
      expect(storeMocks.retryStaleDeliveries).not.toHaveBeenCalled();
    },
  );

  it('uses the safe default when no timeout is supplied', async () => {
    const dispatcher = runDispatcher({} as DatabasePool, {
      pollMs: 60_000,
      handlers: new JobHandlerRegistry(),
    });
    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }
    expect(storeMocks.retryStaleDeliveries).toHaveBeenCalledWith(30_000);
  });

  it('preserves an explicit positive timeout', async () => {
    const dispatcher = runDispatcher({} as DatabasePool, {
      staleAckMs: 120_000,
      pollMs: 60_000,
      handlers: new JobHandlerRegistry(),
    });
    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }
    expect(storeMocks.retryStaleDeliveries).toHaveBeenCalledWith(120_000);
  });
});
