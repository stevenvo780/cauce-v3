import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN_CHAT_PRIORITY, TenantSchema } from '@cauce/protocol';
import {
  CauceRepository, createPool, subscribeDeliveryWakes, withTransaction, type DatabasePool
} from '@cauce/store';
import { PostgresTelegramBridgeRepository } from '../../services/telegram-bridge/src/repository.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../helpers/postgres.js';
import { command, waitFor } from './adversarial-postgres-helpers.js';
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000, ['makes delivery claim token and attempt mandatory in the ACK protocol']);
beforeEach(async () => {
  if (!databaseStarted) return;
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
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('adversarial PostgreSQL store hardening', () => {
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
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    const [delivery] = await repository.claimDeliveries('Isa', 'salva', 'origin-consumer', leaseEpoch, 1);
    if (!delivery) throw new Error('delivery not claimed');
    await repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'origin-consumer', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false
    });
    const [relay] = await repository.claimOutbox('origin_relay', 'origin-relay-worker', 1, 5_000, 'telegram');
    if (!relay) throw new Error('relay not claimed');
    expect(relay).toMatchObject({
      kind: 'origin_relay', adapter: 'telegram', claimed_by: 'origin-relay-worker', delivery_id: delivery.delivery_id
    });
    await pool.query(`UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 millisecond' WHERE id=$1`, [
      relay.id
    ]);
    expect(await repository.status(undefined, undefined, 0)).toMatchObject({
      outbox_stuck_wake: 1,
      outbox_stuck_origin_relay: 1
    });
  });

  it('reaps an outbox crash and grants exactly one replacement claim', async () => {
    await repository.publish(command());
    const [first] = await repository.claimOutbox('wake', 'outbox-a', 1, 20);
    if (!first) throw new Error('first outbox not claimed');
    expect(first).toMatchObject({ attempts: 1, claimed_by: 'outbox-a' });
    await pool.query('SELECT pg_sleep(0.04)');
    expect(await repository.status(undefined, undefined, 0)).toMatchObject({
      outbox_stuck_wake: 1,
      outbox_stuck_origin_relay: 0
    });

    const raced = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      repository.claimOutbox('wake', `outbox-${String(index + 2)}`, 1, 5_000)
    ));
    const replacement = raced.flat();
    expect(replacement).toHaveLength(1);
    const rep0 = replacement[0];
    if (!rep0) throw new Error('replacement outbox not claimed');
    expect(rep0).toMatchObject({ event_id: first.id, attempts: 2 });
    expect(rep0.claim_token).not.toBe(first.claim_token);

    expect(await repository.ackOutbox({
      event_id: first.id, attempt: first.attempts, claim_token: first.claim_token, status: 'sent'
    })).toEqual({ status: 'failed', applied: false });
    expect(await repository.ackOutbox({
      event_id: rep0.event_id,
      attempt: rep0.attempts,
      claim_token: rep0.claim_token,
      status: 'sent'
    })).toEqual({ status: 'sent', applied: true });
    expect((await pool.query(`SELECT 1 FROM adapter_outbox WHERE status='sent'`)).rowCount).toBe(1);

    await repository.publish(command({ body: { text: 'exhaust outbox' } }));
    await pool.query(`UPDATE adapter_outbox SET max_attempts=1 WHERE status='pending'`);
    const [exhausted] = await repository.claimOutbox('wake', 'outbox-dlq', 1, 5_000);
    if (!exhausted) throw new Error('exhausted outbox not claimed');
    expect(await repository.ackOutbox({
      event_id: exhausted.event_id,
      attempt: exhausted.attempt,
      claim_token: exhausted.claim_token,
      status: 'retry',
      error: 'permanent adapter failure'
    })).toEqual({ status: 'dead', applied: true });
    expect((await pool.query('SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1', [
      exhausted.id
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
    const sourceRow = source.rows[0];
    if (!sourceRow) throw new Error('Expected source row');
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
      [sourceRow.id]
    );

    // Empty and invalid fail closed: no row changes state or consumes an attempt.
    await expect(repository.claimWakeOutbox('gateway-empty', [], 10, 5_000)).resolves.toEqual([]);
    await expect(repository.claimWakeOutbox('gateway-invalid', [
      { tenant_id: 'Pablo', alias: 'INVALID' }
    ], 10, 5_000)).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await pool.query<{ attempts: number }>(
      `SELECT attempts FROM adapter_outbox WHERE kind='wake' ORDER BY tenant_id`
    )).rows).toEqual([{ attempts: 0 }, { attempts: 0 }]);

    // The alias is deliberately the same across both tenants. Duplicating the selector does
    // not duplicate the result, and the other tenant's row stays pending with attempts=0.
    const pablo = await repository.claimWakeOutbox('gateway-pablo', [
      { tenant_id: 'Pablo', alias: 'salva' },
      { tenant_id: 'Pablo', alias: 'salva' }
    ], 10, 5_000);
    expect(pablo).toHaveLength(1);
    const pablo0 = pablo[0];
    if (!pablo0) throw new Error('Expected pablo[0]');
    expect(pablo0).toMatchObject({ tenant_id: 'Pablo', attempt: 1 });
    expect(pablo0.payload).toMatchObject({ recipient_alias: 'salva' });
    expect((await pool.query<{ tenant_id: string; status: string; attempts: number }>(
      `SELECT tenant_id,status,attempts FROM adapter_outbox WHERE kind='wake' ORDER BY tenant_id`
    )).rows).toEqual([
      { tenant_id: 'Isa', status: 'pending', attempts: 0 },
      { tenant_id: 'Pablo', status: 'processing', attempts: 1 }
    ]);

    // The locks stay those of the original queue: even with several gateways competing for the
    // same exact pair, a row gets only one claim.
    const raced = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      repository.claimWakeOutbox(`gateway-isa-${String(index)}`, [{ tenant_id: 'Isa', alias: 'salva' }], 1, 5_000)
    ));
    expect(raced.flat()).toHaveLength(1);
    expect(raced.flat()[0]).toMatchObject({ tenant_id: 'Isa', attempt: 1 });
  });

  it('applies migration 005 and fences Telegram cursors', async () => {
    const telegram = new PostgresTelegramBridgeRepository(pool);
    await telegram.initializeCursor('900001', 'Steven', 'kant');
    const first = await telegram.acquirePollLease('900001', 'poller-a', 10_000);
    if (!first) throw new Error('Expected first poll lease');
    expect(first).toMatchObject({ owner_id: 'poller-a', epoch: 1 });
    await expect(telegram.acquirePollLease('900001', 'poller-b', 10_000)).resolves.toBeUndefined();
    await telegram.advanceCursor(first, 7);
    await pool.query(`UPDATE channel_bridge_leases SET lease_until=now()-interval '1 millisecond'
      WHERE bot_id='900001'`);
    const replacement = await telegram.acquirePollLease('900001', 'poller-b', 10_000);
    if (!replacement) throw new Error('Expected replacement poll lease');
    expect(replacement).toMatchObject({ owner_id: 'poller-b', epoch: 2 });
    await expect(telegram.cursor(first)).rejects.toThrow(/fenced/);
    await expect(telegram.cursor(replacement)).resolves.toBe(7);
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
          const pidRow = selected.rows[0];
          if (!pidRow) throw new Error('Expected pid row');
          reportPid(pidRow.pid);
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
    if (!first) throw new Error('Expected first job');
    await pool.query('SELECT pg_sleep(0.04)');
    expect(await repository.completeJob(id, 'job-worker', first.claim_token)).toBe(false);
    expect(await repository.retryExpiredJobs()).toBe(1);
    await pool.query('UPDATE jobs SET available_at=now() WHERE id=$1', [id]);
    const [second] = await repository.claimJobs('batch', 'job-worker', 1, 5_000);
    if (!second) throw new Error('Expected second job');
    expect(second.claim_token).not.toBe(first.claim_token);
    expect(await repository.completeJob(id, 'job-worker', first.claim_token)).toBe(false);
    expect(await repository.completeJob(id, 'job-worker', second.claim_token)).toBe(true);
  });

  it('reconnects the LISTEN supervisor after PostgreSQL terminates its backend', async () => {
    let connected = 0;
    const notices: { tenant_id: string; alias: string }[] = [];
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
      const listenerRow = listener.rows[0];
      if (!listenerRow) throw new Error('Expected listener row');
      expect(listenerRow.pid).toBeTypeOf('number');
      await pool.query('SELECT pg_terminate_backend($1)', [listenerRow.pid]);
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
      if (!job) throw new Error('Expected fair job');
      jobOrder.push(job.id);
      await repository.completeJob(job.id, 'fair-worker', job.claim_token);
    }
    expect(jobOrder.slice(0, 3)).toContain(batchJob);

    const lease = await repository.acquireLease('Pablo', 'midas', 'fair-delivery', [], 10_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
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
    const batchMessageRow = batchMessage.rows[0];
    if (!batchMessageRow) throw new Error('Expected batch message row');
    await pool.query(
      `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
       VALUES($1,'Pablo','midas')`,
      [batchMessageRow.id]
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
        'Pablo', 'midas', 'fair-delivery', leaseEpoch, 1, 5_000, 2
      );
      if (!delivery) throw new Error('Expected fair delivery');
      deliveryOrder.push(delivery.message_id);
      await repository.ackDelivery(delivery.delivery_id, 'Pablo', 'midas', {
        version: '3.0', status: 'done', instance_id: 'fair-delivery', epoch: leaseEpoch,
        event_id: randomUUID(), claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false
      });
    }
    expect(deliveryOrder.slice(0, 3)).toContain(batchMessageRow.id);
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
  });});
