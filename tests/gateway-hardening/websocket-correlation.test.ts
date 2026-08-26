/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { buildGateway, type DeliveryClaimRecord } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { fakePool, fakeRepository, ids, noDeliveryWakes } from './helpers.js';

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function frameReader(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('message', (data) => {
    const decoded = JSON.parse(text(data)) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(decoded);
    else queued.push(decoded);
  });
  return async () => {
    const existing = queued.shift();
    if (existing) return existing;
    return new Promise((resolve) => waiting.push(resolve));
  };
}

describe('gateway WebSocket ACK correlation', () => {
  it('serializes frames and correlates out-of-order delivery ACKs by event_id', async () => {
    const repository = fakeRepository();
    const claims: DeliveryClaimRecord[] = [
      {
        type: 'delivery', delivery_id: ids.delivery, event_id: ids.delivery, attempt: 1, claim_token: ids.claim,
        version: '3.0', message_id: ids.message, request_id: ids.request, trace_id: 'trace-a', epoch: 1,
        ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Steven',
        room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'midas', body: { text: 'a' }
      },
      {
        type: 'delivery', delivery_id: ids.deliveryTwo, event_id: ids.deliveryTwo, attempt: 1, claim_token: ids.claimTwo,
        version: '3.0', message_id: ids.message, request_id: ids.request, trace_id: 'trace-b', epoch: 1,
        ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Steven',
        room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'midas', body: { text: 'b' }
      }
    ];
    vi.mocked(repository.claimDeliveries).mockResolvedValueOnce(claims).mockResolvedValue([]);
    vi.mocked(repository.ackDelivery).mockImplementation(async (deliveryId) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        delivery_id: deliveryId,
        status: 'done',
        applied: true,
        receipt: 'applied',
      };
    });
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(socket);
    const nextFrame = frameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'serial-consumer', capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });
    expect(repository.acquireLease).toHaveBeenCalledWith(
      'Pablo',
      'midas',
      'serial-consumer',
      ['acks.v3', 'renewable_delivery_claims_v1'],
      30_000,
      { resume: true, resumeWindowMs: 600_000, requireDeclaredCapacity: true }
    );
    const delivered = [await nextFrame(), await nextFrame()];
    expect(delivered.map((item) => item.delivery_id)).toEqual([ids.delivery, ids.deliveryTwo]);

    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.eventTwo, delivery_id: ids.deliveryTwo,
      attempt: 1, claim_token: ids.claimTwo, status: 'done', instance_id: 'serial-consumer', epoch: 1
    }));
    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', instance_id: 'serial-consumer', epoch: 1
    }));
    const results = [await nextFrame(), await nextFrame()];

    expect(results).toEqual([
      expect.objectContaining({
        type: 'ack_result',
        delivery_id: ids.deliveryTwo,
        event_id: ids.eventTwo,
        claim_token: ids.claimTwo,
        receipt: 'applied'
      }),
      expect.objectContaining({
        type: 'ack_result',
        delivery_id: ids.delivery,
        event_id: ids.event,
        claim_token: ids.claim,
        receipt: 'applied'
      })
    ]);
    expect(vi.mocked(repository.ackDelivery).mock.calls.map((call) => call[0]))
      .toEqual([ids.deliveryTwo, ids.delivery]);
    expect(vi.mocked(repository.ackDelivery).mock.calls.map((call) => call[4]))
      .toEqual([600_000, 600_000]);
    // Ya no se llama con `undefined` en la posición de `limit` (que se comía el default 20 del
    // store): el primer drain de la sesión pide exactamente el presupuesto vacío.
    expect(repository.claimDeliveries).toHaveBeenNthCalledWith(
      1, 'Pablo', 'midas', 'serial-consumer', 1, 4, 600_000, undefined,
      {
        generalCapacity: 2, humanReservedCapacity: 2, maxClaims: 4,
        requireDeclaredCapacity: true,
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.any(AbortSignal),
    );
    // Tres drains y no uno: el del hello, y uno por cada ACK terminal. Cada ACK terminal libera un
    // cupo de agents.max_concurrent_deliveries y es el único instante en que el agente vuelve a
    // tener lugar; si el gateway no reclamara ahí, la cola se quedaría quieta.
    expect(vi.mocked(repository.claimDeliveries).mock.calls).toHaveLength(3);
  });

  it('keeps renewable leases across transient closes while preserving legacy release behavior', async () => {
    const repository = fakeRepository();
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(socket);
    const nextFrame = frameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'durable-consumer', capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close(1000, 'transient disconnect');
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(repository.releaseLease).not.toHaveBeenCalled();

    const legacySocket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(legacySocket);
    const nextLegacyFrame = frameReader(legacySocket);
    await new Promise<void>((resolve, reject) => {
      legacySocket.once('open', resolve);
      legacySocket.once('error', reject);
    });
    legacySocket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'legacy-consumer', capabilities: ['acks.v3']
    }));
    expect(await nextLegacyFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });
    const legacyClosed = new Promise<void>((resolve) => legacySocket.once('close', () => resolve()));
    legacySocket.close(1000, 'legacy disconnect');
    await legacyClosed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repository.releaseLease).toHaveBeenCalledWith(
      'Pablo', 'midas', 'legacy-consumer', 1, expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
  });

  it('waits for an in-flight legacy ACK before releasing its lease on close', async () => {
    const repository = fakeRepository();
    const claim: DeliveryClaimRecord = {
      type: 'delivery',
      delivery_id: ids.delivery,
      event_id: ids.delivery,
      attempt: 1,
      claim_token: ids.claim,
      version: '3.0',
      message_id: ids.message,
      request_id: ids.request,
      trace_id: 'trace-legacy-close-race',
      epoch: 1,
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
      tenant_id: 'Steven',
      room_id: 'grp.steven',
      actor_alias: 'kant',
      recipient_alias: 'midas',
      body: { text: 'legacy close race' }
    };
    vi.mocked(repository.claimDeliveries).mockResolvedValueOnce([claim]).mockResolvedValue([]);
    let markAckEntered!: () => void;
    const ackEntered = new Promise<void>((resolve) => {
      markAckEntered = resolve;
    });
    let finishAck!: () => void;
    const ackGate = new Promise<void>((resolve) => {
      finishAck = resolve;
    });
    vi.mocked(repository.ackDelivery).mockImplementation(async (deliveryId) => {
      markAckEntered();
      await ackGate;
      return {
        delivery_id: deliveryId,
        status: 'done',
        applied: true,
        receipt: 'applied'
      };
    });
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(socket);
    const nextFrame = frameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello',
      version: '3.0',
      tenant_id: 'Pablo',
      alias: 'midas',
      instance_id: 'legacy-consumer',
      capabilities: ['acks.v3']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });
    expect(await nextFrame()).toMatchObject({
      type: 'delivery',
      delivery_id: ids.delivery,
      attempt: 1,
      claim_token: ids.claim
    });

    socket.send(JSON.stringify({
      type: 'ack',
      version: '3.0',
      event_id: ids.event,
      delivery_id: ids.delivery,
      attempt: 1,
      claim_token: ids.claim,
      status: 'done',
      instance_id: 'legacy-consumer',
      epoch: 1
    }));
    await ackEntered;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close(1000, 'legacy disconnect');
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));

    try {
      expect(repository.releaseLease).not.toHaveBeenCalled();
    } finally {
      finishAck();
    }
    await vi.waitFor(() => {
      expect(repository.releaseLease).toHaveBeenCalledTimes(1);
      expect(repository.releaseLease).toHaveBeenCalledWith(
        'Pablo', 'midas', 'legacy-consumer', 1, expect.stringMatching(/^[0-9a-f-]{36}$/u),
      );
    });
  });

  it('replays an exact renewal after reconnect while fencing an unknown legacy claim', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.ackDelivery).mockImplementation(async (deliveryId) => ({
      delivery_id: deliveryId,
      status: 'started',
      applied: true,
      receipt: 'applied'
    }));
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      ackDeadlineMs: 600_000,
      deliveryLeaseCap: { leaseCapMs: 7_200_000, leaseCapGraceMs: 600_000 },
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const connect = async (capabilities: string[]): Promise<{
      socket: WebSocket;
      nextFrame: () => Promise<Record<string, unknown>>;
    }> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
        headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
      });
      sockets.push(socket);
      const nextFrame = frameReader(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({
        type: 'hello',
        version: '3.0',
        tenant_id: 'Pablo',
        alias: 'midas',
        instance_id: 'durable-consumer',
        capabilities
      }));
      expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });
      return { socket, nextFrame };
    };
    const disconnect = async (socket: WebSocket): Promise<void> => {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.close(1000, 'transient disconnect');
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const initial = await connect(['acks.v3', 'renewable_delivery_claims_v1']);
    await disconnect(initial.socket);

    const resumed = await connect(['acks.v3', 'renewable_delivery_claims_v1']);
    resumed.socket.send(JSON.stringify({
      type: 'ack',
      version: '3.0',
      event_id: ids.event,
      delivery_id: ids.delivery,
      attempt: 1,
      claim_token: ids.claim,
      status: 'started',
      instance_id: 'durable-consumer',
      epoch: 1
    }));
    expect(await resumed.nextFrame()).toEqual({
      type: 'ack_result',
      event_id: ids.event,
      delivery_id: ids.delivery,
      attempt: 1,
      claim_token: ids.claim,
      status: 'started',
      applied: true,
      receipt: 'applied'
    });
    expect(repository.ackDelivery).toHaveBeenCalledWith(
      ids.delivery,
      'Pablo',
      'midas',
      expect.objectContaining({
        event_id: ids.event,
        attempt: 1,
        claim_token: ids.claim,
        status: 'started',
        instance_id: 'durable-consumer',
        epoch: 1
      }),
      600_000,
      // Una renovacion tras reconectar tiene que llevar el techo igual que la primera: es
      // justo el camino por el que una entrega se volvia inmortal.
      { leaseCapMs: 7_200_000, leaseCapGraceMs: 600_000 }
    );
    await disconnect(resumed.socket);

    const legacy = await connect(['acks.v3']);
    const legacyClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      legacy.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });
    legacy.socket.send(JSON.stringify({
      type: 'ack',
      version: '3.0',
      event_id: ids.eventTwo,
      delivery_id: ids.deliveryTwo,
      attempt: 1,
      claim_token: ids.claimTwo,
      status: 'started',
      instance_id: 'durable-consumer',
      epoch: 1
    }));
    expect(await legacy.nextFrame()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(legacyClosed).resolves.toEqual({ code: 4401, reason: 'fenced' });
    expect(repository.ackDelivery).toHaveBeenCalledTimes(1);
  });

  it('correlates an ACK from an older epoch of the same instance without fencing the live session', async () => {
    const repository = fakeRepository();
    const feedback = {
      delegation_rejections: [{
        output_index: 1,
        target: 'missing_peer',
        code: 'unroutable_alias' as const,
        reason: 'The requested target is not routable.',
        guidance: 'Choose a target advertised by the trusted routing inventory.',
      }],
      delegation_materializations: [{
        output_index: 0,
        target_tenant: 'Steven' as const,
        target_alias: 'socrates',
        child_delivery_id: '72000000-0000-4000-8000-000000000001',
      }, {
        output_index: 2,
        target_tenant: 'Steven' as const,
        target_alias: 'socrates',
        child_delivery_id: '72000000-0000-4000-8000-000000000002',
      }],
    };
    vi.mocked(repository.ackDelivery).mockResolvedValue({
      delivery_id: ids.delivery,
      status: 'done',
      applied: false,
      receipt: 'duplicate',
      ...feedback,
    });
    vi.mocked(repository.acquireLease).mockResolvedValue({
      acquired: true,
      epoch: 2,
      connection_token: '90000000-0000-4000-8000-000000000002',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString()
    });
    const currentClaim: DeliveryClaimRecord = {
      type: 'delivery', delivery_id: ids.delivery, event_id: ids.delivery, attempt: 2, claim_token: ids.claimTwo,
      version: '3.0', message_id: ids.message, request_id: ids.request, trace_id: 'trace-current', epoch: 2,
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Steven',
      room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'midas', body: { text: 'current' }
    };
    const nextClaim: DeliveryClaimRecord = {
      type: 'delivery', delivery_id: ids.deliveryTwo, event_id: ids.deliveryTwo, attempt: 1, claim_token: ids.claim,
      version: '3.0', message_id: ids.message, request_id: ids.request, trace_id: 'trace-next', epoch: 2,
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Steven',
      room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'midas', body: { text: 'next' }
    };
    vi.mocked(repository.claimDeliveries)
      .mockResolvedValueOnce([currentClaim])
      .mockResolvedValueOnce([nextClaim])
      .mockResolvedValue([]);
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const app = await buildGateway({
      pool: fakePool(),
      repository,
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      },
      ackDeadlineMs: 600_000,
      outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(socket);
    const nextFrame = frameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'durable-consumer',
      capabilities: ['acks.v3', 'renewable_delivery_claims_v1', 'delegation_feedback_v1']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 2 });
    expect(await nextFrame()).toMatchObject({
      type: 'delivery', delivery_id: ids.delivery, attempt: 2, claim_token: ids.claimTwo
    });

    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', instance_id: 'durable-consumer', epoch: 1
    }));
    expect(await nextFrame()).toEqual({
      type: 'ack_result', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', applied: false,
      receipt: 'duplicate',
      ...feedback,
    });
    expect(repository.ackDelivery).toHaveBeenCalledWith(
      ids.delivery,
      'Pablo',
      'midas',
      expect.objectContaining({
        event_id: ids.event,
        attempt: 1,
        claim_token: ids.claim,
        status: 'done',
        instance_id: 'durable-consumer',
        epoch: 1,
      }),
      600_000,
      expect.any(Object),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.send(JSON.stringify({ type: 'heartbeat', instance_id: 'durable-consumer', epoch: 2 }));
    expect(await nextFrame()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledWith(
      'Pablo', 'midas', 'durable-consumer', 2, 30_000,
      '90000000-0000-4000-8000-000000000002', expect.any(AbortSignal),
    );

    expect(wake).toBeTypeOf('function');
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });
    expect(await nextFrame()).toMatchObject({ type: 'wake', alias: 'midas' });
    expect(await nextFrame()).toMatchObject({ type: 'delivery', delivery_id: ids.deliveryTwo, epoch: 2 });
    expect(repository.claimDeliveries).toHaveBeenCalledTimes(2);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    ['another instance', 'other-consumer', 1, ids.claim, false],
    ['a future epoch', 'durable-consumer', 3, ids.claim, false],
    ['an invalid current claim', 'durable-consumer', 2, ids.claimTwo, true]
  ] as const)('continues to fence an ACK from %s', async (_case, instanceId, epoch, claimToken, hasCurrentClaim) => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockResolvedValue({
      acquired: true,
      epoch: 2,
      connection_token: '90000000-0000-4000-8000-000000000002',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString()
    });
    if (hasCurrentClaim) {
      vi.mocked(repository.claimDeliveries).mockResolvedValueOnce([{
        type: 'delivery', delivery_id: ids.delivery, event_id: ids.delivery, attempt: 1, claim_token: ids.claim,
        version: '3.0', message_id: ids.message, request_id: ids.request, trace_id: 'trace-current', epoch: 2,
        ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Steven',
        room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'midas', body: { text: 'current' }
      }]);
    }
    const app = await buildGateway({
      pool: fakePool(), repository, authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes, outboxPollMs: 60_000
    });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v3/ws`, {
      headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
    });
    sockets.push(socket);
    const nextFrame = frameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
      instance_id: 'durable-consumer', capabilities: ['acks.v3']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 2 });
    if (hasCurrentClaim) expect(await nextFrame()).toMatchObject({ type: 'delivery', delivery_id: ids.delivery });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });

    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: claimToken, status: 'done', instance_id: instanceId, epoch
    }));
    expect(await nextFrame()).toMatchObject({ type: 'error', code: 'fenced' });
    await expect(closed).resolves.toEqual({ code: 4401, reason: 'fenced' });
    expect(repository.ackDelivery).not.toHaveBeenCalled();
  });
});
