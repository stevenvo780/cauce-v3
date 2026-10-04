import { randomUUID } from 'node:crypto';
import type { Ack, Tenant } from '@cauce/protocol';
import { CauceRepository } from '../src/index.js';
import { withTransaction, type DatabaseClient } from '../src/db.js';
import type { DeliveryRow } from '../src/repository/observability.js';
import { insertDelivery, MESSAGE_INSERT_COLUMNS } from '../src/repository/messages/_insert.js';
import { preserveHumanMessageLineage } from '../src/repository/human-message-lineage.js';
import type { HumanMessageInitiator } from '../src/repository/messages/human-initiators.js';
import { command, pool, repository } from './agent-output-postgres-helpers.js';
import { requireValue } from './helpers.js';
import { consumer, nextDelivery, terminalAck } from './helpers/consumer.js';
import { lineageRoot, seedIdentity } from './human-message-lineage-postgres.fixtures.js';
import { waitForBlocked } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';

export async function readDelivery(id: string): Promise<DeliveryRow> {
  const result = await pool.query<DeliveryRow>(
    `SELECT d.*,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,
            m.priority,m.origin,m.auth_session_id,m.auth_channel
     FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=$1`, [id],
  );
  return requireValue(result.rows[0], 'delivery');
}

export async function terminalize(id: string, status: 'dead' | 'failed' = 'dead') {
  await pool.query("UPDATE deliveries SET status=$2,terminal_at=now() WHERE id=$1", [id, status]);
  await pool.query(`INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
    SELECT id,recipient_tenant,'ordinary fixture failure','{}'::jsonb,attempt FROM deliveries WHERE id=$1`, [id]);
}

export async function terminalSource(known = true, recipientTenant: Tenant = 'Jhon') {
  const published = await repository.publish(command({
    recipients: [{ tenant_id: recipientTenant, alias: recipientTenant === 'Jhon' ? 'hegel' : 'argos' }],
  }));
  const deliveryId = requireValue(published.delivery_ids[0], 'source delivery');
  const human = await seedIdentity(pool);
  const lineage = known ? await lineageRoot(pool, human.humanId, published.message_id) : undefined;
  await terminalize(deliveryId);
  return { deliveryId, messageId: published.message_id, lineage, human };
}

export async function openGate(known = true, crossTenant = false) {
  await pool.query("UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default'");
  const target = await consumer(repository, crossTenant ? 'Jhon' : 'Steven', crossTenant ? 'hegel' : 'argos');
  const published = await repository.publish(command({ recipients: [{ tenant_id: target.tenant, alias: target.alias }] }));
  const human = await seedIdentity(pool);
  const lineage = known ? await lineageRoot(pool, human.humanId, published.message_id) : undefined;
  const delivery = await nextDelivery(repository, target);
  const ack = terminalAck(delivery, target, { messages: [{ to: '@human', body: 'Continue the ordinary task?' }] });
  await repository.ackDelivery(delivery.delivery_id, target.tenant, target.alias, ack);
  const gates = await pool.query<{ id: string }>('SELECT id FROM agent_chain_gates WHERE source_delivery_id=$1', [delivery.delivery_id]);
  return { id: requireValue(gates.rows[0], 'gate').id, target, delivery, lineage, human };
}

