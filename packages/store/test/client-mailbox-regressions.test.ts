import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CauceRepository, clientMailboxAddress, clientConnectionReference } from '../src/index.js';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { mutateClientDelegation } from '../../../services/gateway/src/client-delegation-control.js';
import { database, seed, connection, ownedTransaction, controlOptions, issuer } from './human-client-provenance-postgres.fixtures.js';

type Owner = Awaited<ReturnType<typeof seed>>;
type Connection = Awaited<ReturnType<typeof connection>>;
type Pool = Awaited<ReturnType<typeof database>>;

const CAPABILITIES = ['routing_targets_v1', 'client_mailbox_v1', HUMAN_MESSAGE_INITIATOR_CAPABILITY];

async function declare(pool: Pool, owner: Owner, grantId: string, label: string) {
  return ownedTransaction(pool, owner.humanId, client => mutateClientDelegation(client,
    { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias }, controlOptions,
    { operation: 'create', requestId: randomUUID(), label, target: clientConnectionReference(issuer,
      controlOptions.resource, owner.humanId, 'Steven', grantId) }));
}
async function fixture(grants = 1) {
  const pool = await database(); const owner = await seed(pool);
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','socrates'),('Isa','salva') ON CONFLICT DO NOTHING");
  const connections: Connection[] = [];
  for (let index = 0; index < grants; index += 1) {
    const current = await connection(pool, owner);
    await declare(pool, owner, current.identity.grantId, `Cliente ${String(index)}`);
    connections.push(current);
  }
  const [first] = connections;
  if (!first) throw new Error('missing first grant');
  return { pool, owner, first, connections, repository: new CauceRepository(pool),
    aliases: connections.map(current => clientMailboxAddress(current.identity.grantId)) };
}
type State = Awaited<ReturnType<typeof fixture>>;

