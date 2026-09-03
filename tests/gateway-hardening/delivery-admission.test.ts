/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HUMAN_PRIORITY_FLOOR } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { buildGateway, type DeliveryClaimRecord, type GatewayRepository } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, frameReader, noDeliveryWakes
} from './helpers.js';

/** Admission control, in-flight delivery caps and interactive-budget reservation for operators. */

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const HTTP_CONNECTION_TOKEN = '90000000-0000-4000-8000-000000000009';
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

function frameSession(socket: WebSocket): {
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
} {
  const all: Record<string, unknown>[] = [];
  return { next: frameReader(socket, all), seen: () => [...all] };
}

interface QueuedDelivery {
  readonly delivery_id: string;
  readonly body: Record<string, unknown>;
  readonly priority: number;
}

interface ClaimCall {
  readonly limit: number | undefined;
  readonly generalCapacity: number | undefined;
  readonly humanReservedCapacity: number | undefined;
  readonly maxClaims: number | undefined;
  readonly requireDeclaredCapacity: boolean | undefined;
}

interface ActiveDeliveryClaim {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly ack_deadline_at: string;
  readonly human_originated: boolean;
}

/**
 * Fake queue that honors the SAME capacity contract as `CauceRepository.claimDeliveries`: the
 * human wins the turn, spends the reserved budget first, and agent-to-agent work can only fill
 * the general budget. Without this the test would exercise the double, not the gateway.
 */
function queuedRepository(options: { beforeClaim?: (call: number) => Promise<void> } = {}): {
  repository: GatewayRepository;
  enqueue: (delivery: QueuedDelivery) => void;
  pending: () => QueuedDelivery[];
  claimCalls: () => ClaimCall[];
  liveClaims: () => ActiveDeliveryClaim[];
  release: (deliveryId: string) => void;
} {
  const repository = fakeRepository();
  const queue: QueuedDelivery[] = [];
  const calls: ClaimCall[] = [];
  const active = new Map<string, ActiveDeliveryClaim>();
  let sequence = 0;

  vi.mocked(repository.claimDeliveries).mockImplementation(async (
    tenantId, alias, _instanceId, epoch, limit, _ackDeadlineMs, _interactiveBurst, admission
  ) => {
    calls.push({
      limit,
      generalCapacity: admission?.generalCapacity,
      humanReservedCapacity: admission?.humanReservedCapacity,
      maxClaims: admission?.maxClaims,
      requireDeclaredCapacity: admission?.requireDeclaredCapacity,
    });
    await options.beforeClaim?.(calls.length);
    const generalCapacity = admission?.generalCapacity ?? limit ?? 20;
    const reservedCapacity = admission?.humanReservedCapacity ?? 0;
    const maxClaims = admission?.maxClaims ?? limit ?? 20;
    const activeHuman = [...active.values()].filter((claim) => claim.human_originated).length;
    const reservedInFlight = Math.min(activeHuman, reservedCapacity);
    let general = Math.max(0, generalCapacity - (active.size - reservedInFlight));
    let reserved = Math.max(0, reservedCapacity - reservedInFlight);
    const claimed: DeliveryClaimRecord[] = [];
    while (claimed.length < maxClaims) {
      const humanIndex = queue.findIndex((item) => item.priority >= HUMAN_PRIORITY_FLOOR);
      const agentIndex = queue.findIndex((item) => item.priority < HUMAN_PRIORITY_FLOOR);
      let index = -1;
      let human = false;
      if (humanIndex >= 0 && (reserved > 0 || general > 0)) {
        index = humanIndex;
        human = true;
      } else if (agentIndex >= 0 && general > 0) {
        index = agentIndex;
      }
      if (index < 0) break;
      const [taken] = queue.splice(index, 1);
      if (!taken) break;
      if (human && reserved > 0) reserved -= 1;
      else general -= 1;
      sequence += 1;
      const claimToken = `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      const ackDeadlineAt = new Date(Date.now() + 600_000).toISOString();
      active.set(taken.delivery_id, {
        delivery_id: taken.delivery_id,
        attempt: 1,
        claim_token: claimToken,
        ack_deadline_at: ackDeadlineAt,
        human_originated: human,
      });
      claimed.push({
        type: 'delivery',
        version: '3.0',
        delivery_id: taken.delivery_id,
        event_id: taken.delivery_id,
        message_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        request_id: `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        trace_id: `trace-${taken.delivery_id}`,
        epoch,
        attempt: 1,
        claim_token: claimToken,
        ack_deadline_at: ackDeadlineAt,
        tenant_id: tenantId,
        room_id: 'grp.pablo',
        actor_alias: 'kant',
        recipient_alias: alias,
        body: taken.body
      });
    }
    return claimed;
  });
  vi.mocked(repository.ackDelivery).mockImplementation(async (deliveryId: string) => {
    active.delete(deliveryId);
    return {
      delivery_id: deliveryId,
      status: 'done' as const,
      applied: true,
      receipt: 'applied' as const,
    };
  });

  return {
    repository,
    enqueue: (delivery) => queue.push(delivery),
    pending: () => [...queue],
    claimCalls: () => [...calls],
    liveClaims: () => [...active.values()],
    release: (deliveryId) => active.delete(deliveryId),
  };
}

