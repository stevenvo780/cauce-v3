import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  consumer as leaseConsumer, nextDelivery as claimNext, terminalAck as buildTerminalAck,
  type Consumer
} from './helpers/consumer.js';

/**
 * A chain gate is addressed by id alone. Without a tenant check on the loaded row, any actor with
 * `route` in ITS OWN tenant could answer or cancel someone else's gate — and answering injects a
 * delivery into the asking agent. The scope is the row's tenant, or a hub-anchored `allow_control`
 * edge towards it; anything else must be indistinguishable from a gate that does not exist.
 */

let database: TestDatabase;
let databaseStarted = false;
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
    body: { text: 'chain gate tenant isolation source' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

const nextDelivery = (
  target: Consumer, predicate?: (delivery: DeliveryEnvelope) => boolean
): Promise<DeliveryEnvelope> => claimNext(repository, target, predicate);

const terminalAck = (delivery: DeliveryEnvelope, target: Consumer, messages: unknown[]): Ack =>
  buildTerminalAck(delivery, target, { messages });

/** Opens ONE gate through the real path: a delivery ACKed with a `@human` output. */
async function openGate(
  tenant: Tenant, room: string, requester: string, asker: string
): Promise<{ gateId: string; asker: Consumer }> {
  const target = await consumer(tenant, asker);
  await repository.publish(command({
    tenant_id: tenant,
    room_id: room,
    actor_alias: requester,
    recipients: [{ tenant_id: tenant, alias: asker }]
  }));
  const delivery = await nextDelivery(target);
  const result = await repository.ackDelivery(
    delivery.delivery_id, tenant, asker,
    terminalAck(delivery, target, [{ to: '@human', body: '¿aprobás el gasto?' }])
  );
  expect(result.applied).toBe(true);
  const gate = requireValue((await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id,tenant_id FROM agent_chain_gates WHERE tenant_id=$1 AND status='open'`, [tenant]
  )).rows[0], 'open gate');
  return { gateId: gate.id, asker: target };
}

async function gateStatus(gateId: string): Promise<string> {
  return requireValue((await pool.query<{ status: string }>(
    'SELECT status FROM agent_chain_gates WHERE id=$1', [gateId]
  )).rows[0], 'gate row').status;
}

async function gateAudits(action: string): Promise<Record<string, unknown>[]> {
  return (await pool.query<Record<string, unknown>>(
    `SELECT tenant_id,actor_alias,decision,trace_id,
            metadata->>'gate_id' AS gate_id,
            metadata->>'asked_by_alias' AS asked_by_alias,
            metadata->>'cancelled_by' AS cancelled_by,
            metadata->>'answered_by' AS answered_by
     FROM audit_events WHERE action=$1 ORDER BY id`,
    [action]
  )).rows;
}

async function deliveriesFor(alias: string): Promise<number> {
  return (await pool.query('SELECT 1 FROM deliveries WHERE recipient_alias=$1', [alias])).rowCount ?? 0;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
    UPDATE agent_chain_policies SET human_gate_enabled=true WHERE id='default';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('un gate ajeno no se contesta ni se cancela', () => {
  it.each([
    { name: 'arista deshabilitada', patch: 'enabled=false' },
    { name: 'arista sin allow_control', patch: 'allow_control=false' }
  ])('devuelve not_found con $name', async ({ patch }) => {
    const gate = await openGate('Steven', 'grp.steven', 'kant', 'argos');
    await pool.query(
      `UPDATE acl_edges SET ${patch} WHERE from_tenant='Miguel' AND to_tenant='Steven'`
    );

    await expect(repository.answerChainGate(gate.gateId, 'sí', 'Miguel', 'kratos'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });
    await expect(repository.cancelChainGate(gate.gateId, 'Miguel', 'kratos'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });

    expect(await gateStatus(gate.gateId)).toBe('open');
    expect(await gateAudits('agent_chain.gate_answered')).toEqual([]);
    expect(await gateAudits('agent_chain.gate_cancelled')).toEqual([]);
    expect(await deliveriesFor('argos')).toBe(1);
  }, 120_000);

  it('no alcanza entre dos tenants sin hub en ningún extremo', async () => {
    const gate = await openGate('Miguel', 'grp.miguel', 'janus', 'kratos');

    await expect(repository.answerChainGate(gate.gateId, 'sí', 'Pablo', 'seneca'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });
    await expect(repository.cancelChainGate(gate.gateId, 'Pablo', 'seneca'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });

    expect(await gateStatus(gate.gateId)).toBe('open');
    expect(await deliveriesFor('kratos')).toBe(1);
  }, 120_000);

  it('un gate ya contestado tampoco confirma su existencia al tenant ajeno', async () => {
    const gate = await openGate('Steven', 'grp.steven', 'kant', 'argos');
    await repository.answerChainGate(gate.gateId, 'sí', 'Steven', 'kant');
    await pool.query(
      `UPDATE acl_edges SET allow_control=false WHERE from_tenant='Miguel' AND to_tenant='Steven'`
    );

    await expect(repository.answerChainGate(gate.gateId, 'otra vez', 'Miguel', 'kratos'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });
    await expect(repository.cancelChainGate(gate.gateId, 'Miguel', 'kratos'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'not_found' });
  }, 120_000);
});

describe('con arista de control habilitada el gate sí se opera', () => {
  it('contesta desde el tenant vecino y reanuda al agente que preguntó', async () => {
    const gate = await openGate('Steven', 'grp.steven', 'kant', 'argos');

    const answered = await repository.answerChainGate(gate.gateId, 'sí, aprobado', 'Miguel', 'kratos');

    expect(answered).toMatchObject({
      status: 'answered', recipient_tenant: 'Steven', recipient_alias: 'argos'
    });
    expect(await gateStatus(gate.gateId)).toBe('answered');
    const resume = await nextDelivery(gate.asker, (item) => item.body.type === 'agent.message');
    expect(String(resume.body.text)).toContain('sí, aprobado');
    expect(await gateAudits('agent_chain.gate_answered')).toEqual([expect.objectContaining({
      tenant_id: 'Steven', actor_alias: 'kratos', answered_by: 'Miguel/kratos', gate_id: gate.gateId
    })]);
  }, 120_000);

  it('cancela desde el tenant vecino y deja el rastro en audit_events', async () => {
    const gate = await openGate('Steven', 'grp.steven', 'kant', 'argos');

    const cancelled = await repository.cancelChainGate(gate.gateId, 'Miguel', 'kratos');

    expect(cancelled).toEqual({ gate_id: gate.gateId, status: 'cancelled' });
    expect(await gateStatus(gate.gateId)).toBe('cancelled');
    expect(await deliveriesFor('argos')).toBe(1);
    expect(await gateAudits('agent_chain.gate_cancelled')).toEqual([expect.objectContaining({
      tenant_id: 'Steven',
      actor_alias: 'kratos',
      decision: 'allow',
      gate_id: gate.gateId,
      asked_by_alias: 'argos',
      cancelled_by: 'Miguel/kratos'
    })]);
  }, 120_000);

  it('cancelar dentro del propio tenant audita una sola vez y no se repite', async () => {
    const gate = await openGate('Steven', 'grp.steven', 'kant', 'argos');

    await repository.cancelChainGate(gate.gateId, 'Steven', 'kant');
    await expect(repository.cancelChainGate(gate.gateId, 'Steven', 'kant'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'conflict' });

    expect(await gateAudits('agent_chain.gate_cancelled')).toHaveLength(1);
  }, 120_000);
});
