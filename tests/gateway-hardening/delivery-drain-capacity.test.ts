/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreError } from '@cauce/store';
import { WebSocket } from 'ws';
import { buildGateway, type DeliveryClaimRecord } from '../../services/gateway/src/index.js';
import { recordChatLatency } from '../../services/gateway/src/routes/core/outbox.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES
} from '../../services/gateway/src/config.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, frameReader, ids, noDeliveryWakes
} from './helpers.js';

// The risk the concurrency cap introduces, in isolation.
//
// With a cap, a drain may come back empty because the agent is full. From there the backlog only
// moves if the gateway reclaims when capacity is freed. The only instant that happens is an ACK
// that takes the delivery out of the non-terminal set. Before this change the gateway only
// drained after a 'retry' ACK: with a cap, that leaves a queue of 90 waiting for someone to
// publish the 91st.

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, sockets);
  vi.restoreAllMocks();
});

function claim(deliveryId: string, claimToken: string): DeliveryClaimRecord {
  return {
    type: 'delivery', delivery_id: deliveryId, event_id: deliveryId, attempt: 1,
    claim_token: claimToken, version: '3.0', message_id: ids.message, request_id: ids.request,
    trace_id: 'trace-capacity', epoch: 1,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(), tenant_id: 'Pablo',
    room_id: 'grp.pablo', actor_alias: 'seneca', recipient_alias: 'midas', body: { text: 'work' }
  };
}

async function connect(
  repository: ReturnType<typeof fakeRepository>,
  overrides: Record<string, unknown> = {},
  observe?: (app: Awaited<ReturnType<typeof buildGateway>>) => void,
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
  observe?.(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': 'Pablo', 'x-cauce-alias': 'midas' }
  });
  sockets.push(socket);
  const next = frameReader(socket);
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
    instance_id: 'midas-1', capabilities: []
  }));
  const ack = await next();
  expect(ack.type).toBe('hello_ack');
  return { socket, next };
}