export async function historicalReplay(sourceId: string, lineage?: HumanMessageInitiator, alias?: string) {
  return withTransaction(pool, async (client) => {
    const source = await readDelivery(sourceId);
    const inserted = await client.query<{ id: string; request_id: string }>(
      `INSERT INTO messages(${MESSAGE_INSERT_COLUMNS.join(',')})
       SELECT gen_random_uuid(),trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,auth_session_id,auth_channel
       FROM messages WHERE id=$1 RETURNING id,request_id`, [source.message_id],
    );
    const message = requireValue(inserted.rows[0], 'historical message');
    await preserveHumanMessageLineage(client, message.id, lineage);
    const delivery = requireValue((await insertDelivery(client, {
      messageId: message.id, recipientTenant: source.recipient_tenant, recipientAlias: alias ?? source.recipient_alias,
    })).rows[0], 'historical delivery');
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
      VALUES('Steven','kant','delivery.replay','allow',$1,$2,$3,$4,$5::jsonb)`,
    [message.request_id, message.id, delivery.id, source.trace_id, JSON.stringify({ replayed_from_delivery_id: sourceId })]);
    await client.query('UPDATE dead_letters SET resolved_at=now() WHERE delivery_id=$1', [sourceId]);
    return { messageId: message.id, deliveryId: delivery.id };
  });
}

export async function notificationDestination(tenant: Tenant = 'Steven', alias = 'argos') {
  await pool.query("UPDATE role_policies SET allow_notify=true WHERE role='agent'");
  await pool.query(`INSERT INTO egress_destinations(tenant_id,alias,handle,adapter,channel,conversation_id,
    conversation_kind,allow_kinds,require_prior_contact,min_interval_seconds,max_per_hour,max_per_day,max_per_root,enabled)
    VALUES($1,$2,'fixture.dm','telegram','telegram','fixture-conversation','group',ARRAY['task_complete'],false,0,100,100,100,true)`,
  [tenant, alias]);
}

export const notificationEntry = { index: 0, handle: 'fixture.dm', kind: 'task_complete' as const, body: 'Ordinary completion notice' };

export class ContinuationRepository extends CauceRepository {
  notify(client: DatabaseClient, row: DeliveryRow, ack: Ack) {
    return this.materializeAgentNotifications(client, row, ack, [notificationEntry], false);
  }
}

export async function notificationSource(crossTenant = false) {
  const target = await consumer(repository, crossTenant ? 'Jhon' : 'Steven', crossTenant ? 'hegel' : 'argos');
  await notificationDestination(target.tenant, target.alias);
  await repository.publish(command({ recipients: [{ tenant_id: target.tenant, alias: target.alias }] }));
  const delivery = await nextDelivery(repository, target);
  const ack = terminalAck(delivery, target);
  ack.result = { output: { reply: 'done', messages: [], notify: [{ to: notificationEntry.handle,
    kind: notificationEntry.kind, body: notificationEntry.body }], status: 'done', retryable: false, artifacts: [] } };
  return { target, delivery, ack };
}

export async function notificationRow() {
  const result = await pool.query<{ produced_message_id: string; produced_outbox_id: string }>(
    "SELECT produced_message_id,produced_outbox_id FROM egress_notifications WHERE decision='allowed'",
  );
  return requireValue(result.rows[0], 'notification');
}

export async function counts() {
  const result = await pool.query<Record<string, string>>(`SELECT
    (SELECT count(*) FROM messages) AS messages,(SELECT count(*) FROM deliveries) AS deliveries,
    (SELECT count(*) FROM human_message_initiators) AS lineage,(SELECT count(*) FROM adapter_outbox) AS outbox,
    (SELECT count(*) FROM audit_events) AS audit,(SELECT count(*) FROM egress_notifications) AS notifications`);
  return result.rows[0];
}

export async function permissions() {
  const queries = [
    'SELECT * FROM memberships ORDER BY tenant_id,room_id,alias',
    'SELECT * FROM human_tenant_memberships ORDER BY human_id,tenant_id',
    'SELECT * FROM acl_edges ORDER BY from_tenant,to_tenant',
  ];
  return Promise.all(queries.map(async (sql) => (await pool.query<Record<string, unknown>>(sql)).rows));
}

function pinnedRepository(client: DatabaseClient, failOutbox = false): ContinuationRepository {
  const query = new Proxy(client.query.bind(client), {
    apply(target, _receiver, args: unknown[]): unknown {
      if (failOutbox && typeof args[0] === 'string' && args[0].includes('INSERT INTO adapter_outbox')) {
        throw new Error('fixture outbox failure');
      }
      return Reflect.apply(target, client, args) as unknown;
    },
  });
  const wrapped = new Proxy(client, {
    get(target, key, receiver): unknown {
      if (key === 'query') return query;
      if (key === 'release') return () => undefined;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return new ContinuationRepository(new Proxy(pool, {
    get(target, key, receiver): unknown {
      if (key === 'connect') return async () => wrapped;
      if (key === 'query') return target.query.bind(target);
      return Reflect.get(target, key, receiver) as unknown;
    },
  }));
}

export async function failingOutbox(work: (repo: ContinuationRepository) => Promise<unknown>) {
  const client = await pool.connect();
  try { return await work(pinnedRepository(client, true)); } finally { client.release(); }
}

export async function concurrentCalls(
  table: 'deliveries' | 'agent_chain_gates', id: string,
  work: (repo: ContinuationRepository) => Promise<unknown>,
) {
  const blocker = await pool.connect();
  const first = await pool.connect();
  const second = await pool.connect();
  const firstPid = requireValue((await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'pid').pid;
  const secondPid = requireValue((await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'pid').pid;
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    pending = Promise.allSettled([work(pinnedRepository(first)), work(pinnedRepository(second))]);
    await waitForBlocked(blocker, firstPid);
    await waitForBlocked(blocker, secondPid);
    await blocker.query('COMMIT');
    return await pending;
  } finally {
    await blocker.query('ROLLBACK');
    await pending;
    first.release(); second.release(); blocker.release();
  }
}

export function externalNotification() {
  return { destination: 'fixture.dm', kind: 'task_complete' as const, body: 'Ordinary external notice',
    idempotency_key: randomUUID(), dry_run: false };
}
