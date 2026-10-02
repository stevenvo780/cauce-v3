import { describe, expect, it } from 'vitest';
import { StoreError } from '@cauce/store';
import { TelegramPoller } from '../src/poller.js';
import type { PollLease, TelegramIngress, TelegramIngressMessage } from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, MemoryCursorRepository, update, noopActivity, noopObserver
} from './bridge-fixtures.js';

class AlwaysConflictingIngress implements TelegramIngress {
  readonly calls: TelegramIngressMessage[] = [];
  constructor(private readonly error: Error) {}

  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    this.calls.push(message);
    throw this.error;
  }
}

describe('poller idempotency-conflict resolution', () => {
  it.each([
    'idempotency key already used by a different request',
    'the durable publication already represents this update',
  ])('advances past a durable conflict independently of its prose: %s', async (message) => {
    const repository = new MemoryCursorRepository();
    const ingress = new AlwaysConflictingIngress(new StoreError('conflict', message, 'idempotency_durable_conflict'));
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
    expect(metrics).toContain('updates_duplicate');
    // The idempotency key is telegram:{bot_id}:{update_id} alone: a conflict on it proves the
    // update_id is already durably represented, so the fence resolves by update_id and the
    // cursor moves past it rather than getting stuck waiting for a body match that a
    // non-deterministic transcription will never produce twice.
    expect(repository.next).toBe(71);

    const secondCycle = await poller.runOnce();
    expect(secondCycle).toBe(0);
    expect(ingress.calls).toHaveLength(1);
  });

  it.each([
    new StoreError('conflict', 'idempotency key reused with a different request'),
    new StoreError('conflict', 'idempotency request is still in progress'),
    new StoreError('conflict', 'different request', 'consumer_capacity_invalid'),
    new StoreError('forbidden', 'different request', 'idempotency_durable_conflict'),
    Object.assign(new Error('different request'), { name: 'StoreError', code: 'conflict' }),
  ])('never advances the cursor on a generic or unrelated conflict: %s', async (error) => {
    const repository = new MemoryCursorRepository();
    const metrics: string[] = [];
    const poller = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(), config: config(), botId: '900001',
      api: new FakeTelegram([update(70)]), repository, ingress: new AlwaysConflictingIngress(error),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(poller.runOnce()).rejects.toBe(error);
    expect(repository.next).toBe(0);
    expect(metrics).not.toContain('updates_duplicate');
    expect(metrics).not.toContain('updates_conflict');
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

describe('update kinds this bridge does not serve', () => {
  it('records an edited_message with its kind BEFORE the destructive cursor advances', async () => {
    const trace: string[] = [];
    class OrderedCursors extends MemoryCursorRepository {
      override async advanceCursor(lease: PollLease, nextUpdateId: number): Promise<void> {
        trace.push(`cursor:${String(nextUpdateId)}`);
        await super.advanceCursor(lease, nextUpdateId);
      }
    }
    const repository = new OrderedCursors();
    const ingress = new DeduplicatingIngress();
    const metrics: string[] = [];
    const suppressed: { event: string; kind?: string; reason: string; update_id: number }[] = [];

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(),
      botId: '900001',
      api: new FakeTelegram([{
        update_id: 90,
        edited_message: {
          message_id: 190, from: { id: 101 }, chat: { id: 201, type: 'private' }, text: 'corregido'
        }
      }]),
      repository,
      ingress,
      onMetric: (metric) => metrics.push(metric),
      onSuppressed: (record) => {
        trace.push('audit');
        suppressed.push(record);
      }
    }).runOnce();

    expect(ingress.calls).toHaveLength(0);
    expect(metrics).toContain('updates_kind_suppressed');
    expect(metrics).not.toContain('updates_denied');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      // Chat 201 is a DM: naming the record `group` would be a lie in the one place an operator
      // reads to find out which chat went quiet.
      event: 'telegram_update_suppressed',
      kind: 'edited_message', reason: 'update_kind', update_id: 90, message_id: 190
    });
    expect(trace).toEqual(['audit', 'cursor:91']);
    expect(repository.next).toBe(91);
  });
});
