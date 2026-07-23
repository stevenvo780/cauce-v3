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
      return { delivery_id: deliveryId, status: 'done', applied: true };
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
      instance_id: 'serial-consumer', capabilities: ['acks.v3']
    }));
    expect(await nextFrame()).toMatchObject({ type: 'hello_ack', epoch: 1 });
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
      expect.objectContaining({ type: 'ack_result', delivery_id: ids.deliveryTwo, event_id: ids.eventTwo, claim_token: ids.claimTwo }),
      expect.objectContaining({ type: 'ack_result', delivery_id: ids.delivery, event_id: ids.event, claim_token: ids.claim })
    ]);
    expect(vi.mocked(repository.ackDelivery).mock.calls.map((call) => call[0]))
      .toEqual([ids.deliveryTwo, ids.delivery]);
    expect(repository.claimDeliveries).toHaveBeenCalledWith(
      'Pablo', 'midas', 'serial-consumer', 1, undefined, 600_000
    );
  });

  it('correlates an ACK from an older epoch of the same instance without fencing the live session', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.acquireLease).mockResolvedValue({
      acquired: true,
      epoch: 2,
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
      instance_id: 'durable-consumer', capabilities: ['acks.v3']
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
      attempt: 1, claim_token: ids.claim, status: 'done', applied: false
    });
    expect(repository.ackDelivery).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.send(JSON.stringify({ type: 'heartbeat', instance_id: 'durable-consumer', epoch: 2 }));
    expect(await nextFrame()).toMatchObject({ type: 'heartbeat_ack' });
    expect(repository.heartbeat).toHaveBeenCalledWith('Pablo', 'midas', 'durable-consumer', 2, 30_000);

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
