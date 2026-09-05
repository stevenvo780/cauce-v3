import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterEngine } from '../src/sdk/engine.js';
import type { ClientFrame, DeliveryEvent } from '../src/sdk/types.js';
import {
  FakeConnection, SequenceConnector, VirtualClock, makeClient, waitUntil,
} from './client-fixtures.js';

class ReplayConnection extends FakeConnection {
  closeCalls = 0;
  private readonly completions: (() => void)[] = [];

  constructor(private readonly clock: VirtualClock, private readonly delayMs?: number) {
    super();
  }

  override async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
    const lease_expires_at = new Date(this.clock.now().getTime() + 120_000).toISOString();
    if (frame.type === 'hello') {
      this.push({ type: 'hello_ack', version: '3.0', epoch: 1, lease_expires_at });
    } else if (frame.type === 'heartbeat') {
      this.push({ type: 'heartbeat_ack', lease_expires_at });
    } else {
      await new Promise<void>((resolveSend) => {
        const complete = (): void => {
          this.push({
            type: 'ack_result', event_id: frame.event_id, delivery_id: frame.delivery_id,
            attempt: frame.attempt, claim_token: frame.claim_token, status: frame.status,
            applied: true, receipt: 'applied',
          });
          resolveSend();
        };
        this.completions.push(complete);
        if (this.delayMs === 0) complete();
        else if (this.delayMs !== undefined) this.clock.setTimer(complete, this.delayMs);
      });
    }
  }

  completeLateSends(): void {
    for (const complete of this.completions.splice(0)) complete();
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
    await super.close();
  }
}

function events(count: number): DeliveryEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    return {
      event_id: `50000000-0000-4000-8000-${suffix}`,
      delivery_id: `20000000-0000-4000-8000-${suffix}`,
      attempt: 1, claim_token: `40000000-0000-4000-8000-${suffix}`,
      epoch: 1, phase: 'accepted', occurred_at: new Date(0).toISOString(),
    };
  });
}

async function turn(): Promise<void> {
  await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
}

test('slow outbox replay drains receipts and sustains heartbeats beyond their deadline', async (t) => {
  const clock = new VirtualClock();
  const connection = new ReplayConnection(clock, 10_000);
  const connector = new SequenceConnector([connection]);
  const errors: string[] = [];
  const recovery = t.mock.method(AdapterEngine.prototype, 'recover', async () => undefined);
  const context = await makeClient('outbox-slow-live', connector, {
    clock, heartbeatMs: 5_000, heartbeatAckTimeoutMs: 45_000, sendTimeoutMs: 15_000,
    onError: (code) => { errors.push(code); },
  });
  for (const event of events(8)) await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === 'ack'));
    for (let completed = 1; completed <= 8; completed += 1) {
      clock.advance(5_000);
      await turn();
      clock.advance(5_000);
      await waitUntil(() => context.store.pendingEvents().length === 8 - completed,
        500, 'the receipt persisted while replay is still running');
      assert.equal(recovery.mock.callCount(), completed === 8 ? 1 : 0);
      assert.equal(connector.calls, 1);
      assert.deepEqual(errors, []);
    }
    assert.ok(connection.sent.filter((frame) => frame.type === 'heartbeat').length >= 8);
    assert.equal(connection.closeCalls, 0);
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});

test('stopping a blocked replay drains its task without recovery or late sends', async (t) => {
  const clock = new VirtualClock();
  const connection = new ReplayConnection(clock);
  const recovery = t.mock.method(AdapterEngine.prototype, 'recover', async () => undefined);
  const context = await makeClient('outbox-replay-stop', new SequenceConnector([connection]), { clock });
  for (const event of events(2)) await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === 'ack'));
    stop.abort();
    await running;
    connection.completeLateSends();
    await turn();
    assert.equal(connection.sent.filter((frame) => frame.type === 'ack').length, 1);
    assert.equal(context.store.pendingEvents().length, 2);
    assert.equal(recovery.mock.callCount(), 0);
    assert.equal(clock.pendingTimers(), 0);
  } finally {
    stop.abort();
    await running;
  }
});

test('a closed replay cannot recover or append its old snapshot to a new generation', async (t) => {
  const clock = new VirtualClock();
  const first = new ReplayConnection(clock);
  const second = new ReplayConnection(clock, 0);
  const connector = new SequenceConnector([first, second]);
  const recovery = t.mock.method(AdapterEngine.prototype, 'recover', async () => undefined);
  const context = await makeClient('outbox-replay-reconnect', connector, { clock });
  const pending = events(2);
  for (const event of pending) await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === 'ack'));
    first.end();
    await waitUntil(() => clock.scheduledIn(1) > 0, 500, 'reconnect without waiting for the old send');
    assert.equal(recovery.mock.callCount(), 0);
    clock.advance(1);
    await waitUntil(() => context.store.pendingEvents().length === 0);
    assert.equal(connector.calls, 2);
    assert.equal(recovery.mock.callCount(), 1);
    assert.deepEqual(second.sent.filter((frame) => frame.type === 'ack').map((frame) => frame.event_id),
      pending.map((event) => event.event_id));
    first.completeLateSends();
    await turn();
    assert.equal(recovery.mock.callCount(), 1);
    assert.equal(second.sent.filter((frame) => frame.type === 'ack').length, 2);
    assert.equal(first.sent.filter((frame) => frame.type === 'ack').length, 1);
  } finally {
    stop.abort();
    await running;
  }
  assert.equal(clock.pendingTimers(), 0);
});
