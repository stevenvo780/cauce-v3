import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach } from 'vitest';
import { type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
export interface DeadOutboxFixture {
  outboxId: string;
  letterId: string;
  messageId: string;
  requestId: string;
}
export interface ReconciliationTransition {
  rule: string;
  count: number;
}
export interface ReconciliationPlan {
  planSha256: string;
  material: {
    candidateCount: number;
    candidateSetSha256: string;
    inventory: unknown[];
    transitions: ReconciliationTransition[];
  };
}
export interface ReconciliationApply {
  alreadyApplied: boolean;
  transitionCount: number;
  recoveredSentCount: number;
}
export interface SafeListItem {
  id: string;
  [key: string]: unknown;
}

export interface SafeList {
  items: SafeListItem[];
  total: number;
  truncated: boolean;
  nextCursor: string | null;
}

export interface OperatorResolution {
  alreadyApplied: boolean;
}

export let database: TestDatabase;
export let databaseStarted = false;
export let pool: DatabasePool;

export function registerDlqSuite(sourceUrl: string): void {
  preparePostgresSuite(sourceUrl, async () => {
    database = await startTestDatabase();
    databaseStarted = true;
    pool = database.pool;
  }, 120_000);

  afterAll(async () => {
    if (!databaseStarted) return;
    await pool.end();
    await database.container.stop();
  });

  beforeEach(async () => {
    await resetTestDatabase(pool);
  });
}

export async function seedMessage(tenant = 'Steven', room = 'grp.steven', actor = 'kant'): Promise<{
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

export async function seedDeadOutbox(options: {
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

export async function seedOutboxWithoutDlq(payload: Record<string, unknown>): Promise<{ outboxId: string }> {
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

export async function seedEffect(
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

export async function plan(): Promise<ReconciliationPlan> {
  return requireValue((await pool.query<{ value: ReconciliationPlan }>(
    `SELECT cauce_dlq_plan_030('Steven','kant') AS value`,
  )).rows[0], 'rows').value;
}

export async function apply(planValue: ReconciliationPlan): Promise<ReconciliationApply> {
  return requireValue((await pool.query<{ value: ReconciliationApply }>(
    `SELECT cauce_dlq_apply_030('Steven','kant',$1) AS value`,
    [planValue.planSha256],
  )).rows[0], 'rows').value;
}

export async function seedDelivery(options: {
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

export async function seedDeadDelivery(options: Parameters<typeof seedDelivery>[0] & {
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
