import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPublishReceipt, publishReceiptCausalHash, publishRequestHash, type PublishMessage,
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

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
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'receipt survives an upgrade' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides,
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  repository = new CauceRepository(pool);
});

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

describe('publish receipt durable reconstruction', () => {
  it('independently rejects self-consistent alien effect IDs for fresh and duplicate receipts', async () => {
    const input = command();
    const fresh = await repository.publish(input);
    expect(await repository.verifyPublishReceipt(input, fresh)).toBe(true);

    const retryInput = {
      ...input,
      request_id: randomUUID(),
      trace_id: `retry-${randomUUID()}`,
    };
    const duplicate = await repository.publish(retryInput);
    expect(duplicate.duplicate).toBe(true);
    expect(await repository.verifyPublishReceipt(retryInput, duplicate)).toBe(true);

    for (const duplicateFlag of [false, true]) {
      const alien = buildPublishReceipt(input, {
        message_id: randomUUID(),
        delivery_ids: [randomUUID()],
        duplicate: duplicateFlag,
        request_id: duplicateFlag ? randomUUID() : input.request_id,
        trace_id: duplicateFlag ? `alien-${randomUUID()}` : input.trace_id,
      });
      expect(alien.causal_hash).toBe(publishReceiptCausalHash(alien));
      expect(await repository.verifyPublishReceipt(
        duplicateFlag ? retryInput : input,
        alien,
      )).toBe(false);
    }
  });

  it('upgrades a historical response after repository restart without repeating any effect', async () => {
    const input = command();
    const first = await repository.publish(input);
    const before = (await pool.query<{
      messages: string;
      deliveries: string;
      wakes: string;
    }>(
      `SELECT (SELECT count(*) FROM messages)::text AS messages,
              (SELECT count(*) FROM deliveries)::text AS deliveries,
              (SELECT count(*) FROM adapter_outbox WHERE kind='wake')::text AS wakes`,
    )).rows[0];

    // Exact pre-upgrade shape: the durable core exists, but none of the new causal fields does.
    await pool.query(
      `UPDATE idempotency_keys
          SET response=response - ARRAY[
            'idempotency_key','tenant_id','actor_alias','request_hash','causal_hash'
          ]::text[]
        WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
      [input.tenant_id, input.actor_alias, input.idempotency_key],
    );

    // A new repository instance models the service process after an upgrade/restart. The retry
    // receives a new request/trace pair, as it does through the real gateway.
    repository = new CauceRepository(pool);
    const replay = await repository.publish({
      ...input,
      request_id: randomUUID(),
      trace_id: `retry-${randomUUID()}`,
    });

    expect(replay).toMatchObject({
      message_id: first.message_id,
      delivery_ids: first.delivery_ids,
      duplicate: true,
      request_id: first.request_id,
      trace_id: first.trace_id,
      idempotency_key: input.idempotency_key,
      tenant_id: input.tenant_id,
      actor_alias: input.actor_alias,
      request_hash: publishRequestHash(input),
    });
    expect(replay.causal_hash).toBe(publishReceiptCausalHash(replay));
    expect((await pool.query(
      `SELECT (SELECT count(*) FROM messages)::text AS messages,
              (SELECT count(*) FROM deliveries)::text AS deliveries,
              (SELECT count(*) FROM adapter_outbox WHERE kind='wake')::text AS wakes`,
    )).rows[0]).toEqual(before);

    const repaired = (await pool.query<{ response: Record<string, unknown> }>(
      `SELECT response FROM idempotency_keys
       WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
      [input.tenant_id, input.actor_alias, input.idempotency_key],
    )).rows[0]?.response;
    expect(repaired).toMatchObject({ ...replay, duplicate: false });
  });

  it.each(['message_id', 'delivery_ids'] as const)(
    'rejects a historical %s from another durable publish instead of crediting or duplicating it',
    async (field) => {
      const input = command();
      const first = await repository.publish(input);
      const other = await repository.publish(command({ body: { text: 'another publish' } }));
      const forged = field === 'message_id'
        ? JSON.stringify(other.message_id)
        : JSON.stringify(other.delivery_ids);
      await pool.query(
        `UPDATE idempotency_keys
            SET response=(response - ARRAY[
              'idempotency_key','tenant_id','actor_alias','request_hash','causal_hash'
            ]::text[]) || jsonb_build_object($4::text, $5::jsonb)
          WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
        [input.tenant_id, input.actor_alias, input.idempotency_key, field, forged],
      );

      repository = new CauceRepository(pool);
      await expect(repository.publish({
        ...input,
        request_id: randomUUID(),
        trace_id: `retry-${randomUUID()}`,
      })).rejects.toThrow(/historical publish receipt differs from its durable effect/u);
      expect((await pool.query('SELECT 1 FROM messages')).rowCount).toBe(2);
      expect((await pool.query('SELECT 1 FROM deliveries')).rowCount).toBe(2);
      expect((await pool.query<{ message_id: string }>(
        `SELECT message_id FROM idempotency_keys
         WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
        [input.tenant_id, input.actor_alias, input.idempotency_key],
      )).rows[0]?.message_id).toBe(first.message_id);
    },
  );
});
