import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HUMAN_PRIORITY_FLOOR, type Ack, type DeliveryEnvelope, type PublishMessage, type Tenant,
} from '@cauce/protocol';
import { CauceRepository, timeoutRetryBackoffSeconds, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Capacity partitioning and admission/retry policies to optimize concurrency
 * and avoid redundant harness runs.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const humanTenant: Tenant = 'Steven';
const consumerTenant: Tenant = 'Steven';
const consumerAlias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: humanTenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: consumerTenant, alias: consumerAlias }],
    body: { text: 'mensaje de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: HUMAN_PRIORITY_FLOOR,
    ...overrides
  };
}

/**
 * Publishes an agent-to-agent delivery without going through the full delegation chain: it
 * writes the same `body.type` that `materializeAgentOutputs` writes, and the same `lane='batch'`.
 * `publish()` rejects reserved types on purpose, so the INSERT goes straight through.
 */
async function publishRawDelivery(body: Record<string, unknown>, priority: number): Promise<string> {
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
     VALUES($1,$2,$3,'grp.steven','kant',$4::jsonb,'batch',$5) RETURNING id`,
    [randomUUID(), `trace-${randomUUID()}`, humanTenant, JSON.stringify(body), priority]
  );
  const messageId = message.rows[0]!.id;
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
     VALUES($1,$2,$3) RETURNING id`,
    [messageId, consumerTenant, consumerAlias]
  );
  return delivery.rows[0]!.id;
}

async function publishAgentDelivery(text: string): Promise<string> {
  return publishRawDelivery({ type: 'agent.message', text, from_alias: 'kant' }, 0);
}

function ack(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  status: Ack['status'],
  overrides: Partial<Ack> = {}
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...overrides
  };
}

/**
 * Reproduces what the SDK does when the harness REALLY STARTS: a normal 'started' first
 * (which is only "the delivery was admitted") and then, with the session turn in hand and about
 * to invoke the harness, another 'started' with `execution_started`. Both are required because
 * the difference between them is precisely what the reaper must be able to distinguish.
 */
async function startExecution(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number
): Promise<void> {
  await repository.ackDelivery(
    delivery.delivery_id, consumerTenant, consumerAlias,
    ack(delivery, instanceId, epoch, 'started')
  );
  await repository.ackDelivery(
    delivery.delivery_id, consumerTenant, consumerAlias,
    ack(delivery, instanceId, epoch, 'started', { execution_started: true })
  );
}

async function expire(deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second',
       claim_expires_at=now()-interval '1 second' WHERE id=$1`,
    [deliveryId]
  );
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
     VALUES($1,$2,false,100)`,
    [consumerTenant, consumerAlias],
  );
});

