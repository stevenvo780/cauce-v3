import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { fakePool, noDeliveryWakes } from './helpers.js';
import {
  agentDelivery, apps, connect, deliveryId, humanDelivery, queuedRepository,
  registerDeliveryAdmissionTeardown,
} from './delivery-admission-helpers.js';

registerDeliveryAdmissionTeardown();

/** Admission control, in-flight delivery caps and interactive-budget reservation for operators. */

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
  });});
