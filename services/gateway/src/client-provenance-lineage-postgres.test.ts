import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY, HUMAN_CLIENT_PROVENANCE_CAPABILITY,
  HUMAN_CLIENT_DELEGATION_CAPABILITY, type DeliveryEnvelope, type Tenant } from '@cauce/protocol';
import { database, seed, connection, consoleApp, issuer, controlOptions } from '../../../packages/store/test/human-client-provenance-postgres.fixtures.js';
import { clientConnectionReference } from '@cauce/store';
import { terminalAck } from '../../../packages/store/test/helpers/consumer.js';

const capabilities = [HUMAN_MESSAGE_INITIATOR_CAPABILITY, HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY];

async function scenario(source: 'mcp' | 'console' = 'mcp', fanout = false) {
  const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
  await pool.query(`INSERT INTO agents(tenant_id,alias) VALUES('Steven','socrates') ON CONFLICT DO NOTHING;
    INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven','socrates','agent') ON CONFLICT DO NOTHING;
    UPDATE tenants SET enabled=true; UPDATE rooms SET enabled=true; UPDATE memberships SET enabled=true;
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
    UPDATE agent_chain_policies SET progress_relay_enabled=false,cycle_cut_enabled=false,
      failure_coalesce_enabled=false,delegation_caps_enabled=false,human_gate_enabled=false`);
  const web = await consoleApp(pool, owner, source === 'console');
  const label = await web.app.inject({ method: 'POST', url: '/v3/console/mcp/client-delegations', headers: web.headers,
    payload: { request_id: randomUUID(), label: 'Dots',
      connection_ref: clientConnectionReference(issuer, controlOptions.resource, owner.humanId, 'Steven', c.identity.grantId) } });
  expect(label.statusCode).toBe(200);
  const input = { room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }, ...(fanout ? [{ tenant_id: 'Jhon', alias: 'hegel' }] : [])],
    body: { text: 'synthetic integrated provenance', channel: 'human-mcp', client_id: 'Forged', client_label: 'Forged' } };
  let root: { message_id: string };
  if (source === 'mcp') root = await c.operations.submit({ ...input, request_key: randomUUID() });
  else {
    const consoleInput = { ...input, lane: 'interactive', priority: 7 };
    const prepared = await web.app.inject({ method: 'POST', url: '/v3/console/publish-intents', headers: web.headers,
      payload: { ...consoleInput, intent_nonce: randomUUID() } });
    expect(prepared.statusCode).toBe(200);
    const payload = { ...consoleInput, idempotency_key: prepared.json<{ idempotency_key: string }>().idempotency_key };
    const published = await web.app.inject({ method: 'POST', url: '/v3/console/messages', headers: web.headers, payload });
    expect(published.statusCode).toBe(202); root = published.json<{ message_id: string }>();
    const retry = await web.app.inject({ method: 'POST', url: '/v3/console/messages', headers: web.headers, payload });
    expect(retry.statusCode).toBe(202); expect(retry.json<{ message_id: string }>().message_id).toBe(root.message_id);
    expect((await pool.query('SELECT * FROM human_message_client_provenance')).rowCount).toBe(0);
  }
  const repository = c.repository;
  const consumer = async (alias: string, tenant: Tenant = 'Steven', consumerCapabilities = capabilities) => {
    const instanceId = `provenance-${alias}-${randomUUID()}`;
    const lease = await repository.acquireLease(tenant, alias, instanceId, consumerCapabilities, 30000);
    if (lease.epoch === undefined) throw new Error('missing isolated lease');
    const identity = { instanceId, epoch: lease.epoch };
    return {
      next: async (type?: string) => {
        const deliveries = await repository.claimDeliveries(tenant, alias, instanceId, identity.epoch, 10, 30000);
        const delivery = deliveries.find(item => type === undefined || item.body.type === type);
        if (!delivery) throw new Error(`missing ${type ?? 'request'} for ${alias}`);
        return delivery;
      },
      ack: (delivery: DeliveryEnvelope, messages: unknown[] = []) => {
        const ack = terminalAck(delivery, identity, { messages });
        return { apply: () => repository.ackDelivery(delivery.delivery_id, tenant, alias, ack) };
      },
      fail: (delivery: DeliveryEnvelope) => repository.ackDelivery(delivery.delivery_id, tenant, alias,
        { ...terminalAck(delivery, identity, { status: 'failed' }), status: 'failed', retryable: false, error: 'synthetic terminal failure' }),
    };
  };
  const expectProjection = (delivery: DeliveryEnvelope) => {
    expect(delivery.human_initiator).toMatchObject({ human_id: owner.humanId, root_message_id: root.message_id });
    if (source === 'console') {
      expect(delivery).not.toHaveProperty('human_client_provenance');
      expect(delivery).not.toHaveProperty('human_client_delegation');
      return;
    }
    expect(delivery.human_client_provenance).toMatchObject({ root_message_id: root.message_id,
      client: { client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' } });
    expect(delivery.human_client_delegation).toMatchObject({ root_message_id: root.message_id,
      owner_human_id: owner.humanId, label: 'Dots', basis: 'owner_declared_grant', instance: 'unknown' });
    expect(JSON.stringify(delivery)).not.toContain(c.identity.grantId);
  };
  return { pool, repository, root, consumer, expectProjection };
}

describe.each(['mcp', 'console'] as const)('%s client provenance through real durable lineage operations', source => {
  it('projects the same root through outputs, responses, continuation, fan-in and duplicate ACKs', async () => {
    const s = await scenario(source); const argos = await s.consumer('argos'); const kant = await s.consumer('kant');
    const socrates = await s.consumer('socrates');
    const root = await argos.next(); s.expectProjection(root);
    const ack = argos.ack(root, [{ to: 'kant', body: 'synthetic delegated work' }]);
    expect((await ack.apply()).applied).toBe(true); expect((await ack.apply()).applied).toBe(false);
    const child = await kant.next(); s.expectProjection(child);
    await kant.ack(child, [{ to: 'socrates', body: 'synthetic nested work' }]).apply();
    const leaf = await socrates.next(); s.expectProjection(leaf); await socrates.ack(leaf).apply();
    const continuation = await kant.next('agent.response'); s.expectProjection(continuation); await kant.ack(continuation).apply();
    const response = await argos.next('agent.response'); s.expectProjection(response); await argos.ack(response).apply();
    const fanin = await argos.next('agent.fanin'); s.expectProjection(fanin);
    expect((await s.pool.query<{ root_message_id: string }>('SELECT root_message_id FROM human_message_client_provenance')).rows)
      .toEqual(source === 'mcp' ? [{ root_message_id: s.root.message_id }] : []);
  });

  it('preserves the root through an opened and answered human gate and resumed delegation', async () => {
    const s = await scenario(source); await s.pool.query('UPDATE agent_chain_policies SET human_gate_enabled=true');
    const argos = await s.consumer('argos'); const kant = await s.consumer('kant');
    const root = await argos.next(); s.expectProjection(root);
    const opened = await argos.ack(root, [{ to: '@human', body: 'synthetic approval question' }]).apply();
    const gate = opened.chain_gate?.gate_id; if (!gate) throw new Error('missing isolated human gate');
    await s.repository.answerChainGate(gate, 'synthetic approval', 'Steven', 'kant');
    const resume = await argos.next('agent.message'); s.expectProjection(resume);
    await argos.ack(resume, [{ to: 'kant', body: 'synthetic resumed work' }]).apply();
    const child = await kant.next(); s.expectProjection(child);
    expect((await s.pool.query<{ root_message_id: string }>('SELECT root_message_id FROM human_message_client_provenance')).rowCount).toBe(source === 'mcp' ? 1 : 0);
  });

  it('preserves immutable provenance when the operator replays a dead delivery', async () => {
    const s = await scenario(source); const argos = await s.consumer('argos');
    const root = await argos.next(); s.expectProjection(root); await argos.fail(root);
    const replay = await s.repository.replayDelivery(root.delivery_id, 'Steven', 'kant');
    const replayed = await argos.next(); s.expectProjection(replayed);
    expect(replayed.delivery_id).toBe(replay.delivery_id); expect(replayed.message_id).not.toBe(root.message_id);
    expect((await s.pool.query<{ root_message_id: string }>('SELECT root_message_id FROM human_message_client_provenance')).rows)
      .toEqual(source === 'mcp' ? [{ root_message_id: s.root.message_id }] : []);
  });
});

describe('client projection tenant boundary', () => {
  it.each([
    { newCapabilities: [] }, { newCapabilities: [HUMAN_CLIENT_PROVENANCE_CAPABILITY] },
    { newCapabilities: [HUMAN_CLIENT_DELEGATION_CAPABILITY] },
    { newCapabilities: [HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY] },
  ])('keeps fan-out deliverable with new capabilities $newCapabilities and hides both fields from other tenants', async ({ newCapabilities }) => {
    const s = await scenario('mcp', true);
    const caps = [HUMAN_MESSAGE_INITIATOR_CAPABILITY, ...newCapabilities];
    const own = await (await s.consumer('argos', 'Steven', caps)).next();
    const foreign = await (await s.consumer('hegel', 'Jhon', caps)).next();
    expect(own.human_initiator).toEqual(foreign.human_initiator);
    expect(own.human_client_provenance !== undefined).toBe(newCapabilities.includes(HUMAN_CLIENT_PROVENANCE_CAPABILITY));
    expect(own.human_client_delegation !== undefined).toBe(newCapabilities.includes(HUMAN_CLIENT_DELEGATION_CAPABILITY));
    expect(foreign).not.toHaveProperty('human_client_provenance');
    expect(foreign).not.toHaveProperty('human_client_delegation');
    expect(foreign.tenant_id).toBe('Steven');
    expect((await s.pool.query('SELECT * FROM human_message_client_provenance')).rowCount).toBe(1);
  });

  it('projects again on the return to the initiating tenant despite a foreign message tenant', async () => {
    const s = await scenario(); const argos = await s.consumer('argos'); const hegel = await s.consumer('hegel', 'Jhon');
    const root = await argos.next(); s.expectProjection(root);
    await argos.ack(root, [{ to: 'hegel', body: 'synthetic cross-tenant work' }]).apply();
    const child = await hegel.next();
    expect(child.human_initiator).toEqual(root.human_initiator);
    expect(child).not.toHaveProperty('human_client_provenance');
    expect(child).not.toHaveProperty('human_client_delegation');
    await hegel.ack(child).apply();
    const response = await argos.next('agent.response');
    expect(response.tenant_id).toBe('Jhon'); s.expectProjection(response);
    await argos.ack(response).apply(); s.expectProjection(await argos.next('agent.fanin'));
  });
});