describe('drain keeps moving when capacity is what gates the claim', () => {
  it('claims again after a terminal ACK, not only after a retry', async () => {
    // The hard jam: the agent was full, finishes its work, and nobody asks again.
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries)
      .mockResolvedValueOnce([claim(ids.delivery, ids.claim)])   // drain del hello: llena el cupo
      .mockResolvedValueOnce([claim(ids.deliveryTwo, ids.claimTwo)]) // drain tras el ACK terminal
      .mockResolvedValue([]);
    vi.mocked(repository.ackDelivery).mockResolvedValue({
      delivery_id: ids.delivery, status: 'done', applied: true, receipt: 'applied'
    });

    const { socket, next } = await connect(repository);
    const first = await next();
    expect(first.delivery_id).toBe(ids.delivery);

    socket.send(JSON.stringify({
      type: 'ack', delivery_id: ids.delivery, version: '3.0', event_id: ids.event,
      status: 'done', instance_id: 'midas-1', epoch: 1, claim_token: ids.claim,
      attempt: 1, retryable: false
    }));

    const ackResult = await next();
    expect(ackResult.type).toBe('ack_result');
    // Without the terminal-state re-drain this never arrives and the test dies by timeout.
    const second = await next();
    expect(second.type).toBe('delivery');
    expect(second.delivery_id).toBe(ids.deliveryTwo);
  });

  it.each(['failed', 'dead'] as const)(
    'also claims again after a %s ACK, which frees the slot just the same',
    async (status) => {
      const repository = fakeRepository();
      vi.mocked(repository.claimDeliveries)
        .mockResolvedValueOnce([claim(ids.delivery, ids.claim)])
        .mockResolvedValueOnce([claim(ids.deliveryTwo, ids.claimTwo)])
        .mockResolvedValue([]);
      vi.mocked(repository.ackDelivery).mockResolvedValue({
        delivery_id: ids.delivery, status, applied: true, receipt: 'applied'
      });

      const { socket, next } = await connect(repository);
      await next();
      socket.send(JSON.stringify({
        type: 'ack', delivery_id: ids.delivery, version: '3.0', event_id: ids.event,
        status: 'failed', instance_id: 'midas-1', epoch: 1, claim_token: ids.claim,
        attempt: 1, retryable: false, error: 'boom'
      }));
      await next();
      const second = await next();
      expect(second.delivery_id).toBe(ids.deliveryTwo);
    }
  );

  it('coalesces a wake that lands while a drain is already in flight', async () => {
    // The second hole, and the only way two drains actually overlap: socket frames are serialized
    // by frameQueue, but the pg_notify handler calls drain() outside that queue. The old
    // implementation discarded that drain via the `draining` flag. It was tolerable because the
    // in-flight drain claimed up to 20 and emptied the queue anyway; with a cap, the discarded
    // drain can be exactly the one looking for work with the freshly freed budget.
    const repository = fakeRepository();
    let wake: ((notice: { tenant_id: string; alias: string }) => void) | undefined;
    const subscriber: NonNullable<Parameters<typeof buildGateway>[0]['deliveryWakeSubscriber']> =
      async (_pool, listener) => {
        wake = listener;
        return async () => undefined;
      };

    let release: (() => void) | undefined;
    const firstClaimStarted = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.mocked(repository.claimDeliveries).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [];
      }
      if (calls === 2) return [claim(ids.deliveryTwo, ids.claimTwo)];
      return [];
    });

    const { next } = await connect(repository, { deliveryWakeSubscriber: subscriber });
    await firstClaimStarted;
    // Arrives while the first claim is still in flight.
    wake?.({ tenant_id: 'Pablo', alias: 'midas' });

    const frames: Record<string, unknown>[] = [];
    for (let index = 0; index < 2; index += 1) frames.push(await next());
    // The 'wake' frame always goes out; the 'delivery' only if the overlapping drain was not lost.
    expect(frames.map((frame) => frame.type)).toContain('delivery');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  // The gateway always passes an explicit batch size and durable capacities.
  it('asks the store for an explicit batch size instead of leaving it undefined', async () => {
    // Generous budget on purpose: the binding constraint is the batch, so the explicit cap is visible.
    const repository = fakeRepository();
    await connect(repository, {
      deliveryClaimLimit: 4,
      admission: { maxInflightDeliveries: 10, humanReservedDeliveries: 0 }
    });
    expect(vi.mocked(repository.claimDeliveries)).toHaveBeenCalledWith(
      'Pablo', 'midas', 'midas-1', 1, 4, 600_000, undefined,
      {
        generalCapacity: 10, humanReservedCapacity: 0, maxClaims: 4,
        requireDeclaredCapacity: true,
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/u), expect.any(AbortSignal),
    );
  });

  it('defaults the batch size to a real number rather than undefined', async () => {
    const repository = fakeRepository();
    await connect(repository);
    const firstCall = vi.mocked(repository.claimDeliveries).mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('Expected claimDeliveries to be called');
    const [, , , , limit, , , admission] = firstCall;
    // With the defaults the batch equals the total capacity (2 general + 2 human).
    expect(limit).toBe(DEFAULT_MAX_INFLIGHT_DELIVERIES + DEFAULT_HUMAN_RESERVED_DELIVERIES);
    expect(admission).toEqual({
      generalCapacity: DEFAULT_MAX_INFLIGHT_DELIVERIES,
      humanReservedCapacity: DEFAULT_HUMAN_RESERVED_DELIVERIES,
      maxClaims: DEFAULT_MAX_INFLIGHT_DELIVERIES + DEFAULT_HUMAN_RESERVED_DELIVERIES,
      requireDeclaredCapacity: true,
    });
  });

  it('rejects a batch size the store would refuse anyway', async () => {
    await expect(buildGateway({
      pool: fakePool(),
      repository: fakeRepository(),
      authProvider: DevOnlyAuthProvider.forTests(),
      deliveryWakeSubscriber: noDeliveryWakes,
      deliveryClaimLimit: 0
    })).rejects.toThrow(/deliveryClaimLimit/);
  });
});


function latencyCapture(events: Record<string, unknown>[]) {
  return (app: Awaited<ReturnType<typeof buildGateway>>): void => {
    vi.spyOn(app.log, 'info').mockImplementation((entry: unknown) => {
      if (entry && typeof entry === 'object' && 'event' in entry && entry.event === 'chat_latency') {
        events.push(entry);
      }
    });
  };
}

