import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { describe, expect, it } from 'vitest';
import {
  claim, claimFanin, command, deadTelegramAckEffect, pool, registerAgentOutputSuite, repository,
  seedTelegramAckAndFinal, terminalAck,
} from './agent-output-postgres-helpers.js';

registerAgentOutputSuite(import.meta.url);

describe('transactional StructuredOutput.messages materialization', () => {
  it('creates exactly one transactional Telegram ACK across publish replay', async () => {
    const input = command({
      authenticated_context: {
        session_id: 'telegram-ack-session',
        channel: 'telegram',
        origin: {
          adapter: 'telegram',
          channel: 'telegram',
          conversation_id: 'telegram-ack-chat',
          external_message_id: 'telegram-ack-message',
          relay: [],
          metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
        }
      }
    });

    const first = await repository.publish(input);
    const replay = await repository.publish(input);

    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({
      message_id: first.message_id,
      delivery_ids: first.delivery_ids,
      duplicate: true,
      request_id: first.request_id,
      trace_id: first.trace_id,
      idempotency_key: input.idempotency_key,
    });
    expect((await pool.query<{
      idempotency_key: string;
      delivery_id: string | null;
      relay_kind: string;
      terminal: boolean;
      outcome: string;
      reply: string;
      root_message_id: string;
    }>(
      `SELECT idempotency_key,delivery_id,payload->>'relay_kind' AS relay_kind,
              (payload->>'terminal')::boolean AS terminal,payload->>'outcome' AS outcome,
              payload#>>'{result,output,reply}' AS reply,
              payload#>>'{correlation,root_message_id}' AS root_message_id
       FROM adapter_outbox
       WHERE kind='origin_relay' AND idempotency_key=$1`,
      [`relay-ack:${first.message_id}`]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${first.message_id}`,
      delivery_id: first.delivery_ids[0],
      relay_kind: 'ack',
      terminal: false,
      outcome: 'ack',
      reply: 'Recibido por el bus; en cola para el agente.',
      root_message_id: first.message_id
    }]);
  });

  it.each([
    {
      name: 'bare untrusted origin',
      provenance: {
        origin: {
          adapter: 'telegram',
          channel: 'telegram',
          conversation_id: 'bare-origin-chat',
          relay: [],
          metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
        }
      }
    },
    {
      name: 'non-Telegram authenticated channel',
      provenance: {
        authenticated_context: {
          session_id: 'discord-auth-session',
          channel: 'discord',
          origin: {
            adapter: 'telegram',
            channel: 'telegram',
            conversation_id: 'discord-auth-chat',
            relay: [],
            metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
          }
        }
      }
    },
    {
      name: 'non-Telegram authenticated origin channel',
      provenance: {
        authenticated_context: {
          session_id: 'wrong-origin-channel-session',
          channel: 'telegram',
          origin: {
            adapter: 'telegram',
            channel: 'discord',
            conversation_id: 'wrong-origin-channel-chat',
            relay: [],
            metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
          }
        }
      }
    },
    {
      name: 'non-Telegram authenticated origin adapter',
      provenance: {
        authenticated_context: {
          session_id: 'wrong-origin-adapter-session',
          channel: 'telegram',
          origin: {
            adapter: 'discord',
            channel: 'telegram',
            conversation_id: 'wrong-origin-adapter-chat',
            relay: [],
            metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
          }
        }
      }
    }
  ])('does not create a Telegram ACK from $name', async ({ provenance }) => {
    const published = await repository.publish(command(provenance));
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='origin_relay' AND idempotency_key=$1`,
      [`relay-ack:${published.message_id}`]
    )).rowCount).toBe(0);
  });

  it('supersedes an unclaimed ACK as soon as its correlated final is processing', async () => {
    const seeded = await seedTelegramAckAndFinal('processing');

    expect(await repository.claimOutbox(
      'origin_relay', 'processing-final-order', 10, 30_000, 'telegram'
    )).toEqual([]);
    expect((await pool.query<{ status: string; last_error: string }>(
      `SELECT status,last_error FROM adapter_outbox WHERE id=$1`,
      [seeded.ackId]
    )).rows).toEqual([{
      status: 'dead',
      last_error: 'Telegram acceptance ACK was superseded by a claimed or terminal final relay'
    }]);
    expect((await pool.query(
      `SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1 AND resolved_at IS NULL`,
      [seeded.ackId]
    )).rowCount).toBe(1);
  });

  it.each(['sent', 'dead'] as const)(
    'tombstones an expired processing ACK when its correlated final is %s',
    async (finalStatus) => {
      const seeded = await seedTelegramAckAndFinal(finalStatus);
      await pool.query(
        `UPDATE adapter_outbox SET status='processing',attempts=1,claimed_by='expired-ack',
           claim_token=$2,claimed_at=now()-interval '2 minutes',
           claim_expires_at=now()-interval '1 minute'
         WHERE id=$1`,
        [seeded.ackId, randomUUID()]
      );

      expect(await repository.claimOutbox(
        'origin_relay', `expired-ack-${finalStatus}`, 10, 30_000, 'telegram'
      )).toEqual([]);
      expect((await pool.query<{ status: string; last_error: string }>(
        `SELECT status,last_error FROM adapter_outbox WHERE id=$1`,
        [seeded.ackId]
      )).rows).toEqual([{
        status: 'dead',
        last_error: 'Telegram acceptance ACK was superseded by a claimed or terminal final relay'
      }]);
      expect((await pool.query(
        `SELECT 1 FROM outbox_dead_letters WHERE outbox_id=$1 AND resolved_at IS NULL`,
        [seeded.ackId]
      )).rowCount).toBe(1);
    }
  );

  it.each(['processing', 'sent', 'dead'] as const)(
    'rejects manual ACK replay when its correlated final is %s',
    async (finalStatus) => {
      const seeded = await seedTelegramAckAndFinal(finalStatus);
      const replay = await deadTelegramAckEffect(seeded.ackId);

      await expect(replay.bridge.manualReplayEffect(
        0, replay.payloadHash, `review ${finalStatus}`, 'Steven', 'kant', true,
        randomUUID(), replay.deadLetterId, replay.incidentEvidenceSha256, 0
      )).rejects.toThrow(
        'Telegram acceptance ACK replay is forbidden after its final relay was claimed or terminal'
      );
      expect(await replay.bridge.getEffect(replay.effectId)).toMatchObject({
        state: 'dead',
        replay_count: 0
      });
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`,
        [seeded.ackId]
      )).rows).toEqual([{ status: 'dead' }]);
    }
  );

  it('serializes manual ACK replay against a concurrent final claim', async () => {
    const seeded = await seedTelegramAckAndFinal('pending');
    const replay = await deadTelegramAckEffect(seeded.ackId);

    const [manualResult, claimResult] = await Promise.allSettled([
      replay.bridge.manualReplayEffect(
        0, replay.payloadHash, 'concurrent operator review', 'Steven', 'kant', true,
        randomUUID(), replay.deadLetterId, replay.incidentEvidenceSha256, 0
      ),
      repository.claimOutbox(
        'origin_relay', 'concurrent-final-claim', 1, 30_000, 'telegram'
      )
    ]);
    const replayed = manualResult.status === 'fulfilled';
    const claims = claimResult.status === 'fulfilled' ? claimResult.value : [];
    const finalClaims = claims.filter((event) => event.event_id === seeded.finalId);

    expect(replayed && finalClaims.length > 0).toBe(false);
    expect(replayed || finalClaims.length === 1).toBe(true);
    if (replayed) {
      expect(finalClaims).toEqual([]);
      expect(claims.every((event) => event.event_id === seeded.ackId)).toBe(true);
      expect((await pool.query<{ status: string }>(
        `SELECT status FROM adapter_outbox WHERE id=$1`,
        [seeded.ackId]
      )).rows[0]?.status).toMatch(/failed|processing/);
    } else {
      expect(finalClaims).toHaveLength(1);
      expect(finalClaims[0]?.event_id).toBe(seeded.finalId);
      expect(manualResult.status).toBe('rejected');
      const rejection = manualResult.reason as unknown;
      expect(rejection).toBeInstanceOf(Error);
      if (rejection instanceof Error) {
        expect(rejection.message).toBe(
          'Telegram acceptance ACK replay is forbidden after its final relay was claimed or terminal'
        );
      }
    }
  });

  it('creates a same-tenant message and delivery from the authenticated consumer identity', async () => {
    const { delivery, epoch } = await claim(command({
      authenticated_context: {
        session_id: 'telegram-session',
        channel: 'telegram-dm',
        origin: {
          adapter: 'telegram',
          channel: 'dm',
          conversation_id: 'agent-output-chat',
          relay: [],
          metadata: {}
        }
      }
    }), 'Steven', 'argos', 'same-tenant-consumer');
    await expect(repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      terminalAck(delivery, 'same-tenant-consumer', epoch, [{ to: 'kant', body: 'hello kant' }])
    )).resolves.toMatchObject({ status: 'done', applied: true });

    const materialized = await pool.query<{
      source_tenant: string;
      source_alias: string;
      target_tenant: string;
      target_alias: string;
      status: string;
      hop_count: number;
      trace_id: string;
      tenant_id: string;
      room_id: string;
      actor_alias: string;
      body: Record<string, unknown>;
      origin: unknown;
      auth_session_id: string;
      auth_channel: string;
      recipient_tenant: string;
      recipient_alias: string;
      delivery_status: string;
    }>(
      `SELECT materialization.source_tenant,materialization.source_alias,
              materialization.target_tenant,materialization.target_alias,materialization.status,
              materialization.hop_count,materialization.trace_id,
              message.tenant_id,message.room_id,message.actor_alias,message.body,message.origin,
              message.auth_session_id,message.auth_channel,delivery.recipient_tenant,delivery.recipient_alias,
              delivery.status AS delivery_status
       FROM agent_output_materializations materialization
       JOIN messages message ON message.id=materialization.produced_message_id
       JOIN deliveries delivery ON delivery.id=materialization.produced_delivery_id`
    );
    const expectedBody: unknown = expect.objectContaining({
      type: 'agent.message',
      text: 'hello kant',
      from_alias: 'argos'
    });
    expect(materialized.rows).toEqual([expect.objectContaining({
      source_tenant: 'Steven',
      source_alias: 'argos',
      target_tenant: 'Steven',
      target_alias: 'kant',
      status: 'materialized',
      hop_count: 1,
      trace_id: delivery.trace_id,
      tenant_id: 'Steven',
      room_id: 'grp.steven',
      actor_alias: 'argos',
      body: expectedBody,
      origin: {
        adapter: 'telegram',
        channel: 'dm',
        conversation_id: 'agent-output-chat',
        relay: [],
        metadata: {}
      },
      auth_session_id: 'telegram-session',
      auth_channel: 'telegram-dm',
      recipient_tenant: 'Steven',
      recipient_alias: 'kant',
      delivery_status: 'pending'
    })]);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='wake' AND payload->>'recipient_alias'='kant'`
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='origin_relay' AND delivery_id=$1 AND adapter='telegram'`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);

    const childLease = await repository.acquireLease('Steven', 'kant', 'same-tenant-target', [], 30_000);
    const [child] = await repository.claimDeliveries(
      'Steven', 'kant', 'same-tenant-target', requireValue(childLease.epoch, 'childLease.epoch'), 1, 30_000
    );
    expect(child).toMatchObject({
      actor_alias: 'argos',
      recipient_alias: 'kant',
      body: { type: 'agent.message', text: 'hello kant', from_alias: 'argos' },
      origin: {
        adapter: 'telegram',
        conversation_id: 'agent-output-chat'
      },
      authenticated_context: {
        session_id: 'telegram-session',
        channel: 'telegram-dm',
        origin: {
          adapter: 'telegram',
          conversation_id: 'agent-output-chat'
        }
      }
    });

    await repository.ackDelivery(
      requireValue(child, 'child').delivery_id,
      'Steven',
      'kant',
      terminalAck(requireValue(child, 'child'), 'same-tenant-target', requireValue(childLease.epoch, 'childLease.epoch'), [])
    );
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='origin_relay' AND delivery_id=$1 AND adapter='telegram'`,
      [requireValue(child, 'child').delivery_id]
    )).rowCount).toBe(0);

    const [response] = await repository.claimDeliveries(
      'Steven', 'argos', 'same-tenant-consumer', epoch, 1, 30_000
    );
    expect(response).toMatchObject({
      actor_alias: 'kant',
      recipient_alias: 'argos',
      body: {
        type: 'agent.response',
        text: 'done',
        from_alias: 'kant',
        outcome: 'done',
        correlation: {
          root_message_id: delivery.message_id,
          parent_delivery_id: requireValue(child, 'child').delivery_id,
          response_to_delivery_id: delivery.delivery_id
        }
      },
      origin: {
        adapter: 'telegram',
        conversation_id: 'agent-output-chat'
      },
      authenticated_context: {
        session_id: 'telegram-session',
        channel: 'telegram-dm'
      }
    });
    if (!response) throw new Error('expected a durable response delivery to the source agent');
    await repository.ackDelivery(
      response.delivery_id,
      'Steven',
      'argos',
      terminalAck(response, 'same-tenant-consumer', epoch, [])
    );
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [response.trace_id]
    )).rowCount).toBe(0);
    const fanin = await claimFanin('Steven', 'argos', 'same-tenant-consumer', epoch);
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1,
      correlation: {
        root_message_id: delivery.message_id,
        root_delivery_id: delivery.delivery_id
      }
    });
    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'argos',
      terminalAck(fanin, 'same-tenant-consumer', epoch, [])
    );
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox
       WHERE kind='origin_relay' AND delivery_id=$1 AND adapter='telegram'`,
      [fanin.delivery_id]
    )).rowCount).toBe(1);
  });

  it.each([
    {
      name: 'Steven to tenant',
      input: command({ actor_alias: 'argos', recipients: [{ tenant_id: 'Steven', alias: 'kant' }] }),
      consumerTenant: 'Steven',
      consumerAlias: 'kant',
      targetAlias: 'salva',
      targetTenant: 'Isa'
    },
    {
      name: 'tenant to Steven',
      input: command({ recipients: [{ tenant_id: 'Isa', alias: 'salva' }] }),
      consumerTenant: 'Isa',
      consumerAlias: 'salva',
      targetAlias: 'argos',
      targetTenant: 'Steven'
    }
  ])('allows the configured hub-star direction: $name', async ({
    input, consumerTenant, consumerAlias, targetAlias, targetTenant
  }) => {
    const instanceId = `hub-star-${consumerAlias}`;
    const { delivery, epoch } = await claim(input, consumerTenant, consumerAlias, instanceId);
    await repository.ackDelivery(
      delivery.delivery_id,
      consumerTenant,
      consumerAlias,
      terminalAck(delivery, instanceId, epoch, [{ to: targetAlias, body: 'hub-star output' }])
    );
    expect((await pool.query(
      `SELECT source_tenant,source_alias,target_tenant,target_alias,status
       FROM agent_output_materializations`
    )).rows).toEqual([{
      source_tenant: consumerTenant,
      source_alias: consumerAlias,
      target_tenant: targetTenant,
      target_alias: targetAlias,
      status: 'materialized'
    }]);
  });

  it('returns a cross-tenant child answer to the hub agent before relaying to its Telegram origin', async () => {
    const origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: 'jarvis-cross-tenant-chat',
      relay: [],
      metadata: { bridge_alias: 'jarvis', bridge_tenant: 'Steven' }
    };
    const root = await claim(command({
      actor_alias: 'jarvis',
      recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
      authenticated_context: {
        session_id: 'jarvis-cross-tenant-session',
        channel: 'telegram',
        origin
      }
    }), 'Steven', 'jarvis', 'jarvis-cross-tenant');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'jarvis',
      terminalAck(
        root.delivery,
        'jarvis-cross-tenant',
        root.epoch,
        [{ to: 'seneca', body: 'cross-tenant request' }]
      )
    );

    const senecaLease = await repository.acquireLease('Pablo', 'seneca', 'seneca-cross-tenant', [], 30_000);
    const [child] = await repository.claimDeliveries(
      'Pablo', 'seneca', 'seneca-cross-tenant', requireValue(senecaLease.epoch, 'senecaLease.epoch'), 1, 30_000
    );
    expect(child).toMatchObject({
      tenant_id: 'Steven',
      actor_alias: 'jarvis',
      recipient_alias: 'seneca',
      origin: { metadata: { bridge_alias: 'jarvis', bridge_tenant: 'Steven' } }
    });
    if (!child) throw new Error('expected cross-tenant child delivery');
    await repository.ackDelivery(
      child.delivery_id,
      'Pablo',
      'seneca',
      terminalAck(child, 'seneca-cross-tenant', requireValue(senecaLease.epoch, 'senecaLease.epoch'), [])
    );

    const [response] = await repository.claimDeliveries(
      'Steven', 'jarvis', 'jarvis-cross-tenant', root.epoch, 1, 30_000
    );
    expect(response).toMatchObject({
      tenant_id: 'Pablo',
      actor_alias: 'seneca',
      recipient_alias: 'jarvis',
      body: {
        type: 'agent.response',
        from_alias: 'seneca',
        outcome: 'done'
      },
      authenticated_context: {
        session_id: 'jarvis-cross-tenant-session',
        channel: 'telegram',
        origin: { metadata: { bridge_alias: 'jarvis', bridge_tenant: 'Steven' } }
      }
    });
    if (!response) throw new Error('expected cross-tenant response delivery');
    await repository.ackDelivery(
      response.delivery_id,
      'Steven',
      'jarvis',
      terminalAck(response, 'jarvis-cross-tenant', root.epoch, [])
    );
    const fanin = await claimFanin(
      'Steven', 'jarvis', 'jarvis-cross-tenant', root.epoch
    );
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1,
      correlation: { root_message_id: root.delivery.message_id }
    });
    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'jarvis',
      terminalAck(fanin, 'jarvis-cross-tenant', root.epoch, [])
    );
    expect((await pool.query(
      `SELECT tenant_id,adapter,origin->'metadata'->>'bridge_alias' AS bridge_alias
       FROM adapter_outbox WHERE kind='origin_relay' AND delivery_id=$1`,
      [fanin.delivery_id]
    )).rows).toEqual([{
      tenant_id: 'Steven',
      adapter: 'telegram',
      bridge_alias: 'jarvis'
    }]);
  });

  it('diagnoses a denied child return through fan-in without bypassing directly to Telegram', async () => {
    const origin = {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: 'revoked-return-chat',
      relay: [],
      metadata: { bridge_alias: 'jarvis', bridge_tenant: 'Steven' }
    };
    const root = await claim(command({
      actor_alias: 'jarvis',
      recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
      authenticated_context: {
        session_id: 'revoked-return-session',
        channel: 'telegram',
        origin
      }
    }), 'Steven', 'jarvis', 'revoked-return-jarvis');
    await repository.ackDelivery(
      root.delivery.delivery_id,
      'Steven',
      'jarvis',
      terminalAck(root.delivery, 'revoked-return-jarvis', root.epoch, [
        { to: 'seneca', body: 'cross-tenant request before ACL revocation' }
      ])
    );

    const senecaLease = await repository.acquireLease(
      'Pablo', 'seneca', 'revoked-return-seneca', [], 30_000
    );
    const [child] = await repository.claimDeliveries(
      'Pablo', 'seneca', 'revoked-return-seneca', requireValue(senecaLease.epoch, 'senecaLease.epoch'), 1, 30_000
    );
    if (!child) throw new Error('expected the cross-tenant child delivery');
    await pool.query(
      `UPDATE acl_edges SET allow_route=false
       WHERE from_tenant='Pablo' AND to_tenant='Steven'`
    );
    await repository.ackDelivery(
      child.delivery_id,
      'Pablo',
      'seneca',
      terminalAck(child, 'revoked-return-seneca', requireValue(senecaLease.epoch, 'senecaLease.epoch'), [])
    );

    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM adapter_outbox
       WHERE kind='origin_relay' AND trace_id=$1`,
      [root.delivery.trace_id]
    )).rows).toEqual([{
      idempotency_key: `relay-ack:${root.delivery.message_id}`
    }]);
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE action='agent_output.response' AND decision='deny' AND delivery_id=$1`,
      [child.delivery_id]
    )).rows[0]?.metadata).toMatchObject({
      reason: 'reverse_acl_unavailable',
      target_tenant: 'Steven',
      target_alias: 'jarvis'
    });
    const fanin = await claimFanin(
      'Steven', 'jarvis', 'revoked-return-jarvis', root.epoch
    );
    const faninData = fanin.body.fanin_data_v1 as {
      responses: { alias: string; untrusted_text: string }[];
    };
    expect(fanin.body).toMatchObject({
      type: 'agent.fanin',
      expected: 1,
      completed: 1,
      correlation: { root_message_id: root.delivery.message_id }
    });
    expect(faninData.responses).toHaveLength(1);
    expect(faninData.responses[0]).toMatchObject({ alias: 'seneca' });
    expect(faninData.responses[0]?.untrusted_text)
      .toContain('Agent response denied: reverse_acl_unavailable');
    await repository.ackDelivery(
      fanin.delivery_id,
      'Steven',
      'jarvis',
      terminalAck(
        fanin,
        'revoked-return-jarvis',
        root.epoch,
        [],
        randomUUID(),
        'Jarvis reports the denied child return'
      )
    );
    expect((await pool.query<{ idempotency_key: string; delivery_id: string }>(
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
  });});
