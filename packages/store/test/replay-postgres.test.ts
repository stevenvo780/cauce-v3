import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { DurableStore } from '../../adapter-sdk/src/sdk/durable-store.js';
import type { Delivery } from '../../adapter-sdk/src/sdk/types.js';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-replay-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: {
      text: 'manual replay must preserve this body',
      nested: { durable: true }
    },
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 41,
    authenticated_context: {
      session_id: 'trusted-replay-session',
      channel: 'telegram-dm',
      origin: {
        adapter: 'telegram',
        channel: 'dm',
        conversation_id: 'replay-chat',
        external_message_id: 'replay-message',
        relay: [],
        metadata: { scope: 'manual-replay-test' }
      }
    }
  };
}

function failedAck(delivery: DeliveryEnvelope, epoch: number): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: 'replay-consumer',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: true,
    error: `attempt ${delivery.attempt} exhausted`
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
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
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE memberships SET role=CASE
      WHEN tenant_id='Steven' AND alias='kant' THEN 'operator' ELSE 'agent' END;
    UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false WHERE role='agent';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('transactional manual delivery replay', () => {
  it('clones a dead delivery once and cannot collide with the adapter terminal inbox record', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'cauce-replay-store-'));
    try {
      const durableStore = await DurableStore.open(stateDirectory);
      const lease = await repository.acquireLease('Isa', 'salva', 'replay-consumer', [], 60_000);
      const published = await repository.publish(command());
      const originalDeliveryId = published.delivery_ids[0]!;
      let terminalClaim: DeliveryEnvelope | undefined;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [claimed] = await repository.claimDeliveries(
          'Isa', 'salva', 'replay-consumer', lease.epoch!, 1, 30_000
        );
        expect(claimed).toMatchObject({ delivery_id: originalDeliveryId, attempt });
        if (!claimed) throw new Error(`expected delivery attempt ${attempt}`);
        terminalClaim = claimed;
        if (attempt === 3) {
          await expect(durableStore.accept(claimed as Delivery, new Date().toISOString()))
            .resolves.toMatchObject({ acceptance: 'created' });
          await durableStore.transition(claimed.delivery_id, 'failed', new Date().toISOString(), {
            attempt: claimed.attempt,
            claimToken: claimed.claim_token,
            error: { code: 'EXHAUSTED', message: 'terminal attempt 3', retryable: true }
          });
        }
        await expect(repository.ackDelivery(
          claimed.delivery_id,
          'Isa',
          'salva',
          failedAck(claimed, lease.epoch!)
        )).resolves.toMatchObject({
          delivery_id: originalDeliveryId,
          status: attempt === 3 ? 'dead' : 'retry',
          applied: true
        });
        if (attempt < 3) {
          await pool.query(
            `UPDATE deliveries SET available_at=now()-interval '1 millisecond' WHERE id=$1`,
            [originalDeliveryId]
          );
        }
      }
      expect(terminalClaim?.attempt).toBe(3);
      expect(durableStore.getDelivery(originalDeliveryId)).toMatchObject({
        delivery_id: originalDeliveryId,
        attempt: 3,
        state: 'failed'
      });
      await pool.query(
        `UPDATE messages
         SET body='{"n":9007199254740993,"decimal":0.123456789012345678901}'::jsonb,
             origin='{"adapter":"telegram","channel":"dm","conversation_id":"precision",
               "relay":[],"metadata":{"n":9007199254740993,"decimal":0.123456789012345678901}}'::jsonb
         WHERE id=$1`,
        [published.message_id]
      );

      const originalBefore = (await pool.query<Record<string, unknown>>(
        `SELECT message_id,status,attempt,max_attempts,last_ack_rank,last_error,result,terminal_at,
                claimed_at,claim_expires_at,ack_deadline_at,claim_token,
                consumer_instance_id,consumer_epoch,created_at,updated_at
         FROM deliveries WHERE id=$1`,
        [originalDeliveryId]
      )).rows[0]!;
      const originalMessage = (await pool.query<Record<string, unknown>>(
        `SELECT id,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                auth_session_id,auth_channel
         FROM messages WHERE id=$1`,
        [published.message_id]
      )).rows[0]!;

      await expect(repository.replayDelivery(originalDeliveryId, 'Isa', 'salva'))
        .rejects.toMatchObject({ code: 'forbidden' });
      expect((await pool.query('SELECT 1 FROM messages')).rowCount).toBe(1);

      await pool.query(
        `UPDATE memberships SET enabled=false WHERE tenant_id='Isa' AND alias='salva'`
      );
      await expect(repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'))
        .rejects.toMatchObject({ code: 'not_found' });
      await pool.query(
        `UPDATE memberships SET enabled=true WHERE tenant_id='Isa' AND alias='salva'`
      );
      await pool.query(
        `UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Isa'`
      );
      await expect(repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'))
        .rejects.toMatchObject({ code: 'not_found' });
      await pool.query(
        `UPDATE acl_edges SET allow_route=true WHERE from_tenant='Steven' AND to_tenant='Isa'`
      );
      expect((await pool.query('SELECT 1 FROM messages')).rowCount).toBe(1);

      const concurrentReplays = await Promise.allSettled([
        repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'),
        repository.replayDelivery(originalDeliveryId, 'Steven', 'kant')
      ]);
      expect(concurrentReplays.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = concurrentReplays.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      expect(rejected).toHaveLength(1);
      const rejectionReason: unknown = rejected[0]?.reason;
      expect(rejectionReason).toMatchObject({ code: 'conflict' });
      const replay = concurrentReplays.find(
        (outcome): outcome is PromiseFulfilledResult<Record<string, unknown>> => outcome.status === 'fulfilled'
      )?.value;
      if (!replay) throw new Error('expected exactly one successful concurrent replay');
      expect(replay).toMatchObject({
        replayed_from_delivery_id: originalDeliveryId,
        state: 'pending',
        replayed: true
      });
      expect(replay.delivery_id).not.toBe(originalDeliveryId);
      const replayedDeliveryId = String(replay.delivery_id);

      expect((await pool.query<Record<string, unknown>>(
        `SELECT message_id,status,attempt,max_attempts,last_ack_rank,last_error,result,terminal_at,
                claimed_at,claim_expires_at,ack_deadline_at,claim_token,
                consumer_instance_id,consumer_epoch,created_at,updated_at
         FROM deliveries WHERE id=$1`,
        [originalDeliveryId]
      )).rows[0]).toEqual(originalBefore);

      const replayed = (await pool.query<{
        message_id: string; status: string; attempt: number; max_attempts: number;
        last_ack_rank: number; last_error: string | null; result: unknown;
        terminal_at: Date | null; claimed_at: Date | null; claim_expires_at: Date | null;
        ack_deadline_at: Date | null; claim_token: string | null;
        consumer_instance_id: string | null; consumer_epoch: number | null;
      }>(
        `SELECT message_id,status,attempt,max_attempts,last_ack_rank,last_error,result,terminal_at,
                claimed_at,claim_expires_at,ack_deadline_at,claim_token,
                consumer_instance_id,consumer_epoch
         FROM deliveries WHERE id=$1`,
        [replayedDeliveryId]
      )).rows[0]!;
      expect(typeof replayed.message_id).toBe('string');
      expect(replayed).toEqual({
        message_id: replayed.message_id,
        status: 'pending',
        attempt: 0,
        max_attempts: originalBefore.max_attempts,
        last_ack_rank: 0,
        last_error: null,
        result: null,
        terminal_at: null,
        claimed_at: null,
        claim_expires_at: null,
        ack_deadline_at: null,
        claim_token: null,
        consumer_instance_id: null,
        consumer_epoch: null
      });
      expect(replayed.message_id).not.toBe(published.message_id);

      const replayedMessage = (await pool.query<Record<string, unknown>>(
        `SELECT id,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                auth_session_id,auth_channel
         FROM messages WHERE id=$1`,
        [replayed.message_id]
      )).rows[0]!;
      const {
        id: originalMessageId, request_id: originalRequestId, ...originalContext
      } = originalMessage;
      const {
        id: replayedMessageId, request_id: replayedRequestId, ...replayedContext
      } = replayedMessage;
      expect(replayedMessageId).not.toBe(originalMessageId);
      expect(replayedRequestId).not.toBe(originalRequestId);
      expect(replayedContext).toEqual(originalContext);
      expect((await pool.query<{ body_equal: boolean; origin_equal: boolean }>(
        `SELECT original.body=replayed.body AS body_equal,
                original.origin=replayed.origin AS origin_equal
         FROM messages original JOIN messages replayed ON replayed.id=$2
         WHERE original.id=$1`,
        [published.message_id, replayed.message_id]
      )).rows[0]).toEqual({ body_equal: true, origin_equal: true });

      expect((await pool.query(
        `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NOT NULL`,
        [originalDeliveryId]
      )).rowCount).toBe(1);
      expect((await pool.query(
        `SELECT 1 FROM adapter_outbox
         WHERE kind='wake' AND delivery_id=$1
           AND idempotency_key=$2 AND status='pending' AND attempts=0`,
        [replayedDeliveryId, `wake-replay:${replayedDeliveryId}`]
      )).rowCount).toBe(1);
      expect((await pool.query(
        `SELECT 1 FROM audit_events
         WHERE action='delivery.replay' AND decision='allow'
           AND delivery_id=$1 AND metadata->>'replayed_from_delivery_id'=$2`,
        [replayedDeliveryId, originalDeliveryId]
      )).rowCount).toBe(1);
      expect((await pool.query(
        `SELECT 1 FROM messages WHERE trace_id=$1`,
        [published.trace_id]
      )).rowCount).toBe(2);

      await expect(repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'))
        .rejects.toMatchObject({ code: 'conflict' });
      expect((await pool.query(
        `SELECT 1 FROM adapter_outbox WHERE delivery_id=$1`,
        [replayedDeliveryId]
      )).rowCount).toBe(1);
      expect((await pool.query(
        `SELECT 1 FROM messages WHERE trace_id=$1`,
        [published.trace_id]
      )).rowCount).toBe(2);

      const [replayedClaim] = await repository.claimDeliveries(
        'Isa', 'salva', 'replay-consumer', lease.epoch!, 1, 30_000
      );
      expect(replayedClaim).toMatchObject({
        delivery_id: replayedDeliveryId,
        message_id: replayed.message_id,
        request_id: replayedRequestId,
        trace_id: published.trace_id,
        attempt: 1
      });
      if (!replayedClaim) throw new Error('expected replayed delivery claim');
      await expect(durableStore.accept(replayedClaim as Delivery, new Date().toISOString()))
        .resolves.toMatchObject({ acceptance: 'created' });
      expect(durableStore.getDelivery(originalDeliveryId)).toMatchObject({
        attempt: 3,
        state: 'failed'
      });
      expect(durableStore.getDelivery(replayedDeliveryId)).toMatchObject({
        attempt: 1,
        state: 'accepted'
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('waits for an in-progress authorization revocation and rejects without creating a clone', async () => {
    const published = await repository.publish(command());
    const originalDeliveryId = published.delivery_ids[0]!;
    await pool.query(
      `UPDATE deliveries
       SET status='dead',attempt=3,last_ack_rank=3,last_error='concurrent revocation fixture',
           terminal_at=now(),updated_at=now()
       WHERE id=$1`,
      [originalDeliveryId]
    );
    await pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
       VALUES($1,'Isa','concurrent revocation fixture','{}'::jsonb,3)`,
      [originalDeliveryId]
    );

    const revoker = await pool.connect();
    let transactionOpen = false;
    let settled = false;
    let replayPromise: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await revoker.query('BEGIN');
      transactionOpen = true;
      const revokerPid = (await revoker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      )).rows[0]!.pid;
      await revoker.query(
        `UPDATE memberships SET enabled=false
         WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias='kant'`
      );

      replayPromise = repository.replayDelivery(originalDeliveryId, 'Steven', 'kant').then(
        () => {
          settled = true;
          return { ok: true };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false, error };
        }
      );
      await waitFor(async () => (await pool.query(
        `SELECT 1 FROM pg_stat_activity activity
         WHERE activity.datname=current_database()
           AND activity.wait_event_type='Lock'
           AND $1::integer=ANY(pg_blocking_pids(activity.pid))
           AND activity.query LIKE '%role.allow_control%'
         LIMIT 1`,
        [revokerPid]
      )).rowCount === 1);
      expect(settled).toBe(false);

      await revoker.query('COMMIT');
      transactionOpen = false;
      const outcome = await replayPromise;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'not_found' });
    } finally {
      if (transactionOpen) await revoker.query('ROLLBACK');
      revoker.release();
      if (replayPromise) await replayPromise;
    }

    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [published.trace_id]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='delivery.replay' AND metadata->>'replayed_from_delivery_id'=$1`,
      [originalDeliveryId]
    )).rowCount).toBe(0);
    expect((await pool.query<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM dead_letters WHERE delivery_id=$1`,
      [originalDeliveryId]
    )).rows[0]?.resolved_at).toBeNull();
  });

  it('recovers a legacy replay-resolved dead letter exactly once when its old wake proves provenance', async () => {
    const published = await repository.publish(command());
    const originalDeliveryId = published.delivery_ids[0]!;
    await pool.query(
      `UPDATE deliveries
       SET status='dead',attempt=3,last_ack_rank=3,last_error='legacy replay exhausted',
           terminal_at=now(),updated_at=now()
       WHERE id=$1`,
      [originalDeliveryId]
    );
    await pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts,resolved_at)
       VALUES($1,'Isa','legacy replay exhausted','{}'::jsonb,3,now())`,
      [originalDeliveryId]
    );
    const resolvedAt = (await pool.query<{ resolved_at: Date }>(
      `SELECT resolved_at FROM dead_letters WHERE delivery_id=$1`,
      [originalDeliveryId]
    )).rows[0]!.resolved_at;

    await expect(repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [published.trace_id]
    )).rowCount).toBe(1);

    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
       )
       SELECT d.recipient_tenant,'gateway','wake',$2,m.request_id,m.id,d.id,m.trace_id,m.origin,
              jsonb_build_object('recipient_alias',d.recipient_alias,'reason','delivery_available')
       FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=$1`,
      [originalDeliveryId, `wake-replay:${originalDeliveryId}:1721744925000`]
    );

    const concurrentReplays = await Promise.allSettled([
      repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'),
      repository.replayDelivery(originalDeliveryId, 'Steven', 'kant')
    ]);
    const replay = concurrentReplays.find(
      (outcome): outcome is PromiseFulfilledResult<Record<string, unknown>> => outcome.status === 'fulfilled'
    )?.value;
    const rejected = concurrentReplays.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    expect(replay).toMatchObject({
      replayed_from_delivery_id: originalDeliveryId,
      state: 'pending',
      replayed: true
    });
    const rejectionReason: unknown = rejected?.reason;
    expect(rejectionReason).toMatchObject({ code: 'conflict' });
    if (!replay) throw new Error('expected one legacy recovery clone');
    const replayedDeliveryId = String(replay.delivery_id);

    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE id=$1 AND status='dead' AND attempt=3`,
      [originalDeliveryId]
    )).rowCount).toBe(1);
    expect((await pool.query<{ resolved_at: Date }>(
      `SELECT resolved_at FROM dead_letters WHERE delivery_id=$1`,
      [originalDeliveryId]
    )).rows[0]!.resolved_at).toEqual(resolvedAt);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='delivery.replay' AND delivery_id=$1
         AND metadata->>'replayed_from_delivery_id'=$2
         AND metadata->>'legacy_dead_letter_recovery'='true'`,
      [replayedDeliveryId, originalDeliveryId]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE delivery_id=$1 AND idempotency_key=$2`,
      [replayedDeliveryId, `wake-replay:${replayedDeliveryId}`]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [published.trace_id]
    )).rowCount).toBe(2);

    await expect(repository.replayDelivery(originalDeliveryId, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(
      `SELECT 1 FROM messages WHERE trace_id=$1`,
      [published.trace_id]
    )).rowCount).toBe(2);
  });

  it('preserves agent-output lineage beyond sixteen replay clones and fails closed at the hop budget', async () => {
    const root = await repository.publish(command());
    const childRequestId = randomUUID();
    const child = await pool.query<{ message_id: string; delivery_id: string }>(
      `WITH inserted_message AS (
         INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         ) VALUES(
           $1,$2,'Isa','grp.isa','salva','{"text":"materialized child"}'::jsonb,
           NULL,'interactive',9,'agent-output-source','agent-output'
         ) RETURNING id
       ), inserted_delivery AS (
         INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,terminal_at)
         SELECT id,'Steven','argos','dead',3,3,now() FROM inserted_message
         RETURNING id,message_id
       )
       SELECT message_id,id AS delivery_id FROM inserted_delivery`,
      [childRequestId, root.trace_id]
    );
    const childMessageId = child.rows[0]!.message_id;
    const childDeliveryId = child.rows[0]!.delivery_id;
    await pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
       VALUES($1,'Steven','materialized child exhausted','{}'::jsonb,3)`,
      [childDeliveryId]
    );
    await pool.query(
      `INSERT INTO agent_output_materializations(
         source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
         target_tenant,target_alias,target_ref_hash,body_hash,status,produced_message_id,
         produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation
         ) VALUES(
         $1,1,0,$2,'Isa','salva','Steven','argos',$3,$4,'materialized',$5,$6,$7,$8,16,16,$9::jsonb
       )`,
      [
        root.delivery_ids[0], root.message_id, 'a'.repeat(64), 'b'.repeat(64),
        childMessageId, childDeliveryId, childRequestId, root.trace_id,
        JSON.stringify({
          root_request_id: root.request_id,
          root_message_id: root.message_id,
          parent_request_id: root.request_id,
          parent_message_id: root.message_id,
          parent_delivery_id: root.delivery_ids[0],
          parent_attempt: 1,
          output_index: 0,
          trace_id: root.trace_id,
          hop_count: 16,
          hop_budget: 16
        })
      ]
    );

    let replayedDeliveryId = childDeliveryId;
    for (let replayIndex = 0; replayIndex < 17; replayIndex += 1) {
      const replay = await repository.replayDelivery(replayedDeliveryId, 'Steven', 'kant');
      replayedDeliveryId = String(replay.delivery_id);
      if (replayIndex < 16) {
        await pool.query(
          `UPDATE deliveries
           SET status='dead',attempt=3,last_ack_rank=3,last_error='replay chain exhausted',
               terminal_at=now(),updated_at=now()
           WHERE id=$1`,
          [replayedDeliveryId]
        );
        await pool.query(
          `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
           VALUES($1,'Steven','replay chain exhausted','{}'::jsonb,3)`,
          [replayedDeliveryId]
        );
      }
    }
    const lease = await repository.acquireLease('Steven', 'argos', 'lineage-consumer', [], 60_000);
    const [claimed] = await repository.claimDeliveries(
      'Steven', 'argos', 'lineage-consumer', lease.epoch!, 1, 30_000
    );
    expect(claimed).toMatchObject({ delivery_id: replayedDeliveryId, attempt: 1 });
    if (!claimed) throw new Error('expected replayed materialized child');

    await expect(repository.ackDelivery(claimed.delivery_id, 'Steven', 'argos', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: 'lineage-consumer',
      epoch: lease.epoch!,
      claim_token: claimed.claim_token,
      attempt: claimed.attempt,
      retryable: false,
      result: {
        output: {
          reply: 'lineage retained',
          messages: [{ to: 'salva', body: 'next hop' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    })).resolves.toMatchObject({ status: 'done', applied: true });

    expect((await pool.query<{
      status: string; rejection_code: string; hop_count: number;
      hop_budget: number; correlation: Record<string, unknown>;
    }>(
      `SELECT status,rejection_code,hop_count,hop_budget,correlation
       FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND source_attempt=1 AND output_index=0`,
      [replayedDeliveryId]
    )).rows[0]).toMatchObject({
      status: 'rejected',
      rejection_code: 'hop_budget_exhausted',
      hop_count: 17,
      hop_budget: 16,
      correlation: {
        root_request_id: root.request_id,
        root_message_id: root.message_id,
        parent_message_id: claimed.message_id,
        parent_delivery_id: replayedDeliveryId,
        hop_count: 17,
        hop_budget: 16
      }
    });
  });

  it('fails closed instead of resetting lineage when replay audit ancestry contains a cycle', async () => {
    const published = await repository.publish(command());
    const cyclicPeer = await pool.query<{ id: string }>(
      `INSERT INTO messages(
         request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
         auth_session_id,auth_channel
       )
       SELECT gen_random_uuid(),trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
              auth_session_id,auth_channel
       FROM messages WHERE id=$1 RETURNING id`,
      [published.message_id]
    );
    const cyclicPeerId = cyclicPeer.rows[0]!.id;
    await pool.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       )
       SELECT 'Steven','kant','delivery.replay','allow',m.request_id,$1::uuid,$3::uuid,m.trace_id,
              jsonb_build_object('replayed_from_message_id',$2::text,'replayed_from_delivery_id',$3::text)
       FROM messages m WHERE m.id=$1::uuid
       UNION ALL
       SELECT 'Steven','kant','delivery.replay','allow',m.request_id,$2::uuid,$3::uuid,m.trace_id,
              jsonb_build_object('replayed_from_message_id',$1::text,'replayed_from_delivery_id',$3::text)
       FROM messages m WHERE m.id=$2::uuid`,
      [published.message_id, cyclicPeerId, published.delivery_ids[0]]
    );

    const lease = await repository.acquireLease('Isa', 'salva', 'cycle-consumer', [], 60_000);
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'cycle-consumer', lease.epoch!, 1, 30_000
    );
    if (!claimed) throw new Error('expected cyclic-lineage source delivery');
    await expect(repository.ackDelivery(claimed.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: 'cycle-consumer',
      epoch: lease.epoch!,
      claim_token: claimed.claim_token,
      attempt: claimed.attempt,
      retryable: false,
      result: {
        output: {
          reply: 'must fail closed',
          messages: [{ to: 'argos', body: 'must not materialize' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    })).rejects.toMatchObject({ code: 'conflict', message: 'replay lineage cycle detected' });
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE source_delivery_id=$1`,
      [claimed.delivery_id]
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM delivery_acks WHERE delivery_id=$1`,
      [claimed.delivery_id]
    )).rowCount).toBe(0);
  });
});
