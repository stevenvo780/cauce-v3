import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

// Per-agent concurrency cap (agents.max_concurrent_deliveries).
//
// What is being protected, measured in production: the gateway claimed 20 at a time per drain
// while the harness runs ONE per sessionKey. argos reached 92 in-flight deliveries executing 2,
// with a median wait of 3 hours and 73% dead without ever being executed. Claiming is not free:
// it starts ack_deadline_at, and that clock runs while delivery queues behind the harness mutex.
//
// These tests pin down the two halves of the contract, because one without the other is worse
// than doing nothing: (1) nothing is claimed above the cap, and (2) what is NOT claimed stays
// claimable — it remains 'pending', untouched and without having spent an attempt.

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

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
});

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'work' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  return { tenant, alias, instanceId, epoch: lease.epoch! };
}

/**
 * `resetTestDatabase` truncates `agents`, so by default no alias has a row. Claiming in that
 * state fails closed: a consumer must declare its durable capacity. Each test explicitly declares
 * the agent it wants to cap. It is inserted with enabled=false and without placement so as not to
 * drag in the agents_enabled_requires_runtime or agents_placement_atomic constraints, which have
 * nothing to do with what is being tested.
 */
async function declareAgent(
  tenant: Tenant, alias: string, maxConcurrent: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
     VALUES($1,$2,false,$3)
     ON CONFLICT(tenant_id,alias) DO UPDATE SET max_concurrent_deliveries=EXCLUDED.max_concurrent_deliveries`,
    [tenant, alias, maxConcurrent]
  );
}

async function publishMany(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repository.publish(command({ body: { text: `work ${index}` } }));
  }
}

async function statusCounts(alias: string): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; total: string }>(
    `SELECT status, count(*) AS total FROM deliveries
     WHERE recipient_alias=$1 GROUP BY status`, [alias]
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.total)]));
}

function terminalAck(target: Consumer, delivery: { claim_token: string; attempt: number }): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply: 'ok', messages: [], status: 'done', retryable: false, artifacts: [] } }
  };
}

function progressAck(
  target: Consumer,
  delivery: { claim_token: string; attempt: number },
  status: 'accepted' | 'started'
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false
  };
}

describe('per-agent delivery concurrency cap', () => {
  it('never hands out more than the agent can execute, however much is queued', async () => {
    // The exact case of the miniature incident: a large queue, a single generous drain.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    // Before the fix this returned 9: the requested limit, not the executable one.
    expect(claimed).toHaveLength(2);
  });

  it('leaves everything it did not claim as pending, with no attempt spent', async () => {
    // The half that really matters. A cap that claimed less but broke or mis-queued the rest
    // would be a change worse than the problem: that is where the backlog goes up in smoke.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    await repository.claimDeliveries(argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000);

    expect(await statusCounts('argos')).toEqual({ leased: 2, pending: 7 });
    const attempts = await pool.query<{ attempt: number }>(
      `SELECT DISTINCT attempt FROM deliveries WHERE recipient_alias='argos' AND status='pending'`
    );
    // No attempt spent and no ACK clock running on what was not claimed.
    expect(attempts.rows).toEqual([{ attempt: 0 }]);
    const armed = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM deliveries
       WHERE recipient_alias='argos' AND status='pending' AND ack_deadline_at IS NOT NULL`
    );
    expect(Number(armed.rows[0]!.total)).toBe(0);
  });

  it('counts what is already in flight, so repeated drains cannot stack past the cap', async () => {
    // A single bounded claim is not enough: the gateway drains many times (wake, ACK, reconnect).
    await declareAgent('Steven', 'argos', 3);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const first = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const second = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const third = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(await statusCounts('argos')).toEqual({ leased: 3, pending: 6 });
  });

  it('serializes a claim with a concurrent durable cap reduction', async () => {
    await declareAgent('Steven', 'argos', 2);
    await publishMany(2);
    const argos = await consumer('Steven', 'argos');
    const configuration = await pool.connect();
    let settled = false;
    try {
      await configuration.query('BEGIN');
      await configuration.query(
        `SELECT 1 FROM agents WHERE tenant_id='Steven' AND alias='argos' FOR UPDATE`,
      );
      await configuration.query(
        `UPDATE agents SET max_concurrent_deliveries=1
          WHERE tenant_id='Steven' AND alias='argos'`,
      );

      const claiming = repository.claimDeliveries(
        argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000,
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);

      await configuration.query('COMMIT');
      const claimed = await claiming;
      expect(claimed).toHaveLength(1);
      expect(await statusCounts('argos')).toEqual({ leased: 1, pending: 1 });
    } finally {
      if (!settled) await configuration.query('ROLLBACK').catch(() => undefined);
      configuration.release();
    }
  });

  it('keeps counting a delivery the harness has accepted or started', async () => {
    // 'accepted' and 'started' are real occupancy: the harness already has it. If the count only
    // looked at 'leased', the first progress ACK would free a false slot and bring back over-claim.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(6);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(claimed).toHaveLength(2);

    await repository.ackDelivery(claimed[0]!.delivery_id, argos.tenant, argos.alias,
      progressAck(argos, claimed[0]!, 'accepted'), 30_000);
    await repository.ackDelivery(claimed[1]!.delivery_id, argos.tenant, argos.alias,
      progressAck(argos, claimed[1]!, 'started'), 30_000);
    expect(await statusCounts('argos')).toEqual({ accepted: 1, started: 1, pending: 4 });

    const afterProgress = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterProgress).toHaveLength(0);
  });

  it('hands out the next batch as soon as a terminal ACK frees the slot', async () => {
    // Drainage. If this does not happen, the cap stops being a cap and becomes a clog.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(5);
    const argos = await consumer('Steven', 'argos');

    const first = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(first).toHaveLength(2);

    await repository.ackDelivery(
      first[0]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, first[0]!), 30_000
    );

    const afterOne = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterOne).toHaveLength(1);

    await repository.ackDelivery(
      first[1]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, first[1]!), 30_000
    );
    await repository.ackDelivery(
      afterOne[0]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, afterOne[0]!), 30_000
    );

    const afterTwo = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterTwo).toHaveLength(2);

    // All 5 reached execution. None was lost or died waiting.
    const delivered = new Set([...first, ...afterOne, ...afterTwo].map((item) => item.delivery_id));
    expect(delivered.size).toBe(5);
  });

  it('does not let an expired durable claim block the alias when the dispatcher is absent', async () => {
    await declareAgent('Steven', 'argos', 1);
    await publishMany(2);
    const argos = await consumer('Steven', 'argos');
    const first = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000,
    );
    expect(first).toHaveLength(1);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1`,
      [first[0]!.delivery_id],
    );

    // No dispatcher/reaper runs between the two claims. The expired ownership is no longer a
    // live concurrency slot, so the pending delivery must still progress.
    const afterExpiry = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000,
    );
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]?.delivery_id).not.toBe(first[0]?.delivery_id);
    expect(await statusCounts('argos')).toEqual({ leased: 2 });
  });

  it('rejects a consumer that has no durable capacity row', async () => {
    // Fail-open turned a broken inventory into unlimited capacity. A lease is not enough to
    // invent how much work an alias can run.
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    await expect(repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000, 3,
      { requireDeclaredCapacity: true },
    )).rejects.toMatchObject({
      code: 'conflict',
      message: 'delivery consumer is missing its durable agent capacity',
    });
  });

  it('treats a NULL cap as unlimited, the in-place escape hatch', async () => {
    // Rollback without deploy: UPDATE agents SET max_concurrent_deliveries=NULL.
    await declareAgent('Steven', 'argos', null);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    expect(claimed).toHaveLength(9);
  });

  it('still applies a gateway general capacity when the agent cap is explicitly NULL', async () => {
    await declareAgent('Steven', 'argos', null);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 9, 30_000, 3,
      { generalCapacity: 2, humanReservedCapacity: 0, maxClaims: 9 },
    );

    expect(claimed).toHaveLength(2);
    expect(await statusCounts('argos')).toEqual({ leased: 2, pending: 7 });
  });

  it('still honours a caller limit below the cap', async () => {
    // The cap bounds, it does not replace. A caller that asks for less still gets less.
    await declareAgent('Steven', 'argos', 5);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 1, 30_000
    );

    expect(claimed).toHaveLength(1);
  });

  it('caps each agent independently', async () => {
    // The cap belongs to the agent, not the installation: a full agent cannot slow another down.
    await declareAgent('Steven', 'argos', 1);
    await declareAgent('Steven', 'jarvis', 3);
    for (let index = 0; index < 5; index += 1) {
      await repository.publish(command({
        recipients: [
          { tenant_id: 'Steven', alias: 'argos' },
          { tenant_id: 'Steven', alias: 'jarvis' }
        ]
      }));
    }
    const argos = await consumer('Steven', 'argos');
    const jarvis = await consumer('Steven', 'jarvis');

    const argosClaim = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const jarvisClaim = await repository.claimDeliveries(
      jarvis.tenant, jarvis.alias, jarvis.instanceId, jarvis.epoch, 20, 30_000
    );

    expect(argosClaim).toHaveLength(1);
    expect(jarvisClaim).toHaveLength(3);
  });

  it('wakes the recipient when the reaper kills the last in-flight delivery', async () => {
    // The last path that frees a slot: not an ACK, but the reaper running out the ownership.
    // The retry branch already enqueued a wake; the 'dead' branch did not. Without a cap this was
    // harmless — the previous claim had already taken the queue. With a cap, an alias whose
    // in-flight deliveries all die from timeout is left with a free slot, no ACK ever arriving
    // (that is why they expired) and the queue idle until someone publishes a new message.
    await declareAgent('Steven', 'argos', 1);
    await publishMany(4);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(claimed).toHaveLength(1);

    // Exhausts the attempts to force the 'dead' branch instead of the retry one.
    await pool.query(
      `UPDATE deliveries SET attempt=max_attempts WHERE id=$1`, [claimed[0]!.delivery_id]
    );
    const reaped = await repository.retryStaleDeliveries(0, 100);
    expect(reaped.dead).toBe(1);

    const wakes = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM adapter_outbox
       WHERE kind='wake' AND idempotency_key LIKE 'wake-dead:%'
         AND payload->>'recipient_alias'='argos'`
    );
    expect(Number(wakes.rows[0]!.total)).toBe(1);

    // And the freed slot is really claimable.
    const afterReap = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterReap).toHaveLength(1);
  });

  it('does not let concurrent claims for the same alias exceed the cap together', async () => {
    // Two simultaneous drains of the same alias (a wake and an ACK, for example) read and claim
    // in different transactions. What prevents both of them from seeing in_flight=0 and claiming
    // the entire cap is the FOR UPDATE on delivery_lane_fairness, keyed by (tenant_id, alias),
    // which already serializes the pair BEFORE the count. This test pins down that guarantee.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(12);
    const argos = await consumer('Steven', 'argos');

    const results = await Promise.all(Array.from({ length: 4 }, async () => repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    )));

    const total = results.reduce((sum, batch) => sum + batch.length, 0);
    expect(total).toBe(2);
    expect(await statusCounts('argos')).toEqual({ leased: 2, pending: 10 });
  });
});
