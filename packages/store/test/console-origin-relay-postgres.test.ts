import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * The console reads messages and deliveries straight from PostgreSQL; there is no
 * `adapter=console` bridge that could ever claim a durable relay. A terminal ack on a
 * console-originated delivery must not leave a permanently unclaimable `origin_relay` row.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant: Tenant = 'Steven';
const alias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'una pregunta de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

function doneAck(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  reply: string
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply } }
  };
}

function agentDoneAck(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  reply: string,
  messages: readonly { to: string; body: string }[] = []
): Ack {
  return {
    ...doneAck(delivery, instanceId, epoch, reply),
    result: {
      output: {
        reply,
        messages: [...messages],
        status: 'done',
        retryable: false,
        artifacts: []
      }
    }
  };
}

async function relayRowCount(deliveryId: string): Promise<number> {
  const result = await pool.query(
    `SELECT 1 FROM adapter_outbox
     WHERE kind='origin_relay' AND delivery_id=$1 AND payload->>'relay_kind' IS DISTINCT FROM 'ack'`,
    [deliveryId]
  );
  return result.rowCount ?? 0;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

it('does not enqueue a durable relay for a console-originated delivery', async () => {
  const instanceId = 'worker-console';
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(command({
    origin: {
      adapter: 'console', channel: 'console', conversation_id: `console:${randomUUID()}`,
      relay: [], metadata: { auth: 'console-password', user_id: randomUUID() }
    }
  }));
  const [delivery] = await repository.claimDeliveries(tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
  if (!delivery) throw new Error('expected a claimed delivery');

  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
    doneAck(delivery, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'la consola ya la lee de la base')
  );

  expect(await relayRowCount(delivery.delivery_id)).toBe(0);
});

it('still relays a telegram-originated delivery, proving the console guard is adapter-specific', async () => {
  const instanceId = 'worker-telegram';
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(command({
    origin: {
      adapter: 'telegram', channel: 'dm', conversation_id: '42', relay: [], metadata: {}
    }
  }));
  const [delivery] = await repository.claimDeliveries(tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
  if (!delivery) throw new Error('expected a claimed delivery');

  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
    doneAck(delivery, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'esto sí tiene un puente de vuelta')
  );

  expect(await relayRowCount(delivery.delivery_id)).toBe(1);
});

it('returns a cross-tenant fan-in relay to its root actor without exposing it to an unrelated peer', async () => {
  const salvaInstance = 'worker-origin-salva';
  const argosInstance = 'worker-origin-argos';
  const salvaLease = await repository.acquireLease('Isa', 'salva', salvaInstance, [], 30_000);
  const argosLease = await repository.acquireLease('Steven', 'argos', argosInstance, [], 30_000);
  const published = await repository.publish(command({
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    authenticated_context: {
      session_id: `origin-visibility-${randomUUID()}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram', channel: 'telegram', conversation_id: `origin-${randomUUID()}`,
        relay: [], metadata: { bridge_alias: 'kant', bridge_tenant: 'Steven' }
      }
    }
  }));
  const [root] = await repository.claimDeliveries(
    'Isa', 'salva', salvaInstance, requireValue(salvaLease.epoch, 'salvaLease.epoch'), 1, 30_000
  );
  if (!root) throw new Error('expected the cross-tenant root delivery');
  await repository.ackDelivery(
    root.delivery_id,
    'Isa',
    'salva',
    agentDoneAck(
      root,
      salvaInstance,
      requireValue(salvaLease.epoch, 'salvaLease.epoch'),
      'delegated review',
      [{ to: 'argos', body: 'review the result' }]
    )
  );

  const [child] = await repository.claimDeliveries(
    'Steven', 'argos', argosInstance, requireValue(argosLease.epoch, 'argosLease.epoch'), 1, 30_000
  );
  if (!child) throw new Error('expected the delegated child delivery');
  await repository.ackDelivery(
    child.delivery_id,
    'Steven',
    'argos',
    agentDoneAck(
      child, argosInstance, requireValue(argosLease.epoch, 'argosLease.epoch'), 'review complete'
    )
  );

  const [response] = await repository.claimDeliveries(
    'Isa', 'salva', salvaInstance, requireValue(salvaLease.epoch, 'salvaLease.epoch'), 1, 30_000
  );
  if (response?.body.type !== 'agent.response') {
    throw new Error('expected the authenticated child response');
  }
  await repository.ackDelivery(
    response.delivery_id,
    'Isa',
    'salva',
    agentDoneAck(
      response, salvaInstance, requireValue(salvaLease.epoch, 'salvaLease.epoch'), 'combined result'
    )
  );

  const pending = await repository.claimDeliveries(
    'Isa', 'salva', salvaInstance, requireValue(salvaLease.epoch, 'salvaLease.epoch'), 10, 30_000
  );
  const fanin = pending.find((delivery) => delivery.body.type === 'agent.fanin');
  if (!fanin) throw new Error('expected the fan-in delivery');
  await repository.ackDelivery(
    fanin.delivery_id,
    'Isa',
    'salva',
    agentDoneAck(
      fanin, salvaInstance, requireValue(salvaLease.epoch, 'salvaLease.epoch'), 'final result'
    )
  );

  const rootActorView = await repository.listOriginRelays('Steven', 'kant');
  const outsiderView = await repository.listOriginRelays('Steven', 'socrates');
  const finalRelays = (value: Record<string, unknown>): Record<string, unknown>[] => {
    const items: unknown[] = Array.isArray(value.items) ? value.items : [];
    return items.filter((item): item is Record<string, unknown> => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      const payload = row.payload;
      return row.trace_id === published.trace_id
        && typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        && (payload as Record<string, unknown>).outcome === 'done';
    });
  };
  expect(finalRelays(rootActorView)).toEqual([
    expect.objectContaining({
      participants: [{ tenant_id: 'Steven', alias: 'kant' }]
    })
  ]);
  expect(finalRelays(outsiderView)).toEqual([]);

  const unrelated = await repository.publish(command({
    actor_alias: 'socrates',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
  }));
  await pool.query(
    `UPDATE adapter_outbox
     SET payload=jsonb_set(payload,'{correlation,root_message_id}',to_jsonb($2::text))
     WHERE kind='origin_relay' AND delivery_id=$1`,
    [fanin.delivery_id, unrelated.message_id]
  );
  expect(finalRelays(await repository.listOriginRelays('Steven', 'socrates'))).toEqual([]);

  await pool.query(
    `UPDATE adapter_outbox
     SET payload=jsonb_set(payload,'{correlation,root_message_id}',to_jsonb('invalid'::text))
     WHERE kind='origin_relay' AND delivery_id=$1`,
    [fanin.delivery_id]
  );
  await expect(repository.listOriginRelays('Steven', 'kant')).resolves.toBeDefined();
});
