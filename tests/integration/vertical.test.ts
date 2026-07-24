import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHarness } from '@cauce/adapter-sdk';
import type { Ack, DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { FairLaneScheduler } from '../../services/dispatcher/src/scheduler.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

interface Published {
  message_id: string;
  delivery_ids: string[];
  duplicate: boolean;
  request_id: string;
  trace_id: string;
}

interface TestPublish {
  version: '3.0';
  request_id: string;
  trace_id: string;
  tenant_id: 'Steven' | 'Isa' | 'Jhon' | 'Pablo' | 'Miguel';
  room_id: string;
  actor_alias: string;
  recipients: Array<{ tenant_id: 'Steven' | 'Isa' | 'Jhon' | 'Pablo' | 'Miguel'; alias: string }>;
  body: Record<string, unknown>;
  idempotency_key: string;
  lane: 'interactive' | 'batch';
  priority: number;
  origin?: { adapter: string; channel: string; conversation_id: string; external_message_id?: string };
}

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let app: Awaited<ReturnType<typeof buildGateway>>;
let httpUrl: string;
let wsUrl: string;
const harnesses: FakeHarness[] = [];

function harness(tenant_id: 'Steven' | 'Isa' | 'Jhon' | 'Pablo' | 'Miguel', alias: string, instance_id: string = randomUUID()): FakeHarness {
  const client = new FakeHarness({ tenant_id, alias, instance_id, capabilities: ['messages.v3', 'acks.v3'] });
  harnesses.push(client);
  return client;
}

function message(overrides: Partial<TestPublish> = {}): TestPublish {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'vertical slice' }, idempotency_key: randomUUID(),
    lane: 'interactive', priority: 10, ...overrides
  };
}

async function publish(input: TestPublish): Promise<{ response: Response; body: Published | Record<string, unknown> }> {
  const response = await fetch(`${httpUrl}/v3/messages`, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'x-cauce-tenant': input.tenant_id,
      'x-cauce-alias': input.actor_alias
    }, body: JSON.stringify({
      room_id: input.room_id,
      recipients: input.recipients,
      body: input.body,
      idempotency_key: input.idempotency_key,
      lane: input.lane,
      priority: input.priority
    })
  });
  return { response, body: await response.json() as Published | Record<string, unknown> };
}

