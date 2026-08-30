import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const ACK_DEADLINE_MS = 60_000;

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-retention-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'retención de observabilidad' },
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 0
  };
}

function ack(
  delivery: DeliveryEnvelope,
  epoch: number,
  status: Ack['status'],
  executionStarted = false
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: 'retention-consumer',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...(executionStarted ? { execution_started: true } : {})
  };
}

/** One delivery in 'started' plus `renewals` heartbeats on top —the real mix in the table. */
async function deliveryWithRenewals(epoch: number, renewals: number): Promise<DeliveryEnvelope> {
  await repository.publish(command());
  const [claimed] = await repository.claimDeliveries(
    'Isa', 'salva', 'retention-consumer', epoch, 1, ACK_DEADLINE_MS
  );
  if (!claimed) throw new Error('expected a claimed delivery');
  await repository.ackDelivery(
    claimed.delivery_id, 'Isa', 'salva', ack(claimed, epoch, 'accepted'), ACK_DEADLINE_MS
  );
  await repository.ackDelivery(
    claimed.delivery_id, 'Isa', 'salva', ack(claimed, epoch, 'started', true), ACK_DEADLINE_MS
  );
  for (let index = 0; index < renewals; index += 1) {
    await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, epoch, 'started', true), ACK_DEADLINE_MS
    );
  }
  return claimed;
}

async function count(sql: string, parameters: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(sql, parameters);
  return Number(result.rows[0]?.n ?? 0);
}

async function ageEverything(interval: string): Promise<void> {
  await pool.query(`UPDATE delivery_acks SET created_at=now()-interval '${interval}'`);
  await pool.query(`UPDATE audit_events SET created_at=now()-interval '${interval}'`);
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true,allow_read=true WHERE role='agent';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('retención por tipo de la observabilidad', () => {
  it('marca como renovación sólo los latidos, no la transición a started', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 3);

    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks WHERE renewal`)).toBe(3);
    // accepted + the first started: they are state transitions and last forever.
    expect(await count(
      `SELECT count(*)::text AS n FROM delivery_acks WHERE NOT renewal`
    )).toBe(2);
  });

  /**
   * THE POINT OF THE PATCH. With the SAME age, heartbeats go and transitions stay.
   * Plain age-based deletion would take all five rows or none.
   */
  it('borra los latidos viejos y conserva las transiciones de la misma edad', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 4);
    await ageEverything('8 hours');

    const pruned = await repository.pruneObservability({
      ackRenewalMs: 6 * 60 * 60_000,
      ackMs: 14 * 24 * 60 * 60_000,
      auditRenewalMs: 6 * 60 * 60_000,
      auditMs: 30 * 24 * 60 * 60_000
    });

    expect(pruned.ack_renewals).toBe(4);
    expect(pruned.acks).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks`)).toBe(2);
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks WHERE renewal`)).toBe(0);
  });

  it('poda las renovaciones históricas de audit_events sin columna nueva', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 4);
    const renewalAudits = await count(
      `SELECT count(*)::text AS n FROM audit_events WHERE metadata->>'lease_renewed'='true'`
    );
    const otherAudits = await count(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE metadata->>'lease_renewed' IS DISTINCT FROM 'true'`
    );
    expect(renewalAudits).toBe(4);
    expect(otherAudits).toBeGreaterThan(0);
    await ageEverything('8 hours');

    const pruned = await repository.pruneObservability({
      ackRenewalMs: 6 * 60 * 60_000,
      auditRenewalMs: 6 * 60 * 60_000
    });

    expect(pruned.audit_renewals).toBe(renewalAudits);
    expect(pruned.audit_events).toBe(0);
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_events WHERE metadata->>'lease_renewed'='true'`
    )).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM audit_events`)).toBe(otherAudits);
  });

  it('no toca nada que siga dentro de su ventana', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 4);
    const acksBefore = await count(`SELECT count(*)::text AS n FROM delivery_acks`);
    const auditBefore = await count(`SELECT count(*)::text AS n FROM audit_events`);
    await ageEverything('2 hours');

    expect(await repository.pruneObservability({ ackRenewalMs: 6 * 60 * 60_000 }))
      .toEqual({ ack_renewals: 0, acks: 0, audit_renewals: 0, audit_events: 0 });
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks`)).toBe(acksBefore);
    expect(await count(`SELECT count(*)::text AS n FROM audit_events`)).toBe(auditBefore);
  });

  /**
   * The long window does take the transitions too. It is what recovers the backlog of pre-migration
   * rows that cannot be reclassified as heartbeats.
   */
  it('la ventana general también se lleva las transiciones cuando ya son muy viejas', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 2);
    await ageEverything('40 days');

    // accepted + the first started + the 2 heartbeats.
    const pruned = await repository.pruneObservability();
    expect(pruned.ack_renewals + pruned.acks).toBe(4);
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks`)).toBe(0);
    // From `audit_events` only the whitelist telemetry is removed; `message.publish` and company
    // survive because they are not a log, they are state.
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_events WHERE action='delivery.ack'`
    )).toBe(0);
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_events WHERE action='message.publish'`
    )).toBeGreaterThan(0);
  });

  /**
   * There is never an unbounded DELETE on a live database: the first sweep over a large backlog
   * takes one batch and comes back on the next tick.
   */
  it('acota cada barrido al tamaño de lote configurado', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'retention-consumer', [], 120_000);
    await deliveryWithRenewals(requireValue(lease.epoch, 'lease.epoch'), 5);
    await ageEverything('8 hours');

    expect((await repository.pruneObservability({ batch: 2 })).ack_renewals).toBe(2);
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks WHERE renewal`)).toBe(3);
    expect((await repository.pruneObservability({ batch: 2 })).ack_renewals).toBe(2);
    expect((await repository.pruneObservability({ batch: 2 })).ack_renewals).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM delivery_acks WHERE renewal`)).toBe(0);
  });

  /**
   * `audit_events` is NOT a log: it is state on which correctness guards depend. A plain
   * age-based DELETE would break the replay idempotency lock (a dead letter reenqueued after 31
   * days would be cloned twice) and the agent-to-agent chain's trust mark, silently and with
   * weeks of delay. That is why pruning is a WHITELIST.
   */
  it('nunca borra los audit_events de los que dependen las guardas, por viejos que sean', async () => {
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    for (const action of ['delivery.replay', 'agent_output.response', 'message.publish']) {
      await pool.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id,delivery_id,metadata,created_at)
         VALUES('Steven','kant',$1,'allow',$2,$3,'{}'::jsonb,now()-interval '400 days')`,
        [action, messageId, deliveryId]
      );
    }
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata,created_at)
       VALUES('Steven','kant','delivery.ack','allow','{}'::jsonb,now()-interval '400 days')`
    );

    const pruned = await repository.pruneObservability();

    // Only the telemetry left, even though the four rows have the same age.
    expect(pruned.audit_events).toBe(1);
    const survivors = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events ORDER BY action`
    );
    expect(survivors.rows.map((row) => row.action))
      .toEqual(['agent_output.response', 'delivery.replay', 'message.publish']);
  });

  it('rechaza una ventana de renovaciones más larga que la general', async () => {
    await expect(repository.pruneObservability({
      ackRenewalMs: 10 * 24 * 60 * 60_000,
      ackMs: 24 * 60 * 60_000
    })).rejects.toMatchObject({
      code: 'conflict',
      message: 'renewal retention window cannot exceed the general retention window'
    });
  });
});
