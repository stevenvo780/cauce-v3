import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AckSchema, HUMAN_CHAT_PRIORITY, TenantSchema, type PublishMessage,
} from '@cauce/protocol';
import {
  CauceRepository, createPool, subscribeDeliveryWakes, withTransaction, type DatabasePool
} from '@cauce/store';
import { PostgresTelegramBridgeRepository } from '../../services/telegram-bridge/src/repository.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'adversarial hardening' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(
    'TRUNCATE delivery_lane_fairness,job_lane_fairness,outbox_dead_letters CASCADE',
  );
  await pool.query(`
    DELETE FROM memberships WHERE tenant_id='Acme';
    DELETE FROM rooms WHERE tenant_id='Acme';
    DELETE FROM acl_edges WHERE from_tenant='Acme' OR to_tenant='Acme';
    DELETE FROM tenants WHERE id='Acme';
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE memberships SET role=CASE
      WHEN tenant_id='Steven' AND alias='kant' THEN 'operator' ELSE 'agent' END;
    UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false WHERE role='agent';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('adversarial PostgreSQL store hardening', () => {
  it('makes delivery claim token and attempt mandatory in the ACK protocol', () => {
    expect(AckSchema.safeParse({
      version: '3.0', status: 'done', instance_id: 'worker', epoch: 1
    }).success).toBe(false);
    expect(AckSchema.parse({
      version: '3.0', status: 'done', instance_id: 'worker', epoch: 1,
      event_id: randomUUID(), claim_token: randomUUID(), attempt: 1
    })).toMatchObject({ status: 'done', attempt: 1 });
  });

  it('serializes 20 initial lease racers and rejects reuse of the live instance id', async () => {
    const racers = Array.from({ length: 20 }, (_, index) =>
      repository.acquireLease('Isa', 'salva', `racer-${index}`, [], 10_000)
    );
    const results = await Promise.all(racers);
    const winners = results.map((result, index) => ({ result, index }))
      .filter(({ result }) => result.acquired);
    expect(winners).toHaveLength(1);
    const winner = `racer-${winners[0]!.index}`;
    expect(await repository.acquireLease('Isa', 'salva', winner, [], 10_000))
      .toMatchObject({ acquired: false, active_instance_id: winner });

    const takeover = await repository.acquireLease('Isa', 'salva', 'explicit-takeover', [], 10_000, {
      takeover: true
    });
    expect(takeover).toMatchObject({ acquired: true, epoch: 2 });
  });

  it('resumes the same stable instance and epoch only inside the configured window', async () => {
    const instanceId = 'stable-resume-worker';
    const initial = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['initial-capability'], 10_000
    );
    expect(initial).toMatchObject({ acquired: true, epoch: 1 });

    const liveResume = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(liveResume).toMatchObject({ acquired: true, epoch: initial.epoch });

    await pool.query(
      `UPDATE connection_leases
       SET lease_until=now()-interval '5 seconds'
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    const recentExpiredResume = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(recentExpiredResume).toMatchObject({ acquired: true, epoch: initial.epoch });

    const resumedRow = await pool.query<{
      instance_id: string;
      epoch: string;
      capabilities: string[];
      live: boolean;
    }>(
      `SELECT instance_id,epoch,capabilities,(lease_until > now()) AS live
       FROM connection_leases
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    expect(resumedRow.rows[0]).toMatchObject({
      instance_id: instanceId,
      epoch: String(initial.epoch),
      capabilities: ['renewable_delivery_claims_v1'],
      live: true
    });

    await pool.query(
      `UPDATE connection_leases
       SET lease_until=now()-interval '2 minutes'
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    const outsideWindow = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(outsideWindow).toMatchObject({
      acquired: true,
      epoch: initial.epoch! + 1
    });
  });

  it('renews only a live, exactly fenced started claim with a new ACK event', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'delivery-worker', [], 10_000);
    const published = await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'delivery-worker', lease.epoch!, 1, 5_000
    );
    expect(delivery).toMatchObject({
      delivery_id: published.delivery_ids[0], attempt: 1
    });

    const stale = await repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'delivery-worker', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: randomUUID(), attempt: delivery!.attempt, retryable: false
    });
    expect(stale).toMatchObject({ applied: false, status: 'leased' });

    const before = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    await repository.heartbeat('Isa', 'salva', 'delivery-worker', lease.epoch!, 60_000);
    const after = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(after.rows[0]!.ack_deadline_at.getTime()).toBe(before.rows[0]!.ack_deadline_at.getTime());

    await expect(repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt,
      retryable: false, result: { progress: 'initial' }
    }, 5_000)).resolves.toMatchObject({ applied: true, status: 'started' });

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()+interval '1 second',
           claim_expires_at=now()+interval '1 second'
       WHERE id=$1`,
      [delivery!.delivery_id]
    );
    const renewalEventId = randomUUID();
    await expect(repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: lease.epoch!,
      event_id: renewalEventId, claim_token: delivery!.claim_token, attempt: delivery!.attempt,
      retryable: false, result: { progress: 'heartbeat-only' }
    }, 5_000)).resolves.toMatchObject({ applied: true, status: 'started' });
    const renewed = await pool.query<{
      ack_deadline_at: Date;
      claim_expires_at: Date;
      last_ack_rank: number;
      result: Record<string, unknown>;
    }>(
      `SELECT ack_deadline_at,claim_expires_at,last_ack_rank,result
       FROM deliveries WHERE id=$1`,
      [delivery!.delivery_id]
    );
    expect(renewed.rows[0]).toMatchObject({
      last_ack_rank: 2,
      result: { progress: 'initial' }
    });
    expect(renewed.rows[0]!.ack_deadline_at.getTime() - Date.now()).toBeGreaterThan(4_000);
    expect(Math.abs(
      renewed.rows[0]!.ack_deadline_at.getTime()
      - renewed.rows[0]!.claim_expires_at.getTime()
    )).toBeLessThanOrEqual(5);

    await expect(repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: lease.epoch!,
      event_id: renewalEventId, claim_token: delivery!.claim_token, attempt: delivery!.attempt,
      retryable: false
    }, 60_000)).resolves.toMatchObject({
      applied: true,
      status: 'started',
      receipt: 'duplicate'
    });
    const afterDuplicate = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(afterDuplicate.rows[0]!.ack_deadline_at.getTime())
      .toBeGreaterThan(renewed.rows[0]!.ack_deadline_at.getTime());

    await expect(repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'other-worker', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt,
      retryable: false
    }, 60_000)).rejects.toMatchObject({ code: 'fenced' });
    const afterFenced = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(afterFenced.rows[0]!.ack_deadline_at.getTime())
      .toBe(afterDuplicate.rows[0]!.ack_deadline_at.getTime());

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()-interval '1 millisecond',
           claim_expires_at=now()-interval '1 millisecond'
       WHERE id=$1`,
      [
      delivery!.delivery_id
      ]
    );
    const late = await repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt,
      retryable: false
    }, 60_000);
    expect(late).toMatchObject({ applied: false, status: 'started' });
    const expired = await pool.query<{ ack_deadline_at: Date; claim_expires_at: Date }>(
      'SELECT ack_deadline_at,claim_expires_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(expired.rows[0]!.ack_deadline_at.getTime()).toBeLessThan(Date.now());
    expect(expired.rows[0]!.claim_expires_at.getTime()).toBeLessThan(Date.now());
    expect((await pool.query('SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND NOT applied', [
      delivery!.delivery_id
    ])).rowCount).toBe(2);
  });

  it('preserves ownership_lost when replaying a rejected renewal event', async () => {
    // This collision scenario deliberately keeps two deliveries live. Declare that durable
    // capacity explicitly; relying on the legacy direct-caller fallback of one would make the
    // second claim impossible and would test admission instead of event-id ownership.
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
       VALUES('Isa','salva',false,2)`,
    );
    const lease = await repository.acquireLease(
      'Isa', 'salva', 'renewal-replay-worker', [], 60_000,
      { requireDeclaredCapacity: true },
    );
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'renewal-replay-worker', lease.epoch!, 1, 30_000
    );
    if (!delivery) throw new Error('expected a renewal replay delivery');

    await expect(repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: lease.epoch!,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    }, 30_000)).resolves.toMatchObject({ applied: true, receipt: 'applied' });

    const appliedRenewal = AckSchema.parse({
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: lease.epoch!,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', appliedRenewal, 30_000
    )).resolves.toMatchObject({ applied: true, receipt: 'applied' });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', appliedRenewal, 30_000
    )).resolves.toMatchObject({ applied: true, receipt: 'duplicate' });

    await repository.publish(command());
    const [otherDelivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'renewal-replay-worker', lease.epoch!, 1, 30_000
    );
    if (!otherDelivery) throw new Error('expected a collision test delivery');
    await expect(repository.ackDelivery(otherDelivery.delivery_id, 'Isa', 'salva', {
      ...appliedRenewal,
      claim_token: otherDelivery.claim_token,
      attempt: otherDelivery.attempt
    }, 30_000)).resolves.toMatchObject({
      applied: false,
      receipt: 'ownership_lost'
    });

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()-interval '1 second',
           claim_expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [delivery.delivery_id]
    );
    const rejectedRenewal = AckSchema.parse({
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: lease.epoch!,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', rejectedRenewal, 30_000
    )).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost' });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', rejectedRenewal, 30_000
    )).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost' });
  });

  it('never retries an allowlisted ambiguity even when a direct store caller marks it retryable', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 10_000);
    const published = await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 5_000
    );
    if (!delivery) throw new Error('expected an ambiguity test delivery');
    const eventId = randomUUID();

    // La entrega tiene que HABER ARRANCADO para que su ambigüedad valga: `execution_started_at`
    // es lo que dice que el harness fue invocado y la cuota comprometida. Sin esa marca un
    // ambiguo ya no es terminal —murió antes de ejecutar, así que se reintenta— y este test
    // pasaba por el motivo equivocado: mataba en el intento 1 una entrega que nunca corrió.
    // Lo que sigue fijando, que es su intención original: con trabajo posiblemente pagado, ni
    // `retryable: true` de un llamador directo del store consigue un reintento.
    await repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'started',
      instance_id: 'ambiguous-worker',
      epoch: lease.epoch!,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false,
      execution_started: true
    }, 30_000);

    await expect(repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'failed',
      instance_id: 'ambiguous-worker',
      epoch: lease.epoch!,
      event_id: eventId,
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: true,
      error: 'execution may have completed before the transport failed',
      error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS'
    })).resolves.toEqual({
      delivery_id: delivery.delivery_id,
      status: 'dead',
      applied: true,
      receipt: 'applied'
    });

    expect((await pool.query<{
      status: string; last_ack_rank: number; terminal: boolean;
    }>(
      `SELECT status,last_ack_rank,terminal_at IS NOT NULL AS terminal
       FROM deliveries WHERE id=$1`,
      [delivery.delivery_id]
    )).rows[0]).toEqual({ status: 'dead', last_ack_rank: 3, terminal: true });
    expect((await pool.query<{ status: string; applied: boolean; payload: Record<string, unknown> }>(
      `SELECT status,applied,payload FROM delivery_acks WHERE event_id=$1`,
      [eventId]
    )).rows[0]).toEqual({
      status: 'failed',
      applied: true,
      payload: {
        retryable: true,
        error: 'execution may have completed before the transport failed',
        error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS'
      }
    });
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox WHERE delivery_id=$1 AND idempotency_key LIKE 'wake-retry:%'`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='delivery.ack' AND delivery_id=$1
         AND metadata->>'resulting_status'='dead'
         AND metadata->>'ambiguous_execution'='true'`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
    expect(published.delivery_ids).toContain(delivery.delivery_id);
  });

  it('cuts an open runtime lease when route permission is revoked', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'revoked-worker', [], 10_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'revoked-worker', lease.epoch!, 1, 5_000
    );
    await pool.query(`UPDATE role_policies SET allow_route=false WHERE role='agent'`);

    await expect(repository.heartbeat('Isa', 'salva', 'revoked-worker', lease.epoch!, 10_000))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.claimDeliveries('Isa', 'salva', 'revoked-worker', lease.epoch!, 1))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'revoked-worker', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt, retryable: false
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.acquireLease('Isa', 'salva', 'revoked-reconnect', [], 10_000))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT 1 FROM delivery_acks WHERE delivery_id=$1', [delivery!.delivery_id])).rowCount)
      .toBe(0);
  });

  it('makes event_id idempotent before applying a second lifecycle transition', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'event-worker', [], 10_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries('Isa', 'salva', 'event-worker', lease.epoch!, 1, 5_000);
    const eventId = randomUUID();
    const accepted = await repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', event_id: eventId, status: 'accepted', instance_id: 'event-worker', epoch: lease.epoch!,
      claim_token: delivery!.claim_token, attempt: delivery!.attempt, retryable: false
    });
    const replayedAsDone = await repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', event_id: eventId, status: 'done', instance_id: 'event-worker', epoch: lease.epoch!,
      claim_token: delivery!.claim_token, attempt: delivery!.attempt, retryable: false
    });
    expect(accepted).toMatchObject({ status: 'accepted', applied: true });
    expect(replayedAsDone).toMatchObject({ status: 'accepted', applied: false });
    expect((await pool.query('SELECT status FROM delivery_acks WHERE event_id=$1', [eventId])).rows)
      .toEqual([{ status: 'accepted' }]);
  });

  it('persists trusted session/channel/origin provenance', async () => {
    const origin = { adapter: 'telegram', channel: 'dm', conversation_id: 'chat-7', relay: [], metadata: {} };
    const published = await repository.publish(command({
      authenticated_context: { session_id: 'session-7', channel: 'telegram-dm', origin }
    }));
    const stored = await pool.query<{
      auth_session_id: string; auth_channel: string; origin: Record<string, unknown>;
    }>('SELECT auth_session_id,auth_channel,origin FROM messages WHERE id=$1', [published.message_id]);
    expect(stored.rows[0]).toEqual({
      auth_session_id: 'session-7', auth_channel: 'telegram-dm', origin
    });

    const lease = await repository.acquireLease('Isa', 'salva', 'origin-consumer', [], 10_000);
    const [delivery] = await repository.claimDeliveries('Isa', 'salva', 'origin-consumer', lease.epoch!, 1);
    await repository.ackDelivery(delivery!.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'origin-consumer', epoch: lease.epoch!,
      event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt, retryable: false
    });
    const [relay] = await repository.claimOutbox('origin_relay', 'origin-relay-worker', 1, 5_000, 'telegram');
    expect(relay).toMatchObject({
      kind: 'origin_relay', adapter: 'telegram', claimed_by: 'origin-relay-worker', delivery_id: delivery!.delivery_id
    });
    await pool.query(`UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 millisecond' WHERE id=$1`, [
      relay!.id
    ]);
    expect(await repository.status(undefined, undefined, 0)).toMatchObject({
      outbox_stuck_wake: 1,
      outbox_stuck_origin_relay: 1
    });
  });

  it('reaps an outbox crash and grants exactly one replacement claim', async () => {
    await repository.publish(command());
    const [first] = await repository.claimOutbox('wake', 'outbox-a', 1, 20);
    expect(first).toMatchObject({ attempts: 1, claimed_by: 'outbox-a' });
    await pool.query('SELECT pg_sleep(0.04)');
    expect(await repository.status(undefined, undefined, 0)).toMatchObject({
      outbox_stuck_wake: 1,
      outbox_stuck_origin_relay: 0
    });

    const raced = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      repository.claimOutbox('wake', `outbox-${index + 2}`, 1, 5_000)
    ));
    const replacement = raced.flat();
    expect(replacement).toHaveLength(1);
    expect(replacement[0]).toMatchObject({ event_id: first!.id, attempts: 2 });
    expect(replacement[0]!.claim_token).not.toBe(first!.claim_token);

    expect(await repository.ackOutbox({
      event_id: first!.id, attempt: first!.attempts, claim_token: first!.claim_token, status: 'sent'
    })).toEqual({ status: 'failed', applied: false });
    expect(await repository.ackOutbox({
      event_id: replacement[0]!.event_id,
      attempt: replacement[0]!.attempts,
      claim_token: replacement[0]!.claim_token,
      status: 'sent'
    })).toEqual({ status: 'sent', applied: true });
    expect((await pool.query(`SELECT 1 FROM adapter_outbox WHERE status='sent'`)).rowCount).toBe(1);

    await repository.publish(command({ body: { text: 'exhaust outbox' } }));
    await pool.query(`UPDATE adapter_outbox SET max_attempts=1 WHERE status='pending'`);
    const [exhausted] = await repository.claimOutbox('wake', 'outbox-dlq', 1, 5_000);
    expect(await repository.ackOutbox({
      event_id: exhausted!.event_id,
      attempt: exhausted!.attempt,
      claim_token: exhausted!.claim_token,
      status: 'retry',
      error: 'permanent adapter failure'
    })).toEqual({ status: 'dead', applied: true });
    expect((await pool.query('SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1', [
      exhausted!.id
    ])).rowCount).toBe(1);
  });

  it('claims wake outbox rows only for exact connected tenant and alias pairs', async () => {
    await repository.publish(command({
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      idempotency_key: `wake-filter-${randomUUID()}`
    }));
    const source = await pool.query<{ id: string }>(
      `SELECT id FROM adapter_outbox WHERE kind='wake' AND tenant_id='Isa' ORDER BY created_at LIMIT 1`
    );
    expect(source.rows).toHaveLength(1);
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,
         origin,payload,available_at,created_at
       )
       SELECT 'Pablo',adapter,kind,idempotency_key || ':other-tenant',request_id,message_id,
              delivery_id,trace_id,origin,
              jsonb_set(payload,'{recipient_alias}',to_jsonb('salva'::text)),available_at,
              created_at + interval '1 millisecond'
       FROM adapter_outbox WHERE id=$1`,
      [source.rows[0]!.id]
    );

    // Vacío e inválido fallan cerrados: ninguna fila cambia de estado ni consume un intento.
    await expect(repository.claimWakeOutbox('gateway-empty', [], 10, 5_000)).resolves.toEqual([]);
    await expect(repository.claimWakeOutbox('gateway-invalid', [
      { tenant_id: 'Pablo', alias: 'INVALID' }
    ], 10, 5_000)).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await pool.query<{ attempts: number }>(
      `SELECT attempts FROM adapter_outbox WHERE kind='wake' ORDER BY tenant_id`
    )).rows).toEqual([{ attempts: 0 }, { attempts: 0 }]);

    // El alias es deliberadamente igual en ambos tenants. Duplicar el selector no duplica el
    // resultado, y la fila del otro tenant permanece pendiente con attempts=0.
    const pablo = await repository.claimWakeOutbox('gateway-pablo', [
      { tenant_id: 'Pablo', alias: 'salva' },
      { tenant_id: 'Pablo', alias: 'salva' }
    ], 10, 5_000);
    expect(pablo).toHaveLength(1);
    expect(pablo[0]).toMatchObject({ tenant_id: 'Pablo', attempt: 1 });
    expect(pablo[0]!.payload).toMatchObject({ recipient_alias: 'salva' });
    expect((await pool.query<{ tenant_id: string; status: string; attempts: number }>(
      `SELECT tenant_id,status,attempts FROM adapter_outbox WHERE kind='wake' ORDER BY tenant_id`
    )).rows).toEqual([
      { tenant_id: 'Isa', status: 'pending', attempts: 0 },
      { tenant_id: 'Pablo', status: 'processing', attempts: 1 }
    ]);

    // Los locks siguen siendo los de la cola original: aun con varios gateways compitiendo por
    // el mismo par exacto, una fila sólo obtiene una garra.
    const raced = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      repository.claimWakeOutbox(`gateway-isa-${index}`, [{ tenant_id: 'Isa', alias: 'salva' }], 1, 5_000)
    ));
    expect(raced.flat()).toHaveLength(1);
    expect(raced.flat()[0]).toMatchObject({ tenant_id: 'Isa', attempt: 1 });
  });

  it('applies migration 005 and fences Telegram cursors', async () => {
    const telegram = new PostgresTelegramBridgeRepository(pool);
    await telegram.initializeCursor('900001', 'Steven', 'kant');
    const first = await telegram.acquirePollLease('900001', 'poller-a', 10_000);
    expect(first).toMatchObject({ owner_id: 'poller-a', epoch: 1 });
    await expect(telegram.acquirePollLease('900001', 'poller-b', 10_000)).resolves.toBeUndefined();
    await telegram.advanceCursor(first!, 7);
    await pool.query(`UPDATE channel_bridge_leases SET lease_until=now()-interval '1 millisecond'
      WHERE bot_id='900001'`);
    const replacement = await telegram.acquirePollLease('900001', 'poller-b', 10_000);
    expect(replacement).toMatchObject({ owner_id: 'poller-b', epoch: 2 });
    await expect(telegram.cursor(first!)).rejects.toThrow(/fenced/);
    await expect(telegram.cursor(replacement!)).resolves.toBe(7);
  });

  it('bounds pool readiness waits and survives ten backend-loss cycles without unhandled rejection', async () => {
    const bounded = createPool(database.url, {
      max: 1,
      connectionTimeoutMillis: 75,
      applicationName: 'cauce-readiness-test'
    });
    const held = await bounded.connect();
    try {
      const startedAt = Date.now();
      await expect(bounded.query('SELECT 1')).rejects.toThrow(/timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      held.release();
      await bounded.end();
    }

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let cycle = 0; cycle < 10; cycle += 1) {
        let reportPid!: (pid: number) => void;
        const pid = new Promise<number>((resolve) => {
          reportPid = resolve;
        });
        const transaction = withTransaction(pool, async (client) => {
          const selected = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          reportPid(selected.rows[0]!.pid);
          await client.query('SELECT pg_sleep(30)');
        }).then(
          () => ({ resolved: true, error: undefined }),
          (error: unknown) => ({ resolved: false, error })
        );
        const backendPid = await pid;
        if (cycle === 4 || cycle === 9) {
          await database.container.restart({ timeout: 0 }); const containerHost = database.container.getHost();
          if (containerHost !== 'external') {
            const nextUrl = new URL(database.url); const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
            nextUrl.hostname = network ? database.container.getIpAddress(network) : containerHost;
            nextUrl.port = String(network ? 5432 : database.container.getMappedPort(5432));
            if (nextUrl.href !== database.url) {
              await pool.end(); database.url = nextUrl.href; pool = createPool(database.url);
              repository = new CauceRepository(pool);
            }
          }
        } else {
          await pool.query('SELECT pg_terminate_backend($1)', [backendPid]);
        }
        const outcome = await transaction; expect(outcome.resolved).toBe(false); expect(outcome.error).toBeDefined();
        await waitFor(() => pool.query('SELECT 1').then(() => true), 60_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 180_000);

  it('rejects stale job tokens after expiry and reclaims with a new token', async () => {
    const id = await repository.enqueueJob('Steven', 'batch', 0, 'token-test', { value: 1 });
    const [first] = await repository.claimJobs('batch', 'job-worker', 1, 20);
    await pool.query('SELECT pg_sleep(0.04)');
    expect(await repository.completeJob(id, 'job-worker', first!.claim_token)).toBe(false);
    expect(await repository.retryExpiredJobs()).toBe(1);
    await pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [id]);
    const [second] = await repository.claimJobs('batch', 'job-worker', 1, 5_000);
    expect(second!.claim_token).not.toBe(first!.claim_token);
    expect(await repository.completeJob(id, 'job-worker', first!.claim_token)).toBe(false);
    expect(await repository.completeJob(id, 'job-worker', second!.claim_token)).toBe(true);
  });

  it('reconnects the LISTEN supervisor after PostgreSQL terminates its backend', async () => {
    let connected = 0;
    const notices: Array<{ tenant_id: string; alias: string }> = [];
    const stop = await subscribeDeliveryWakes(pool, (notice) => notices.push(notice), {
      minBackoffMs: 10,
      maxBackoffMs: 50,
      onStateChange: (state) => {
        if (state === 'connected') connected += 1;
      }
    });
    try {
      const listener = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND query='LISTEN cauce_delivery_wake'
         ORDER BY backend_start DESC LIMIT 1`
      );
      expect(listener.rows[0]?.pid).toBeTypeOf('number');
      await pool.query('SELECT pg_terminate_backend($1)', [listener.rows[0]!.pid]);
      await waitFor(() => connected >= 2);
      await pool.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake', JSON.stringify({ tenant_id: 'Isa', alias: 'salva' })
      ]);
      await waitFor(() => notices.length === 1);
      expect(notices).toEqual([{ tenant_id: 'Isa', alias: 'salva' }]);
    } finally {
      await stop();
    }
  });

  it('transactionally gives batch quota under continuous interactive traffic', async () => {
    const batchJob = await repository.enqueueJob('Steven', 'batch', 0, 'batch', {});
    const jobOrder: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await repository.enqueueJob('Steven', 'interactive', 100, 'interactive', { index });
      const [job] = await repository.claimFairJobs('fair-worker', 1, 5_000, 2, 'test-jobs');
      jobOrder.push(job!.id);
      await repository.completeJob(job!.id, 'fair-worker', job!.claim_token);
    }
    expect(jobOrder.slice(0, 3)).toContain(batchJob);

    const lease = await repository.acquireLease('Pablo', 'midas', 'fair-delivery', [], 10_000);
    // `agent.message` is an internal materialization and is correctly rejected by publish().
    // Seed that already-authorized hop at the persistence boundary, as the agent-output path
    // would do. Delivery fairness is classified by provenance, not by the inherited lane.
    const batchMessage = await pool.query<{ id: string }>(
      `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
       VALUES($1,$2,'Steven','grp.steven','kant',$3::jsonb,'batch',0) RETURNING id`,
      [randomUUID(), `trace-${randomUUID()}`, JSON.stringify({
        type: 'agent.message', text: 'background agent work', from_alias: 'kant'
      })]
    );
    await pool.query(
      `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
       VALUES($1,'Pablo','midas')`,
      [batchMessage.rows[0]!.id]
    );
    const deliveryOrder: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await repository.publish(command({
        recipients: [{ tenant_id: 'Pablo', alias: 'midas' }],
        // `claimDeliveries` receives priority only after trusted ingress policy. At this direct
        // store boundary, seed the resulting human band explicitly; body shape and lane are not
        // authority and priority 0 correctly belongs to the non-human class.
        lane: 'interactive', priority: HUMAN_CHAT_PRIORITY, body: { index }
      }));
      const [delivery] = await repository.claimDeliveries(
        'Pablo', 'midas', 'fair-delivery', lease.epoch!, 1, 5_000, 2
      );
      deliveryOrder.push(delivery!.message_id);
      await repository.ackDelivery(delivery!.delivery_id, 'Pablo', 'midas', {
        version: '3.0', status: 'done', instance_id: 'fair-delivery', epoch: lease.epoch!,
        event_id: randomUUID(), claim_token: delivery!.claim_token, attempt: delivery!.attempt, retryable: false
      });
    }
    expect(deliveryOrder.slice(0, 3)).toContain(batchMessage.rows[0]!.id);
  });

  it('enforces the data-driven hub-star in ACLs and delivery inserts even for operators', async () => {
    await pool.query(`UPDATE memberships SET role='operator'
      WHERE tenant_id='Isa' AND room_id='grp.isa' AND alias='salva'`);

    await expect(pool.query(`INSERT INTO acl_edges(
      from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control
    ) VALUES('Isa','Jhon',true,true,true,true)`)).rejects.toMatchObject({ code: '23514' });
    await expect(repository.publish(command({
      tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
      recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }]
    }))).rejects.toMatchObject({ code: 'forbidden' });

    await expect(pool.query(
      `WITH routed_message AS (
         INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
         VALUES($1,$2,'Isa','grp.isa','salva',$3::jsonb,'interactive',0)
         RETURNING id
       )
       INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
       SELECT id,'Jhon','hegel' FROM routed_message`,
      [randomUUID(), `trace-${randomUUID()}`, JSON.stringify({ text: 'DB routing backstop' })]
    )).rejects.toMatchObject({ code: '23514' });

    await expect(repository.publish(command({
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }]
    }))).resolves.toMatchObject({ duplicate: false });
    await expect(repository.publish(command({
      tenant_id: 'Isa', room_id: 'grp.isa', actor_alias: 'salva',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }]
    }))).resolves.toMatchObject({ duplicate: false });
  });

  it('separates ACL policies and exposes only actual cross-hub participants', async () => {
    const shared = await repository.publish(command({
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }, { tenant_id: 'Jhon', alias: 'hegel' }]
    }));
    const isa = await repository.getMessage(shared.message_id, 'Isa', 'salva');
    const jhon = await repository.getMessage(shared.message_id, 'Jhon', 'hegel');
    expect(isa.deliveries).toEqual([
      expect.objectContaining({ tenant_id: 'Isa', alias: 'salva' })
    ]);
    expect(jhon.deliveries).toEqual([
      expect.objectContaining({ tenant_id: 'Jhon', alias: 'hegel' })
    ]);

    const jhonOnly = await repository.publish(command({
      recipients: [{ tenant_id: 'Jhon', alias: 'hegel' }]
    }));
    await expect(repository.getMessage(jhonOnly.message_id, 'Isa', 'salva'))
      .rejects.toMatchObject({ code: 'not_found' });

    await pool.query(`UPDATE acl_edges SET allow_read=false WHERE from_tenant='Isa' AND to_tenant='Steven'`);
    await expect(repository.getMessage(shared.message_id, 'Isa', 'salva'))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.assertPermission('Isa', 'salva', 'control'))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.assertPermission('Steven', 'kant', 'control')).resolves.toBeUndefined();

    await pool.query(`
      INSERT INTO tenants(id) VALUES('Acme');
      INSERT INTO rooms(id,tenant_id) VALUES('grp.acme','Acme');
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Acme','grp.acme','acmebot','agent');
      INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
        VALUES('Steven','Acme',true,true,true,false),('Acme','Steven',true,false,true,false);
    `);
    expect(TenantSchema.parse('Acme')).toBe('Acme');
    expect((await pool.query(`SELECT is_hub FROM tenants WHERE id='Steven'`)).rows[0]).toEqual({ is_hub: true });
    const dynamic = await repository.publish(command({
      recipients: [{ tenant_id: 'Acme', alias: 'acmebot' }]
    }));
    await expect(repository.getMessage(dynamic.message_id, 'Acme', 'acmebot')).resolves.toMatchObject({
      id: dynamic.message_id
    });
  });
});