describe('atomic delivery-consumer lease admission', () => {
  it('creates no lease when the durable capacity row is missing', async () => {
    await pool.query(
      `DELETE FROM agents WHERE tenant_id=$1 AND alias=$2`,
      [consumerTenant, consumerAlias],
    );

    await expect(repository.acquireLease(
      consumerTenant, consumerAlias, 'missing-capacity-initial', [], 30_000,
      { requireDeclaredCapacity: true },
    )).rejects.toThrow('delivery consumer is missing its durable agent capacity');

    const durable = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM connection_leases
        WHERE tenant_id=$1 AND alias=$2`,
      [consumerTenant, consumerAlias],
    );
    expect(durable.rows[0]).toEqual({ count: '0' });
  });

  it('does not rotate a renewable lease when the durable capacity row is missing', async () => {
    const instanceId = 'atomic-capacity-resume';
    const original = await repository.acquireLease(
      consumerTenant, consumerAlias, instanceId, [], 30_000,
      { resume: true, resumeWindowMs: 60_000, requireDeclaredCapacity: true },
    );
    expect(original.acquired).toBe(true);
    expect(original.connection_token).toMatch(/^[0-9a-f-]{36}$/u);

    await pool.query(
      `DELETE FROM agents WHERE tenant_id=$1 AND alias=$2`,
      [consumerTenant, consumerAlias],
    );
    await expect(repository.acquireLease(
      consumerTenant, consumerAlias, instanceId, [], 30_000,
      { resume: true, resumeWindowMs: 60_000, requireDeclaredCapacity: true },
    )).rejects.toThrow('delivery consumer is missing its durable agent capacity');

    const durable = await pool.query<{ epoch: string; connection_token: string }>(
      `SELECT epoch,connection_token::text FROM connection_leases
        WHERE tenant_id=$1 AND alias=$2`,
      [consumerTenant, consumerAlias],
    );
    expect(durable.rows[0]).toEqual({
      epoch: String(original.epoch), connection_token: original.connection_token,
    });
    await expect(repository.heartbeat(
      consumerTenant, consumerAlias, instanceId, original.epoch!, 30_000,
      original.connection_token,
    )).resolves.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe('claim admission with a reserve for humans', () => {
  it('derives the human class from trusted priority, never from producer-controlled body shape', async () => {
    const lease = await repository.acquireLease(
      consumerTenant, consumerAlias, 'assistant-priority-authority', [], 30_000,
    );
    const spoofedHumanId = await publishRawDelivery({ text: 'parezco humano' }, 0);
    const trustedHumanId = await publishRawDelivery(
      { type: 'agent.message', text: 'el body no decide la clase', from_alias: 'kant' },
      HUMAN_PRIORITY_FLOOR,
    );

    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-priority-authority', lease.epoch!,
      0, 30_000, 3,
      { generalCapacity: 0, humanReservedCapacity: 1, maxClaims: 1 },
    );

    expect(claimed.map((delivery) => delivery.delivery_id)).toEqual([trustedHumanId]);
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE id=$1`, [spoofedHumanId],
    )).rows[0]).toEqual({ status: 'pending' });
  });

  it('admits a human delivery through the reserve while the general budget is exhausted', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-1', [], 30_000);
    await publishAgentDelivery('tarea larga entre agentes');
    await publishAgentDelivery('otra tarea larga');
    await repository.publish(command({ body: { text: '¿cómo venís?' } }));

    // The general capacity is explicitly zero. Without a reserve this would return zero and the
    // human would be left waiting for the task to finish.
    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-1', lease.epoch!, 0, 30_000, 3,
      { generalCapacity: 0, humanReservedCapacity: 1, maxClaims: 1 }
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.body).toMatchObject({ text: '¿cómo venís?' });
    // And the two agent-to-agent tasks keep waiting: the human used its share, not theirs.
    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE status='pending'`
    )).rowCount).toBe(2);
  });

  it('serves the human delivery first even when it was queued last', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-2', [], 30_000);
    for (let index = 0; index < 4; index += 1) await publishAgentDelivery(`hop ${index}`);
    await repository.publish(command({ body: { text: 'llegué última' } }));

    const [first] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-2', lease.epoch!, 1, 30_000
    );

    expect(first?.body).toMatchObject({ text: 'llegué última' });
  });

  it('yields one turn to agent work after the configured human burst', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-3', [], 30_000);
    for (let index = 0; index < 4; index += 1) await publishAgentDelivery(`hop ${index}`);
    for (let index = 0; index < 4; index += 1) {
      await repository.publish(command({ body: { text: `humano ${index}` } }));
    }

    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-3', lease.epoch!, 8, 30_000, 3
    );

    // Three humans, then one agent, then a human again: the same alternation that
    // `delivery_lane_fairness` already did, except now the partition actually discriminates.
    expect(claimed.map(
      (delivery) => typeof delivery.body.type === 'string' ? delivery.body.type : 'human'
    )).toEqual([
      'human', 'human', 'human', 'agent.message', 'human', 'agent.message', 'agent.message', 'agent.message'
    ]);
  });

  /**
   * The admission budget must be reconstructible from the database, or a reconnect multiplies
   * it: the gateway used to build an empty claim map on every `hello` and hand the entire
   * capacity back to the adapter. With `renewable_delivery_claims_v1` this is doubly severe,
   * because that capacity exists to PRESERVE the lease across reconnects.
   */
  it('reports the live claims of an alias with their admission class', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-5', [], 30_000);
    await publishAgentDelivery('trabajo entre agentes');
    await repository.publish(command({ body: { text: 'mensaje de una persona' } }));
    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-5', lease.epoch!, 2, 30_000
    );
    expect(claimed).toHaveLength(2);

    const live = await repository.liveDeliveryClaims(consumerTenant, consumerAlias);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((claim) => claim.human_originated))).toEqual(new Set([true, false]));

    // A finished claim stops occupying capacity immediately.
    const first = claimed.find((delivery) => delivery.body.type === undefined)!;
    await repository.ackDelivery(
      first.delivery_id, consumerTenant, consumerAlias,
      ack(first, 'assistant-5', lease.epoch!, 'done')
    );
    const remaining = await repository.liveDeliveryClaims(consumerTenant, consumerAlias);
    expect(remaining.map((claim) => claim.human_originated)).toEqual([false]);
  });

  it('rejects a claim with no general budget and no reserve', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-4', [], 30_000);
    await expect(repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-4', lease.epoch!, 0, 30_000
    )).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('agent-derived messages leave the interactive lane', () => {
  it('materializes delegated work on the batch lane instead of inheriting the parent lane', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'delegator-1', [], 30_000);
    const source = command({ lane: 'interactive', body: { text: 'delegá esto' } });
    await repository.publish(source);
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'delegator-1', lease.epoch!, 1, 30_000
    );

    await repository.ackDelivery(delivery!.delivery_id, consumerTenant, consumerAlias, {
      ...ack(delivery!, 'delegator-1', lease.epoch!, 'done'),
      result: {
        output: {
          reply: null,
          messages: [{ to: 'socrates', body: 'hacé la parte dos' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    });

    const derived = await pool.query<{ lane: string; type: string }>(
      `SELECT lane,body->>'type' AS type FROM messages WHERE body->>'type'='agent.message'`
    );
    expect(derived.rowCount).toBe(1);
    // The original message from the human stays on 'interactive'; only the descendents move to
    // 'batch'. Inheriting it was what made the assistant queue and the work queue the same queue.
    expect(derived.rows[0]).toEqual({ lane: 'batch', type: 'agent.message' });
    expect((await pool.query<{ lane: string }>(
      `SELECT lane FROM messages WHERE request_id=$1`, [source.request_id]
    )).rows[0]).toEqual({ lane: 'interactive' });
  });
});

describe('stale delivery reaper', () => {
  it('retries a delivery that never started, with backoff instead of immediately', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'crashed-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'crashed-1', lease.epoch!, 1, 30_000
    );
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0, parked: 0 });

    const row = await pool.query<{ status: string; available_in: number }>(
      `SELECT status,EXTRACT(EPOCH FROM (available_at-now())) AS available_in
       FROM deliveries WHERE id=$1`, [delivery!.delivery_id]
    );
    expect(row.rows[0]?.status).toBe('retry');
    // `available_at=now()` returned the delivery to the same saturated agent on the next tick:
    // it is the positive feedback of the incident, every death generating more load.
    expect(Number(row.rows[0]?.available_in)).toBeGreaterThan(timeoutRetryBackoffSeconds(1) - 5);
  });

  /**
   * THE case that caused user work to be lost, and that is why it comes before the cost-saving one.
   *
   * A 'started' ACK does NOT prove execution: the SDK emits it before calling the harness, and the
   * delivery can sit for minutes waiting on the session lock, renewing every 60 s, without having
   * spent a cent. The previous version of the reaper took it as proof and sent those deliveries to
   * `dead`: work requested by a human, lost forever, never having run.
   */
  it('retries a delivery that only ACKed started, because that is not proof of execution', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'waiting-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'waiting-1', lease.epoch!, 1, 30_000
    );
    await repository.ackDelivery(
      delivery!.delivery_id, consumerTenant, consumerAlias,
      ack(delivery!, 'waiting-1', lease.epoch!, 'started')
    );
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0, parked: 0 });
    expect((await pool.query<{ status: string; execution_started_at: Date | null }>(
      'SELECT status,execution_started_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    )).rows[0]).toMatchObject({ status: 'retry', execution_started_at: null });
  });

  it('holds a delivery that already started for manual review instead of paying the run twice', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-1', lease.epoch!, 1, 30_000
    );
    // Explicit mark from the SDK: the harness obtained the session turn and was invoked. THAT is
    // what it means that a run has already been paid for.
    await startExecution(delivery!, 'worker-1', lease.epoch!);
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 0, dead: 1, parked: 0 });

    const row = await pool.query<{ status: string; attempt: number; last_error: string }>(
      'SELECT status,attempt,last_error FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(row.rows[0]).toMatchObject({
      status: 'dead',
      // It did not consume an extra attempt: nothing was re-executed.
      attempt: 1,
      last_error: 'ACK timeout: execution already started; held for manual replay'
    });
    // `dead` + row in dead_letters is exactly what `replayDelivery` requires, so the
    // operator has the reenqueue button without it having been reenqueued on its own.
    expect((await pool.query(
      `SELECT 1 FROM dead_letters
       WHERE delivery_id=$1 AND reason='ACK timeout: execution already started; held for manual replay'`,
      [delivery!.delivery_id]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE delivery_id=$1 AND action='delivery.ack_timeout'
         AND metadata->>'reason'='execution_already_started'`,
      [delivery!.delivery_id]
    )).rowCount).toBe(1);
    // And above all: nobody can take it over again.
    // `takeover: true` on purpose: without it, acquireLease returns acquired:false WITHOUT epoch
    // (worker-1 still has the lease alive) and the next claim would go out with epoch undefined,
    // i.e. rejected by fencing -- which is correct, but would prove something different. What we
    // want to show here is that not even a legitimate consumer, with its own lease and a new epoch,
    // can claim a delivery held for manual review.
    const secondLease = await repository.acquireLease(
      consumerTenant, consumerAlias, 'worker-2', [], 30_000, { takeover: true }
    );
    expect(await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-2', secondLease.epoch!, 5, 30_000
    )).toHaveLength(0);
  });

  it('still relays the failure to the origin so the human is not left in silence', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-3', [], 30_000);
    await repository.publish(command({
      origin: {
        adapter: 'telegram', channel: 'dm', conversation_id: '42', relay: [], metadata: {}
      }
    }));
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-3', lease.epoch!, 1, 30_000
    );
    await startExecution(delivery!, 'worker-3', lease.epoch!);
    await expire(delivery!.delivery_id);

    await repository.retryStaleDeliveries(0);

    // "It stopped halfway" is a reply; silence is not. The system owner explicitly asked
    // to be able to know what happened, even if the answer is that it failed.
    const relay = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM adapter_outbox WHERE kind='origin_relay' AND delivery_id=$1`,
      [delivery!.delivery_id]
    );
    expect(relay.rowCount).toBe(1);
    expect(relay.rows[0]?.payload).toMatchObject({
      outcome: 'dead',
      error: 'ACK timeout: execution already started; held for manual replay'
    });
  });

  it('restores the blind retry when the emergency lever is on', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-4', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-4', lease.epoch!, 1, 30_000
    );
    await startExecution(delivery!, 'worker-4', lease.epoch!);
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0, 100, { retryStartedDeliveries: true }))
      .toEqual({ retried: 1, dead: 0, parked: 0 });
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    )).rows[0]?.status).toBe('retry');
  });

  it('scopes the started evidence to the current attempt', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-5', [], 30_000);
    await repository.publish(command());
    const [first] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-5', lease.epoch!, 1, 30_000
    );
    await startExecution(first!, 'worker-5', lease.epoch!);
    await expire(first!.delivery_id);
    // Force the retry of attempt 1 with the lever, to leave in delivery_acks a
    // 'started' applied from an OLD attempt. The backoff pushes available_at into the future, so
    // it has to be rehabilitated to be claimable inside the test.
    expect(await repository.retryStaleDeliveries(0, 100, { retryStartedDeliveries: true }))
      .toEqual({ retried: 1, dead: 0, parked: 0 });
    await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [first!.delivery_id]);

    const [second] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-5', lease.epoch!, 1, 30_000
    );
    expect(second?.attempt).toBe(2);
    await expire(second!.delivery_id);

    // Attempt 2 never started. The mark belongs to the attempt and is cleared both on
    // retry and on claim; without that, a delivery would be held forever by evidence from an
    // earlier run.
    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0, parked: 0 });
  });
});

describe('ack deadline bookkeeping', () => {
  /**
   * The FIRST 'started' also moves the deadline. Before, only renewals moved it, so
   * the database kept counting from the claim while the gateway -- which does move it on seeing
   * the ACK applied -- considered the claim alive longer than it actually was. The two views of
   * the same claim diverged by how long the startup took, and the gateway capacity was held
   * against a delivery the database could already hand back to the reaper.
   */
  it('moves the ack deadline on the first started, not only on renewals', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'deadline-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'deadline-1', lease.epoch!, 1, 5_000
    );
    const claimed = Date.parse(delivery!.ack_deadline_at);

    await repository.ackDelivery(
      delivery!.delivery_id, consumerTenant, consumerAlias,
      ack(delivery!, 'deadline-1', lease.epoch!, 'started'),
      60_000
    );

    const row = await pool.query<{ ack_deadline_at: Date; claim_expires_at: Date }>(
      'SELECT ack_deadline_at,claim_expires_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(row.rows[0]!.ack_deadline_at.getTime()).toBeGreaterThan(claimed);
    expect(row.rows[0]!.claim_expires_at.getTime())
      .toBe(row.rows[0]!.ack_deadline_at.getTime());
  });
});
