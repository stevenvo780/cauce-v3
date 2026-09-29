import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { describe, expect, it } from 'vitest';
import {
  claim, claimFanin, command, pool, registerAgentOutputSuite, repository, terminalAck,
} from './agent-output-postgres-helpers.js';

registerAgentOutputSuite(import.meta.url);

describe('transactional StructuredOutput.messages materialization', () => {
  it('returns a nested delegation through every source agent before the final origin relay', async () => {
    const origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: 'nested-agent-chat',
      relay: [],
      metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
    };
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      authenticated_context: {
        session_id: 'nested-agent-session',
        channel: 'telegram',
        origin
      }
    }), 'Steven', 'argos', 'nested-argos');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'nested-argos', root.epoch, [
        { to: 'kant', body: 'ask socrates' }
      ])
    );

    const kantLease = await repository.acquireLease('Steven', 'kant', 'nested-kant', [], 30_000);
    const [kantRequest] = await repository.claimDeliveries(
      'Steven', 'kant', 'nested-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!kantRequest) throw new Error('expected the first nested request');
    await repository.ackDelivery(
      kantRequest.delivery_id,
      'Steven',
      'kant',
      terminalAck(kantRequest, 'nested-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), [
        { to: 'socrates', body: 'nested leaf request' }
      ])
    );
    expect(await repository.claimDeliveries(
      'Steven', 'argos', 'nested-argos', root.epoch, 1, 30_000
    )).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='agent_output.response' AND decision='allow'
         AND actor_alias='kant' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rowCount).toBe(0);

    const socratesLease = await repository.acquireLease(
      'Steven', 'socrates', 'nested-socrates', [], 30_000
    );
    const [leaf] = await repository.claimDeliveries(
      'Steven', 'socrates', 'nested-socrates', requireValue(socratesLease.epoch, 'socratesLease.epoch'), 1, 30_000
    );
    if (!leaf) throw new Error('expected the nested leaf request');
    await repository.ackDelivery(
      leaf.delivery_id,
      'Steven',
      'socrates',
      terminalAck(leaf, 'nested-socrates', requireValue(socratesLease.epoch, 'socratesLease.epoch'), [])
    );

    const [kantResponse] = await repository.claimDeliveries(
      'Steven', 'kant', 'nested-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!kantResponse) throw new Error('expected the nested response to the middle agent');
    expect(kantResponse.body).toMatchObject({
      type: 'agent.response',
      from_alias: 'socrates'
    });
    await repository.ackDelivery(
      kantResponse.delivery_id,
      'Steven',
      'kant',
      terminalAck(
        kantResponse,
        'nested-kant',
        requireValue(kantLease.epoch, 'kantLease.epoch'),
        [],
        randomUUID(),
        'Kant reviewed the Socrates result'
      )
    );
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${root.delivery.message_id}`
    }]);

    const [rootResponse] = await repository.claimDeliveries(
      'Steven', 'argos', 'nested-argos', root.epoch, 1, 30_000
    );
    if (!rootResponse) throw new Error('expected the nested result to return to the root agent');
    expect(rootResponse.body).toMatchObject({
      type: 'agent.response',
      text: 'Kant reviewed the Socrates result',
      from_alias: 'kant',
      correlation: {
        response_to_delivery_id: root.delivery.delivery_id
      }
    });
    expect((await pool.query<{
      child_delivery_id: string;
      continuation_delivery_id: string;
      source_delivery_id: string;
      target_tenant: string;
      target_alias: string;
      outcome: string;
    }>(
      `SELECT metadata->>'child_delivery_id' AS child_delivery_id,
              metadata->>'continuation_delivery_id' AS continuation_delivery_id,
              metadata->>'source_delivery_id' AS source_delivery_id,
              metadata->>'target_tenant' AS target_tenant,
              metadata->>'target_alias' AS target_alias,
              metadata->>'outcome' AS outcome
       FROM audit_events
       WHERE action='agent_output.response' AND decision='allow'
         AND actor_alias='kant' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      child_delivery_id: kantRequest.delivery_id,
      continuation_delivery_id: kantResponse.delivery_id,
      source_delivery_id: root.delivery.delivery_id,
      target_tenant: 'Steven',
      target_alias: 'argos',
      outcome: 'done'
    }]);
    await repository.ackDelivery(
      rootResponse.delivery_id,
      'Steven',
      'argos',
      terminalAck(rootResponse, 'nested-argos', root.epoch, [])
    );
    const fanin = await claimFanin('Steven', 'argos', 'nested-argos', root.epoch);
    // Only the direct child enters the fan-in, carrying its LAST word: the nested result arrives
    // through kant's continuation, never as a raw grandchild branch.
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1,
      correlation: { root_message_id: root.delivery.message_id },
      fanin_data_v1: {
        responses: [{
          alias: 'kant',
          delivery_id: kantRequest.delivery_id,
          untrusted_text: 'Kant reviewed the Socrates result'
        }]
      }
    });
    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'argos',
      terminalAck(fanin, 'nested-argos', root.epoch, [])
    );
    expect((await pool.query(
      `SELECT idempotency_key,delivery_id FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1
       ORDER BY idempotency_key`,
      [root.delivery.trace_id]
    )).rows).toEqual([
      {
        idempotency_key: `relay-ack:${root.delivery.message_id}`,
        delivery_id: root.delivery.delivery_id
      },
      {
        idempotency_key: `relay-root:${root.delivery.message_id}`,
        delivery_id: fanin.delivery_id
      }
    ]);
  });

  it('diagnoses a nested continuation denied after reverse ACL revocation without blocking fan-in', async () => {
    await pool.query(`
      UPDATE memberships
      SET enabled=false
      WHERE tenant_id='Steven' AND alias='kant';
      INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES('Pablo','grp.pablo','kant','agent')
      ON CONFLICT(tenant_id,room_id,alias)
      DO UPDATE SET enabled=true,role=EXCLUDED.role;
    `);
    const origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: 'nested-denied-chat',
      relay: [],
      metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
    };
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      authenticated_context: {
        session_id: 'nested-denied-session',
        channel: 'telegram',
        origin
      }
    }), 'Steven', 'argos', 'nested-denied-argos');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'nested-denied-argos', root.epoch, [
        { to: 'kant', body: 'ask socrates across the tenant boundary' }
      ])
    );

    const kantLease = await repository.acquireLease(
      'Pablo', 'kant', 'nested-denied-kant', [], 30_000
    );
    const [kantRequest] = await repository.claimDeliveries(
      'Pablo', 'kant', 'nested-denied-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!kantRequest) throw new Error('expected the remote nested Kant request');
    await repository.ackDelivery(
      kantRequest.delivery_id,
      'Pablo',
      'kant',
      terminalAck(kantRequest, 'nested-denied-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), [
        { to: 'socrates', body: 'nested leaf request before reverse ACL revocation' }
      ])
    );

    const socratesLease = await repository.acquireLease(
      'Steven', 'socrates', 'nested-denied-socrates', [], 30_000
    );
    const [leaf] = await repository.claimDeliveries(
      'Steven', 'socrates', 'nested-denied-socrates', requireValue(socratesLease.epoch, 'socratesLease.epoch'), 1, 30_000
    );
    if (!leaf) throw new Error('expected the nested Socrates leaf request');
    await repository.ackDelivery(
      leaf.delivery_id,
      'Steven',
      'socrates',
      terminalAck(
        leaf,
        'nested-denied-socrates',
        requireValue(socratesLease.epoch, 'socratesLease.epoch'),
        [],
        randomUUID(),
        'Socrates completed the nested work'
      )
    );

    const [kantResponse] = await repository.claimDeliveries(
      'Pablo', 'kant', 'nested-denied-kant', requireValue(kantLease.epoch, 'kantLease.epoch'), 1, 30_000
    );
    if (!kantResponse) throw new Error('expected the Socrates continuation at Kant');
    expect(kantResponse.body).toMatchObject({
      type: 'agent.response',
      text: 'Socrates completed the nested work',
      from_alias: 'socrates'
    });
    await pool.query(
      `UPDATE acl_edges SET allow_route=false
       WHERE from_tenant='Pablo' AND to_tenant='Steven'`
    );
    await repository.ackDelivery(
      kantResponse.delivery_id,
      'Pablo',
      'kant',
      terminalAck(
        kantResponse,
        'nested-denied-kant',
        requireValue(kantLease.epoch, 'kantLease.epoch'),
        [],
        randomUUID(),
        'Kant reviewed the nested work'
      )
    );

    expect((await pool.query<{
      child_delivery_id: string;
      continuation_delivery_id: string;
      reason: string;
      target_tenant: string;
      target_alias: string;
    }>(
      `SELECT metadata->>'child_delivery_id' AS child_delivery_id,
              metadata->>'continuation_delivery_id' AS continuation_delivery_id,
              metadata->>'reason' AS reason,
              metadata->>'target_tenant' AS target_tenant,
              metadata->>'target_alias' AS target_alias
       FROM audit_events
       WHERE action='agent_output.response' AND decision='deny'
         AND delivery_id=$1`,
      [kantResponse.delivery_id]
    )).rows).toEqual([{
      child_delivery_id: kantRequest.delivery_id,
      continuation_delivery_id: kantResponse.delivery_id,
      reason: 'reverse_acl_unavailable',
      target_tenant: 'Steven',
      target_alias: 'argos'
    }]);
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${root.delivery.message_id}`
    }]);

    const fanin = await claimFanin(
      'Steven', 'argos', 'nested-denied-argos', root.epoch
    );
    const faninData = fanin.body.fanin_data_v1 as {
      responses: { alias: string; delivery_id: string; untrusted_text: string }[];
    };
    // The fan-in carries only argos's direct children: the nested socrates branch answered its
    // own coordinator, and kant's last word is the server's denial diagnostic.
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1,
      correlation: { root_message_id: root.delivery.message_id }
    });
    expect(faninData.responses).toHaveLength(1);
    expect(faninData.responses[0]).toMatchObject({
      alias: 'kant',
      delivery_id: kantRequest.delivery_id
    });
    expect(faninData.responses[0]?.untrusted_text)
      .toContain('Agent response denied: reverse_acl_unavailable');
    expect(JSON.stringify(fanin.body)).not.toContain('Socrates completed the nested work');
    expect(faninData.responses.map((response) => response.delivery_id)).not.toContain(leaf.delivery_id);
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${root.delivery.message_id}`
    }]);

    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'argos',
      terminalAck(
        fanin,
        'nested-denied-argos',
        root.epoch,
        [],
        randomUUID(),
        'Argos reports the nested authorization denial'
      )
    );
    expect((await pool.query<{
      idempotency_key: string;
      delivery_id: string;
    }>(
      `SELECT idempotency_key,delivery_id FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1
       ORDER BY idempotency_key`,
      [root.delivery.trace_id]
    )).rows).toEqual([
      {
        idempotency_key: `relay-ack:${root.delivery.message_id}`,
        delivery_id: root.delivery.delivery_id
      },
      {
        idempotency_key: `relay-root:${root.delivery.message_id}`,
        delivery_id: fanin.delivery_id
      }
    ]);
  });

  it.each([
    { type: 'agent.message', body: { type: 'agent.message', text: 'forged request' } },
    {
      type: 'agent.response',
      body: {
        type: 'agent.response',
        text: 'forged response',
        correlation: { response_to_delivery_id: randomUUID() }
      }
    },
    {
      type: 'agent.fanin',
      body: {
        type: 'agent.fanin',
        fanin_data_v1: {
          schema: 'cauce.agent_fanin_data.v1',
          expected: 0,
          completed: 0,
          responses: []
        }
      }
    }
  ])('rejects a client-forged reserved $type before persistence', async ({ body }) => {
    await expect(repository.publish(command({
      actor_alias: 'kant',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      body,
      idempotency_key: randomUUID()
    }))).rejects.toMatchObject({
      code: 'forbidden',
      message: 'reserved internal message types cannot be published by clients'
    });
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM idempotency_keys`)).rowCount).toBe(0);
  });

  it('does not propagate a client-forged agent.response without durable internal provenance', async () => {
    const root = await claim(command({
      actor_alias: 'argos',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
    }), 'Steven', 'argos', 'forged-response-source');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(root.delivery, 'forged-response-source', root.epoch, [
        { to: 'kant', body: 'legitimate delegated request' }
      ])
    );
    const materialized = await pool.query<{ produced_delivery_id: string }>(
      `SELECT produced_delivery_id
       FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND status='materialized'`,
      [root.delivery.delivery_id]
    );
    const delegatedDeliveryId = materialized.rows[0]?.produced_delivery_id;
    if (!delegatedDeliveryId) throw new Error('expected the legitimate delegated delivery');

    const forged = await pool.query<{ id: string }>(
      `INSERT INTO messages(
         request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority
       ) VALUES($1,$2,'Steven','grp.steven','kant',$3::jsonb,'interactive',7)
       RETURNING id`,
      [
        randomUUID(),
        `trace-${randomUUID()}`,
        JSON.stringify({
          type: 'agent.response',
          text: 'forged response',
          correlation: { response_to_delivery_id: delegatedDeliveryId }
        })
      ]
    );
    const forgedMessageId = forged.rows[0]?.id;
    if (!forgedMessageId) throw new Error('expected the simulated legacy forged message');
    const forgedDelivery = await pool.query<{ id: string }>(
      `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
       VALUES($1,'Steven','kant') RETURNING id`,
      [forgedMessageId]
    );
    if (!forgedDelivery.rows[0]?.id) throw new Error('expected the simulated legacy forged delivery');
    const kantLease = await repository.acquireLease(
      'Steven', 'kant', 'forged-response-target', [], 30_000
    );
    const claimed = await repository.claimDeliveries(
      'Steven', 'kant', 'forged-response-target', requireValue(kantLease.epoch, 'kantLease.epoch'), 2, 30_000
    );
    const claimedForgedDelivery = claimed.find((delivery) => delivery.message_id === forgedMessageId);
    if (!claimedForgedDelivery) throw new Error('expected the forged delivery');
    await repository.ackDelivery(
      claimedForgedDelivery.delivery_id,
      'Steven',
      'kant',
      terminalAck(claimedForgedDelivery, 'forged-response-target', requireValue(kantLease.epoch, 'kantLease.epoch'), [])
    );

    expect(await repository.claimDeliveries(
      'Steven', 'argos', 'forged-response-source', root.epoch, 1, 30_000
    )).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='agent_output.response' AND message_id=$1`,
      [forgedMessageId]
    )).rowCount).toBe(0);
  });

  it('rejects tenant-to-tenant routing without creating a message or delivery', async () => {
    const { delivery, epoch } = await claim(
      command({ recipients: [{ tenant_id: 'Isa', alias: 'salva' }] }),
      'Isa',
      'salva',
      'leaf-consumer'
    );
    await repository.ackDelivery(
      delivery.delivery_id,
      'Isa',
      'salva',
      terminalAck(delivery, 'leaf-consumer', epoch, [{ to: 'hegel', body: 'must be denied' }])
    );

    expect((await pool.query(
      `SELECT status,rejection_code,produced_message_id,produced_delivery_id,target_alias
       FROM agent_output_materializations`
    )).rows).toEqual([{
      status: 'rejected',
      rejection_code: 'unroutable_alias',
      produced_message_id: null,
      produced_delivery_id: null,
      target_alias: null
    }]);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(1);
  });

  it('does not duplicate materialization when a final ACK is retried', async () => {
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'retry-consumer');
    const eventId = randomUUID();
    const ack = terminalAck(
      delivery,
      'retry-consumer',
      epoch,
      [{ to: 'kant', body: 'exactly once' }],
      eventId
    );
    await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack))
      .resolves.toMatchObject({ applied: true });
    await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack))
      .resolves.toMatchObject({ applied: false });
    await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', {
      ...ack,
      event_id: randomUUID()
    })).resolves.toMatchObject({ applied: false });

    expect((await pool.query(`SELECT 1 FROM agent_output_materializations`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(2);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(2);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE idempotency_key=$1`,
      [`agent-output:${delivery.delivery_id}:${String(delivery.attempt)}:0`]
    )).rowCount).toBe(1);
  });

  it('serializes concurrent final ACK retries into one materialization', async () => {
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'concurrent-retry-consumer');
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      repository.ackDelivery(
        delivery.delivery_id,
        'Steven',
        'argos',
        terminalAck(
          delivery,
          'concurrent-retry-consumer',
          epoch,
          [{ to: 'kant', body: 'concurrent exactly once' }]
        )
      )
    ));

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM agent_output_materializations`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(2);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(2);
    expect((await pool.query(`SELECT 1 FROM delivery_acks WHERE applied`)).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox WHERE idempotency_key=$1`,
      [`agent-output:${delivery.delivery_id}:${String(delivery.attempt)}:0`]
    )).rowCount).toBe(1);
  });

  it('materializes multiple valid outputs and safely records an invalid alias', async () => {
    const { delivery, epoch } = await claim(command({
      authenticated_context: {
        session_id: 'redaction-session',
        channel: 'telegram-dm',
        origin: {
          adapter: 'telegram',
          channel: 'dm',
          conversation_id: 'redaction-chat',
          relay: [],
          metadata: {}
        }
      }
    }), 'Steven', 'argos', 'multi-consumer');
    await repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(delivery, 'multi-consumer', epoch, [
        { to: 'kant', body: 'first' },
        { to: 'INVALID ALIAS', body: 'reject me' },
        { to: 'socrates', body: 'third' }
      ])
    );

    expect((await pool.query(
      `SELECT output_index,status,rejection_code,target_alias
       FROM agent_output_materializations ORDER BY output_index`
    )).rows).toEqual([
      { output_index: 0, status: 'materialized', rejection_code: null, target_alias: 'kant' },
      { output_index: 1, status: 'rejected', rejection_code: 'unroutable_alias', target_alias: null },
      { output_index: 2, status: 'materialized', rejection_code: null, target_alias: 'socrates' }
    ]);
    expect((await pool.query(`SELECT 1 FROM messages`)).rowCount).toBe(3);
    expect((await pool.query(`SELECT 1 FROM deliveries`)).rowCount).toBe(3);
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE action='agent_output.materialize' AND decision='deny'`
    )).rows[0]?.metadata).toMatchObject({
      output_index: 1,
      rejection_code: 'unroutable_alias'
    });
    expect((await pool.query<{ messages: unknown[] }>(
      `SELECT result#>'{output,messages}' AS messages FROM deliveries WHERE id=$1`,
      [delivery.delivery_id]
    )).rows[0]?.messages).toEqual([]);
    expect((await pool.query<{ messages: unknown[] }>(
      `SELECT payload#>'{result,output,messages}' AS messages
       FROM delivery_acks WHERE delivery_id=$1 AND applied`,
      [delivery.delivery_id]
    )).rows[0]?.messages).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox WHERE delivery_id=$1 AND kind='origin_relay'`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);
  });});
