import { readFile } from 'node:fs/promises';
import { requireValue } from './helpers.js';
import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../src/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const upPath = new URL('../migrations/030_dlq_causal_reconciliation.sql', import.meta.url);
const downPath = new URL('../migrations/down/030_dlq_causal_reconciliation.sql', import.meta.url);

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;

beforeAll(async () => {
  [up, down] = await Promise.all([readFile(upPath, 'utf8'), readFile(downPath, 'utf8')]);
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

async function recordMigration(): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES('030_dlq_causal_reconciliation.sql')
     ON CONFLICT DO NOTHING`,
  );
}

async function seedOutbox(
  adapter: string,
  kind: 'wake' | 'origin_relay',
  status: 'failed' | 'processing',
): Promise<{ outboxId: string; letterId: string | null }> {
  const requestId = randomUUID();
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES($1,$2,'Steven','grp.steven','kant','{}'::jsonb,'interactive') RETURNING id`,
    [requestId, `migration-030-${randomUUID()}`],
  );
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload,
       status,attempts,max_attempts,claimed_by,claim_token,claim_expires_at
     ) VALUES(
       'Steven',$1,$2,$3,$4,$5,'migration-030','{}'::jsonb,$6,1,3,
       CASE WHEN $6='processing' THEN 'migration-writer' ELSE NULL END,
       CASE WHEN $6='processing' THEN gen_random_uuid() ELSE NULL END,
       CASE WHEN $6='processing' THEN now()+interval '1 minute' ELSE NULL END
     ) RETURNING id`,
    [adapter, kind, randomUUID(), requestId, requireValue(message.rows[0], 'message.rows').id, status],
  );
  const hasDisposition = requireValue((await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='outbox_dead_letters'
         AND column_name='disposition'
     ) AS exists`,
  )).rows[0], 'rows').exists;
  if (!hasDisposition) return { outboxId: requireValue(outbox.rows[0], 'outbox.rows').id, letterId: null };
  const letter = await pool.query<{ id: string }>(
    `INSERT INTO outbox_dead_letters(
       outbox_id,tenant_id,adapter,kind,reason,payload,attempts,resolved_at
     ) VALUES($1,'Steven',$2,$3,'migration race','{}'::jsonb,1,now()) RETURNING id`,
    [requireValue(outbox.rows[0], 'outbox.rows').id, adapter, kind],
  );
  return { outboxId: requireValue(outbox.rows[0], 'outbox.rows').id, letterId: requireValue(letter.rows[0], 'letter.rows').id };
}

