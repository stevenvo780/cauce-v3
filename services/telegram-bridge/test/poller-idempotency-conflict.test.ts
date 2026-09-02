import { describe, expect, it } from 'vitest';
import { TelegramPoller } from '../src/poller.js';
import type { TelegramIngress, TelegramIngressMessage } from '../src/types.js';
import { config, FakeTelegram, MemoryCursorRepository, update, noopActivity, noopObserver } from './bridge-fixtures.js';

/**
 * Shaped exactly like the store's idempotency-key conflict: same `request_id`
 * (`telegram:{bot_id}:{update_id}`, content-free), different computed body — the case a
 * non-deterministic voice transcription produces on a retried update.
 */
class StoreConflictError extends Error {
  readonly code = 'conflict';
  constructor() {
    super('idempotency key already used by a different request');
    this.name = 'StoreError';
  }
}

class AlwaysConflictingIngress implements TelegramIngress {
  readonly calls: TelegramIngressMessage[] = [];
  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    this.calls.push(message);
    throw new StoreConflictError();
  }
}

describe('poller idempotency-conflict resolution', () => {
  it('advances the cursor past a conflicting update instead of retrying it forever', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new AlwaysConflictingIngress();
    const api = new FakeTelegram([update(70)]);
    const metrics: string[] = [];

    const poller = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(),
      botId: '900001',
      api,
      repository,
      ingress,
      onMetric: (metric) => metrics.push(metric)
    });

    const firstCycle = await poller.runOnce();
    expect(firstCycle).toBe(1);
    expect(metrics).toContain('updates_conflict');
    // The idempotency key is telegram:{bot_id}:{update_id} alone: a conflict on it proves the
    // update_id is already durably represented, so the fence resolves by update_id and the
    // cursor moves past it rather than getting stuck waiting for a body match that a
    // non-deterministic transcription will never produce twice.
    expect(repository.next).toBe(71);

    const secondCycle = await poller.runOnce();
    expect(secondCycle).toBe(0);
    expect(ingress.calls).toHaveLength(1);
  });

  it('still surfaces a non-conflict publish failure instead of masking it', async () => {
    const repository = new MemoryCursorRepository();
    class BrokenIngress implements TelegramIngress {
      async publish(): Promise<{ duplicate: boolean }> {
        throw new Error('database offline');
      }
    }
    const poller = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(),
      botId: '900001',
      api: new FakeTelegram([update(80)]),
      repository,
      ingress: new BrokenIngress()
    });

    await expect(poller.runOnce()).rejects.toThrow('database offline');
    // A genuine failure must NOT advance the cursor: the update is retried, not lost.
    expect(repository.next).toBe(0);
  });
});