describe('chat latency delivery boundaries', () => {
  it('observes a blocked claim before its result and the actual WS enqueue', async () => {
    const repository = fakeRepository();
    let release!: (deliveries: DeliveryClaimRecord[]) => void;
    const pending = new Promise<DeliveryClaimRecord[]>((resolve) => { release = resolve; });
    vi.mocked(repository.claimDeliveries).mockImplementationOnce(async () => pending).mockResolvedValue([]);
    const events: Record<string, unknown>[] = [];
    const { next } = await connect(repository, {}, latencyCapture(events));
    try {
      await vi.waitFor(() => { expect(events.some((event) => event.phase === 'delivery_claim_entered')).toBe(true); });
      expect(events.some((event) => event.phase === 'delivery_claim_result')).toBe(false);
      expect(events.some((event) => event.phase === 'delivery_frame_queued')).toBe(false);
      release([{ ...claim(ids.delivery, ids.claim), body: { text: 'body-sentinel' }, trace_id: 'unsafe-trace-secret' }]);
      expect(await next()).toMatchObject({ type: 'delivery', delivery_id: ids.delivery });
      const phases = events.map((event) => event.phase);
      expect(phases.indexOf('delivery_claim_result')).toBeGreaterThan(phases.indexOf('delivery_claim_entered'));
      expect(phases.indexOf('delivery_frame_queued')).toBeGreaterThan(phases.indexOf('delivery_claim_result'));
      const entry = events.find((event) => event.phase === 'delivery_claim_entered');
      const frame = events.find((event) => event.phase === 'delivery_frame_queued');
      expect(frame).toMatchObject({ operation_id: entry?.operation_id, round: 0, delivery_id: ids.delivery,
        message_id: ids.message, request_id: ids.request, attempt: 1 });
      expect(JSON.stringify(events)).not.toMatch(/body-sentinel|unsafe-trace-secret|claim_token|connection_token|body|tenant|alias|headers/);
      expect(repository.claimDeliveries).toHaveBeenCalledTimes(1);
    } finally { release([]); }
  });

  it('does not credit a returned claim after its socket has closed', async () => {
    const repository = fakeRepository();
    let release!: (deliveries: DeliveryClaimRecord[]) => void;
    const pending = new Promise<DeliveryClaimRecord[]>((resolve) => { release = resolve; });
    vi.mocked(repository.claimDeliveries).mockImplementationOnce(async () => pending).mockResolvedValue([]);
    const events: Record<string, unknown>[] = [];
    const { socket } = await connect(repository, {}, latencyCapture(events));
    try {
      await vi.waitFor(() => { expect(repository.claimDeliveries).toHaveBeenCalledOnce(); });
      const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve(); }); });
      socket.close(); await closed;
      release([claim(ids.delivery, ids.claim)]);
      await vi.waitFor(() => { expect(events.some((event) => event.phase === 'drain_finished')).toBe(true); });
      expect(events.some((event) => event.phase === 'delivery_frame_queued')).toBe(false);
    } finally { release([]); }
  });

  it('does not report a queued frame for a fenced claim', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries).mockRejectedValueOnce(new StoreError('fenced', 'private-error-sentinel'));
    const events: Record<string, unknown>[] = [];
    const { next } = await connect(repository, {}, latencyCapture(events));
    expect(await next()).toMatchObject({ type: 'error', code: 'fenced' });
    await vi.waitFor(() => { expect(events.some((event) => event.status === 'fenced')).toBe(true); });
    expect(events.some((event) => event.phase === 'delivery_frame_queued')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private-error-sentinel');
  });

  it('keeps delivery and capacity unchanged when the latency sink throws', async () => {
    const repository = fakeRepository();
    vi.mocked(repository.claimDeliveries).mockResolvedValueOnce([claim(ids.delivery, ids.claim)]).mockResolvedValue([]);
    let attempts = 0;
    const { next } = await connect(repository, {}, (app) => {
      vi.spyOn(app.log, 'info').mockImplementation((entry: unknown) => {
        if (entry && typeof entry === 'object' && 'event' in entry && entry.event === 'chat_latency') {
          attempts += 1; throw new Error('latency sink unavailable');
        }
      });
    });
    expect(await next()).toMatchObject({ type: 'delivery', delivery_id: ids.delivery });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(repository.claimDeliveries).toHaveBeenCalledOnce();
  });
});


describe('chat latency metadata limits', () => {
  it('drops invalid correlation and numeric fields without copying private data', async () => {
    const app = await buildGateway({ pool: fakePool(), repository: fakeRepository(),
      authProvider: DevOnlyAuthProvider.forTests(), deliveryWakeSubscriber: noDeliveryWakes });
    apps.push(app);
    const events: Record<string, unknown>[] = [];
    latencyCapture(events)(app);
    recordChatLatency(app.log, 'drain_started', {
      operation_id: 'unsafe-id', trace_id: 'private-trace-sentinel', request_correlation: '/private/path',
      elapsed_ms: Number.NaN, wake_claim_elapsed_ms: Number.POSITIVE_INFINITY,
      round: 16, attempt: 0, claimed_count: -1, wake_claim_started_at: 'invalid-date',
      body: 'private-body-sentinel', claim_token: ids.claim, headers: { authorization: 'private-header-sentinel' },
    });
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['at', 'event', 'phase', 'version']);
    expect(JSON.stringify(events)).not.toMatch(/private|unsafe|token|header/);
  });
});
