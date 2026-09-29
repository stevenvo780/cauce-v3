import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL_ALIASES, type Tenant } from '@cauce/protocol';
import {
  claim, claimFanin, command, pool, registerAgentOutputSuite, repository,
  ROUTABLE_FLEET_EXCEPT_ARGOS, terminalAck,
} from './agent-output-postgres-helpers.js';

registerAgentOutputSuite(import.meta.url);

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

  it('keeps system principals out of ordinary delivery destinations', async () => {
    await expect(repository.publish(command({
      recipients: [{ tenant_id: 'Steven', alias: 'quota-collector' }]
    }))).rejects.toMatchObject({ code: 'no_route' });
    await expect(repository.publish(command({
      recipients: [{ tenant_id: 'Steven', alias: 'gate-probe' }]
    }))).rejects.toMatchObject({ code: 'no_route' });
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

  it('excludes self, offline peers, and ACL-denied live peers from @all', async () => {
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', 'filtered-all-source');
    await repository.acquireLease('Steven', 'kant', 'filtered-all-kant', [], 30_000);
    const offlineLease = await repository.acquireLease(
      'Steven', 'socrates', 'filtered-all-socrates', [], 30_000
    );
    await repository.releaseLease(
      'Steven', 'socrates', 'filtered-all-socrates', requireValue(offlineLease.epoch, 'offlineLease.epoch')
    );
    await repository.acquireLease('Pablo', 'seneca', 'filtered-all-seneca', [], 30_000);
    await pool.query(
      `UPDATE acl_edges SET allow_route=false
       WHERE from_tenant='Steven' AND to_tenant='Pablo'`
    );

    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'filtered-all-source', root.epoch, [
        { to: '@all', body: 'only currently reachable peers' }
      ])
    );
    expect((await pool.query(
      `SELECT target_tenant,target_alias
       FROM agent_output_materializations WHERE status='materialized'`
    )).rows).toEqual([{ target_tenant: 'Steven', target_alias: 'kant' }]);
  });

  it.each([
    {
      name: 'mixed with a direct target',
      messages: [
        { to: '@all', body: 'broadcast' },
        { to: 'kant', body: 'partial route must not happen' }
      ]
    },
    {
      name: 'repeated',
      messages: [
        { to: '@all', body: 'broadcast one' },
        { to: '@all', body: 'broadcast two' }
      ]
    }
  ])('rejects a non-exclusive @all directive atomically: $name', async ({ messages }) => {
    const sourceInstance = `invalid-all-${randomUUID()}`;
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', sourceInstance);
    await repository.acquireLease('Steven', 'kant', `invalid-all-kant-${randomUUID()}`, [], 30_000);
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, sourceInstance, root.epoch, messages)
    );
    expect((await pool.query(
      `SELECT status,rejection_code
       FROM agent_output_materializations ORDER BY output_index`
    )).rows).toEqual(messages.map(() => ({
      status: 'rejected',
      rejection_code: 'invalid_output'
    })));
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it('rejects a direct output to the current agent without creating a cycle', async () => {
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', 'self-route-source');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'self-route-source', root.epoch, [
        { to: 'argos', body: 'legacy client attempted to bounce to self' }
      ])
    );
    expect((await pool.query(
      `SELECT status,rejection_code,target_alias,produced_delivery_id
       FROM agent_output_materializations`
    )).rows).toEqual([{
      status: 'rejected',
      rejection_code: 'unroutable_alias',
      target_alias: null,
      produced_delivery_id: null
    }]);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it.each([
    { name: 'whitespace', body: ' \t\r\n' },
    { name: 'zero-width format characters', body: '\u200B\u2060' },
    { name: 'NUL and controls', body: '\u0000\u0001' },
    { name: 'combining grapheme joiner', body: '\u034F' },
    { name: 'variation selector', body: '\uFE0F' },
    { name: 'combining mark', body: '\u0301' },
    { name: 'enclosing mark', body: '\u20DD' }
  ])('rejects an invisible agent output body: $name', async ({ body }) => {
    const instanceId = `invisible-body-${randomUUID()}`;
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', instanceId);
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, instanceId, root.epoch, [
        { to: 'kant', body }
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

  it('accepts a combining mark when it accompanies a visible Unicode base', async () => {
    const instanceId = `visible-combining-${randomUUID()}`;
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', instanceId);
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, instanceId, root.epoch, [
        { to: 'kant', body: 'a\u0301' }
      ])
    );
    expect((await pool.query(
      `SELECT status,rejection_code FROM agent_output_materializations`
    )).rows).toEqual([{ status: 'materialized', rejection_code: null }]);
    expect((await pool.query(
      `SELECT body->>'text' AS text FROM messages WHERE body->>'type'='agent.message'`
    )).rows).toEqual([{ text: 'a\u0301' }]);
  });

  it.each([
    {
      name: 'one body above 64 KiB',
      messages: [{ to: 'kant', body: 'a'.repeat((64 * 1024) + 1) }]
    },
    {
      name: 'aggregate bodies above 256 KiB',
      messages: Array.from({ length: 5 }, () => ({
        to: 'kant',
        body: 'a'.repeat(60 * 1024)
      }))
    }
  ])('rejects bounded relay output: $name', async ({ messages }) => {
    const instanceId = `bounded-output-${randomUUID()}`;
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', instanceId);
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, instanceId, root.epoch, messages)
    );
    expect((await pool.query(
      `SELECT status,rejection_code FROM agent_output_materializations ORDER BY output_index`
    )).rows).toEqual(messages.map(() => ({
      status: 'rejected',
      rejection_code: 'invalid_output'
    })));
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
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
