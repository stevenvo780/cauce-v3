import { describe, expect, it } from 'vitest';
import { exactCancelReceipt, exactReplayReceipt } from './delivery-receipts';

describe('exact delivery mutation receipts', () => {
  it('credits only a new pending replay linked to the requested delivery', () => {
    const source = 'a0000000-0000-4000-8000-000000000001';
    const replay = 'b0000000-0000-4000-8000-000000000001';
    expect(exactReplayReceipt({
      delivery_id: replay,
      replayed_from_delivery_id: source,
      state: 'pending',
      replayed: true,
    }, source)).toBe(true);
    expect(exactReplayReceipt({
      delivery_id: source,
      replayed_from_delivery_id: source,
      state: 'pending',
      replayed: true,
    }, source)).toBe(false);
    expect(exactReplayReceipt({
      delivery_id: 'not-a-uuid', replayed_from_delivery_id: source, state: 'pending', replayed: true,
    }, source)).toBe(false);
    expect(exactReplayReceipt({
      delivery_id: replay.toUpperCase(), replayed_from_delivery_id: source,
      state: 'pending', replayed: true,
    }, source)).toBe(false);
    expect(exactReplayReceipt({
      delivery_id: replay.replace(/-4/u, '-7'), replayed_from_delivery_id: source,
      state: 'pending', replayed: true,
    }, source)).toBe(false);
    expect(exactReplayReceipt({
      delivery_id: replay, replayed_from_delivery_id: source, state: 'pending', replayed: true,
      extra: true,
    }, source)).toBe(false);
    expect(exactReplayReceipt({ replayed: true }, source)).toBe(false);
  });

  it('credits cancellation only with the exact dead/replayable lifecycle receipt', () => {
    const delivery = 'c0000000-0000-4000-8000-000000000001';
    const exact = {
      delivery_id: delivery,
      state: 'dead' as const,
      cancelled: true,
      cancelled_from_state: 'started' as const,
      parent_notice: 'returned' as const,
      origin_relayed: true,
      replayable: true,
    };
    expect(exactCancelReceipt(exact, delivery)).toBe(true);
    expect(exactCancelReceipt({ ...exact, replayable: null }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, parent_notice: null }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, parent_notice: 'constructor' as never }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, cancelled_from_state: 'done' }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, delivery_id: 'another' }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, delivery_id: delivery.toUpperCase() }, delivery)).toBe(false);
    expect(exactCancelReceipt({ ...exact, extra: true }, delivery)).toBe(false);
  });
});
