/* eslint-disable @typescript-eslint/unbound-method */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Tenant } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import {
  buildGateway, WakePumpTelemetry,
  type GatewayRepository, type OutboxLeaseAck, type OutboxLeaseEvent
} from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, frameReader, noDeliveryWakes
} from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
const sockets: WebSocket[] = [];
const pendingReleases = new Set<() => void>();
let eventSequence = 0;

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.clear();
  await closeGatewaysAndSockets(apps, sockets);
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`);
}

function wakeEvent(
  worker: string,
  tenantId: Tenant,
  alias: string,
  attempt = 1,
  expiresAt = new Date(Date.now() + 30_000)
): OutboxLeaseEvent {
  eventSequence += 1;
  const suffix = eventSequence.toString().padStart(12, '0');
  const id = `70000000-0000-4000-8000-${suffix}`;
  return {
    id,
    event_id: id,
    tenant_id: tenantId,
    adapter: 'gateway',
    kind: 'wake',
    request_id: `30000000-0000-4000-8000-${suffix}`,
    message_id: `10000000-0000-4000-8000-${suffix}`,
    delivery_id: `20000000-0000-4000-8000-${suffix}`,
    trace_id: `trace-selective-wake-${String(eventSequence)}`,
    origin: null,
    payload: { recipient_alias: alias, reason: 'delivery_available' },
    attempts: attempt,
    attempt,
    max_attempts: 5,
    claimed_by: worker,
    claim_token: `40000000-0000-4000-8000-${suffix}`,
    claim_expires_at: expiresAt
  };
}

interface WakeState {
  readonly tenantId: Tenant;
  readonly alias: string;
  status: 'pending' | 'processing' | 'failed' | 'sent';
  attempts: number;
}

function wakeQueue(tenantId: Tenant, alias: string): {
  readonly state: WakeState;
  readonly claim: GatewayRepository['claimWakeOutbox'];
  readonly ack: NonNullable<GatewayRepository['ackOutbox']>;
} {
  const state: WakeState = { tenantId, alias, status: 'pending', attempts: 0 };
  const claim = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
    const selected = recipients.some((recipient) =>
      recipient.tenant_id === state.tenantId && recipient.alias === state.alias);
    if (!selected || (state.status !== 'pending' && state.status !== 'failed')) return [];
    state.status = 'processing';
    state.attempts += 1;
    return [wakeEvent(worker, state.tenantId, state.alias, state.attempts)];
  });
  const ack = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(async (value) => {
    expect(value.attempt).toBe(state.attempts);
    if (value.status === 'sent') {
      state.status = 'sent';
      return { status: 'sent', applied: true };
    }
    state.status = 'failed';
    return { status: 'failed', applied: true };
  });
  return { state, claim, ack };
}

interface StartOptions {
  outboxPollMs?: number;
  outboxWakeConcurrency?: number;
  outboxShutdownTimeoutMs?: number;
  wakePumpTelemetry?: WakePumpTelemetry;
}

async function start(
  repository: GatewayRepository,
  overrides: StartOptions = {}
): Promise<{ app: Awaited<ReturnType<typeof buildGateway>>; port: number }> {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: overrides.outboxPollMs ?? 10,
    outboxLeaseMs: 30_000,
    outboxWakeConcurrency: overrides.outboxWakeConcurrency ?? 4,
    outboxShutdownTimeoutMs: overrides.outboxShutdownTimeoutMs ?? 100,
    ...(overrides.wakePumpTelemetry === undefined
      ? {} : { wakePumpTelemetry: overrides.wakePumpTelemetry })
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as AddressInfo).port };
}

async function connect(
  port: number,
  tenantId: Tenant,
  alias: string,
  instanceId: string
): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  received: Record<string, unknown>[];
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v3/ws`, {
    headers: { 'x-cauce-tenant': tenantId, 'x-cauce-alias': alias }
  });
  sockets.push(socket);
  const received: Record<string, unknown>[] = [];
  const next = frameReader(socket, received);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'hello', version: '3.0', tenant_id: tenantId, alias,
    instance_id: instanceId, capabilities: ['acks.v3', 'renewable_delivery_claims_v1']
  }));
  expect(await next()).toMatchObject({ type: 'hello_ack' });
  return { socket, next, received };
}

function sawWake(connection: { received: Record<string, unknown>[] }): boolean {
  return connection.received.some((frame) => frame.type === 'wake');
}

function fencedLogged(error: unknown): boolean {
  return error instanceof StoreError && error.code === 'fenced';
}

