import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='kant';
    UPDATE role_policies SET allow_read=true WHERE role='operator';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

async function message(tenant: string, room: string, actor: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,'interactive',0) RETURNING id`,
    [randomUUID(), `trace-${randomUUID()}`, tenant, room, actor, JSON.stringify({ text: 'private body' })],
  );
  return result.rows[0]!.id;
}

async function audit(values: {
  tenant: string;
  actor: string;
  action: string;
  decision: 'allow' | 'deny' | 'info';
  metadata: Record<string, unknown>;
  messageId?: string;
  deliveryId?: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO audit_events(
       tenant_id,actor_alias,action,decision,message_id,delivery_id,trace_id,metadata,created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'2026-08-26T08:00:00Z') RETURNING id`,
    [values.tenant, values.actor, values.action, values.decision, values.messageId ?? null,
      values.deliveryId ?? null, `trace-${randomUUID()}`, JSON.stringify(values.metadata)],
  );
  return result.rows[0]!.id;
}

describe('participant-aware audit keyset pagination', () => {
  it('has no gaps or duplicates, preserves participant visibility and never emits raw metadata', async () => {
    const crossMessage = await message('Miguel', 'grp.miguel', 'janus');
    const crossDelivery = await pool.query<{ id: string }>(
      `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,max_attempts)
       VALUES($1,'Steven','kant',3) RETURNING id`,
      [crossMessage],
    );
    const roomMessage = await message('Steven', 'grp.steven', 'argos');

    await audit({
      tenant: 'Miguel', actor: 'janus', action: 'hidden.event', decision: 'deny',
      metadata: { body: 'HIDDEN_SECRET' },
    });
    const ownOld = await audit({
      tenant: 'Steven', actor: 'kant', action: 'message.publish', decision: 'allow',
      metadata: { queued: true, body: 'OWN_SECRET', token: 'OWN_SECRET' },
    });
    const cross = await audit({
      tenant: 'Miguel', actor: 'janus', action: 'delivery.ack', decision: 'allow',
      metadata: { ack: 'done', payload: 'CROSS_SECRET', token: 'CROSS_SECRET' },
      deliveryId: crossDelivery.rows[0]!.id,
    });
    const room = await audit({
      tenant: 'Steven', actor: 'argos', action: 'message.route', decision: 'allow',
      metadata: { outcome: 'delivered', body: 'ROOM_SECRET' }, messageId: roomMessage,
    });
    const ownNew = await audit({
      tenant: 'Steven', actor: 'kant', action: 'fleet.reconcile', decision: 'info',
      metadata: { state: 'converged', credentials: 'INFO_SECRET' },
    });
    await audit({
      tenant: 'Pablo', actor: 'midas', action: 'hidden.newer', decision: 'info',
      metadata: { body: 'HIDDEN_SECRET' },
    });

    const first = await repository.listAudit('Steven', 'kant', { limit: 2 });
    expect(first).toEqual({
      items: [
        expect.objectContaining({ event_id: ownNew, tenant_id: 'Steven', decision: 'info', summary: '{"state":"converged"}' }),
        expect.objectContaining({ event_id: room, actor_alias: 'argos', summary: '{"outcome":"delivered"}' }),
      ],
      next_cursor: room,
    });

    const second = await repository.listAudit('Steven', 'kant', {
      limit: 2,
      before: String((first as { next_cursor: string }).next_cursor),
    });
    expect(second).toEqual({
      items: [
        expect.objectContaining({ event_id: cross, tenant_id: 'Miguel', summary: '{"ack":"done"}' }),
        expect.objectContaining({ event_id: ownOld, tenant_id: 'Steven', summary: '{"queued":true}' }),
      ],
      next_cursor: null,
    });

    const serialized = JSON.stringify([first, second]);
    for (const secret of ['OWN_SECRET', 'CROSS_SECRET', 'ROOM_SECRET', 'INFO_SECRET', 'HIDDEN_SECRET']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('metadata');
    const observedIds = [...(first.items as Array<{ event_id: string }>),
      ...(second.items as Array<{ event_id: string }>)]
      .map((item) => item.event_id);
    expect(observedIds).toEqual([ownNew, room, cross, ownOld]);
    expect(new Set(observedIds)).toHaveLength(observedIds.length);
  });

  it.each([
    { limit: 0 },
    { limit: 501 },
    { before: '01' },
    { before: '9223372036854775808' },
  ])('rejects malformed pagination defensively: %j', async (options) => {
    await expect(repository.listAudit('Steven', 'kant', options))
      .rejects.toBeInstanceOf(StoreError);
  });
});
