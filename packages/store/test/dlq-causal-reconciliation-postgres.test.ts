import { randomUUID } from 'node:crypto';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
interface DeadOutboxFixture {
  outboxId: string;
  letterId: string;
  messageId: string;
  requestId: string;
}

interface ReconciliationTransition {
  rule: string;
  count: number;
}

interface ReconciliationPlan {
  planSha256: string;
  material: {
    candidateCount: number;
    candidateSetSha256: string;
    inventory: unknown[];
    transitions: ReconciliationTransition[];
  };
}

interface ReconciliationApply {
  alreadyApplied: boolean;
  transitionCount: number;
  recoveredSentCount: number;
}

interface SafeListItem {
  id: string;
  [key: string]: unknown;
}

interface SafeList {
  items: SafeListItem[];
  total: number;
  truncated: boolean;
  nextCursor: string | null;
}

interface OperatorResolution {
  alreadyApplied: boolean;
}

let database: TestDatabase;
let pool: DatabasePool;

beforeAll(async () => {
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

async function seedMessage(tenant = 'Steven', room = 'grp.steven', actor = 'kant'): Promise<{
  messageId: string;
  requestId: string;
}> {
  const requestId = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'interactive') RETURNING id`,
    [requestId, `dlq-test-${randomUUID()}`, tenant, room, actor],
  );
  return { messageId: requireValue(result.rows[0], 'result.rows').id, requestId };
}

async function seedDeadOutbox(options: {
  adapter?: string;
  kind?: 'wake' | 'origin_relay';
  payload?: Record<string, unknown>;
  deliveryId?: string;
  lastError?: string;
  createdAt?: string;
} = {}): Promise<DeadOutboxFixture> {
  const seeded = await seedMessage();
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload,
       status,attempts,max_attempts,last_error,dead_at,created_at
     ) VALUES(
       'Steven',$1,$2,$3,$4,$5,$6,'dlq-causal-test',$7::jsonb,
       'dead',3,3,$8,now(),COALESCE($9::timestamptz,now())
     ) RETURNING id`,
    [
      options.adapter ?? 'telegram',
      options.kind ?? 'origin_relay',
      randomUUID(),
      seeded.requestId,
      seeded.messageId,
      options.deliveryId ?? null,
      JSON.stringify(options.payload ?? {}),
      options.lastError ?? 'synthetic terminal failure',
      options.createdAt ?? null,
    ],
  );
  const letter = await pool.query<{ id: string }>(
    `INSERT INTO outbox_dead_letters(
       outbox_id,tenant_id,adapter,kind,reason,payload,attempts,created_at
     ) VALUES($1,'Steven',$2,$3,$4,$5::jsonb,3,COALESCE($6::timestamptz,now())) RETURNING id`,
    [
      requireValue(outbox.rows[0], 'outbox.rows').id,
      options.adapter ?? 'telegram',
      options.kind ?? 'origin_relay',
      options.lastError ?? 'synthetic terminal failure',
      JSON.stringify(options.payload ?? {}),
      options.createdAt ?? null,
    ],
  );
  return {
    outboxId: requireValue(outbox.rows[0], 'outbox.rows').id,
    letterId: requireValue(letter.rows[0], 'letter.rows').id,
    messageId: seeded.messageId,
    requestId: seeded.requestId,
  };
}

