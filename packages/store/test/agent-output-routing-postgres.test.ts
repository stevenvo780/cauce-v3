import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/index.js';
import { SYSTEM_PRINCIPAL_ALIASES, type Tenant } from '@cauce/protocol';
import {
  claim, claimFanin, command, database, pool, registerAgentOutputSuite, repository,
  ROUTABLE_FLEET_EXCEPT_ARGOS, terminalAck,
} from './agent-output-postgres-helpers.js';

registerAgentOutputSuite(import.meta.url);

beforeEach(async () => {
  const name = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
  if (!name || !/^cauce_test_[a-z0-9_]+$/u.test(name)) throw new Error('routing fixture requires its owned case database');
  const url = new URL(database.adminUrl); url.pathname = `/${name}`;
  const admin = createPool(url.toString(), { max: 1 });
  try {
    await admin.query("DELETE FROM memberships WHERE tenant_id='Steven' AND alias='context-director'");
    await admin.query("SELECT cauce_register_company_director('humanizar','Steven')");
    expect((await pool.query(`SELECT delivery_source_only FROM company_system_principals
      WHERE company_id='humanizar' AND kind='director' AND principal_alias='context-director'`)).rows)
      .toEqual([{ delivery_source_only: true }]);
  } finally { await admin.end(); }
});

