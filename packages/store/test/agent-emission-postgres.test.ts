import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import { CauceRepository, type AgentProgressInput, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { consumer, nextDelivery } from './helpers/consumer.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
});
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false WHERE role='agent'`);
  await pool.query(`INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
    VALUES('Steven','socrates',false,1),('Steven','jarvis',false,1)`);
  await pool.query(`UPDATE agent_chain_policies SET progress_relay_enabled=true,progress_relay_max_events=10`);
});
afterAll(async () => {
  if (!database) return;
  await database.pool.end();
  await database.container.stop();
});

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: 'Steven',
    room_id: 'grp.steven', actor_alias: 'argos', recipients: [{ tenant_id: 'Steven', alias: 'socrates' }],
    body: { text: 'Perform a bounded task' }, idempotency_key: randomUUID(), lane: 'interactive', priority: 7,
    authenticated_context: {
      session_id: 'test-mcp', channel: 'telegram-dm',
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: 'test-chat',
        external_message_id: randomUUID(), relay: [], metadata: { bridge_alias: 'socrates' } },
    },
    ...overrides,
  };
}

async function activeDelivery() {
  await repository.publish(command());
  const target = await consumer(repository, 'Steven', 'socrates', 60_000);
  const delivery = await nextDelivery(repository, target);
  const input: AgentProgressInput = {
    text: 'Validated the first stage', attempt: delivery.attempt, claim_token: delivery.claim_token,
    epoch: target.epoch, instance_id: target.instanceId,
  };
  return { id: delivery.delivery_id, input };
}

async function terminalDelivery(status: 'dead' | 'failed' = 'dead', overrides: Partial<PublishMessage> = {}) {
  const published = await repository.publish(command(overrides));
  const id = requireValue(published.delivery_ids[0], 'delivery id');
  await pool.query(`UPDATE deliveries SET status=$2,terminal_at=now() WHERE id=$1`, [id, status]);
  await pool.query(`INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
    SELECT id,recipient_tenant,'test failure','{}'::jsonb,attempt FROM deliveries WHERE id=$1`, [id]);
  return id;
}

describe('agent emission with durable authority', () => {
  it('lists only nonterminal deliveries of the exact recipient identity', async () => {
    const own = await repository.publish(command());
    await repository.publish(command({ recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }] }));
    await terminalDelivery();
    const queue = await repository.agentQueue('Steven', 'socrates');
    expect(queue.total).toBe(1);
    expect(queue.deliveries).toHaveLength(1);
    expect(queue.deliveries[0]).toMatchObject({ delivery_id: own.delivery_ids[0], status: 'pending', attempt: 0 });
    expect(Object.keys(requireValue(queue.deliveries[0], 'queue row')).sort()).toEqual([
      'attempt', 'created_at', 'deadline_at', 'delivery_id', 'status',
    ]);
    expect(await repository.agentQueue('Isa', 'salva')).toEqual({ deliveries: [], total: 0 });
  });

  it('persists progress and its existing origin relay without closing or renewing the delivery', async () => {
    const { id, input } = await activeDelivery();
    const before = (await pool.query('SELECT status,ack_deadline_at FROM deliveries WHERE id=$1', [id])).rows;
    expect(await repository.recordAgentProgress(id, 'Steven', 'socrates', input)).toMatchObject({ recorded: true, duplicate: false });
    expect(await repository.recordAgentProgress(id, 'Steven', 'socrates', input)).toMatchObject({ duplicate: true });
    expect((await pool.query('SELECT status,ack_deadline_at FROM deliveries WHERE id=$1', [id])).rows).toEqual(before);
    const audit = await pool.query<{ metadata: unknown }>(`SELECT metadata FROM audit_events WHERE delivery_id=$1 AND action='delivery.progress'`, [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata).toMatchObject({ text: input.text, attempt: input.attempt });
    const relays = await pool.query<{ payload: unknown }>(`SELECT payload FROM adapter_outbox WHERE delivery_id=$1 AND kind='origin_relay'`, [id]);
    expect(relays.rows).toHaveLength(1);
    expect(relays.rows[0]?.payload).toMatchObject({ terminal: false, progress_stage: 'progress', result: { output: { reply: input.text } } });
  });

  it.each(['attempt', 'claim_token', 'epoch', 'instance_id'] as const)('rejects stale %s without persisting progress', async (field) => {
    const { id, input } = await activeDelivery();
    const changed = { ...input, [field]: typeof input[field] === 'number' ? input[field] + 1 : randomUUID() };
    await expect(repository.recordAgentProgress(id, 'Steven', 'socrates', changed)).rejects.toMatchObject({ code: 'fenced' });
    expect((await pool.query(`SELECT 1 FROM audit_events WHERE action='delivery.progress'`)).rowCount).toBe(0);
  });

  it.each(['lease', 'deadline', 'terminal'])('rejects an expired %s even with the original claim', async (expired) => {
    const { id, input } = await activeDelivery();
    if (expired === 'lease') await pool.query(`UPDATE connection_leases SET lease_until=now()-interval '1 second' WHERE alias='socrates'`);
    if (expired === 'deadline') await pool.query(`UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1`, [id]);
    if (expired === 'terminal') await pool.query(`UPDATE deliveries SET status='done',terminal_at=now() WHERE id=$1`, [id]);
    await expect(repository.recordAgentProgress(id, 'Steven', 'socrates', input)).rejects.toMatchObject({ code: 'fenced' });
    expect((await pool.query(`SELECT 1 FROM audit_events WHERE action='delivery.progress'`)).rowCount).toBe(0);
  });

  it('rejects a different recipient with its own valid lease', async () => {
    const { id, input } = await activeDelivery();
    const other = await consumer(repository, 'Steven', 'jarvis');
    await expect(repository.recordAgentProgress(id, 'Steven', 'jarvis', {
      ...input, instance_id: other.instanceId, epoch: other.epoch,
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rechecks elapsed lease time after waiting for the delivery lock', async () => {
    const { id, input } = await activeDelivery();
    await pool.query(`UPDATE connection_leases SET lease_until=clock_timestamp()+interval '500 milliseconds'
      WHERE alias='socrates'`);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM deliveries WHERE id=$1 FOR UPDATE', [id]);
      const recording = repository.recordAgentProgress(id, 'Steven', 'socrates', input);
      const rejected = expect(recording).rejects.toMatchObject({ code: 'fenced' });
      await new Promise((resolve) => setTimeout(resolve, 650));
      await blocker.query('COMMIT');
      await rejected;
      expect((await pool.query(`SELECT 1 FROM audit_events WHERE action='delivery.progress'`)).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('allows a route-only author to retry once under concurrent requests and audits the clone', async () => {
    const id = await terminalDelivery();
    const [left, right] = await Promise.all([
      repository.retryOwnDelivery(id, 'Steven', 'argos'), repository.retryOwnDelivery(id, 'Steven', 'argos'),
    ]);
    expect(left.delivery_id).toBe(right.delivery_id);
    expect([left.already_replayed, right.already_replayed].sort()).toEqual([false, true]);
    expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(2);
    expect((await pool.query<{ metadata: unknown }>(`SELECT metadata FROM audit_events WHERE action='delivery.replay'`)).rows[0]?.metadata)
      .toMatchObject({ initiated_by_agent: true, replayed_from_delivery_id: id });
    const original = (await pool.query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [id])).rows[0];
    expect(original).toMatchObject({ status: 'dead' });
    expect((await pool.query(`SELECT 1 FROM adapter_outbox WHERE delivery_id=$1 AND kind='wake'`, [left.delivery_id])).rowCount).toBe(1);
  });

  it.each([['Steven', 'socrates'], ['Steven', 'jarvis'], ['Isa', 'salva']])('denies retry to %s/%s even when it can read the delivery', async (tenant, alias) => {
    const id = await terminalDelivery();
    await expect(repository.retryOwnDelivery(id, tenant, alias)).rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(1);
  });

  it('does not retry failed deliveries through the agent endpoint', async () => {
    const id = await terminalDelivery('failed');
    await expect(repository.retryOwnDelivery(id, 'Steven', 'argos')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rechecks cross-tenant route policy before an owned retry', async () => {
    const id = await terminalDelivery('dead', { recipients: [{ tenant_id: 'Isa', alias: 'salva' }] });
    await pool.query(`UPDATE acl_edges SET allow_route=false WHERE from_tenant='Steven' AND to_tenant='Isa'`);
    await expect(repository.retryOwnDelivery(id, 'Steven', 'argos')).rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(1);
  });
});