async function seedOutboxWithoutDlq(payload: Record<string, unknown>): Promise<{ outboxId: string }> {
  const seeded = await seedMessage();
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,payload,
       status,attempts,max_attempts
     ) VALUES('Steven','telegram','origin_relay',$1,$2,$3,'dlq-sibling-test',$4::jsonb,
       'pending',0,3) RETURNING id`,
    [randomUUID(), seeded.requestId, seeded.messageId, JSON.stringify(payload)],
  );
  return { outboxId: requireValue(outbox.rows[0], 'outbox.rows').id };
}

async function seedEffect(
  fixture: DeadOutboxFixture,
  index: number,
  count: number,
  state: 'prepared' | 'sending' | 'sent' | 'ambiguous' | 'dead',
  options: { provider?: string | null; sentAt?: boolean; hash?: string } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE adapter_outbox SET status='processing',dead_at=NULL WHERE id=$1`,
      [fixture.outboxId],
    );
    await client.query(
      `INSERT INTO telegram_egress_effects(
         effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state,
         provider_message_id,sending_at,sent_at
       ) VALUES($1,$2,'Steven','kant',$3,$4,$5,$6,$7,
         CASE WHEN $6 IN ('sending','sent','ambiguous') THEN now() ELSE NULL END,
         CASE WHEN $8 THEN now() ELSE NULL END)`,
      [
        `${fixture.outboxId}:${String(index)}`,
        fixture.outboxId,
        index,
        count,
        options.hash ?? String(index + 1).repeat(64).slice(0, 64),
        state,
        options.provider === undefined ? (state === 'sent' ? `provider-${String(index)}` : null) : options.provider,
        options.sentAt ?? state === 'sent',
      ],
    );
    await client.query(
      `UPDATE adapter_outbox SET status='dead',dead_at=now() WHERE id=$1`,
      [fixture.outboxId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function plan(): Promise<ReconciliationPlan> {
  return requireValue((await pool.query<{ value: ReconciliationPlan }>(
    `SELECT cauce_dlq_plan_030('Steven','kant') AS value`,
  )).rows[0], 'rows').value;
}

async function apply(planValue: ReconciliationPlan): Promise<ReconciliationApply> {
  return requireValue((await pool.query<{ value: ReconciliationApply }>(
    `SELECT cauce_dlq_apply_030('Steven','kant',$1) AS value`,
    [planValue.planSha256],
  )).rows[0], 'rows').value;
}

async function seedDelivery(options: {
  status: string;
  terminal?: boolean;
  executionStarted?: boolean;
  recipientTenant?: string;
  recipientAlias?: string;
}): Promise<string> {
  const seeded = await seedMessage();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(
       message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,
       terminal_at,execution_started_at
     ) VALUES($1,$2,$3,$4,3,3,
       CASE WHEN $5 THEN now() ELSE NULL END,
       CASE WHEN $6 THEN now() ELSE NULL END) RETURNING id`,
    [
      seeded.messageId,
      options.recipientTenant ?? 'Steven',
      options.recipientAlias ?? 'kant',
      options.status,
      options.terminal ?? false,
      options.executionStarted ?? false,
    ],
  );
  return requireValue(result.rows[0], 'result.rows').id;
}

async function seedDeadDelivery(options: Parameters<typeof seedDelivery>[0] & {
  letterId?: string;
  createdAt?: string;
}): Promise<{
  deliveryId: string;
  letterId: string;
}> {
  const { letterId: requestedLetterId, createdAt, ...deliveryOptions } = options;
  const deliveryId = await seedDelivery(deliveryOptions);
  const letter = await pool.query<{ id: string }>(
    `INSERT INTO dead_letters(id,delivery_id,tenant_id,reason,payload,attempts,created_at)
     VALUES(COALESCE($2::uuid,gen_random_uuid()),$1,'Steven','synthetic delivery incident',
       '{}'::jsonb,3,COALESCE($3::timestamptz,now())) RETURNING id`,
    [deliveryId, requestedLetterId ?? null, createdAt ?? null],
  );
  return { deliveryId, letterId: requireValue(letter.rows[0], 'letter.rows').id };
}

describe('causal DLQ reconciliation', () => {
  it('recovers dead to sent only with complete chunk proof, including a superseded outbox', async () => {
    const proven = await seedDeadOutbox({ lastError: 'superseded by a newer relay' });
    await seedEffect(proven, 0, 2, 'sent');
    await seedEffect(proven, 1, 2, 'sent');

    const missingChunk = await seedDeadOutbox();
    await seedEffect(missingChunk, 0, 2, 'sent');
    const duplicateProvider = await seedDeadOutbox();
    await seedEffect(duplicateProvider, 0, 2, 'sent', { provider: 'provider-duplicate' });
    await seedEffect(duplicateProvider, 1, 2, 'sent', { provider: 'provider-duplicate' });
    const invalidSent = await seedDeadOutbox();
    await expect(seedEffect(invalidSent, 0, 1, 'sent', { provider: null }))
      .rejects.toThrow(/durable provider acceptance and sent time/u);
    const ambiguous = await seedDeadOutbox();
    await seedEffect(ambiguous, 0, 1, 'ambiguous');

    const planned = await plan();
    const serializedPlan = JSON.stringify(planned);
    expect(serializedPlan).not.toContain(proven.outboxId);
    expect(serializedPlan).not.toContain('provider-0');
    expect(serializedPlan).not.toContain('superseded by a newer relay');
    expect(planned.material.candidateSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'telegram_exact_sent_v1', count: 1 }),
      expect.objectContaining({ rule: 'classify_ambiguous_v1', count: 1 }),
    ]));

    const applied = await apply(planned);
    expect(applied).toMatchObject({ alreadyApplied: false, recoveredSentCount: 1 });
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM adapter_outbox WHERE id=$1`, [proven.outboxId],
    )).rows[0]?.status).toBe('sent');
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [proven.letterId],
    )).rows[0]?.resolved).toBe(true);

    for (const fixture of [missingChunk, duplicateProvider, invalidSent, ambiguous]) {
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`, [fixture.outboxId],
      )).rows[0]?.status).toBe('dead');
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(false);
    }
    expect((await pool.query<{ disposition: string }>(
      `SELECT disposition FROM outbox_dead_letters WHERE id=$1`, [ambiguous.letterId],
    )).rows[0]?.disposition).toBe('ambiguous');

    const auditBefore = Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='dlq.reconcile'`,
    )).rows[0]?.count);
    await expect(apply(planned)).resolves.toMatchObject({ alreadyApplied: true, transitionCount: 0 });
    expect(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='dlq.reconcile'`,
    )).rows[0]?.count)).toBe(auditBefore);

    const audit = await pool.query<{ tenant_id: string; metadata: Record<string, unknown> }>(
      `SELECT tenant_id,metadata FROM audit_events
       WHERE action='dlq.reconcile' AND metadata->>'rule'='telegram_exact_sent_v1'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.tenant_id).toBe('Steven');
    const auditText = JSON.stringify(audit.rows[0]?.metadata);
    expect(auditText).not.toContain(proven.outboxId);
    expect(auditText).not.toContain('provider-0');
    expect(auditText).not.toMatch(/payload|origin|provider_message_id/u);
  });

  it('shares an outbox-stable effect fence with concurrent effect writers', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'sent');
    const planned = await plan();
    const writer = await pool.connect();
    let applySettled = false;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('telegram-effect:' || $1::text,0))`,
        [fixture.outboxId],
      );
      const applying = apply(planned).finally(() => { applySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(applySettled).toBe(false);
      await expect(writer.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,'Steven','kant',1,2,$3,'prepared')`,
        [`${fixture.outboxId}:late`, fixture.outboxId, 'f'.repeat(64)],
      )).rejects.toThrow(/live processing outbox/u);
      await writer.query('ROLLBACK');
      await expect(applying).resolves.toMatchObject({ recoveredSentCount: 1 });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET state='prepared'
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/durably sent Telegram effect is immutable/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET provider_message_id=NULL
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/durably sent Telegram effect is immutable/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET payload_hash=$2
       WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`, 'e'.repeat(64)],
    )).rejects.toThrow(/causal coordinates are immutable/u);
    expect((await pool.query<{ status: string; effects: string }>(
      `SELECT outbox.status,count(effect.*)::text AS effects
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       WHERE outbox.id=$1 GROUP BY outbox.status`,
      [fixture.outboxId],
    )).rows[0]).toEqual({ status: 'sent', effects: '1' });

    const wrongKind = await seedDeadOutbox({ adapter: 'gateway', kind: 'wake' });
    await expect(seedEffect(wrongKind, 0, 1, 'prepared'))
      .rejects.toThrow(/causal origin-relay outbox/u);
    const wrongTenant = await seedDeadOutbox();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE adapter_outbox SET status='processing',dead_at=NULL WHERE id=$1`, [
        wrongTenant.outboxId,
      ]);
      await expect(client.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,'Isa','salva',0,1,$3,'prepared')`,
        [`${wrongTenant.outboxId}:wrong-tenant`, wrongTenant.outboxId, 'a'.repeat(64)],
      )).rejects.toThrow(/causal origin-relay outbox/u);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('freezes outbox/effect/DLQ causal identity without advisory-order deadlocks', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'prepared', { hash: 'a'.repeat(64) });
    for (const statement of [
      `UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE adapter_outbox SET adapter='gateway' WHERE id=$1`,
      `UPDATE adapter_outbox SET payload='{"changed":true}'::jsonb WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [fixture.outboxId]))
        .rejects.toThrow(/causal coordinates are immutable/u);
    }
    for (const statement of [
      `UPDATE outbox_dead_letters SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE outbox_dead_letters SET adapter='gateway' WHERE id=$1`,
      `UPDATE outbox_dead_letters SET created_at=created_at+interval '1 second' WHERE id=$1`,
      `DELETE FROM outbox_dead_letters WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [fixture.letterId]))
        .rejects.toThrow(/causal coordinates|must be resolved/u);
    }
    await expect(pool.query(
      `UPDATE outbox_dead_letters SET disposition='safe_retry',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`,
      [fixture.letterId, 'b'.repeat(64)],
    )).resolves.toBeDefined();

    const delivery = await seedDeadDelivery({ status: 'dead', terminal: true });
    for (const statement of [
      `UPDATE dead_letters SET tenant_id='Isa' WHERE id=$1`,
      `UPDATE dead_letters SET created_at=created_at+interval '1 second' WHERE id=$1`,
      `DELETE FROM dead_letters WHERE id=$1`,
    ]) {
      await expect(pool.query(statement, [delivery.letterId]))
        .rejects.toThrow(/causal coordinates|must be resolved/u);
    }
    await expect(pool.query(
      `UPDATE dead_letters SET disposition='safe_retry',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`,
      [delivery.letterId, 'c'.repeat(64)],
    )).resolves.toBeDefined();
    const mismatchedDelivery = await seedDelivery({ status: 'dead', terminal: true });
    await expect(pool.query(
      `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
       VALUES($1,'Isa','mismatch','{}'::jsonb,1)`,
      [mismatchedDelivery],
    )).rejects.toThrow(/does not match its causal target/u);

    const mismatch = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    await expect(pool.query(
      `INSERT INTO outbox_dead_letters(
         outbox_id,tenant_id,adapter,kind,reason,payload,attempts
       ) VALUES($1,'Isa','telegram','origin_relay','mismatch','{}'::jsonb,0)`,
      [mismatch.outboxId],
    )).rejects.toThrow(/does not match its causal outbox/u);

    await expect(pool.query(
      `UPDATE telegram_egress_effects SET replay_count=-1 WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/replay generation must be monotonic/u);
    await expect(pool.query(
      `UPDATE telegram_egress_effects SET replay_count=1 WHERE effect_id=$1`,
      [`${fixture.outboxId}:0`],
    )).rejects.toThrow(/requires a new prepared transition/u);

    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('telegram-effect:' || $1::text,0))`,
        [fixture.outboxId],
      );
      await expect(pool.query(
        `UPDATE adapter_outbox SET status='failed',dead_at=NULL WHERE id=$1`,
        [fixture.outboxId],
      )).resolves.toBeDefined();
      await expect(writer.query(
        `SELECT 1 FROM adapter_outbox WHERE id=$1 FOR UPDATE`, [fixture.outboxId],
      )).resolves.toBeDefined();
      await writer.query('ROLLBACK');
    } finally {
      writer.release();
    }
  });

  it('serializes both DLQ-insert/outbox-update interleavings without scope drift', async () => {
    const updateFirst = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    const updater = await pool.connect();
    try {
      await updater.query('BEGIN');
      await updater.query(`SELECT 1 FROM adapter_outbox WHERE id=$1 FOR UPDATE`, [updateFirst.outboxId]);
      let insertSettled = false;
      const inserting = pool.query(
        `INSERT INTO outbox_dead_letters(
           outbox_id,tenant_id,adapter,kind,reason,payload,attempts
         ) VALUES($1,'Steven','telegram','origin_relay','racing','{}'::jsonb,0)`,
        [updateFirst.outboxId],
      ).finally(() => { insertSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(insertSettled).toBe(false);
      await updater.query(`UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`, [updateFirst.outboxId]);
      await updater.query('COMMIT');
      await expect(inserting).rejects.toThrow(/does not match its causal outbox/u);
    } finally {
      await updater.query('ROLLBACK').catch(() => undefined);
      updater.release();
    }

    const insertFirst = await seedOutboxWithoutDlq({ relay_kind: 'final' });
    const inserter = await pool.connect();
    try {
      await inserter.query('BEGIN');
      await inserter.query(
        `INSERT INTO outbox_dead_letters(
           outbox_id,tenant_id,adapter,kind,reason,payload,attempts
         ) VALUES($1,'Steven','telegram','origin_relay','racing','{}'::jsonb,0)`,
        [insertFirst.outboxId],
      );
      let updateSettled = false;
      const updating = pool.query(
        `UPDATE adapter_outbox SET tenant_id='Isa' WHERE id=$1`, [insertFirst.outboxId],
      ).finally(() => { updateSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(updateSettled).toBe(false);
      await inserter.query('COMMIT');
      await expect(updating).rejects.toThrow(/causal coordinates are immutable/u);
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined);
      inserter.release();
    }
  });

  it('applies only the exact captured candidate set when a new incident commits mid-apply', async () => {
    const approved = await seedDeadOutbox();
    await seedEffect(approved, 0, 1, 'sent');
    const planned = await plan();
    const auditBlocker = await pool.connect();
    let applySettled = false;
    try {
      await auditBlocker.query('BEGIN');
      await auditBlocker.query(`LOCK TABLE audit_events IN SHARE MODE`);
      const applying = apply(planned).finally(() => { applySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(applySettled).toBe(false);
      const late = await seedDeadOutbox();
      await seedEffect(late, 0, 1, 'sent');
      await auditBlocker.query('COMMIT');
      await expect(applying).resolves.toMatchObject({ recoveredSentCount: 1, transitionCount: 1 });
      expect((await pool.query<{ status: string; resolved: boolean }>(
        `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved
         FROM adapter_outbox outbox JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
         WHERE outbox.id=$1`, [late.outboxId],
      )).rows[0]).toEqual({ status: 'dead', resolved: false });
    } finally {
      await auditBlocker.query('ROLLBACK').catch(() => undefined);
      auditBlocker.release();
    }
  });

  it.each(['processing', 'sent', 'dead'] as const)(
    'resolves an ACK only after its correlated final is claimed or terminal (%s)',
    async (finalStatus) => {
      const root = randomUUID();
      const acknowledgement = await seedDeadOutbox({
        payload: { relay_kind: 'ack', correlation: { root_message_id: root } },
      });
      const final = await seedOutboxWithoutDlq({
        relay_kind: 'final', correlation: { root_message_id: root },
      });
      await pool.query(
        `UPDATE adapter_outbox SET status=$2,attempts=$3,dead_at=CASE WHEN $2='dead' THEN now() ELSE NULL END
         WHERE id=$1`,
        [final.outboxId, finalStatus, finalStatus === 'processing' ? 1 : 0],
      );

      const planned = await plan();
      expect(planned.material.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: 'telegram_ack_final_claimed_v1', count: 1 }),
      ]));
      const results = await Promise.all([apply(planned), apply(planned)]);
      expect(results.map((value) => value.alreadyApplied).sort()).toEqual([false, true]);
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [acknowledgement.letterId],
      )).rows[0]?.resolved).toBe(true);
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`, [acknowledgement.outboxId],
      )).rows[0]?.status).toBe('dead');
      expect((await pool.query(
        `SELECT 1 FROM audit_events
         WHERE action='dlq.reconcile' AND metadata->>'rule'='telegram_ack_final_claimed_v1'`,
      )).rowCount).toBe(1);
    },
  );

  it('keeps an ACK open while its correlated final is only pending', async () => {
    const root = randomUUID();
    const acknowledgement = await seedDeadOutbox({
      payload: { relay_kind: 'ack', correlation: { root_message_id: root } },
    });
    const final = await seedOutboxWithoutDlq({
      relay_kind: 'final', correlation: { root_message_id: root },
    });
    await pool.query(
      `UPDATE adapter_outbox SET status='pending',attempts=0,dead_at=NULL WHERE id=$1`,
      [final.outboxId],
    );
    await apply(await plan());
    expect((await pool.query<{ resolved: boolean; disposition: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,disposition
       FROM outbox_dead_letters WHERE id=$1`, [acknowledgement.letterId],
    )).rows[0]).toEqual({ resolved: false, disposition: 'missing_final' });
  });

  it('resolves wakes only from a terminal delivery or a later sent wake and classifies the rest', async () => {
    const terminalDelivery = await seedDelivery({ status: 'done', terminal: true });
    const terminalWake = await seedDeadOutbox({ kind: 'wake', adapter: 'gateway', deliveryId: terminalDelivery });

    const retriedDelivery = await seedDelivery({ status: 'pending' });
    const oldWake = await seedDeadOutbox({
      kind: 'wake', adapter: 'gateway', deliveryId: retriedDelivery, createdAt: '2026-01-01T00:00:00Z',
    });
    const seeded = await seedMessage();
    await pool.query(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload,
         status,attempts,max_attempts,sent_at,created_at
       ) VALUES('Steven','gateway','wake',$1,$2,$3,$4,'wake-later','{}','sent',1,3,now(),now())`,
      [randomUUID(), seeded.requestId, seeded.messageId, retriedDelivery],
    );

    const missingFinal = await seedDeadOutbox({ kind: 'wake', adapter: 'gateway' });
    const offlineDelivery = await seedDelivery({ status: 'pending', recipientAlias: 'hegel' });
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,enabled)
       VALUES('Steven','hegel','openclaw',false)`,
    );
    const expectedOffline = await seedDeadOutbox({
      kind: 'wake', adapter: 'gateway', deliveryId: offlineDelivery,
    });

    await apply(await plan());
    for (const fixture of [terminalWake, oldWake]) {
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(true);
    }
    expect((await pool.query<{ disposition: string }>(
      `SELECT disposition FROM outbox_dead_letters WHERE id=$1`, [missingFinal.letterId],
    )).rows[0]?.disposition).toBe('missing_final');
    expect((await pool.query<{ resolved: boolean; rule: string; disposition: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,resolution_rule AS rule,disposition
       FROM outbox_dead_letters WHERE id=$1`, [expectedOffline.letterId],
    )).rows[0]).toEqual({
      resolved: true,
      rule: 'wake_expected_offline_v1',
      disposition: 'expected_offline',
    });
    const inventory = await pool.query<{
      source: string; kind: string; actionable: boolean; count: string;
    }>(
      `SELECT source,kind,actionable,count::text FROM cauce_dlq_inventory_030
       WHERE source='outbox' ORDER BY kind,open,actionable`,
    );
    expect(inventory.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'outbox', kind: 'wake', actionable: false }),
      expect.objectContaining({ source: 'outbox', kind: 'wake', actionable: true }),
    ]));
  });

  it('resolves terminal delivery incidents only from direct allow audits and preserves deliveries', async () => {
    const proven = await Promise.all([
      'agent_output.materialize', 'agent_output.response', 'agent_output.fanin', 'delivery.cancel',
    ].map(async (action) => {
      const fixture = await seedDeadDelivery({ status: 'dead', terminal: true });
      await pool.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
         VALUES('Steven','kant',$2,'allow',$1)`,
        [fixture.deliveryId, action],
      );
      return { ...fixture, action };
    }));
    const denied = await seedDeadDelivery({ status: 'dead', terminal: true });
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
       VALUES('Steven','kant','agent_output.response','deny',$1)`,
      [denied.deliveryId],
    );
    const absent = await seedDeadDelivery({ status: 'failed', terminal: true });
    const nonterminal = await seedDeadDelivery({ status: 'dead', terminal: false });
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,delivery_id)
       VALUES('Steven','kant','agent_output.fanin','allow',$1)`,
      [nonterminal.deliveryId],
    );
    const before = await pool.query<{ id: string; value: string }>(
      `SELECT id,row_to_json(delivery)::text AS value FROM deliveries delivery
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [proven.map((fixture) => fixture.deliveryId)],
    );

    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'delivery_terminal_notice_materialized_v1', count: 3 }),
      expect.objectContaining({ rule: 'delivery_cancelled_v1', count: 1 }),
    ]));
    const results = await Promise.all([apply(planned), apply(planned)]);
    expect(results.map((result) => result.alreadyApplied).sort()).toEqual([false, true]);

    const after = await pool.query<{ id: string; value: string }>(
      `SELECT id,row_to_json(delivery)::text AS value FROM deliveries delivery
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [proven.map((fixture) => fixture.deliveryId)],
    );
    expect(after.rows).toEqual(before.rows);
    for (const fixture of proven) {
      const incident = (await pool.query<{ resolved: boolean; rule: string; evidence: string }>(
        `SELECT resolved_at IS NOT NULL AS resolved,resolution_rule AS rule,
                evidence_sha256 AS evidence FROM dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0];
      expect(incident?.resolved).toBe(true);
      expect(incident?.rule).toBe(
        fixture.action === 'delivery.cancel'
          ? 'delivery_cancelled_v1'
          : 'delivery_terminal_notice_materialized_v1',
      );
      expect(incident?.evidence).toMatch(/^[a-f0-9]{64}$/u);
    }
    for (const fixture of [denied, absent, nonterminal]) {
      expect((await pool.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved FROM dead_letters WHERE id=$1`,
        [fixture.letterId],
      )).rows[0]?.resolved).toBe(false);
    }
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.reconcile'
         AND metadata->>'rule' IN (
           'delivery_terminal_notice_materialized_v1','delivery_cancelled_v1'
         )`,
    )).rowCount).toBe(4);
  });

  it('auto-closes never-executed deliveries for a disabled recipient and fences re-enable races', async () => {
    await pool.query(
      `UPDATE agents SET enabled=false WHERE tenant_id='Steven' AND alias='argos';
       UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND alias='argos';`,
    );
    const offline = await seedDeadDelivery({
      status: 'dead', terminal: true, executionStarted: false, recipientAlias: 'argos',
    });
    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'delivery_expected_offline_v1', count: 1 }),
    ]));
    await apply(planned);
    expect((await pool.query<{ resolved: boolean; disposition: string; rule: string }>(
      `SELECT resolved_at IS NOT NULL AS resolved,disposition,resolution_rule AS rule
       FROM dead_letters WHERE id=$1`,
      [offline.letterId],
    )).rows[0]).toEqual({
      resolved: true, disposition: 'expected_offline', rule: 'delivery_expected_offline_v1',
    });

    const racing = await seedDeadDelivery({
      status: 'dead', terminal: true, executionStarted: false, recipientAlias: 'argos',
    });
    const stale = await plan();
    await pool.query(
      `UPDATE agents SET enabled=true WHERE tenant_id='Steven' AND alias='argos';
       UPDATE memberships SET enabled=true WHERE tenant_id='Steven' AND alias='argos';`,
    );
    await expect(apply(stale)).rejects.toThrow(/plan is stale/u);
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM dead_letters WHERE id=$1`,
      [racing.letterId],
    )).rows[0]?.resolved).toBe(false);
  });
});

describe('operator-only DLQ transitions', () => {
  it('manual replay verifies control and hash, preserves the incident, and reopens it on failure', async () => {
    const fixture = await seedDeadOutbox();
    const replayRequestId = randomUUID();
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'a'.repeat(64) });
    await apply(await plan());
    const incidentEvidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;
    const inspected = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(Object.keys(inspected).sort()).toEqual([
      'evidenceSha256', 'id', 'items', 'phase', 'schemaVersion', 'suite', 'total',
    ]);
    expect(inspected).toMatchObject({
      id: fixture.letterId,
      evidenceSha256: incidentEvidence,
      total: 1,
      items: [{
        chunkIndex: 0, effectSha256: 'a'.repeat(64),
        state: 'ambiguous', replayCount: 0, duplicateRisk: true,
      }],
    });
    const inspectedText = JSON.stringify(inspected);
    expect(inspectedText).not.toMatch(/payload|origin|provider|messageId|outboxId|diagnostic/u);
    expect(inspectedText).not.toContain(fixture.outboxId);

    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','jarvis',true,$2,$3,$4,0
       )`,
      ['a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/lacks control permission/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',false,$2,$3,$4,0
       )`,
      ['a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/duplicate-risk acknowledgement/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       )`,
      ['b'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence],
    )).rejects.toThrow(/exactly one current effect/u);

    const replay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      ['a'.repeat(64), replayRequestId, fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(replay).toMatchObject({ appliedCount: 1, duplicateRisk: true });
    expect((await pool.query<{ status: string; state: string; resolved: boolean }>(
      `SELECT outbox.status,effect.state,letter.resolved_at IS NOT NULL AS resolved
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0]).toEqual({ status: 'failed', state: 'prepared', resolved: true });
    expect((await pool.query(
      `SELECT 1 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rowCount).toBe(1);

    await pool.query(
      `UPDATE adapter_outbox SET status='dead',attempts=attempts+1,dead_at=now(),
         last_error='known later rejection',claimed_by='telegram-worker'
       WHERE id=$1 AND status='failed'`,
      [fixture.outboxId],
    );
    const reopened = (await pool.query<{
      resolved: boolean; reopen_count: number; last_reopened_at: Date | null;
    }>(
      `SELECT resolved_at IS NOT NULL AS resolved,reopen_count,last_reopened_at
       FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0];
    expect(reopened).toMatchObject({ resolved: false, reopen_count: 1 });
    expect(reopened?.last_reopened_at).toBeInstanceOf(Date);
    expect((await pool.query(
      `SELECT 1 FROM telegram_manual_replays WHERE effect_id=$1`, [`${fixture.outboxId}:0`],
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.reopen'`,
    )).rowCount).toBe(1);
    const idempotentRetry = await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'ticket 42','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      ['a'.repeat(64), replayRequestId, fixture.letterId, incidentEvidence],
    );
    expect(requireValue(idempotentRetry.rows[0], 'idempotentRetry.rows').value).toMatchObject({
      appliedCount: 0, alreadyApplied: true, replaySequence: 1,
    });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM telegram_manual_replays WHERE request_id=$1`,
      [replayRequestId],
    )).rows[0]?.count).toBe('1');

    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'stale review','Steven','kant',true,$2,$3,$4,0
       )`, [
        'a'.repeat(64), randomUUID(), fixture.letterId, incidentEvidence,
      ],
    )).rejects.toThrow(/incident evidence changed|current incident state|incident\/effect evidence/u);
    await apply(await plan());
    const refreshed = requireValue((await pool.query<{
      evidence_sha256: string;
    }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;
    const refreshedInspect = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, refreshed],
    )).rows[0], 'rows').value;
    expect(refreshedInspect).toMatchObject({
      items: [expect.objectContaining({ replayCount: 1, state: 'prepared', duplicateRisk: false })],
    });
    const secondReplay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'fresh second review','Steven','kant',true,$2,$3,$4,1
       ) AS value`, [
        'a'.repeat(64), randomUUID(), fixture.letterId, refreshed,
      ],
    )).rows[0], 'rows').value;
    expect(secondReplay).toMatchObject({ appliedCount: 1, replaySequence: 2, duplicateRisk: false });
  });

  it('classifies prepared-only crashes as safe retry and schedules unsent chunks idempotently', async () => {
    const preparedOnly = await seedDeadOutbox();
    await seedEffect(preparedOnly, 0, 1, 'prepared', { hash: '1'.repeat(64) });
    const remainingPrepared = await seedDeadOutbox();
    await seedEffect(remainingPrepared, 0, 2, 'sent', {
      hash: '2'.repeat(64), provider: 'provider-complete-0',
    });
    await seedEffect(remainingPrepared, 1, 2, 'prepared', { hash: '3'.repeat(64) });

    const planned = await plan();
    expect(planned.material.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'classify_safe_retry_v1', count: 2 }),
    ]));
    await apply(planned);
    expect((await pool.query<{ disposition: string; count: string }>(
      `SELECT disposition,count(*)::text AS count FROM outbox_dead_letters
       WHERE id=ANY($1::uuid[]) GROUP BY disposition`,
      [[preparedOnly.letterId, remainingPrepared.letterId]],
    )).rows).toEqual([{ disposition: 'safe_retry', count: '2' }]);
    const preparedEvidence = (await pool.query<{ id: string; evidence_sha256: string }>(
      `SELECT id,evidence_sha256 FROM outbox_dead_letters WHERE id=ANY($1::uuid[])`,
      [[preparedOnly.letterId, remainingPrepared.letterId]],
    )).rows;
    const evidenceById = new Map(
      preparedEvidence.map((row) => [row.id, row.evidence_sha256] as const),
    );

    const preparedRequestId = randomUUID();
    const remainingRequestId = randomUUID();
    const calls = await Promise.all([
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,0,'prepared before remote call','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '1'.repeat(64), preparedRequestId,
          preparedOnly.letterId, evidenceById.get(preparedOnly.letterId),
        ],
      ),
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,1,'resume remaining unsent chunk','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '3'.repeat(64), remainingRequestId,
          remainingPrepared.letterId, evidenceById.get(remainingPrepared.letterId),
        ],
      ),
      pool.query<{ value: Record<string, unknown> }>(
        `SELECT cauce_manual_replay_telegram_030(
           $1,1,'resume remaining unsent chunk','Steven','kant',true,$2,$3,$4,0
         ) AS value`,
        [
          '3'.repeat(64), remainingRequestId,
          remainingPrepared.letterId, evidenceById.get(remainingPrepared.letterId),
        ],
      ),
    ]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.appliedCount).sort()).toEqual([0, 1, 1]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.alreadyApplied).sort()).toEqual([
      false, false, true,
    ]);
    expect(calls.every((call) => requireValue(call.rows[0], 'call.rows').value.duplicateRisk === false)).toBe(true);

    expect((await pool.query<{ status: string; resolved: boolean; rule: string }>(
      `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved,
              letter.resolution_rule AS rule
       FROM adapter_outbox outbox
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`,
      [remainingPrepared.outboxId],
    )).rows[0]).toEqual({ status: 'failed', resolved: true, rule: 'telegram_prepared_retry_v1' });
    expect((await pool.query<{
      state: string; provider_message_id: string | null; replay_count: number;
    }>(
      `SELECT state,provider_message_id,replay_count
       FROM telegram_egress_effects WHERE outbox_id=$1 ORDER BY chunk_index`,
      [remainingPrepared.outboxId],
    )).rows).toEqual([
      { state: 'sent', provider_message_id: 'provider-complete-0', replay_count: 0 },
      { state: 'prepared', provider_message_id: null, replay_count: 1 },
    ]);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE action='telegram.manual_replay'
         AND metadata->>'rule'='telegram_prepared_retry_v1'`,
    )).rows[0]?.count).toBe('2');
  });

  it('selects a replay by safe chunk coordinates when two chunks have the same payload hash', async () => {
    const fixture = await seedDeadOutbox();
    const sharedHash = '9'.repeat(64);
    await seedEffect(fixture, 0, 2, 'ambiguous', { hash: sharedHash });
    await seedEffect(fixture, 1, 2, 'ambiguous', { hash: sharedHash });
    await apply(await plan());
    const incidentEvidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;

    const inspected = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Steven','kant') AS value`,
      [fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(inspected).toMatchObject({
      total: 2,
      items: [
        { chunkIndex: 0, effectSha256: sharedHash, state: 'ambiguous', replayCount: 0,
          duplicateRisk: true },
        { chunkIndex: 1, effectSha256: sharedHash, state: 'ambiguous', replayCount: 0,
          duplicateRisk: true },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain(fixture.outboxId);

    const replay = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_manual_replay_telegram_030(
         $1,1,'select second identical chunk','Steven','kant',true,$2,$3,$4,0
       ) AS value`,
      [sharedHash, randomUUID(), fixture.letterId, incidentEvidence],
    )).rows[0], 'rows').value;
    expect(replay).toMatchObject({ appliedCount: 1, replaySequence: 1 });
    expect((await pool.query<{ chunk_index: number; state: string; replay_count: number }>(
      `SELECT chunk_index,state,replay_count FROM telegram_egress_effects
       WHERE outbox_id=$1 ORDER BY chunk_index`, [fixture.outboxId],
    )).rows).toEqual([
      { chunk_index: 0, state: 'ambiguous', replay_count: 0 },
      { chunk_index: 1, state: 'prepared', replay_count: 1 },
    ]);
  });

  it('resolves reviewed ambiguity without replay, with ACL scope, CAS and concurrent idempotence', async () => {
    const fixture = await seedDeadOutbox();
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'c'.repeat(64) });
    await apply(await plan());
    const evidence = requireValue((await pool.query<{ evidence_sha256: string }>(
      `SELECT evidence_sha256 FROM outbox_dead_letters WHERE id=$1`, [fixture.letterId],
    )).rows[0], 'rows').evidence_sha256;

    await pool.query(
      `UPDATE memberships SET role='operator'
       WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET allow_control=false WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'reviewed incident','Isa','salva',true,true
       )`, [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);

    const scopedAway = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value;
    expect(scopedAway.items).toEqual([]);
    const scopedPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(scopedPlan.material).toMatchObject({ candidateCount: 0, inventory: [] });
    const visible = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Steven','kant',200) AS value`,
    )).rows[0], 'rows').value;
    const listed = visible.items.find((item) => item.id === fixture.letterId);
    expect(listed).toMatchObject({
      target: 'outbox', kind: 'origin_relay', adapter: 'telegram', disposition: 'ambiguous',
      tenantId: 'Steven', open: true, actionable: true, evidenceSha256: evidence,
      attempts: 3, resolutionRule: null, reopenCount: 0,
    });
    expect(listed).toBeDefined();
    if (!listed) throw new Error('expected the scoped incident in the safe DLQ list');
    expect(Object.keys(listed).sort()).toEqual([
      'actionable', 'adapter', 'attempts', 'createdAt', 'disposition', 'dispositionAt',
      'evidenceSha256', 'id', 'kind', 'lastReopenedAt', 'open', 'reopenCount',
      'resolutionRule', 'resolvedAt', 'target', 'tenantId',
    ]);

    const before = requireValue((await pool.query<{ outbox: string; effect: string }>(
      `SELECT row_to_json(outbox)::text AS outbox,row_to_json(effect)::text AS effect
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0], 'rows');
    const calls = await Promise.all([
      pool.query<{ value: OperatorResolution }>(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'reviewed incident','Steven','kant',true,true
         ) AS value`, [fixture.letterId, evidence],
      ),
      pool.query<{ value: OperatorResolution }>(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'reviewed incident','Steven','kant',true,true
         ) AS value`, [fixture.letterId, evidence],
      ),
    ]);
    expect(calls.map((call) => requireValue(call.rows[0], 'call.rows').value.alreadyApplied).sort()).toEqual([false, true]);

    const after = requireValue((await pool.query<{ outbox: string; effect: string; resolved: boolean }>(
      `SELECT row_to_json(outbox)::text AS outbox,row_to_json(effect)::text AS effect,
              letter.resolved_at IS NOT NULL AS resolved
       FROM adapter_outbox outbox
       JOIN telegram_egress_effects effect ON effect.outbox_id=outbox.id
       JOIN outbox_dead_letters letter ON letter.outbox_id=outbox.id
       WHERE outbox.id=$1`, [fixture.outboxId],
    )).rows[0], 'rows');
    expect(after.outbox).toBe(before.outbox);
    expect(after.effect).toBe(before.effect);
    expect(after.resolved).toBe(true);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='dlq.resolve_without_replay'`,
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM dlq_operator_resolutions WHERE dead_letter_id=$1`, [fixture.letterId],
    )).rowCount).toBe(1);
  });

  it.each([
    { disposition: 'safe_retry', duplicate: false },
    { disposition: 'missing_final', duplicate: true },
    { disposition: 'auth', duplicate: false },
  ] as const)('closes actionable $disposition without replay', async ({ disposition, duplicate }) => {
    const fixture = await seedDeadOutbox();
    const evidence = disposition.charCodeAt(0).toString(16).padStart(2, '0').repeat(32);
    await pool.query(
      `UPDATE outbox_dead_letters SET disposition=$2,disposition_at=now(),evidence_sha256=$3
       WHERE id=$1`, [fixture.letterId, disposition, evidence],
    );
    const result = requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'reviewed without replay','Steven','kant',$3,true
       ) AS value`, [fixture.letterId, evidence, duplicate],
    )).rows[0], 'rows').value;
    expect(result).toMatchObject({ appliedCount: 1, alreadyApplied: false });
    expect((await pool.query<{ status: string; resolved: boolean }>(
      `SELECT outbox.status,letter.resolved_at IS NOT NULL AS resolved
       FROM outbox_dead_letters letter JOIN adapter_outbox outbox ON outbox.id=letter.outbox_id
       WHERE letter.id=$1`, [fixture.letterId],
    )).rows[0]).toEqual({ status: 'dead', resolved: true });
  });

  it('revalidates no-replay scope after a concurrent ACL revocation commits', async () => {
    const fixture = await seedDeadOutbox();
    const evidence = '9'.repeat(64);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );

    const revoker = await pool.connect();
    let settled = false;
    try {
      await revoker.query('BEGIN');
      await revoker.query(
        `UPDATE acl_edges SET allow_control=false
          WHERE from_tenant='Isa' AND to_tenant='Steven'`,
      );
      const resolving = pool.query(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'revoked concurrently','Isa','salva',true,true
         )`,
        [fixture.letterId, evidence],
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      await expect(resolving).rejects.toThrow(/outside actor control scope/u);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);
  });

  it.each([
    {
      label: 'membership disable',
      revoke: `UPDATE memberships SET enabled=false
               WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    },
    {
      label: 'room disable',
      revoke: `UPDATE rooms SET enabled=false WHERE tenant_id='Isa' AND id='grp.isa'`,
    },
  ])('revalidates actor control after concurrent $label', async ({ revoke }) => {
    const fixture = await seedDeadOutbox();
    const evidence = '8'.repeat(64);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await pool.query(
      `UPDATE memberships SET role='operator',enabled=true
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(`UPDATE rooms SET enabled=true WHERE tenant_id='Isa' AND id='grp.isa'`);
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );

    const revoker = await pool.connect();
    let settled = false;
    try {
      await revoker.query('BEGIN');
      await revoker.query(revoke);
      const resolving = pool.query(
        `SELECT cauce_resolve_dlq_without_replay_030(
           'outbox',$1,$2,'actor revoked concurrently','Isa','salva',true,true
         )`,
        [fixture.letterId, evidence],
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      await expect(resolving).rejects.toThrow(/lacks control permission/u);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);
  });

  it('denies list, plan, apply, no-replay and manual replay through historical invalid edges', async () => {
    const fixture = await seedDeadOutbox();
    const evidence = 'c'.repeat(64);
    await seedEffect(fixture, 0, 1, 'ambiguous', { hash: 'a'.repeat(64) });
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await pool.query(
      `UPDATE acl_edges SET enabled=true,allow_control=true
        WHERE from_tenant='Isa' AND to_tenant='Steven'`,
    );
    const authorizedPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(authorizedPlan.material.candidateCount).toBe(1);

    await pool.query(`
      BEGIN;
      ALTER TABLE tenants DISABLE TRIGGER tenants_hub_star_guard;
      UPDATE tenants SET is_hub=false WHERE id IN ('Isa','Steven');
      ALTER TABLE tenants ENABLE TRIGGER tenants_hub_star_guard;
      COMMIT
    `);
    expect(requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value.items).toEqual([]);
    expect(requireValue((await pool.query<{ value: Record<string, unknown> }>(
      `SELECT cauce_dlq_inspect_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value).toMatchObject({ inventory: [] });
    expect(requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value.material).toMatchObject({ candidateCount: 0, inventory: [] });
    await expect(pool.query(
      `SELECT cauce_dlq_apply_030('Isa','salva',$1)`, [authorizedPlan.planSha256],
    )).rejects.toThrow(/plan is stale/u);
    await pool.query(
      `UPDATE outbox_dead_letters
          SET disposition='ambiguous',disposition_at=now(),evidence_sha256=$2
        WHERE id=$1`,
      [fixture.letterId, evidence],
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'client-client historical edge','Isa','salva',true,true
       )`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'client-client historical edge','Isa','salva',true,$2,$3,$4,0
       )`, ['a'.repeat(64), randomUUID(), fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_inspect_telegram_replay_030($1,$2,'Isa','salva')`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    expect((await pool.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM outbox_dead_letters WHERE id=$1`,
      [fixture.letterId],
    )).rows[0]?.resolved).toBe(false);

    await pool.query(`UPDATE tenants SET is_hub=(id='Steven') WHERE id IN ('Isa','Steven')`);
    const enabledPlan = requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value;
    expect(enabledPlan.material.inventory).not.toEqual([]);
    await pool.query(`UPDATE tenants SET enabled=false WHERE id='Steven'`);
    expect(requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Isa','salva',200) AS value`,
    )).rows[0], 'rows').value.items).toEqual([]);
    expect(requireValue((await pool.query<{ value: ReconciliationPlan }>(
      `SELECT cauce_dlq_plan_030('Isa','salva') AS value`,
    )).rows[0], 'rows').value.material).toMatchObject({ candidateCount: 0, inventory: [] });
    await expect(pool.query(
      `SELECT cauce_dlq_apply_030('Isa','salva',$1)`, [enabledPlan.planSha256],
    )).rejects.toThrow(/plan is stale/u);
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'disabled target tenant','Isa','salva',true,true
       )`,
      [fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
    await expect(pool.query(
      `SELECT cauce_manual_replay_telegram_030(
         $1,0,'disabled target tenant','Isa','salva',true,$2,$3,$4,0
       )`, ['a'.repeat(64), randomUUID(), fixture.letterId, evidence],
    )).rejects.toThrow(/outside actor control scope/u);
  });

  it('paginates the safe list with a scoped deterministic keyset cursor', async () => {
    const timestamp = '2026-08-26T12:34:56.123456Z';
    const outbox = await seedDeadOutbox({ createdAt: timestamp });
    await seedDeadDelivery({
      status: 'dead', terminal: true, letterId: outbox.letterId, createdAt: timestamp,
    });

    const repository = new CauceRepository(pool);
    const first = await repository.listOperationalDlq('Steven', 'kant', 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ target: 'outbox', id: outbox.letterId });
    expect(first).toMatchObject({ total: 2, truncated: true });
    expect(first.nextCursor).toMatch(/^[a-f0-9]+$/u);
    expect(first.nextCursor).not.toContain(outbox.letterId);

    const second = await repository.listOperationalDlq('Steven', 'kant', 1, first.nextCursor);
    expect(second.items).toEqual([
      expect.objectContaining({ target: 'delivery', id: outbox.letterId }),
    ]);
    expect(second).toMatchObject({ total: 2, truncated: false, nextCursor: null });
    expect(new Set(
      [...first.items, ...second.items].map((item) => `${item.target}:${item.id}`),
    ).size).toBe(2);

    await expect(pool.query(
      `SELECT cauce_list_dlq_030('Steven','kant',1,'not-a-cursor')`,
    )).rejects.toThrow(/cursor is invalid/u);
    await pool.query(
      `UPDATE memberships SET role='operator'
        WHERE tenant_id='Isa' AND alias='salva' AND room_id='grp.isa'`,
    );
    await expect(pool.query(
      `SELECT cauce_list_dlq_030('Isa','salva',1,$1)`, [first.nextCursor],
    )).rejects.toThrow(/cursor is invalid/u);
  });

  it('rejects unclassified incidents and risk acknowledgements that do not match uncertainty', async () => {
    const unclassified = await seedDeadOutbox();
    await pool.query(
      `UPDATE outbox_dead_letters SET evidence_sha256=$2 WHERE id=$1`,
      [unclassified.letterId, 'd'.repeat(64)],
    );
    const safeList = requireValue((await pool.query<{ value: SafeList }>(
      `SELECT cauce_list_dlq_030('Steven','kant',200) AS value`,
    )).rows[0], 'rows').value;
    expect(safeList.items.find((item) => item.id === unclassified.letterId)).toMatchObject({
      disposition: 'unclassified', open: true, actionable: false,
    });
    expect((await pool.query<{ actionable: boolean }>(
      `SELECT actionable FROM cauce_dlq_inventory_030
       WHERE source='outbox' AND kind='origin_relay' AND disposition='unclassified' AND open`,
    )).rows[0]).toEqual({ actionable: false });
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'not classified','Steven','kant',true,true
       )`, [unclassified.letterId, 'd'.repeat(64)],
    )).rejects.toThrow(/fenced by current incident state/u);

    const missingFinal = await seedDeadOutbox();
    await pool.query(
      `UPDATE outbox_dead_letters SET disposition='missing_final',disposition_at=now(),
         evidence_sha256=$2 WHERE id=$1`, [missingFinal.letterId, 'e'.repeat(64)],
    );
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'uncertain','Steven','kant',false,true
       )`, [missingFinal.letterId, 'e'.repeat(64)],
    )).rejects.toThrow(/possible-duplicate acknowledgement/u);
    await expect(pool.query(
      `SELECT cauce_resolve_dlq_without_replay_030(
         'outbox',$1,$2,'uncertain','Steven','kant',true,false
       )`, [missingFinal.letterId, 'e'.repeat(64)],
    )).rejects.toThrow(/no-delivery acknowledgement/u);
  });
});