describe('transactional StructuredOutput.messages materialization', () => {
  it('advertises routing_targets only to capability-aware leases', async () => {
    const legacyLease = await repository.acquireLease(
      'Steven', 'argos', 'legacy-routing-client', [], 30_000
    );
    await repository.publish(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }));
    const [legacyDelivery] = await repository.claimDeliveries(
      'Steven', 'argos', 'legacy-routing-client', requireValue(legacyLease.epoch, 'legacyLease.epoch'), 1, 30_000
    );
    if (!legacyDelivery) throw new Error('expected a legacy delivery');
    expect(legacyDelivery.routing_targets).toBeUndefined();
    await repository.ackDelivery(
      legacyDelivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(legacyDelivery, 'legacy-routing-client', requireValue(legacyLease.epoch, 'legacyLease.epoch'), [])
    );
    await repository.releaseLease(
      'Steven', 'argos', 'legacy-routing-client', requireValue(legacyLease.epoch, 'legacyLease.epoch')
    );

    await repository.acquireLease('Steven', 'kant', 'routing-live-kant', [], 30_000);
    const capableLease = await repository.acquireLease(
      'Steven', 'argos', 'capable-routing-client', ['routing_targets_v1'], 30_000
    );
    await repository.publish(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }));
    const [capableDelivery] = await repository.claimDeliveries(
      'Steven', 'argos', 'capable-routing-client', requireValue(capableLease.epoch, 'capableLease.epoch'), 1, 30_000
    );
    if (!capableDelivery) throw new Error('expected a capability-aware delivery');
    expect(capableDelivery.routing_targets?.map(
      ({ tenant_id, alias }) => `${tenant_id}:${alias}`
    ).sort()).toEqual([...ROUTABLE_FLEET_EXCEPT_ARGOS].sort());
    expect(capableDelivery.routing_targets).toContainEqual({
      tenant_id: 'Steven',
      alias: 'kant',
      online: true
    });
    expect(capableDelivery.routing_targets).toContainEqual({
      tenant_id: 'Steven',
      alias: 'socrates',
      online: false
    });
    expect(capableDelivery.routing_targets).not.toContainEqual(
      expect.objectContaining({ tenant_id: 'Steven', alias: 'argos' })
    );
    expect(capableDelivery.routing_targets).not.toContainEqual(
      expect.objectContaining({ tenant_id: 'Steven', alias: 'quota-collector' })
    );
    expect(capableDelivery.routing_targets).not.toContainEqual(
      expect.objectContaining({ tenant_id: 'Steven', alias: 'gate-probe' })
    );
  });

  it('expands one @all output atomically to every online routable peer except self', async () => {
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', 'all-source');
    await repository.acquireLease('Steven', 'kant', 'all-kant', [], 30_000);
    await repository.acquireLease('Steven', 'socrates', 'all-socrates', [], 30_000);
    await repository.acquireLease('Pablo', 'seneca', 'all-seneca', [], 30_000);

    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'all-source', root.epoch, [
        { to: '@all', body: 'validate the live bus' }
      ])
    );

    expect((await pool.query(
      `SELECT output_index,target_tenant,target_alias,status
       FROM agent_output_materializations ORDER BY output_index`
    )).rows).toEqual([
      { output_index: 100, target_tenant: 'Pablo', target_alias: 'seneca', status: 'materialized' },
      { output_index: 101, target_tenant: 'Steven', target_alias: 'kant', status: 'materialized' },
      { output_index: 102, target_tenant: 'Steven', target_alias: 'socrates', status: 'materialized' }
    ]);
    expect((await pool.query(
      `SELECT count(DISTINCT request_id)::int AS request_count,
              count(DISTINCT produced_delivery_id)::int AS delivery_count
       FROM agent_output_materializations`
    )).rows).toEqual([{ request_count: 3, delivery_count: 3 }]);
  });

  it('rejects an @all expansion above the 512 KiB transactional budget', async () => {
    const instanceId = `bounded-all-${randomUUID()}`;
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', instanceId);
    const targets = (await pool.query<{ tenant_id: Tenant; alias: string }>(
      `SELECT DISTINCT membership.tenant_id,membership.alias
       FROM memberships membership
       WHERE membership.enabled
         AND NOT EXISTS(SELECT 1 FROM company_system_principals principal WHERE principal.delivery_source_only
           AND principal.tenant_id=membership.tenant_id AND principal.principal_alias=membership.alias)
         AND NOT (membership.tenant_id='Steven' AND membership.alias='argos')
         AND NOT (membership.alias=ANY($1::text[]))
       ORDER BY membership.tenant_id,membership.alias`,
      [SYSTEM_PRINCIPAL_ALIASES],
    )).rows;
    expect(targets.map(
      ({ tenant_id, alias }) => `${tenant_id}:${alias}`
    )).toEqual([...ROUTABLE_FLEET_EXCEPT_ARGOS].sort());
    for (const [index, target] of targets.entries()) {
      await repository.acquireLease(
        target.tenant_id,
        target.alias,
        `bounded-all-${String(index)}-${randomUUID()}`,
        [],
        30_000
      );
    }
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, instanceId, root.epoch, [
        { to: '@all', body: 'a'.repeat(48 * 1024) }
      ])
    );
    expect((await pool.query(
      `SELECT status,rejection_code,produced_delivery_id
       FROM agent_output_materializations`
    )).rows).toEqual([{
      status: 'rejected',
      rejection_code: 'invalid_output',
      produced_delivery_id: null
    }]);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it('rejects an internal bounce to sender while preserving the authorized response path', async () => {
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', 'sender-bounce-source');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'sender-bounce-source', root.epoch, [
        { to: 'kant', body: 'legitimate child request' }
      ])
    );
    const kantLease = await repository.acquireLease(
      'Steven', 'kant', 'sender-bounce-kant', [], 30_000
    );
    const [child] = await repository.claimDeliveries(
      'Steven', 'kant', 'sender-bounce-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!child) throw new Error('expected sender-bounce child');
    expect(child).toMatchObject({
      actor_alias: 'argos',
      recipient_alias: 'kant',
      body: { type: 'agent.message', from_alias: 'argos' }
    });
    await repository.ackDelivery(
      child.delivery_id,
      'Steven',
      'kant',
      terminalAck(child, 'sender-bounce-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), [
        { to: 'argos', body: 'malicious duplicate return' }
      ])
    );
    expect((await pool.query(
      `SELECT status,rejection_code
       FROM agent_output_materializations WHERE source_delivery_id=$1`,
      [child.delivery_id]
    )).rows).toEqual([{
      status: 'rejected',
      rejection_code: 'unroutable_alias'
    }]);
    const [authorizedResponse] = await repository.claimDeliveries(
      'Steven', 'argos', 'sender-bounce-source', root.epoch, 1, 30_000
    );
    expect(authorizedResponse).toMatchObject({
      actor_alias: 'kant',
      recipient_alias: 'argos',
      body: { type: 'agent.response', from_alias: 'kant' }
    });
  });

  it('waits for the valid branch when sibling outputs are rejected', async () => {
    const root = await claim(command({
      authenticated_context: {
        session_id: 'mixed-output-session',
        channel: 'telegram',
        origin: {
          adapter: 'telegram',
          channel: 'telegram',
          conversation_id: 'mixed-output-chat',
          relay: [],
          metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
        }
      }
    }), 'Steven', 'argos', 'mixed-output-source');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'mixed-output-source', root.epoch, [
        { to: 'kant', body: 'the one valid branch' },
        { to: 'INVALID ALIAS', body: 'must be rejected' }
      ], randomUUID(), null)
    );
    expect((await pool.query(
      `SELECT output_index,status,rejection_code
       FROM agent_output_materializations ORDER BY output_index`
    )).rows).toEqual([
      { output_index: 0, status: 'materialized', rejection_code: null },
      { output_index: 1, status: 'rejected', rejection_code: 'unroutable_alias' }
    ]);
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${root.delivery.message_id}`
    }]);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE adapter='gateway' AND idempotency_key=$1`,
      [`agent-fanin:${root.delivery.message_id}`]
    )).rowCount).toBe(0);

    const kantLease = await repository.acquireLease(
      'Steven', 'kant', 'mixed-output-kant', [], 30_000
    );
    const [child] = await repository.claimDeliveries(
      'Steven', 'kant', 'mixed-output-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!child) throw new Error('expected the valid mixed-output branch');
    await repository.ackDelivery(
      child.delivery_id,
      'Steven',
      'kant',
      terminalAck(
        child,
        'mixed-output-kant',
        requireValue(kantLease.epoch, 'kantLease.epoch'),
        [],
        randomUUID(),
        'the valid branch completed'
      )
    );
    const [response] = await repository.claimDeliveries(
      'Steven', 'argos', 'mixed-output-source', root.epoch, 1, 30_000
    );
    if (!response) throw new Error('expected the valid branch response');
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE adapter='gateway' AND idempotency_key=$1`,
      [`agent-fanin:${root.delivery.message_id}`]
    )).rowCount).toBe(0);
    await repository.ackDelivery(
      response.delivery_id,
      'Steven',
      'argos',
      terminalAck(
        response,
        'mixed-output-source',
        root.epoch,
        [],
        randomUUID(),
        'Argos processed the valid branch'
      )
    );

    const fanin = await claimFanin(
      'Steven', 'argos', 'mixed-output-source', root.epoch
    );
    const faninData = fanin.body.fanin_data_v1 as {
      responses: { alias: string; untrusted_text: string }[];
    };
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1
    });
    expect(faninData.responses).toEqual([
      expect.objectContaining({
        alias: 'kant',
        untrusted_text: 'the valid branch completed'
      })
    ]);
    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'argos',
      terminalAck(
        fanin,
        'mixed-output-source',
        root.epoch,
        [],
        randomUUID(),
        'Mixed output final'
      )
    );
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1
       ORDER BY idempotency_key`,
      [root.delivery.trace_id]
    )).rows).toEqual([
      { idempotency_key: `relay-ack:${root.delivery.message_id}` },
      { idempotency_key: `relay-root:${root.delivery.message_id}` }
    ]);
  });});