function agentBody(text_: string): Record<string, unknown> {
  return { type: 'agent.message', text: text_, from_alias: 'kant' };
}

function humanBody(text_: string): Record<string, unknown> {
  return { text: text_ };
}

function agentDelivery(index: number, text_: string): QueuedDelivery {
  return { delivery_id: deliveryId(index), body: agentBody(text_), priority: 0 };
}

function humanDelivery(
  index: number,
  text_: string,
  body: Record<string, unknown> = humanBody(text_),
): QueuedDelivery {
  return { delivery_id: deliveryId(index), body, priority: HUMAN_PRIORITY_FLOOR };
}

function deliveryId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function connect(port: number, instanceId: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  seen: () => Record<string, unknown>[];
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const reader = frameSession(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: instanceId, capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
  }));
  expect(await reader.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });
  return { socket, next: reader.next, seen: reader.seen };
}

describe('gateway delivery admission control', () => {
  it('claims at most the configured in-flight budget instead of the store default of 20', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 10; index += 1) {
      store.enqueue(agentDelivery(index, `work ${String(index)}`));
    }
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'bounded-consumer');

    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The other eight stay queued: the reserved budget is NOT lent to agent work.
    expect(store.pending()).toHaveLength(8);
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(2);
    expect(store.claimCalls()[0]).toEqual({
      limit: 4, generalCapacity: 2, humanReservedCapacity: 2, maxClaims: 4,
      requireDeclaredCapacity: true,
    });
  });

  it('admits a human message while agent-to-agent work holds every general slot', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 5; index += 1) {
      store.enqueue(agentDelivery(index, `long task ${String(index)}`));
    }
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      },
      // A single general slot: the worst case of the owner's complaint — "the only slot is held
      // by a 40-minute task".
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'busy-assistant');

    expect(await session.next()).toMatchObject({
      type: 'delivery', delivery_id: deliveryId(1), body: { type: 'agent.message' }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The general budget is full and the long task is NOT ACK'd: it keeps running, as it should.
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(1);

    store.enqueue(humanDelivery(99, '¿cómo venís con eso?'));
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });

    expect(await session.next()).toMatchObject({ type: 'wake' });
    // This is the whole point: it enters through the reserved budget, on the same tick, without
    // having cancelled, interrupted, or shortened the agent task still in flight.
    expect(await session.next()).toMatchObject({
      type: 'delivery',
      delivery_id: deliveryId(99),
      body: { text: '¿cómo venís con eso?' }
    });
    expect(store.claimCalls().at(-1)).toEqual({
      limit: 2, generalCapacity: 1, humanReservedCapacity: 1, maxClaims: 2,
      requireDeclaredCapacity: true,
    });
    // The four remaining agent tasks keep waiting their turn: the human did not steal their
    // budget, it used its own.
    expect(store.pending()).toHaveLength(4);
  });

  it('serves a human message before queued agent work when both are waiting', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 4; index += 1) {
      store.enqueue(agentDelivery(index, `chain hop ${String(index)}`));
    }
    store.enqueue(humanDelivery(99, 'hola'));
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'queued-assistant');

    const first = await session.next();
    const second = await session.next();
    // The human message arrived last in the queue and leaves first. Before, it left fifth,
    // behind the whole agent chain — that is why midas had a 114-minute median wait.
    expect([first, second].map((frame) => frame.delivery_id)).toContain(deliveryId(99));
    expect(first.delivery_id).toBe(deliveryId(99));
  });

  it('drains again as soon as a terminal ACK frees an in-flight slot', async () => {
    const store = queuedRepository();
    store.enqueue(agentDelivery(1, 'first'));
    store.enqueue(agentDelivery(2, 'second'));
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      // No external wakes: if the gateway does not drain again on its own when the claim is
      // released, the agent sits idle forever with a full queue. That is the patch's main risk
      // and this test is what covers it.
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'single-slot-consumer');

    const first = await session.next();
    expect(first).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    expect(store.pending()).toHaveLength(1);

    session.socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: '50000000-0000-4000-8000-000000000001',
      delivery_id: deliveryId(1), attempt: 1, claim_token: first.claim_token,
      status: 'done', instance_id: 'single-slot-consumer', epoch: 1
    }));
    expect(await session.next()).toMatchObject({ type: 'ack_result', delivery_id: deliveryId(1) });
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    expect(store.pending()).toHaveLength(0);
  });

  it('does not lose a wake that arrives while a drain is already in flight', async () => {
    let releaseFirstClaim!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    let claimCount = 0;
    const store = queuedRepository({
      beforeClaim: async (call) => {
        claimCount = call;
        if (call === 1) await firstClaimGate;
      }
    });
    store.enqueue(humanDelivery(1, 'primero'));
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      },
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'racing-consumer');

    await vi.waitFor(() => { expect(claimCount).toBe(1); });
    // The wake arrives while a drain is in progress. It used to be discarded with
    // `if (draining) return` — and with a budget, that can be the only signal that work was waiting.
    store.enqueue(humanDelivery(2, 'segundo'));
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstClaim();

    // Without `drainAgain` the second delivery never leaves: no more wakes, no ACK to free
    // budget, and the outbox is at 60 s. That it arrives is the proof that the lost wake was
    // recovered when the in-progress drain finished.
    await vi.waitFor(() => {
      expect(new Set(session.seen()
        .filter((frame) => frame.type === 'delivery')
        .map((frame) => frame.delivery_id)))
        .toEqual(new Set([deliveryId(1), deliveryId(2)]));
    });
    expect(claimCount).toBeGreaterThanOrEqual(2);
  });

  /**
   * The MOST frequent outcome under saturation, and the one that slipped through: an ACK the
   * database resolves as 'retry'. There the delivery belongs to no one — `claim_token`,
   * consumer and deadline all go to NULL — but the gateway kept it in `session.claims` until
   * its `admissionExpiresAtMs` elapsed. With the budget at 1, a single retryable failure left
   * the agent at ZERO BUDGET for half an hour — exactly the failure mode this patch exists to
   * prevent.
   */
  it('frees the in-flight slot when an ACK resolves to retry, not only on terminal states', async () => {
    const store = queuedRepository();
    store.enqueue(agentDelivery(1, 'rate limited'));
    store.enqueue(agentDelivery(2, 'siguiente'));
    vi.mocked(store.repository.ackDelivery).mockImplementation(async (id: string) => {
      store.release(id);
      return {
        delivery_id: id,
        status: 'retry' as const,
        applied: true,
        receipt: 'applied' as const
      };
    });
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const session = await connect(port, 'retrying-consumer');

    const first = await session.next();
    expect(first).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    expect(store.pending()).toHaveLength(1);

    session.socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: '50000000-0000-4000-8000-000000000011',
      delivery_id: deliveryId(1), attempt: 1, claim_token: first.claim_token,
      status: 'failed', retryable: true, instance_id: 'retrying-consumer', epoch: 1
    }));
    expect(await session.next()).toMatchObject({ type: 'ack_result', status: 'retry' });
    // With the budget freed, the next delivery leaves in the same drain. Without the fix this
    // never arrived: `claimDeliveries` was called with limit 0 and the queue stayed frozen.
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(2) });
    expect(store.claimCalls().at(-1)).toEqual({
      limit: 1, generalCapacity: 1, humanReservedCapacity: 0, maxClaims: 1,
      requireDeclaredCapacity: true,
    });
  });

  /**
   * The budget cannot live only in the socket's RAM. With `renewable_delivery_claims_v1` the
   * lease and epoch SURVIVE a reconnect on purpose, so claims remain alive in the database; a
   * `claims: new Map()` on every hello handed the full budget back to the adapter and a flapping
   * consumer took one delivery per reconnect.
   */
  it('rebuilds the in-flight budget from the store instead of handing it back on every reconnect', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 3; index += 1) {
      store.enqueue(agentDelivery(index, `work ${String(index)}`));
    }
    const repository = {
      ...store.repository,
      // Minimal mirror of `CauceRepository.liveDeliveryClaims`: whatever the database still
      // holds with the ACK deadline running for this alias, regardless of which socket claimed it.
      liveDeliveryClaims: vi.fn(async () => store.liveClaims())
    };
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 1, humanReservedDeliveries: 0 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const first = await connect(port, 'flapping-consumer');
    expect(await first.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    // The close handshake ends only once the server answered: the reconnect cannot race it.
    const firstClosed = new Promise<void>((resolve) => { first.socket.once('close', () => { resolve(); }); });
    first.socket.close();
    await firstClosed;

    // Reconnects with the SAME `instance_id`, having ACK'd nothing: the first delivery's
    // claim stays alive on the database side.
    const second = await connect(port, 'flapping-consumer');
    // Frames are serialized: this reply can only be written after the hello's initial drain.
    second.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'flapping-consumer', epoch: 1,
    }));
    expect(await second.next()).toMatchObject({ type: 'heartbeat_ack' });

    expect(second.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(0);
    // The gateway queries again, but PostgreSQL durably subtracts the previous claim and
    // returns zero. The budget no longer depends on the memory of any socket or process.
    expect(store.claimCalls()).toEqual([
      {
        limit: 1, generalCapacity: 1, humanReservedCapacity: 0, maxClaims: 1,
        requireDeclaredCapacity: true,
      },
      {
        limit: 1, generalCapacity: 1, humanReservedCapacity: 0, maxClaims: 1,
        requireDeclaredCapacity: true,
      },
    ]);
    expect(vi.mocked(repository.liveDeliveryClaims)).toHaveBeenCalledTimes(2);
    // Two of three stay queued: reconnecting did not multiply the budget.
    expect(store.pending()).toHaveLength(2);
  });

  it('fails recovery visibly without expiring renewable claims from the acquired epoch', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.liveDeliveryClaims).mockRejectedValueOnce(new Error('database unavailable'));
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    const reader = frameSession(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'recovery-fails', capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));

    expect(await reader.next()).toMatchObject({
      type: 'error', code: 'delivery_unavailable',
      message: 'durable delivery claim recovery is unavailable',
    });
    await expect(closed).resolves.toBe(1011);
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(repository.claimDeliveries).not.toHaveBeenCalled();
  });

  it('closes a consumer whose durable capacity declaration is missing instead of leaving a false-green hello', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockRejectedValueOnce(new StoreError(
      'conflict', 'delivery consumer is missing its durable agent capacity',
    ));
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    const reader = frameSession(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => { resolve({ code, reason: reason.toString('utf8') }); });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'undeclared-consumer',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));

    expect(await reader.next()).toEqual({
      type: 'error', code: 'consumer_not_declared',
      message: 'consumer has no valid durable delivery capacity declaration',
    });
    await expect(closed).resolves.toEqual({ code: 4403, reason: 'consumer not declared' });
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(repository.claimDeliveries).not.toHaveBeenCalled();
  });

  it('rejects HTTP hello atomically without creating a lease when durable capacity is missing', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockRejectedValueOnce(new StoreError(
      'conflict', 'delivery consumer is missing its durable agent capacity',
    ));
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/v3/connections/hello',
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
      payload: {
        type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
        instance_id: 'undeclared-http-consumer', capabilities: ['acks.v3'],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'conflict', message: 'delivery consumer is missing its durable agent capacity',
    });
    expect(repository.acquireLease).toHaveBeenCalledWith(
      'Pablo', 'midas', 'undeclared-http-consumer', ['acks.v3'], 180_000,
      { requireDeclaredCapacity: true, requireEnabledAgent: true },
    );
    expect(repository.releaseLease).not.toHaveBeenCalled();
    expect(response.body).not.toContain('connection_token');
  });

  it('lets only the newest simultaneous resume install the local session', async () => {
    const repository = fakeRepository();
    let releaseFirstRecovery!: () => void;
    const firstRecoveryGate = new Promise<void>((resolve) => { releaseFirstRecovery = resolve; });
    let firstRecoveryStarted!: () => void;
    const firstRecoveryObserved = new Promise<void>((resolve) => { firstRecoveryStarted = resolve; });
    let recoveryCalls = 0;
    vi.mocked(repository.liveDeliveryClaims).mockImplementation(async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        firstRecoveryStarted();
        await firstRecoveryGate;
      }
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(firstSocket);
    const firstReader = frameSession(firstSocket);
    const firstClosed = new Promise<number>((resolve) => {
      firstSocket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      firstSocket.once('open', resolve);
      firstSocket.once('error', reject);
    });
    const hello = {
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'simultaneous-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    };
    firstSocket.send(JSON.stringify(hello));
    await firstRecoveryObserved;

    const current = await connect(port, 'simultaneous-resume');
    releaseFirstRecovery();
    expect(await firstReader.next()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(firstClosed).resolves.toBe(4401);

    current.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'simultaneous-resume', epoch: 1,
    }));
    expect(await current.next()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledTimes(4);
  });

  it('fences an older acquire response that arrives after a newer resume', async () => {
    const repository = fakeRepository();
    let releaseFirstAcquire!: () => void;
    const firstAcquireGate = new Promise<void>((resolve) => { releaseFirstAcquire = resolve; });
    let firstAcquireStarted!: () => void;
    const firstAcquireObserved = new Promise<void>((resolve) => { firstAcquireStarted = resolve; });
    let acquireCalls = 0;
    let currentToken = '';
    vi.mocked(repository.acquireLease).mockImplementation(async () => {
      acquireCalls += 1;
      const token = acquireCalls === 1
        ? '91000000-0000-4000-8000-000000000001'
        : '91000000-0000-4000-8000-000000000002';
      currentToken = token;
      if (acquireCalls === 1) {
        firstAcquireStarted();
        await firstAcquireGate;
      }
      return {
        acquired: true, epoch: 1, connection_token: token,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    vi.mocked(repository.heartbeat).mockImplementation(async (
      _tenant, _alias, _instance, _epoch, _ttl, token,
    ) => {
      if (token !== currentToken) throw new StoreError('fenced', 'stale connection token');
      return new Date(Date.now() + 60_000).toISOString();
    });
    let releaseCurrentRecovery!: () => void;
    const currentRecoveryGate = new Promise<void>((resolve) => { releaseCurrentRecovery = resolve; });
    let currentRecoveryStarted!: () => void;
    const currentRecoveryObserved = new Promise<void>((resolve) => { currentRecoveryStarted = resolve; });
    vi.mocked(repository.liveDeliveryClaims).mockImplementationOnce(async () => {
      currentRecoveryStarted();
      await currentRecoveryGate;
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(firstSocket);
    const firstReader = frameSession(firstSocket);
    const firstClosed = new Promise<number>((resolve) => {
      firstSocket.once('close', (code) => { resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      firstSocket.once('open', resolve);
      firstSocket.once('error', reject);
    });
    firstSocket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'capacity-race-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await firstAcquireObserved;

    const currentSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(currentSocket);
    const currentReader = frameSession(currentSocket);
    await new Promise<void>((resolve, reject) => {
      currentSocket.once('open', resolve);
      currentSocket.once('error', reject);
    });
    currentSocket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'capacity-race-resume',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await currentRecoveryObserved;

    releaseFirstAcquire();
    expect(await firstReader.next()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(firstClosed).resolves.toBe(4401);
    releaseCurrentRecovery();
    expect(await currentReader.next()).toMatchObject({ type: 'hello_ack', epoch: 1 });

    currentSocket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'capacity-race-resume', epoch: 1,
    }));
    expect(await currentReader.next()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledTimes(4);
  });

  it('preserves a renewable lease and its claims when the socket closes during rehydration', async () => {
    const repository = fakeRepository();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let recoveryStarted!: () => void;
    const recoveryObserved = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    let calls = 0;
    vi.mocked(repository.liveDeliveryClaims).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        recoveryStarted();
        await recoveryGate;
      }
      return [];
    });
    const app = await buildGateway({
      pool: fakePool(), repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      outboxPollMs: 60_000,
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'closed-during-recovery',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1'],
    }));
    await recoveryObserved;
    const closed = new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
    socket.close();
    await closed;
    releaseRecovery();

    const replacement = await connect(port, 'closed-during-recovery');
    replacement.socket.send(JSON.stringify({
      type: 'heartbeat', instance_id: 'closed-during-recovery', epoch: 1,
    }));
    expect(await replacement.next()).toMatchObject({ type: 'heartbeat_ack' });
    // The heartbeat is the barrier: the abandoned hello finished, and the only claim is this one's.
    expect(repository.claimDeliveries).toHaveBeenCalledTimes(1);
    expect(repository.releaseLease).not.toHaveBeenCalled();
  });

  it('caps a client-chosen HTTP claim limit at the configured budget', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 40; index += 1) {
      store.enqueue(agentDelivery(index, `bulk ${String(index)}`));
    }
    const app = await buildGateway({
      pool: fakePool(),
      repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-consumer', epoch: 3, limit: 100,
        connection_token: HTTP_CONNECTION_TOKEN,
      },
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ deliveries: DeliveryClaimRecord[] }>();
    // Without a cap, a single POST emptied 20 deliveries at once: the same suicidal batch the drain caused.
    expect(body.deliveries).toHaveLength(2);
    expect(store.claimCalls()[0]).toEqual({
      limit: 4, generalCapacity: 2, humanReservedCapacity: 2, maxClaims: 4,
      requireDeclaredCapacity: true,
    });
  });

  it('shares one durable budget across repeated stateless HTTP polls', async () => {
    const store = queuedRepository();
    for (let index = 1; index <= 6; index += 1) store.enqueue(agentDelivery(index, `poll ${String(index)}`));
    const app = await buildGateway({
      pool: fakePool(), repository: store.repository,
      authProvider: DevOnlyAuthProvider.forTests(), deliveryWakeSubscriber: noDeliveryWakes,
      admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 1 },
      ackDeadlineMs: 600_000, outboxPollMs: 60_000,
    });
    apps.push(app);

    const query = () => app.inject({
      method: 'POST', url: '/v3/deliveries/query',
      payload: {
        instance_id: 'http-repeat', epoch: 3, limit: 100,
        connection_token: HTTP_CONNECTION_TOKEN,
      },
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' },
    });
    const first = await query();
    const second = await query();

    expect(first.json<{ deliveries: DeliveryClaimRecord[] }>().deliveries).toHaveLength(2);
    expect(second.json<{ deliveries: DeliveryClaimRecord[] }>().deliveries).toHaveLength(0);
    expect(store.pending()).toHaveLength(4);
  });
});
