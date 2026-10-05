import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import type { Principal } from '../../../services/gateway/src/auth.js';
import { visibleQueue } from '../../../services/gateway/src/facades.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  if (!databaseStarted) return;
  const cleanupErrors: unknown[] = [];
  try {
    await pool.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await database.container.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL test cleanup failed');
  }
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

interface TerminalFixture {
  deliveryId: string;
  letterId: string;
  messageId: string;
}

interface QueueSnapshot extends Record<string, unknown> {
  dead: number;
  totals: { dead: number };
  muestra_recortada: boolean;
  items: { delivery_id: string; state: string; dlq_resolved: boolean }[];
}

async function seedTerminalDelivery(options: {
  tenant: string;
  room: string;
  actor: string;
  recipientAlias: string;
  status: 'dead' | 'failed';
  createdAt: string;
  classified?: boolean;
}): Promise<TerminalFixture> {
  const message = await repository.publish({
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `queue-dlq-${randomUUID()}`,
    tenant_id: options.tenant,
    room_id: options.room,
    actor_alias: options.actor,
    recipients: [{ tenant_id: options.tenant, alias: options.recipientAlias }],
    body: { text: 'queue snapshot fixture' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
  });
  const delivery = await pool.query<{ id: string }>(
    `UPDATE deliveries SET status=$2,terminal_at=$3,created_at=$3
     WHERE message_id=$1 RETURNING id`,
    [message.message_id, options.status, options.createdAt],
  );
  const deliveryId = delivery.rows[0]?.id;
  if (deliveryId === undefined) throw new Error('published delivery was not found');
  const evidenceSha256 = options.classified ? 'a'.repeat(64) : null;
  const letter = await pool.query<{ id: string }>(
    `INSERT INTO dead_letters(
       delivery_id,tenant_id,reason,payload,attempts,created_at,disposition,disposition_at,evidence_sha256
     ) VALUES($1,$2,'queue snapshot fixture','{}'::jsonb,3,$3,$4,$5,$6) RETURNING id`,
    [deliveryId, options.tenant, options.createdAt, options.classified ? 'safe_retry' : 'unclassified',
      options.classified ? options.createdAt : null, evidenceSha256],
  );
  const letterId = letter.rows[0]?.id;
  if (letterId === undefined) throw new Error('dead letter was not inserted');
  return { deliveryId, letterId, messageId: message.message_id };
}

describe('resolved delivery DLQ rows in queue snapshots', () => {
  it('keeps the resolved row in history while reducing sample and full visible dead totals', async () => {
    const operator: Principal = {
      tenant_id: 'Steven',
      alias: 'kant',
      session_id: 'queue-dlq-resolution-test',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read'],
    };
    const oldDead = await seedTerminalDelivery({
      tenant: 'Steven', room: 'grp.steven', actor: 'kant', recipientAlias: 'argos',
      status: 'dead', createdAt: '2026-01-01T00:00:00.000Z',
    });
    const sampledFailed = await seedTerminalDelivery({
      tenant: 'Steven', room: 'grp.steven', actor: 'kant', recipientAlias: 'argos',
      status: 'failed', createdAt: '2026-01-02T00:00:00.000Z',
    });
    const resolvedDead = await seedTerminalDelivery({
      tenant: 'Steven', room: 'grp.steven', actor: 'kant', recipientAlias: 'argos',
      status: 'dead', createdAt: '2026-01-03T00:00:00.000Z', classified: true,
    });
    const foreignDead = await seedTerminalDelivery({
      tenant: 'Miguel', room: 'grp.miguel', actor: 'janus', recipientAlias: 'janus',
      status: 'dead', createdAt: '2026-01-04T00:00:00.000Z',
    });

    const before = await repository.queueSnapshot('Steven', 'kant', 2) as QueueSnapshot;
    expect(before.dead).toBe(2);
    expect(before.totals.dead).toBe(3);
    expect(before.muestra_recortada).toBe(true);
    expect(before.items.map((item) => item.delivery_id)).toEqual([
      resolvedDead.deliveryId, sampledFailed.deliveryId,
    ]);
    expect(before.items.some((item) => item.delivery_id === oldDead.deliveryId)).toBe(false);

    const resolution = await repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', {
      target: 'delivery',
      id: resolvedDead.letterId,
      evidenceSha256: 'a'.repeat(64),
      reason: 'Verified this incident requires no replay',
      possibleDuplicateAcknowledged: false,
      possibleNoDeliveryAcknowledged: true,
    });
    expect(resolution).toMatchObject({ phase: 'resolved', appliedCount: 1, alreadyApplied: false });

    const after = await repository.queueSnapshot('Steven', 'kant', 2) as QueueSnapshot;
    expect(after.items.map((item) => item.delivery_id)).toEqual([
      resolvedDead.deliveryId, sampledFailed.deliveryId,
    ]);
    expect(after.items[0]).toMatchObject({
      delivery_id: resolvedDead.deliveryId, state: 'dead', dlq_resolved: true,
    });
    expect(after.items[1]).toMatchObject({
      delivery_id: sampledFailed.deliveryId, state: 'failed', dlq_resolved: false,
    });
    expect(after.dead).toBe(1);
    expect(after.totals.dead).toBe(2);
    expect(after.muestra_recortada).toBe(true);
    expect(visibleQueue(after, operator)).toMatchObject({
      dead: 1, totals: { dead: 2 }, muestra_recortada: true,
    });

    const complete = await repository.queueSnapshot('Steven', 'kant', 200) as QueueSnapshot;
    expect(complete.dead).toBe(2);
    expect(complete.totals.dead).toBe(2);
    expect(complete.muestra_recortada).toBe(false);
    expect(complete.items).toHaveLength(3);
    expect(complete.items.find((item) => item.delivery_id === resolvedDead.deliveryId))
      .toMatchObject({ dlq_resolved: true });
    expect(complete.items.find((item) => item.delivery_id === oldDead.deliveryId))
      .toMatchObject({ state: 'dead', dlq_resolved: false });
    expect(complete.items.some((item) => item.delivery_id === foreignDead.deliveryId)).toBe(false);

    const durable = await pool.query<{ resolved: boolean; status: string }>(
      `SELECT letter.resolved_at IS NOT NULL AS resolved,delivery.status
       FROM dead_letters letter JOIN deliveries delivery ON delivery.id=letter.delivery_id
       WHERE letter.id=$1`, [resolvedDead.letterId],
    );
    expect(durable.rows[0]).toEqual({ resolved: true, status: 'dead' });
    expect((await pool.query(
      `SELECT 1 FROM dlq_operator_resolutions WHERE target='delivery' AND dead_letter_id=$1`,
      [resolvedDead.letterId],
    )).rowCount).toBe(1);
  }, 120_000);
});