describe('gateway selective durable wake routing', () => {
  it('does not claim an offline tenant through another tenant with the same alias', async () => {
    const queue = wakeQueue('Steven', 'midas');
    const repository = fakeRepository();
    repository.claimWakeOutbox = queue.claim;
    repository.ackOutbox = queue.ack;
    const { port } = await start(repository);

    await connect(port, 'Pablo', 'midas', 'pablo-midas');
    await waitFor(() => vi.mocked(queue.claim).mock.calls.length > 0);

    expect(queue.state).toMatchObject({ status: 'pending', attempts: 0 });
    for (const call of vi.mocked(queue.claim).mock.calls) {
      expect(call[1]).toHaveLength(1);
      expect(call[1][0]).toMatchObject({
        tenant_id: 'Pablo', alias: 'midas', instance_id: 'pablo-midas', epoch: 1,
      });
      expect(call[1][0]?.connection_token).toMatch(/^[0-9a-f-]{36}$/u);
      expect(call[2]).toBe(1);
    }
    expect(queue.ack).not.toHaveBeenCalled();

    const later = await connect(port, 'Steven', 'midas', 'steven-midas');
    expect(await later.next()).toMatchObject({
      type: 'wake', alias: 'midas', reason: 'delivery_available'
    });
    await waitFor(() => queue.state.status === 'sent');
    expect(queue.state.attempts).toBe(1);
    expect(queue.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent', attempt: 1 }),
      expect.any(AbortSignal),
    );
  });

  it('lets tenant B progress while tenant A has a blocked delivery drain', async () => {
    const repository = fakeRepository();
    let enabled = false;
    let blockADrain = false;
    let drainEntered = false;
    let releaseDrain: (() => void) | undefined;
    const emitted = new Set<string>();
    const acknowledgements: OutboxLeaseAck[] = [];
    vi.mocked(repository.claimDeliveries).mockImplementation(async (tenantId, alias) => {
      if (blockADrain && tenantId === 'Pablo' && alias === 'midas' && !drainEntered) {
        drainEntered = true;
        await new Promise<void>((resolve) => {
          releaseDrain = resolve;
          pendingReleases.add(resolve);
        });
      }
      return [];
    });
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
      if (!enabled) return [];
      return recipients.flatMap((recipient) => {
        const key = `${recipient.tenant_id}:${recipient.alias}`;
        if (emitted.has(key)) return [];
        emitted.add(key);
        return [wakeEvent(worker, recipient.tenant_id, recipient.alias)];
      });
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(async (ack) => {
      acknowledgements.push(ack);
      return { status: ack.status === 'sent' ? 'sent' : 'failed', applied: true };
    });
    const { port } = await start(repository, { outboxWakeConcurrency: 2 });
    const blocked = await connect(port, 'Pablo', 'midas', 'blocked-a');
    const progressing = await connect(port, 'Steven', 'kant', 'progressing-b');

    blockADrain = true;
    enabled = true;
    await waitFor(() => drainEntered);
    await waitFor(() => sawWake(progressing));
    expect(sawWake(blocked)).toBe(true);
    expect(acknowledgements.filter((ack) => ack.status === 'sent')).toHaveLength(1);
    expect(acknowledgements.find((ack) =>
      ack.connection.tenant_id === 'Pablo' && ack.status === 'sent')).toBeUndefined();

    releaseDrain?.();
    if (releaseDrain !== undefined) pendingReleases.delete(releaseDrain);
    await waitFor(() => acknowledgements.filter((ack) => ack.status === 'sent').length === 2);
  });

  it('isolates one recipient pre-send failure while the rest of the bounded batch succeeds', async () => {
    const repository = fakeRepository();
    let enabled = false;
    const attempted = new Set<string>();
    let activeRenewals = 0;
    let maxActiveRenewals = 0;
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
      if (!enabled) return [];
      return recipients.flatMap((recipient) => {
        const key = `${recipient.tenant_id}:${recipient.alias}`;
        if (attempted.has(key)) return [];
        attempted.add(key);
        return [wakeEvent(worker, recipient.tenant_id, recipient.alias)];
      });
    });
    repository.renewWakeOutbox = vi.fn<GatewayRepository['renewWakeOutbox']>(async (fence) => {
      activeRenewals += 1;
      maxActiveRenewals = Math.max(maxActiveRenewals, activeRenewals);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (fence.connection.tenant_id === 'Pablo') {
          throw new Error('recipient-specific renewal failure');
        }
        return true;
      } finally {
        activeRenewals -= 1;
      }
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(async (ack) => ({
      status: ack.status === 'sent' ? 'sent' : 'failed', applied: true
    }));
    const { app, port } = await start(repository, { outboxWakeConcurrency: 2 });
    const error = vi.spyOn(app.log, 'error');
    const failed = await connect(port, 'Pablo', 'midas', 'failed-recipient');
    const first = await connect(port, 'Steven', 'kant', 'first-success');
    const second = await connect(port, 'Isa', 'salva', 'second-success');

    enabled = true;
    await waitFor(() => sawWake(first) && sawWake(second));
    await waitFor(() => error.mock.calls.some(([reason]) =>
      reason instanceof Error && reason.message === 'recipient-specific renewal failure'));
    expect(sawWake(failed)).toBe(false);
    expect(repository.ackOutbox).toHaveBeenCalledTimes(2);
    expect(maxActiveRenewals).toBe(2);
    for (const call of vi.mocked(repository.claimWakeOutbox).mock.calls) {
      expect(call[1].length).toBeGreaterThanOrEqual(1);
      expect(call[2]).toBe(call[1].length);
    }
  });

  it('does not emit or ACK a wake whose lease is already expired', async () => {
    const repository = fakeRepository();
    let enabled = false;
    let emitted = false;
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
      if (!enabled || emitted) return [];
      emitted = true;
      const recipient = recipients[0];
      if (!recipient) return [];
      return [wakeEvent(worker, recipient.tenant_id, recipient.alias, 1, new Date(Date.now() - 1))];
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(
      async () => ({ status: 'sent', applied: true })
    );
    repository.renewWakeOutbox = vi.fn(async () => false);
    const { app, port } = await start(repository);
    const error = vi.spyOn(app.log, 'error');
    const connection = await connect(port, 'Steven', 'kant', 'expired-lease');

    enabled = true;
    await waitFor(() => error.mock.calls.some(([reason]) => fencedLogged(reason)));
    expect(sawWake(connection)).toBe(false);
    expect(repository.ackOutbox).not.toHaveBeenCalled();
  });

  it('treats ackOutbox applied=false as an observable fenced result, never success', async () => {
    const repository = fakeRepository();
    const telemetry = new WakePumpTelemetry();
    let enabled = false;
    let emitted = false;
    let connection: Awaited<ReturnType<typeof connect>> | undefined = undefined;
    let wakeObservedBeforeAck = false;
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
      if (!enabled || emitted) return [];
      emitted = true;
      const recipient = recipients[0];
      if (!recipient) return [];
      return [wakeEvent(worker, recipient.tenant_id, recipient.alias)];
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(
      async () => {
        await waitFor(() => {
          wakeObservedBeforeAck = connection !== undefined && sawWake(connection);
          return wakeObservedBeforeAck;
        });
        return { status: 'sent', applied: false };
      }
    );
    const { app, port } = await start(repository, { wakePumpTelemetry: telemetry });
    const error = vi.spyOn(app.log, 'error');
    connection = await connect(port, 'Steven', 'kant', 'fenced-ack');

    enabled = true;
    await waitFor(() => sawWake(connection));
    await waitFor(() => vi.mocked(repository.ackOutbox).mock.calls.length === 1);
    await waitFor(() => error.mock.calls.some(([reason]) =>
      reason instanceof StoreError
      && reason.code === 'fenced'
      && reason.message === 'wake outbox ACK was fenced'));
    expect(sawWake(connection)).toBe(true);
    expect(wakeObservedBeforeAck).toBe(true);
    const fencedSnapshot = telemetry.snapshot();
    expect(typeof fencedSnapshot.lastProgressAtMs).toBe('number');
    expect(fencedSnapshot.counters).toMatchObject({ claimed: 1, sent: 0, fenced: 1 });
    expect(JSON.stringify(fencedSnapshot)).not.toMatch(/Steven|kant|70000000/);
  });

  it('retries one close-after-claim race, stays quiescent offline, and resumes later', async () => {
    const repository = fakeRepository();
    let enabled = false;
    let status: 'pending' | 'processing' | 'failed' | 'sent' = 'pending';
    let attempts = 0;
    let claimEntered = false;
    let releaseClaim: (() => void) | undefined;
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (worker, recipients) => {
      const recipient = recipients[0];
      if (!recipient) return [];
      if (!enabled || recipient.tenant_id !== 'Steven' || recipient.alias !== 'midas'
          || (status !== 'pending' && status !== 'failed')) return [];
      status = 'processing';
      attempts += 1;
      const event = wakeEvent(worker, 'Steven', 'midas', attempts);
      if (attempts === 1) {
        claimEntered = true;
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
          pendingReleases.add(resolve);
        });
      }
      return [event];
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(async (ack) => {
      status = ack.status === 'sent' ? 'sent' : 'failed';
      return { status: ack.status === 'sent' ? 'sent' : 'failed', applied: true };
    });
    const { port } = await start(repository);
    await connect(port, 'Pablo', 'midas', 'other-tenant-online');
    const raced = await connect(port, 'Steven', 'midas', 'steven-race');
    enabled = true;
    await waitFor(() => claimEntered);

    const closed = new Promise<void>((resolve) => raced.socket.once('close', () => { resolve(); }));
    raced.socket.close(1000, 'race after wake claim');
    await closed;
    releaseClaim?.();
    if (releaseClaim !== undefined) pendingReleases.delete(releaseClaim);

    await waitFor(() => status === 'failed');
    expect(attempts).toBe(1);
    expect(repository.ackOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'retry', attempt: 1, error: 'recipient disconnected during wake delivery'
      }),
      expect.any(AbortSignal),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(attempts).toBe(1);

    const resumed = await connect(port, 'Steven', 'midas', 'steven-race');
    await waitFor(() => sawWake(resumed));
    await waitFor(() => status === 'sent');
    expect(attempts).toBe(2);
    expect(repository.ackOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'sent', attempt: 2 }),
      expect.any(AbortSignal),
    );
  });

  it('uses one rotated batch claim per cycle for fifteen empty sessions', async () => {
    const repository = fakeRepository();
    const claim = vi.fn<GatewayRepository['claimWakeOutbox']>(async () => []);
    repository.claimWakeOutbox = claim;
    const { port } = await start(repository, { outboxPollMs: 20 });
    await Promise.all(Array.from({ length: 15 }, async (_, index) =>
      connect(port, 'Steven', `agent-${String(index)}`, `instance-${String(index)}`)));
    claim.mockClear();

    await waitFor(() => claim.mock.calls.length > 0);
    const firstCycle = claim.mock.calls[0];
    expect(firstCycle).toBeDefined();
    if (!firstCycle) throw new Error('Expected claim to be called');
    expect(firstCycle[1]).toHaveLength(15);
    expect(firstCycle[2]).toBe(15);
    const identities = firstCycle[1].map((recipient) =>
      `${recipient.tenant_id}:${recipient.alias}`);
    expect(new Set(identities).size).toBe(15);
  });

  it('bounds shutdown and cancels a claim continuation before any late side effect', async () => {
    const repository = fakeRepository();
    const telemetry = new WakePumpTelemetry();
    let enabled = false;
    let claimEntered = false;
    repository.claimWakeOutbox = vi.fn<GatewayRepository['claimWakeOutbox']>(async (
      worker, recipients, _limit, _leaseMs, signal,
    ) => {
      if (!enabled) return [];
      claimEntered = true;
      const recipient = recipients[0];
      if (!recipient) return [];
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => { resolve(); }, { once: true });
      });
      if (signal?.aborted) return [];
      return [wakeEvent(worker, recipient.tenant_id, recipient.alias)];
    });
    repository.ackOutbox = vi.fn<NonNullable<GatewayRepository['ackOutbox']>>(
      async () => ({ status: 'sent', applied: true })
    );
    const { app, port } = await start(repository, {
      outboxPollMs: 5,
      outboxShutdownTimeoutMs: 30,
      wakePumpTelemetry: telemetry
    });
    const error = vi.spyOn(app.log, 'error');
    const connection = await connect(port, 'Steven', 'kant', 'bounded-close');
    enabled = true;
    await waitFor(() => claimEntered);

    const startedAt = Date.now();
    let closeGuard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      app.close().then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => {
        closeGuard = setTimeout(() => { resolve('timed-out'); }, 500);
      })
    ]);
    if (closeGuard !== undefined) clearTimeout(closeGuard);
    expect(outcome).toBe('closed');
    expect(Date.now() - startedAt).toBeLessThan(200);
    apps.splice(apps.indexOf(app), 1);
    await waitFor(() => telemetry.snapshot().counters.cancelled === 1);
    expect(sawWake(connection)).toBe(false);
    expect(repository.ackOutbox).not.toHaveBeenCalled();
    expect(error.mock.calls.some(([reason]) =>
      reason instanceof Error && reason.message.includes('still waiting'))).toBe(false);
    const stoppedSnapshot = telemetry.snapshot();
    expect(stoppedSnapshot.state).toBe('stopping');
    expect(typeof stoppedSnapshot.lastProgressAtMs).toBe('number');
    expect(stoppedSnapshot.counters).toMatchObject({ claimed: 0, cancelled: 1, sent: 0 });
  });
});
