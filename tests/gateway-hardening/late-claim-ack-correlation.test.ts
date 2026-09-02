/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { StoreError } from '@cauce/store';
import { buildGateway, type DeliveryClaimRecord } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, frameReader, ids, noDeliveryWakes
} from './helpers.js';

// A late ACK is not an intruder: it is the result of a run this same socket delivered. The gateway
// correlates it against the attempt it remembers and lets the store decide, instead of closing the
// connection of an agent that is still working on the retry.

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
});

async function frameMatching(
  next: () => Promise<Record<string, unknown>>,
  matches: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frame = await next();
    if (matches(frame)) return frame;
  }
  throw new Error('expected frame never arrived');
}

function claim(attempt: number, claimToken: string, deadlineMs: number): DeliveryClaimRecord {
  return {
    type: 'delivery', delivery_id: ids.delivery, event_id: ids.delivery, attempt,
    claim_token: claimToken, version: '3.0', message_id: ids.message, request_id: ids.request,
    trace_id: 'trace-late-ack', epoch: 1,
    ack_deadline_at: new Date(Date.now() + deadlineMs).toISOString(), tenant_id: 'Pablo',
    room_id: 'grp.pablo', actor_alias: 'seneca', recipient_alias: 'midas', body: { text: 'work' }
  };
}

async function connect(
  repository: ReturnType<typeof fakeRepository>,
  overrides: Record<string, unknown> = {},
): Promise<{ socket: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    ackDeadlineMs: 600_000,
    outboxPollMs: 60_000,
    ...overrides
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const next = frameReader(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: 'midas-1', capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
  }));
  expect(await next()).toMatchObject({ type: 'hello_ack' });
  return { socket, next };
}

describe('a late ACK of a re-claimed delivery', () => {
  it('still correlates after the same socket claimed the next attempt', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries)
      .mockResolvedValueOnce([claim(1, ids.claim, 60)])
      .mockResolvedValueOnce([claim(2, ids.claimTwo, 30_000)])
      .mockResolvedValue([]);
    vi.mocked(repository.ackDelivery).mockResolvedValue({
      delivery_id: ids.delivery, status: 'leased', applied: false, receipt: 'ownership_lost'
    });
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;

    const { socket, next } = await connect(repository, {
      deliveryWakeSubscriber: async (_pool: unknown, listener: typeof wake) => {
        wake = listener;
        return async () => undefined;
      }
    });
    expect(await next()).toMatchObject({ type: 'delivery', attempt: 1, claim_token: ids.claim });

    // The claim of attempt 1 expires: the reaper retried it and the same adapter takes it again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wake).toBeTypeOf('function');
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });
    expect(await frameMatching(next, (frame) => frame.type === 'delivery')).toMatchObject({
      delivery_id: ids.delivery, attempt: 2, claim_token: ids.claimTwo
    });

    // The result of attempt 1 arrives now, under the very same epoch.
    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', instance_id: 'midas-1', epoch: 1,
      retryable: false
    }));

    expect(await next()).toEqual({
      type: 'ack_result', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'leased', applied: false,
      receipt: 'ownership_lost'
    });
    // The durable authority saw the result: the gateway did not fence it out of RAM.
    expect(repository.ackDelivery).toHaveBeenCalledWith(
      ids.delivery, 'Pablo', 'midas',
      expect.objectContaining({ attempt: 1, claim_token: ids.claim, status: 'done' }),
      600_000, expect.any(Object),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('answers a store fence with a correlated receipt instead of closing the socket', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries)
      .mockResolvedValueOnce([claim(1, ids.claim, 30_000)])
      .mockResolvedValue([]);
    vi.mocked(repository.ackDelivery).mockRejectedValue(
      new StoreError('fenced', 'ACK identity does not own this delivery claim')
    );

    const { socket, next } = await connect(repository);
    expect(await next()).toMatchObject({ type: 'delivery', attempt: 1, claim_token: ids.claim });

    socket.send(JSON.stringify({
      type: 'ack', version: '3.0', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', instance_id: 'midas-1', epoch: 1,
      retryable: false
    }));

    expect(await next()).toEqual({
      type: 'ack_result', event_id: ids.event, delivery_id: ids.delivery,
      attempt: 1, claim_token: ids.claim, status: 'done', applied: false,
      receipt: 'ownership_lost'
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