describe('migration 030 lifecycle', () => {
  it('down/up is complete and idempotent before any 030 history exists', async () => {
    await pool.query(down);
    await expect(pool.query(down)).resolves.toBeDefined();
    expect((await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='outbox_dead_letters'
           AND column_name='disposition'
       ) AS exists`,
    )).rows[0]?.exists).toBe(false);
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure(
         'cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer)'
       )
         IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(false);
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure('cauce_fence_telegram_effect_030()') IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(false);

    await pool.query(up);
    await recordMigration();
    await expect(pool.query(up)).resolves.toBeDefined();
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure('cauce_list_dlq_030(text,text,integer)') IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(true);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_trigger
       WHERE tgname IN ('cauce_fence_telegram_effect_030','cauce_fence_dlq_delivery_evidence_030')
         AND NOT tgisinternal`,
    )).rows[0]?.count).toBe('2');
    expect((await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='outbox_dead_letters'
           AND column_name IN ('disposition','resolution_rule','evidence_sha256','reopen_count')
         HAVING count(*)=4
       ) AS exists`,
    )).rows[0]?.exists).toBe(true);
  });

  it('down is CAS-safe under the migration lock and refuses to erase durable 030 history', async () => {
    const holder = await pool.connect();
    const contender = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      await contender.query(`SET lock_timeout='100ms'`);
      await expect(contender.query(down)).rejects.toMatchObject({ code: '55P03' });
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
      contender.release();
    }

    await pool.query(
      `INSERT INTO dlq_reconciliation_runs(
         plan_sha256,actor_sha256,transition_count,resolved_count,recovered_sent_count,disposition_count
       ) VALUES($1,$2,0,0,0,0)`,
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    await expect(pool.query(down)).rejects.toThrow(/cannot downgrade schema 030/u);
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure('cauce_dlq_apply_030(text,text,text)') IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(true);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dlq_reconciliation_runs`,
    )).rows[0]?.count).toBe('1');
  });

  it('up waits for an in-flight effect writer and rejects its inconsistent committed evidence', async () => {
    await pool.query(down);
    const fixture = await seedOutbox('gateway', 'wake', 'processing');
    const writer = await pool.connect();
    let upSettled = false;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,'Isa','salva',0,1,$3,'prepared')`,
        [`${fixture.outboxId}:invalid`, fixture.outboxId, 'a'.repeat(64)],
      );
      const upgrading = pool.query(up).finally(() => { upSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(upSettled).toBe(false);
      await writer.query('COMMIT');
      await expect(upgrading).rejects.toThrow(/refuses inconsistent causal DLQ\/effect evidence/u);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure('cauce_fence_telegram_effect_030()') IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(false);
    await pool.query(`DELETE FROM telegram_egress_effects WHERE outbox_id=$1`, [fixture.outboxId]);
    await pool.query(up);
    await recordMigration();
  });

  it('up waits for an in-flight DLQ writer and rejects cross-tenant projection drift', async () => {
    await pool.query(down);
    const fixture = await seedOutbox('telegram', 'origin_relay', 'failed');
    const letterId = randomUUID();
    const writer = await pool.connect();
    let upSettled = false;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO outbox_dead_letters(
           id,outbox_id,tenant_id,adapter,kind,reason,payload,attempts
         ) VALUES($1,$2,'Isa','telegram','origin_relay','racing mismatch','{}'::jsonb,1)`,
        [letterId, fixture.outboxId],
      );
      const upgrading = pool.query(up).finally(() => { upSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(upSettled).toBe(false);
      await writer.query('COMMIT');
      await expect(upgrading).rejects.toThrow(/refuses inconsistent causal DLQ\/effect evidence/u);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      if ((await pool.query<{ exists: boolean }>(
        `SELECT to_regprocedure('cauce_fence_outbox_dead_letter_030()') IS NOT NULL AS exists`,
      )).rows[0]?.exists) {
        await pool.query(down);
      }
      await pool.query(`DELETE FROM outbox_dead_letters WHERE id=$1`, [letterId]);
      await pool.query(up);
      await recordMigration();
    }
  });

  it('up refuses a pre-030 negative or timestamp-incoherent replay generation', async () => {
    await pool.query(down);
    const fixture = await seedOutbox('telegram', 'origin_relay', 'processing');
    await pool.query(
      `INSERT INTO telegram_egress_effects(
         effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state,
         replay_count,replayed_at
       ) VALUES($1,$2,'Steven','kant',0,1,$3,'prepared',-1,now())`,
      [`${fixture.outboxId}:invalid-replay`, fixture.outboxId, 'd'.repeat(64)],
    );
    try {
      await expect(pool.query(up)).rejects.toThrow(/refuses inconsistent causal DLQ\/effect evidence/u);
    } finally {
      await pool.query(`DELETE FROM telegram_egress_effects WHERE outbox_id=$1`, [fixture.outboxId]);
      await pool.query(up);
      await recordMigration();
    }
  });

  it('down waits for trigger writers before its precheck and preserves newly appended history', async () => {
    const fixture = await seedOutbox('telegram', 'origin_relay', 'failed');
    if (!fixture.letterId) throw new Error('expected a schema-030 dead letter');
    const blocker = await pool.connect();
    let writerSettled = false;
    let downSettled = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM outbox_dead_letters WHERE id=$1 FOR UPDATE`, [fixture.letterId],
      );
      const writing = pool.query(
        `UPDATE adapter_outbox
            SET status='dead',dead_at=now(),last_error='concurrent retry failed'
          WHERE id=$1`,
        [fixture.outboxId],
      ).finally(() => { writerSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writerSettled).toBe(false);

      const downgrading = pool.query(down).finally(() => { downSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(downSettled).toBe(false);
      await blocker.query('COMMIT');
      await expect(writing).resolves.toBeDefined();
      await expect(downgrading).rejects.toThrow(/cannot downgrade schema 030/u);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dlq_reconciliation_transitions
       WHERE dead_letter_id=$1 AND rule='outbox_reopened_after_retry_v1'`,
      [fixture.letterId],
    )).rows[0]?.count).toBe('1');
    expect((await pool.query<{ exists: boolean }>(
      `SELECT to_regprocedure('cauce_reopen_outbox_dead_letter_030()') IS NOT NULL AS exists`,
    )).rows[0]?.exists).toBe(true);
  });
});