function command(alias: string, actor = 'argos', text = 'ping from agent') {
  return { version: '3.0' as const, request_id: randomUUID(), trace_id: randomUUID(),
    tenant_id: 'Steven' as const, room_id: 'grp.steven', actor_alias: actor,
    recipients: [{ tenant_id: 'Steven' as const, alias }], body: { text }, lane: 'batch' as const,
    priority: 0, idempotency_key: randomUUID() };
}
function human(state: State, to: string, text = 'please relay') {
  return state.first.operations.submit({ request_key: randomUUID(), room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven' as const, alias: to }], body: { text } });
}
function telegramRoot(state: State, to = 'argos') {
  const base = command(to, 'kant', 'relay this to my client');
  return state.repository.publish({ ...base, lane: 'interactive' as const, authenticated_context: {
    session_id: `telegram-${randomUUID()}`, channel: 'telegram', origin: { adapter: 'telegram', channel: 'telegram',
      conversation_id: 'mailbox-chat', external_message_id: randomUUID(), relay: [],
      metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' } } } });
}
async function consume(state: State, alias: string, instance: string, capabilities = CAPABILITIES) {
  const lease = await state.repository.acquireLease('Steven', alias, instance, capabilities, 30000, { resume: true });
  if (!lease.epoch || !lease.connection_token) throw new Error(`missing lease for ${alias}`);
  const delivery = (await state.repository.claimDeliveries('Steven', alias, instance, lease.epoch, 1, 30000, 3, {},
    lease.connection_token))[0];
  if (!delivery) throw new Error(`no delivery to claim for ${alias}`);
  const epoch = lease.epoch;
  return { delivery, ack: (reply: string, messages: { to: string; body: string }[] = []) => state.repository.ackDelivery(
    delivery.delivery_id, 'Steven', alias, { version: '3.0' as const, retryable: false, event_id: randomUUID(),
      claim_token: delivery.claim_token, attempt: delivery.attempt, instance_id: instance, epoch, status: 'done' as const,
      result: { output: { reply, messages, status: 'done', retryable: false, artifacts: [] } } }) };
}
const relays = (state: State, deliveryId: string) => state.pool.query(
  "SELECT idempotency_key,payload FROM adapter_outbox WHERE kind='origin_relay' AND delivery_id=$1 AND payload->>'outcome' IS DISTINCT FROM 'ack'", [deliveryId]);

describe('client mailbox regressions', () => {
  it('does not deadlock two concurrent publishers whose recipient lists are mailbox A,B and B,A', async () => {
    const state = await fixture(2); const [a, b] = state.aliases;
    if (!a || !b) throw new Error('missing mailboxes');
    const recipient = (alias: string) => ({ tenant_id: 'Steven' as const, alias });
    for (let round = 0; round < 6; round += 1) {
      const forward = { ...command(a, 'argos', `forward ${String(round)}`), recipients: [recipient(a), recipient(b)] };
      const reverse = { ...command(b, 'kant', `reverse ${String(round)}`), recipients: [recipient(b), recipient(a)] };
      const results = await Promise.allSettled([state.repository.publish(forward), state.repository.publish(reverse)]);
      expect(results.map(result => result.status), JSON.stringify(results)).toEqual(['fulfilled', 'fulfilled']);
    }
    for (const alias of state.aliases) {
      expect((await state.pool.query('SELECT count(*)::integer AS n FROM deliveries WHERE recipient_alias=$1', [alias])).rows[0])
        .toEqual({ n: 12 });
    }
  });

  it('answers the human immediately when argos emits only a mailbox message', async () => {
    const state = await fixture(); const [alias] = state.aliases;
    if (!alias) throw new Error('missing mailbox');
    await telegramRoot(state);
    const work = await consume(state, 'argos', 'argos-only-mailbox');
    await work.ack('delivered to Cronos', [{ to: alias, body: 'only mailbox' }]);
    const stored = await state.pool.query<{ status: string; attempt: number }>(
      'SELECT d.status,d.attempt FROM deliveries d WHERE d.recipient_alias=$1', [alias]);
    expect(stored.rows).toEqual([{ status: 'done', attempt: 0 }]);
    expect((await state.pool.query('SELECT status FROM deliveries WHERE id=$1', [work.delivery.delivery_id])).rows[0])
      .toEqual({ status: 'done' });
    expect((await state.pool.query("SELECT * FROM messages WHERE body->>'type'='agent.fanin'")).rowCount).toBe(0);
    expect((await relays(state, work.delivery.delivery_id)).rowCount, 'origin relay must not wait for a 15 minute sweep')
      .toBe(1);
    expect((await state.first.operations.mailbox?.({}))?.items).toMatchObject([{ from: { alias: 'argos' }, text: 'only mailbox' }]);
    await state.repository.sweepSilentChains();
    expect((await state.pool.query("SELECT 1 FROM audit_events WHERE metadata->>'reason'='terminal_without_response'" )).rowCount).toBe(0);
    const graph = await state.repository.agentChain(work.delivery.trace_id, 'Steven', 'kant');
    expect(graph).toMatchObject({ edges: [ { target: { client_mailbox: { state: 'stored' } } } ] });
  });

  it('returns the response of a nested agent that only emits a mailbox message to its parent at once', async () => {
    const state = await fixture(); const [alias] = state.aliases;
    if (!alias) throw new Error('missing mailbox');
    await telegramRoot(state);
    const argos = await consume(state, 'argos', 'argos-nested');
    await argos.ack('delegating', [{ to: 'socrates', body: 'tell Cronos hello' }]);
    const socrates = await consume(state, 'socrates', 'socrates-nested');
    await socrates.ack('told Cronos', [{ to: alias, body: 'hello Cronos' }]);
    expect((await state.first.operations.mailbox?.({}))?.items).toMatchObject([{ from: { alias: 'socrates' }, text: 'hello Cronos' }]);
    const back = await consume(state, 'argos', 'argos-nested');
    expect(back.delivery.body).toMatchObject({ type: 'agent.response' });
    await back.ack('all relayed');
    const fanin = await consume(state, 'argos', 'argos-nested');
    expect(fanin.delivery.body).toMatchObject({ type: 'agent.fanin' });
    await fanin.ack('final for the human');
    expect((await relays(state, fanin.delivery.delivery_id)).rowCount).toBe(1);
  });

  it('does not let a stored mailbox child block fan-in of a mixed mailbox and agent fan-out', async () => {
    const state = await fixture(); const [alias] = state.aliases;
    if (!alias) throw new Error('missing mailbox');
    await telegramRoot(state);
    const argos = await consume(state, 'argos', 'argos-mixed');
    await argos.ack('fan-out', [{ to: alias, body: 'to mailbox' }, { to: 'socrates', body: 'to agent' }]);
    expect((await relays(state, argos.delivery.delivery_id)).rowCount).toBe(0);
    const socrates = await consume(state, 'socrates', 'socrates-mixed');
    await socrates.ack('agent done');
    const response = await consume(state, 'argos', 'argos-mixed');
    expect(response.delivery.body).toMatchObject({ type: 'agent.response' });
    await response.ack('noted');
    const fanin = await consume(state, 'argos', 'argos-mixed');
    expect(fanin.delivery.body).toMatchObject({ type: 'agent.fanin' });
    await fanin.ack('final summary');
    expect((await relays(state, fanin.delivery.delivery_id)).rowCount).toBe(1);
  }, 60000);

  it('keeps agent routing targets within the 100 cap with 101+ grants and resolves the last mailbox exactly on ACK', async () => {
    const state = await fixture(102);
    const last = [...state.aliases.map((alias, index) => ({ alias, grant: state.connections[index]?.identity.grantId ?? '' }))]
      .sort((left, right) => (left.grant < right.grant ? -1 : 1)).at(-1);
    if (!last) throw new Error('missing last grant');
    await human(state, 'argos');
    const argos = await consume(state, 'argos', 'argos-many');
    const targets = argos.delivery.routing_targets ?? [];
    expect(targets.length).toBeLessThanOrEqual(100);
    expect(targets.filter(target => !target.client_mailbox).length).toBeGreaterThan(0);
    expect(targets.some(target => target.alias === 'socrates')).toBe(true);
    expect(targets.filter(target => target.client_mailbox).length).toBeLessThan(102);
    await argos.ack('stored at last', [{ to: last.alias, body: 'to the last mailbox' }]);
    const owner = state.connections.find(current => current.identity.grantId === last.grant);
    expect((await owner?.operations.mailbox?.({}))?.items).toMatchObject([{ text: 'to the last mailbox' }]);
  }, 120000);

  it('marks a human root sent to a mailbox as stored in its receipt', async () => {
    const state = await fixture(); const [alias] = state.aliases;
    if (!alias) throw new Error('missing mailbox');
    const submitted = await human(state, alias, 'direct to my mailbox');
    const receipt = await state.first.operations.receipt(submitted.message_id);
    expect(receipt.deliveries).toMatchObject([{ alias, status: 'done', attempt: 0, client_mailbox: { label: 'Cliente 0', state: 'stored' } }]);
    expect((await state.first.operations.mailbox?.({}))?.items).toMatchObject([{ message_id: submitted.message_id }]);
  });

  it('routes cross-tenant to a mailbox over allow_route alone, without an inverse ACL, and the owner reads it', async () => {
    const state = await fixture(); const [alias] = state.aliases;
    if (!alias) throw new Error('missing mailbox');
    await state.pool.query("DELETE FROM acl_edges WHERE from_tenant='Steven' AND to_tenant='Isa'");
    await state.pool.query("UPDATE acl_edges SET allow_route=true,allow_read=false WHERE from_tenant='Isa' AND to_tenant='Steven'");
    const foreign = { ...command(alias, 'salva', 'from Isa'), tenant_id: 'Isa' as const, room_id: 'grp.isa' };
    await state.repository.publish(foreign);
    expect((await state.first.operations.mailbox?.({}))?.items).toMatchObject([{ from: { tenant_id: 'Isa', alias: 'salva' }, text: 'from Isa' }]);
    await state.pool.query("UPDATE acl_edges SET allow_route=false WHERE from_tenant='Isa' AND to_tenant='Steven'");
    await expect(state.repository.publish({ ...foreign, request_id: randomUUID(), idempotency_key: randomUUID() }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