async function ackAndWait(
  client: FakeHarness,
  delivery: DeliveryEnvelope,
  status: Ack['status'],
  detail: Partial<Pick<Ack, 'event_id' | 'retryable' | 'error' | 'error_code' | 'result'>> = {}
) {
  client.ack(delivery, status, detail);
  return client.waitFor((frame) => frame.type === 'ack_result' && frame.delivery_id === delivery.delivery_id);
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
  app = await buildGateway({
    pool, authProvider: DevOnlyAuthProvider.forTests(), leaseTtlMs: 10_000,
    ackDeadlineMs: 600_000, outboxPollMs: 20
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/v3/ws`;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (client) => client.close()));
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('Cauce V3 PostgreSQL + HTTP + WebSocket vertical slice', () => {
  it('records accepted/started/done and ignores duplicate or out-of-order ACKs', async () => {
    const consumer = harness('Isa', 'salva', 'ack-consumer');
    await consumer.connect(wsUrl);
    const sent = await publish(message());
    expect(sent.response.status).toBe(202);
    const delivery = await consumer.nextDelivery();

    expect(await ackAndWait(consumer, delivery, 'accepted')).toMatchObject({ status: 'accepted', applied: true });
    expect(await ackAndWait(consumer, delivery, 'started')).toMatchObject({ status: 'started', applied: true });
    expect(await ackAndWait(consumer, delivery, 'accepted')).toMatchObject({ status: 'started', applied: false });
    expect(await ackAndWait(consumer, delivery, 'done', { result: { answer: 42 } })).toMatchObject({ status: 'done', applied: true });
    expect(await ackAndWait(consumer, delivery, 'failed')).toMatchObject({ status: 'done', applied: false });

    const ackRows = await pool.query<{ status: string; applied: boolean }>(
      'SELECT status,applied FROM delivery_acks WHERE delivery_id=$1 ORDER BY id', [delivery.delivery_id]
    );
    expect(ackRows.rows).toEqual([
      { status: 'accepted', applied: true }, { status: 'started', applied: true },
      { status: 'accepted', applied: false }, { status: 'done', applied: true },
      { status: 'failed', applied: false }
    ]);
  });

  it('rejects a second live consumer and fences by epoch', async () => {
    const first = harness('Isa', 'salva', 'instance-a');
    const second = harness('Isa', 'salva', 'instance-b');
    const epoch = await first.connect(wsUrl);
    await expect(second.connect(wsUrl)).rejects.toThrow('takeover_rejected:instance-a');
    await expect(repository.heartbeat('Isa', 'salva', 'instance-a', epoch + 1, 1_000)).rejects.toMatchObject({ code: 'fenced' });
    const presence = await repository.listPresence();
    expect(presence).toContainEqual(expect.objectContaining({ alias: 'salva', instance_id: 'instance-a', online: true }));
  });

  it('durably queues offline and delivers after reconnect', async () => {
    const sent = await publish(message());
    expect(sent.response.status).toBe(202);
    const persisted = await pool.query<{ status: string }>('SELECT status FROM deliveries');
    expect(persisted.rows).toEqual([{ status: 'pending' }]);

    const consumer = harness('Isa', 'salva', 'offline-reconnect');
    await consumer.connect(wsUrl);
    const delivery = await consumer.nextDelivery();
    expect(delivery.message_id).toBe((sent.body as Published).message_id);
    expect(await ackAndWait(consumer, delivery, 'done')).toMatchObject({ status: 'done' });
  });

  it('supports the canonical HTTP hello/query/ack vertical path and retains terminal rows', async () => {
    const sent = await publish(message({ recipients: [{ tenant_id: 'Pablo', alias: 'midas' }] }));
    const headers = {
      'content-type': 'application/json',
      'x-cauce-tenant': 'Pablo',
      'x-cauce-alias': 'midas'
    };
    const helloResponse = await fetch(`${httpUrl}/v3/connections/hello`, {
      method: 'POST', headers, body: JSON.stringify({
        type: 'hello', version: '3.0', tenant_id: 'Pablo', alias: 'midas',
        instance_id: 'http-consumer', capabilities: ['messages.v3']
      })
    });
    const lease = await helloResponse.json() as { epoch: number };
    expect(helloResponse.status).toBe(200);

    const queryResponse = await fetch(`${httpUrl}/v3/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ instance_id: 'http-consumer', epoch: lease.epoch, limit: 1 })
    });
    const queried = await queryResponse.json() as { deliveries: DeliveryEnvelope[] };
    expect(queried.deliveries).toHaveLength(1);
    expect(queried.deliveries[0]?.message_id).toBe((sent.body as Published).message_id);

    const queriedDelivery = queried.deliveries[0]!;
    const deliveryId = queriedDelivery.delivery_id;
    const ackResponse = await fetch(`${httpUrl}/v3/ack`, {
      method: 'POST', headers,
      body: JSON.stringify({
        version: '3.0', event_id: randomUUID(), delivery_id: deliveryId, status: 'done',
        attempt: queriedDelivery.attempt, claim_token: queriedDelivery.claim_token,
        instance_id: 'http-consumer', epoch: lease.epoch
      })
    });
    expect(await ackResponse.json()).toMatchObject({ delivery_id: deliveryId, status: 'done', applied: true });
    expect((await pool.query('SELECT 1 FROM deliveries WHERE id=$1 AND status=$2', [deliveryId, 'done'])).rowCount).toBe(1);
  });

  it('fences a new consumer from ACKing work claimed under an older epoch', async () => {
    const firstLease = await repository.acquireLease('Jhon', 'hegel', 'epoch-a', [], 10_000);
    await publish(message({ recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }] }));
    const claimed = await repository.claimDeliveries('Jhon', 'hegel', 'epoch-a', firstLease.epoch!, 1);
    await repository.releaseLease('Jhon', 'hegel', 'epoch-a', firstLease.epoch!);
    const secondLease = await repository.acquireLease('Jhon', 'hegel', 'epoch-b', [], 10_000);

    await expect(repository.ackDelivery(claimed[0]!.delivery_id, 'Jhon', 'hegel', {
      version: '3.0', event_id: randomUUID(), status: 'done', instance_id: 'epoch-b', epoch: secondLease.epoch!,
      attempt: claimed[0]!.attempt, claim_token: claimed[0]!.claim_token, retryable: false
    })).rejects.toMatchObject({ code: 'fenced' });

    await repository.retryStaleDeliveries(0);
    const reclaimed = await repository.claimDeliveries('Jhon', 'hegel', 'epoch-b', secondLease.epoch!, 1);
    expect(reclaimed[0]).toMatchObject({ delivery_id: claimed[0]!.delivery_id, attempt: 2, epoch: secondLease.epoch });
  });

  it('requeues a delivery when the consumer dies before terminal ACK', async () => {
    const consumer = harness('Isa', 'salva', 'crash-stable-instance');
    const firstEpoch = await consumer.connect(wsUrl);
    await publish(message());
    const first = await consumer.nextDelivery();
    consumer.terminate();
    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0 });

    const secondEpoch = await consumer.connect(wsUrl);
    expect(secondEpoch).toBeGreaterThan(firstEpoch);
    const redelivery = await consumer.nextDelivery();
    expect(redelivery.delivery_id).toBe(first.delivery_id);
    expect(redelivery.attempt).toBe(2);
    expect(await ackAndWait(consumer, redelivery, 'done')).toMatchObject({ status: 'done' });
  });

  it('keeps a fixed 10-minute claim deadline across started heartbeats and reaps only stale work', async () => {
    const consumer = harness('Isa', 'salva', 'slow-task-consumer');
    await consumer.connect(wsUrl);
    await publish(message());
    const delivery = await consumer.nextDelivery();
    const initialDeadline = new Date(delivery.ack_deadline_at).getTime();
    expect(initialDeadline - Date.now()).toBeGreaterThan(9 * 60_000);

    expect(await ackAndWait(consumer, delivery, 'accepted')).toMatchObject({ status: 'accepted', applied: true });
    expect(await ackAndWait(consumer, delivery, 'started')).toMatchObject({ status: 'started', applied: true });
    expect(await ackAndWait(consumer, delivery, 'started')).toMatchObject({ status: 'started', applied: false });
    const afterStarted = await pool.query<{ ack_deadline_at: Date; status: string }>(
      'SELECT ack_deadline_at,status FROM deliveries WHERE id=$1', [delivery.delivery_id]
    );
    expect(afterStarted.rows[0]?.ack_deadline_at.getTime()).toBe(initialDeadline);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 120_000));
      // Simulate the database-side claimed-at clock moving with the two-minute task.
      // Reaping must still use the immutable ten-minute claim deadline.
      await pool.query(
        `UPDATE deliveries SET claimed_at=claimed_at-interval '2 minutes' WHERE id=$1`,
        [delivery.delivery_id]
      );
      expect(await repository.retryStaleDeliveries(120_000)).toEqual({ retried: 0, dead: 0 });
      expect((await pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE id=$1', [delivery.delivery_id]
      )).rows[0]?.status).toBe('started');

      await pool.query(
        `UPDATE deliveries SET ack_deadline_at=now()-interval '1 millisecond',
           claim_expires_at=now()-interval '1 millisecond' WHERE id=$1`,
        [delivery.delivery_id]
      );
      expect(await repository.retryStaleDeliveries(120_000)).toEqual({ retried: 1, dead: 0 });
      expect((await pool.query<{ status: string; claim_token: string | null }>(
        'SELECT status,claim_token FROM deliveries WHERE id=$1', [delivery.delivery_id]
      )).rows[0]).toEqual({ status: 'retry', claim_token: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates repeated publish and rejects idempotency-key mutation', async () => {
    const input = message();
    const first = await publish(input);
    const duplicate = await publish(input);
    expect(first.response.status).toBe(202);
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.body).toMatchObject({ message_id: (first.body as Published).message_id, duplicate: true });
    expect((await pool.query('SELECT 1 FROM messages')).rowCount).toBe(1);

    const changed = await publish({ ...input, body: { text: 'different' } });
    expect(changed.response.status).toBe(409);
    expect(changed.body).toMatchObject({ error: 'conflict' });
  });

  it('default-denies tenant-to-tenant, allows Steven hub edges, and returns no_route for zero recipients', async () => {
    const denied = await publish(message({
      tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
      recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }]
    }));
    expect(denied.response.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'forbidden' });

    const hub = await publish(message({ recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }] }));
    expect(hub.response.status).toBe(202);

    const noRoute = await publish(message({ recipients: [] }));
    expect(noRoute.response.status).toBe(422);
    expect(noRoute.body).toMatchObject({ error: 'no_route' });
  });

  it('derives presence from lease heartbeat expiry', async () => {
    const acquired = await repository.acquireLease('Pablo', 'midas', 'short-lived', ['jobs'], 50);
    expect(acquired.acquired).toBe(true);
    expect(await repository.listPresence()).toContainEqual(expect.objectContaining({ alias: 'midas', online: true }));
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(await repository.listPresence()).toContainEqual(expect.objectContaining({ alias: 'midas', online: false }));
  });

  it('pushes an asynchronous wake and delivery over WebSocket', async () => {
    const consumer = harness('Jhon', 'hegel', 'wake-consumer');
    await consumer.connect(wsUrl);
    const wake = consumer.waitFor((frame) => frame.type === 'wake');
    const sent = await publish(message({ recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }] }));
    expect(sent.response.status).toBe(202);
    await expect(wake).resolves.toMatchObject({ type: 'wake', alias: 'hegel' });
    await expect(consumer.nextDelivery()).resolves.toMatchObject({ message_id: (sent.body as Published).message_id });
  });

  it('creates an idempotent origin relay outbox event with full correlation', async () => {
    const consumer = harness('Isa', 'salva', 'relay-consumer');
    await consumer.connect(wsUrl);
    const sent = await publish(message({
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: 'chat-7', external_message_id: 'tg-9' }
    }));
    const delivery = await consumer.nextDelivery();
    await ackAndWait(consumer, delivery, 'done', {
      result: {
        output: {
          reply: 'respuesta',
          messages: [],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    });
    const outbox = await repository.listOutbox('origin_relay');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      adapter: 'dev-auth', message_id: (sent.body as Published).message_id,
      delivery_id: delivery.delivery_id,
      payload: {
        outcome: 'done',
        result: { output: { reply: 'respuesta', messages: [] } },
        correlation: {
          request_id: delivery.request_id, message_id: delivery.message_id,
          delivery_id: delivery.delivery_id, trace_id: delivery.trace_id
        }
      }
    });
  });

  it('backs off retries and moves exhausted delivery to DLQ', async () => {
    const consumer = harness('Isa', 'salva', 'retry-consumer');
    await consumer.connect(wsUrl);
    await publish(message());
    const first = await consumer.nextDelivery();
    expect(await ackAndWait(consumer, first, 'failed', { retryable: true, error: 'temporary-1' }))
      .toMatchObject({ status: 'retry' });
    const second = await consumer.nextDelivery(4_000);
    expect(second.attempt).toBe(2);
    expect(await ackAndWait(consumer, second, 'failed', { retryable: true, error: 'temporary-2' }))
      .toMatchObject({ status: 'retry' });
    const third = await consumer.nextDelivery(5_000);
    expect(third.attempt).toBe(3);
    expect(await ackAndWait(consumer, third, 'failed', { retryable: true, error: 'temporary-3' }))
      .toMatchObject({ status: 'dead' });
    const dead = await pool.query<{ delivery_id: string; attempts: number }>('SELECT delivery_id,attempts FROM dead_letters');
    expect(dead.rows).toEqual([{ delivery_id: first.delivery_id, attempts: 3 }]);
  });

  it('dead-letters an ambiguous execution ACK and permits exactly one manual replay clone', async () => {
    const consumer = harness('Isa', 'salva', 'ambiguous-consumer');
    await consumer.connect(wsUrl);
    const sent = await publish(message());
    expect(sent.response.status).toBe(202);
    const original = await consumer.nextDelivery();
    const eventId = randomUUID();
    const detail = {
      event_id: eventId,
      retryable: false,
      error: 'execution may have completed before timeout',
      error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS',
      result: {
        output: {
          reply: 'ambiguous output must not route',
          messages: [{ to: 'kant', body: 'must never materialize' }],
          status: 'failed',
          retryable: false,
          artifacts: []
        }
      }
    } as const;

    expect(await ackAndWait(consumer, original, 'failed', detail)).toMatchObject({
      delivery_id: original.delivery_id,
      status: 'dead',
      applied: true
    });
    expect(await ackAndWait(consumer, original, 'failed', detail)).toMatchObject({
      delivery_id: original.delivery_id,
      status: 'dead',
      applied: false
    });

    expect((await pool.query<{
      delivery_id: string;
      attempts: number;
      reason: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT delivery_id,attempts,reason,payload
       FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [original.delivery_id]
    )).rows[0]).toMatchObject({
      delivery_id: original.delivery_id,
      attempts: 1,
      reason: detail.error,
      payload: { text: 'vertical slice' }
    });
    expect((await pool.query<{ payload: Record<string, unknown>; applied: boolean }>(
      `SELECT payload,applied FROM delivery_acks WHERE event_id=$1`,
      [eventId]
    )).rows[0]).toMatchObject({
      applied: true,
      payload: {
        retryable: false,
        error: detail.error,
        error_code: detail.error_code
      }
    });
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE action='delivery.ack' AND delivery_id=$1 ORDER BY id DESC LIMIT 1`,
      [original.delivery_id]
    )).rows[0]?.metadata).toMatchObject({
      resulting_status: 'dead',
      error_code: detail.error_code,
      ambiguous_execution: true
    });
    expect((await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM adapter_outbox
       WHERE kind='origin_relay' AND delivery_id=$1`,
      [original.delivery_id]
    )).rows[0]?.payload).toMatchObject({
      outcome: 'dead',
      error_code: detail.error_code
    });
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE source_delivery_id=$1`,
      [original.delivery_id]
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [(sent.body as Published).trace_id]
    )).rowCount).toBe(1);

    const replayUrl = `${httpUrl}/v3/console/deliveries/${original.delivery_id}/replay`;
    const replayHeaders = {
      origin: httpUrl,
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': 'kant'
    };
    const replayResponses = await Promise.all([
      fetch(replayUrl, { method: 'POST', headers: replayHeaders }),
      fetch(replayUrl, { method: 'POST', headers: replayHeaders })
    ]);
    expect(replayResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    const replayResponse = replayResponses.find((response) => response.status === 200);
    if (!replayResponse) throw new Error('expected one successful manual replay');
    const replay = await replayResponse.json() as {
      delivery_id: string;
      replayed_from_delivery_id: string;
      state: string;
      replayed: boolean;
    };
    expect(replay).toMatchObject({
      replayed_from_delivery_id: original.delivery_id,
      state: 'pending',
      replayed: true
    });
    expect(replay.delivery_id).not.toBe(original.delivery_id);
    const replayedDelivery = await consumer.nextDelivery();
    expect(replayedDelivery).toMatchObject({
      delivery_id: replay.delivery_id,
      attempt: 1
    });
    expect(replayedDelivery.message_id).not.toBe(original.message_id);
    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [(sent.body as Published).trace_id]
    )).rowCount).toBe(2);
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NOT NULL`,
      [original.delivery_id]
    )).rowCount).toBe(1);
  });

  it('rejects an invented ambiguous suffix and keeps the failure out of the DLQ', async () => {
    const consumer = harness('Isa', 'salva', 'ordinary-failure-consumer');
    await consumer.connect(wsUrl);
    await publish(message());
    const delivery = await consumer.nextDelivery();
    expect(await ackAndWait(consumer, delivery, 'failed', {
      retryable: false,
      error: 'deterministic execution failure',
      error_code: 'CLIENT_INVENTED_AMBIGUOUS'
    })).toMatchObject({ status: 'failed', applied: true });
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);
  });

  it('claims PostgreSQL jobs with bounded interactive/batch lane fairness', async () => {
    for (let index = 0; index < 6; index += 1) await repository.enqueueJob('Steven', 'interactive', index, 'test', { index });
    for (let index = 0; index < 2; index += 1) await repository.enqueueJob('Steven', 'batch', index, 'test', { index });
    const scheduler = new FairLaneScheduler(2);
    let interactive = 6;
    let batch = 2;
    const claimed: string[] = [];
    while (interactive + batch > 0) {
      const lane = scheduler.next(interactive > 0, batch > 0)!;
      const jobs = await repository.claimJobs(lane, 'fairness-test', 1);
      expect(jobs).toHaveLength(1);
      claimed.push(lane);
      if (lane === 'interactive') interactive -= 1;
      else batch -= 1;
    }
    expect(claimed.slice(0, 6)).toEqual(['interactive', 'interactive', 'batch', 'interactive', 'interactive', 'batch']);
  });

  it('fences job completion and dead-letters exhausted jobs', async () => {
    const jobId = await repository.enqueueJob('Steven', 'batch', 0, 'failing-test', { input: 1 });
    await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [jobId]);
    const [job] = await repository.claimJobs('batch', 'worker-a', 1, 5_000);
    expect(job).toMatchObject({ id: jobId, attempts: 1, status: 'running' });
    await expect(repository.completeJob(jobId, 'worker-b', job!.claim_token)).resolves.toBe(false);
    await expect(repository.failJob(jobId, 'worker-a', 'permanent failure', job!.claim_token)).resolves.toBe('dead');
    expect((await pool.query('SELECT 1 FROM dead_letters WHERE job_id=$1', [jobId])).rowCount).toBe(1);
  });
});
