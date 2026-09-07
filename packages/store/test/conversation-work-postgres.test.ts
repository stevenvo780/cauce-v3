import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { DeliveryEnvelopeSchema, type DeliveryEnvelope, type PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { ackWith, consumer, nextDelivery, type Consumer } from './helpers/consumer.js';
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
  await pool.query(`UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true;
    UPDATE tenants SET enabled=true; UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter')`);
});
afterAll(async () => {
  if (!database) return;
  await pool.end();
  await database.container.stop();
});

function request(conversation = 'owner-dm', session = 'owner-session'): PublishMessage {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: randomUUID(),
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { type: 'telegram.message', text: 'Revisa el estado; password: root-secret-never-copy' },
    idempotency_key: randomUUID(), lane: 'interactive', priority: 7,
    authenticated_context: {
      session_id: session, channel: 'telegram', origin: {
        adapter: 'telegram', channel: 'telegram', conversation_id: conversation,
        external_message_id: randomUUID(), relay: [], metadata: {},
      },
    },
  };
}

async function coordinator(capable = true): Promise<Consumer> {
  const instanceId = randomUUID();
  const lease = await repository.acquireLease('Steven', 'argos', instanceId,
    capable ? ['conversation_work_v1'] : [], 60_000);
  return { tenant: 'Steven', alias: 'argos', instanceId, epoch: requireValue(lease.epoch, 'epoch') };
}

async function completedBranch(): Promise<{ parent: Consumer; root: DeliveryEnvelope; child: DeliveryEnvelope }> {
  const parent = await coordinator();
  const developer = await consumer(repository, 'Steven', 'socrates');
  await repository.publish(request());
  const root = await nextDelivery(repository, parent);
  await ackWith(repository, parent, root, {
    reply: 'Delegated server.py', messages: [{ to: 'socrates', body: 'Fix only server.py; run py_compile' }],
  });
  const child = await nextDelivery(repository, developer);
  await ackWith(repository, developer, child, {
    reply: 'server.py delivered; py_compile EXIT:0',
  });
  const response = await nextDelivery(repository, parent);
  expect(response.conversation_work_state?.branches[0]?.status).toBe('done');
  await ackWith(repository, parent, response, { reply: 'Reviewed server.py, integration pending' });
  const fanin = await nextDelivery(repository, parent);
  expect(fanin.body.type).toBe('agent.fanin');
  expect(fanin.conversation_work_state).toBeUndefined();
  await ackWith(repository, parent, fanin);
  return { parent, root, child };
}

it('retains branch evidence after fan-in and repository restart for the next human turn', async () => {
  const { parent, root, child } = await completedBranch();
  repository = new CauceRepository(pool);
  await repository.publish(request());
  const next = await nextDelivery(repository, parent);
  const state = requireValue(next.conversation_work_state, 'conversation state');
  expect(DeliveryEnvelopeSchema.safeParse(next).success).toBe(true);
  expect(state.branches).toHaveLength(1);
  expect(state.branches[0]).toMatchObject({
    source_delivery_id: root.delivery_id, child_delivery_id: child.delivery_id,
    root_message_id: root.message_id, target_alias: 'socrates', status: 'done',
    task_untrusted: 'Fix only server.py; run py_compile',
    review_untrusted: 'Reviewed server.py, integration pending', review_status: 'done',
    review_matches_current_result: true,
  });
  expect(state.branches[0]?.result_untrusted).toContain('py_compile EXIT:0');
  expect(JSON.stringify(state)).not.toContain('root-secret-never-copy');
});

it('does not expose conversation evidence to another conversation or authentication scope', async () => {
  const { parent } = await completedBranch();
  for (const [conversation, session] of [['other-dm','owner-session'],['owner-dm','other-session']]) {
    await repository.publish(request(conversation, session));
    const next = await nextDelivery(repository, parent);
    expect(next.conversation_work_state).toBeUndefined();
    await ackWith(repository, parent, next);
  }
});

it('does not expose a coordinator\'s state to another alias even with the same conversation', async () => {
  await completedBranch();
  const other = await consumer(repository, 'Steven', 'kant');
  await pool.query('UPDATE connection_leases SET capabilities=$1 WHERE tenant_id=$2 AND alias=$3',
    [JSON.stringify(['conversation_work_v1']), other.tenant, other.alias]);
  await repository.publish({ ...request(), recipients: [{ tenant_id: 'Steven', alias: 'kant' }] });
  const next = await nextDelivery(repository, other);
  expect(next.conversation_work_state).toBeUndefined();
});

