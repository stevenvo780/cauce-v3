import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLegacyConsoleOutboxReconciliation,
  inspectLegacyConsoleOutbox,
  legacyConsoleOutboxReason,
} from '../../../deploy/runtime/reconcile-stale-console-outbox-core.mjs';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import type { DatabasePool } from '@cauce/store';

let database: TestDatabase;
let pool: DatabasePool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

async function message(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES(gen_random_uuid(),'reconcile-test','Steven','grp.steven','kant','{}','interactive')
     RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('message fixture was not created');
  return id;
}

describe('legacy console origin-relay reconciliation', () => {
  it('dead-letters exactly one stale row, preserves payload/history and is idempotent', async () => {
    const messageId = await message();
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload,created_at
       ) VALUES('Steven','console','origin_relay','legacy-console',gen_random_uuid(),$1,
                'reconcile-test','{"legacy":true}',now()-interval '2 days')`,
      [messageId],
    );
    const existing = await pool.query<{ id: string }>(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload,status,dead_at
       ) VALUES('Steven','telegram','origin_relay','historical-dead',gen_random_uuid(),$1,
                'historical','{}','dead',now()-interval '10 days') RETURNING id`,
      [messageId],
    );
    await pool.query(
      `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
       VALUES($1,'Steven','telegram','origin_relay','historical','{}',1)`,
      [existing.rows[0]?.id],
    );

    const before = await inspectLegacyConsoleOutbox(pool, { thresholdSeconds: 3_600 });
    expect(before.counts).toMatchObject({ candidates: 1, deadTotal: 1, reconciliationAudits: 0 });
    const applied = await applyLegacyConsoleOutboxReconciliation(pool, {
      thresholdSeconds: 3_600,
      expectedCandidates: 1,
    });
    expect(applied).toMatchObject({ appliedCount: 1, alreadyApplied: false });
    expect(applied.rowDigests[0]).toMatch(/^[a-f0-9]{64}$/u);

    const row = await pool.query<{ status: string; last_error: string; payload: unknown }>(
      `SELECT status,last_error,payload FROM adapter_outbox
        WHERE adapter='console' AND idempotency_key='legacy-console'`,
    );
    expect(row.rows[0]).toMatchObject({
      status: 'dead',
      last_error: legacyConsoleOutboxReason,
      payload: { legacy: true },
    });
    const dead = await pool.query<{ reason: string; payload: unknown }>(
      `SELECT dead.reason,dead.payload FROM outbox_dead_letters dead
        JOIN adapter_outbox outbox ON outbox.id=dead.outbox_id
       WHERE outbox.idempotency_key='legacy-console'`,
    );
    expect(dead.rows).toEqual([{ reason: legacyConsoleOutboxReason, payload: { legacy: true } }]);
    expect((await inspectLegacyConsoleOutbox(pool, { thresholdSeconds: 3_600 })).counts)
      .toMatchObject({ candidates: 0, deadTotal: 2, reconciliationAudits: 1 });

    await expect(applyLegacyConsoleOutboxReconciliation(pool, {
      thresholdSeconds: 3_600,
      expectedCandidates: 1,
    })).resolves.toMatchObject({ appliedCount: 0, alreadyApplied: true });
  }, 120_000);

  it('fails closed instead of stealing a stale processing claim', async () => {
    const messageId = await message();
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload,status,
         claimed_at,claim_expires_at,created_at
       ) VALUES('Steven','console','origin_relay','claimed-console',gen_random_uuid(),$1,
                'reconcile-claimed','{}','processing',now()-interval '2 days',now()-interval '1 day',
                now()-interval '2 days')`,
      [messageId],
    );
    await expect(applyLegacyConsoleOutboxReconciliation(pool, {
      thresholdSeconds: 3_600,
      expectedCandidates: 1,
    })).rejects.toThrow(/claimed or inconsistent/u);
  }, 120_000);
});
