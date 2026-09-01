import { describe, expect, it, vi } from 'vitest';
import type { CancelResult, ReplayResult } from '../../api/types';
import {
  cancelDeliverySafely, replayDeliverySafely, rereadProvesDeliveryEffect,
} from './delivery-actions';

const SOURCE = 'a0000000-0000-4000-8000-000000000001';
const REPLAY = 'b0000000-0000-4000-8000-000000000001';

function api(overrides: {
  replayDelivery?: (deliveryId: string) => Promise<ReplayResult>;
  cancelDelivery?: (deliveryId: string) => Promise<CancelResult>;
} = {}) {
  return {
    replayDelivery: vi.fn(overrides.replayDelivery ?? (async () => ({
      delivery_id: REPLAY, replayed_from_delivery_id: SOURCE, state: 'pending' as const, replayed: true,
    }))),
    cancelDelivery: vi.fn(overrides.cancelDelivery ?? (async () => ({
      delivery_id: SOURCE, state: 'dead' as const, cancelled: true, cancelled_from_state: 'started' as const,
      parent_notice: 'returned' as const, origin_relayed: true, replayable: true,
    }))),
  };
}

describe('safe delivery commands', () => {
  it('credits replay only after an exact receipt and rereads once', async () => {
    const client = api();
    const reread = vi.fn(async () => ({ data: { observed_at: 'now' } }));
    await expect(replayDeliverySafely({ api: client, deliveryId: SOURCE, reread })).resolves.toMatchObject({
      kind: 'confirmed', rereadCompleted: true,
    });
    expect(client.replayDelivery).toHaveBeenCalledExactlyOnceWith(SOURCE);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('does not blindly repeat an ambiguous replay and locks before its authoritative reread', async () => {
    let finish!: (value: { data: unknown }) => void;
    const reread = vi.fn(() => new Promise<{ data: unknown }>((resolve) => { finish = resolve; }));
    const client = api({ replayDelivery: vi.fn(async () => ({
      delivery_id: SOURCE, replayed_from_delivery_id: SOURCE, state: 'pending' as const, replayed: true,
    })) });
    const uncertain = vi.fn();
    const command = replayDeliverySafely({ api: client, deliveryId: SOURCE, reread, onUncertain: uncertain });

    await vi.waitFor(() => { expect(uncertain).toHaveBeenCalledOnce(); });
    expect(client.replayDelivery).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledOnce();
    finish({ data: {} });
    await expect(command).resolves.toMatchObject({ kind: 'uncertain', effectProven: false });
    expect(client.replayDelivery).toHaveBeenCalledTimes(1);
  });

  it('proves a replay only from a distinct clone linked to the source in a known state', async () => {
    const client = api({ replayDelivery: vi.fn(async () => ({
      delivery_id: REPLAY,
      replayed_from_delivery_id: SOURCE,
      state: 'pending' as const,
      replayed: true,
      extra: 'forces ambiguous receipt',
    })) });
    const outcome = await replayDeliverySafely({
      api: client,
      deliveryId: SOURCE,
      reread: async () => ({ data: { items: [{
        delivery_id: REPLAY,
        replayed_from_delivery_id: SOURCE,
        state: 'started',
      }] } }),
    });
    expect(outcome).toMatchObject({ kind: 'uncertain', effectProven: true });
    expect(outcome.notice).toMatch(/demostró el efecto durable/i);
    expect(client.replayDelivery).toHaveBeenCalledTimes(1);
  });

  it('keeps uncertainty explicit when the reread also fails', async () => {
    const client = api({ replayDelivery: vi.fn(async () => { throw new Error('connection lost'); }) });
    const outcome = await replayDeliverySafely({
      api: client,
      deliveryId: SOURCE,
      reread: async () => ({ error: new Error('snapshot unavailable') }),
    });
    expect(outcome).toMatchObject({ kind: 'uncertain', effectProven: false });
    expect(outcome.notice).toMatch(/acción permanece bloqueada/i);
    expect(client.replayDelivery).toHaveBeenCalledTimes(1);
  });

  it('validates cancellation and rereads without issuing replay', async () => {
    const client = api();
    const outcome = await cancelDeliverySafely({ api: client, deliveryId: SOURCE, reread: async () => ({ data: {} }) });
    expect(outcome).toMatchObject({ kind: 'confirmed', rereadCompleted: true });
    expect(client.cancelDelivery).toHaveBeenCalledExactlyOnceWith(SOURCE);
    expect(client.replayDelivery).not.toHaveBeenCalled();
  });

  it('proves an ambiguous cancellation only from its exact durable state and reason', async () => {
    const client = api({ cancelDelivery: vi.fn(async () => ({
      delivery_id: SOURCE, state: 'dead' as const, cancelled: true,
    })) });
    const outcome = await cancelDeliverySafely({
      api: client,
      deliveryId: SOURCE,
      reread: async () => ({ data: { items: [{
        delivery_id: SOURCE,
        state: 'dead',
        last_error: 'Cancelled by operator Steven:kant',
      }] } }),
    });
    expect(outcome).toMatchObject({ kind: 'uncertain', effectProven: true });
    expect(client.cancelDelivery).toHaveBeenCalledTimes(1);
  });

  it('rejects inconclusive state-only evidence for both commands', () => {
    expect(rereadProvesDeliveryEffect(
      { action: 'cancel', deliveryId: SOURCE },
      { items: [{ delivery_id: SOURCE, state: 'dead', last_error: 'max attempts exhausted' }] },
    )).toBe(false);
    expect(rereadProvesDeliveryEffect(
      { action: 'replay', deliveryId: SOURCE },
      { items: [{ delivery_id: REPLAY, state: 'pending' }] },
    )).toBe(false);
    expect(rereadProvesDeliveryEffect(
      { action: 'replay', deliveryId: SOURCE },
      { items: [{ delivery_id: REPLAY, replayed_from_delivery_id: SOURCE, state: 'future-state' }] },
    )).toBe(false);
  });
});