it('exposes a newer terminal result while marking the prior review as stale', async () => {
  const { parent, child } = await completedBranch();
  await pool.query(`UPDATE deliveries SET result=$2,updated_at=clock_timestamp()
    WHERE id=$1`, [child.delivery_id, JSON.stringify({ output: { reply: 'New result: candidate B, tests passed' } })]);
  await repository.publish(request());
  const next = await nextDelivery(repository, parent);
  expect(next.conversation_work_state?.branches[0]).toMatchObject({
    result_untrusted: 'New result: candidate B, tests passed',
    review_untrusted: 'Reviewed server.py, integration pending',
    review_matches_current_result: false,
  });
  await ackWith(repository, parent, next);
  await pool.query(`UPDATE deliveries reviewed SET updated_at=clock_timestamp()
    FROM messages response WHERE reviewed.message_id=response.id
      AND response.body->>'type'='agent.response'
      AND response.body->'correlation'->>'child_delivery_id'=$1`, [child.delivery_id]);
  await repository.publish(request());
  const completedLater = await nextDelivery(repository, parent);
  expect(completedLater.conversation_work_state?.branches[0]?.review_matches_current_result).toBe(false);
});

it('does not send the new field to an older strict adapter', async () => {
  const { parent } = await completedBranch();
  await pool.query('UPDATE connection_leases SET capabilities=$1 WHERE tenant_id=$2 AND alias=$3',
    [JSON.stringify([]), parent.tenant, parent.alias]);
  await repository.publish(request());
  const next = await nextDelivery(repository, parent);
  expect(next.conversation_work_state).toBeUndefined();
});

it('reports a failed branch as terminal failure and never as active work', async () => {
  const parent = await coordinator();
  const developer = await consumer(repository, 'Steven', 'socrates');
  await repository.publish(request());
  const root = await nextDelivery(repository, parent);
  await ackWith(repository, parent, root, { messages: [{ to: 'socrates', body: 'Inspect server.py' }] });
  const child = await nextDelivery(repository, developer);
  expect(child.conversation_work_state).toBeUndefined();
  await ackWith(repository, developer, child, { status: 'failed', reply: 'Execution interrupted; no verified patch' });
  const response = await nextDelivery(repository, parent);
  expect(response.conversation_work_state?.branches[0]).toMatchObject({
    child_delivery_id: child.delivery_id, status: 'failed',
    result_untrusted: 'Execution interrupted; no verified patch',
  });
});

it('keeps an older leased branch visible when newer completed history exceeds the snapshot limit', async () => {
  const parent = await coordinator();
  const developer = await consumer(repository, 'Steven', 'socrates', 120_000);
  let oldest: DeliveryEnvelope | undefined;
  for (let index = 0; index < 17; index += 1) {
    await repository.publish(request());
    const root = await nextDelivery(repository, parent, () => true, 1);
    await ackWith(repository, parent, root, {
      messages: [{ to: 'socrates', body: `Distinct task ${String(index)} in its own file` }],
    });
    const [claimed] = await repository.claimDeliveries('Steven', 'socrates',
      developer.instanceId, developer.epoch, 1, 60_000, 3, { generalCapacity: 20 });
    const child = requireValue(claimed, `child ${String(index)}`);
    if (index === 0) oldest = child;
    else await pool.query("UPDATE deliveries SET status='done',terminal_at=now(),updated_at=now() WHERE id=$1", [child.delivery_id]);
  }
  await repository.publish(request());
  const next = await nextDelivery(repository, parent, () => true, 1);
  const state = requireValue(next.conversation_work_state, 'bounded state');
  expect(state.has_more).toBe(true);
  expect(state.branches).toHaveLength(16);
  expect(state.branches[0]).toMatchObject({ child_delivery_id: oldest?.delivery_id, status: 'leased' });
});

it('correlates separate tasks and reviews to their exact branch when both use the same developer', async () => {
  const parent = await coordinator();
  const developer = await consumer(repository, 'Steven', 'socrates');
  await repository.publish(request());
  const root = await nextDelivery(repository, parent);
  await ackWith(repository, parent, root, { messages: [
    { to: 'socrates', body: 'Task A: server.py' },
    { to: 'socrates', body: 'Task B: app.js' },
  ] });
  const expected = new Map<string, string>();
  for (let index = 0; index < 2; index += 1) {
    const child = await nextDelivery(repository, developer, () => true, 1);
    const name = String(child.body.text);
    expected.set(child.delivery_id, name);
    await ackWith(repository, developer, child, { reply: `Delivered ${name}` });
    const response = await nextDelivery(repository, parent, () => true, 1);
    await ackWith(repository, parent, response, { reply: `Reviewed ${name}` });
  }
  const fanin = await nextDelivery(repository, parent, () => true, 1);
  await ackWith(repository, parent, fanin);
  await repository.publish(request());
  const next = await nextDelivery(repository, parent, () => true, 1);
  const branches = requireValue(next.conversation_work_state, 'state').branches;
  expect(branches).toHaveLength(2);
  for (const branch of branches) {
    expect(branch.task_untrusted).toBe(expected.get(branch.child_delivery_id));
    expect(branch.result_untrusted).toBe(`Delivered ${branch.task_untrusted}`);
    expect(branch.review_untrusted).toBe(`Reviewed ${branch.task_untrusted}`);
  }
});
