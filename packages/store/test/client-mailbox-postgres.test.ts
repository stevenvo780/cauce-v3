import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CauceRepository, CLIENT_MAILBOX_CAPACITY, clientMailboxAddress, clientConnectionReference, withTransaction } from '../src/index.js';
import { DeliveryEnvelopeSchema, HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { openAgentRoots } from '../src/repository/messages/agent-roots.js';
import { mutateClientDelegation } from '../../../services/gateway/src/client-delegation-control.js';
import { database, seed, connection, ownedTransaction, controlOptions, issuer } from './human-client-provenance-postgres.fixtures.js';

async function fixture() {
  const pool = await database(); const owner = await seed(pool); const first = await connection(pool, owner);
  const declaration = await ownedTransaction(pool, owner.humanId, client => mutateClientDelegation(client,
    { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias }, controlOptions,
    { operation: 'create', requestId: randomUUID(), label: 'Cronos', target: clientConnectionReference(issuer,
      controlOptions.resource, owner.humanId, 'Steven', first.identity.grantId) }));
  const repository = new CauceRepository(pool);
  const alias = clientMailboxAddress(first.identity.grantId, 'Steven');
  return { pool, owner, first, declaration, repository, alias };
}
function command(alias: string, text = 'ping from agent') {
  return { version: '3.0' as const, request_id: randomUUID(), trace_id: randomUUID(),
    tenant_id: 'Steven' as const, room_id: 'grp.steven', actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven' as const, alias }], body: { text }, lane: 'batch' as const,
    priority: 0, idempotency_key: randomUUID() };
}
async function fill(state: Awaited<ReturnType<typeof fixture>>, count: number) {
  await state.pool.query(`WITH inserted AS (INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
    SELECT gen_random_uuid(),'mailbox-fixture','Steven','grp.steven','argos','{"text":"seed"}'::jsonb,'batch',0
    FROM generate_series(1,$1) RETURNING id)
    INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,terminal_at,result)
    SELECT id,'Steven',$2,'done',now(),$3::jsonb FROM inserted`, [count, state.alias,
    JSON.stringify({ kind: 'client_mailbox', state: 'stored', label: 'Cronos',
      owner_human_id: state.owner.humanId, grant_id: state.first.identity.grantId })]);
}

describe('durable client mailbox', () => {
  it('paginates timestamp ties without loss and preserves the microsecond cursor', async () => {
    const state = await fixture(); await fill(state, 41);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await state.first.operations.mailbox?.({ limit: 7, ...(cursor === undefined ? {} : { cursor }) });
      if (!page) throw new Error('missing page');
      ids.push(...page.items.map(item => item.delivery_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(ids).toHaveLength(41);
    expect(new Set(ids).size).toBe(41);
  });

  it('returns complete Unicode text through mailbox and the compatibility inbox', async () => {
    const state = await fixture(); const text = '😀'.repeat(3000);
    await state.repository.publish(command(state.alias, text));
    const mailbox = await state.first.operations.mailbox?.({});
    expect(mailbox?.items[0]).toMatchObject({ text, text_truncated: false });
    expect((await state.first.operations.inbox({})).mailbox?.items[0]?.text).toBe(text);
    await state.pool.query("UPDATE messages SET auth_channel='chain-gate' WHERE id=$1", [mailbox?.items[0]?.message_id]);
    expect((await state.first.operations.mailbox?.({}))?.items[0]?.text).toBe(text);
  });

  it('paginates full text by byte budget without hiding or skipping messages', async () => {
    const state = await fixture(); const text = '😀'.repeat(3000);
    for (let index = 0; index < 20; index += 1) await state.repository.publish(command(state.alias, `${String(index)}:${text}`));
    const first = await state.first.operations.mailbox?.({ limit: 50 });
    expect(first?.items.length).toBeLessThan(20);
    expect(first?.next_cursor).toBeTruthy();
    const next = await state.first.operations.mailbox?.({ limit: 50, cursor: first?.next_cursor ?? '' });
    const items = [...(first?.items ?? []), ...(next?.items ?? [])];
    expect(items).toHaveLength(20);
    expect(new Set(items.map(item => item.delivery_id)).size).toBe(20);
    expect(items.every(item => item.text.endsWith(text) && !item.text_truncated)).toBe(true);
  });

  it('serializes concurrent admission at capacity and preserves an idempotent retry after the box fills', async () => {
    const state = await fixture(); await fill(state, CLIENT_MAILBOX_CAPACITY - 1);
    const inputs = [command(state.alias, 'capacity winner A'), command(state.alias, 'capacity winner B')];
    const results = await Promise.allSettled(inputs.map(input => state.repository.publish(input)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const input = inputs[winner];
    if (!input) throw new Error('missing winning input');
    expect(await state.repository.publish(input)).toMatchObject({ duplicate: true });
    expect((await state.pool.query('SELECT count(*)::integer AS n FROM deliveries WHERE recipient_alias=$1', [state.alias])).rows[0])
      .toEqual({ n: CLIENT_MAILBOX_CAPACITY });
  });

  it('rechecks nonblocking grant revocation after waiting for mailbox admission and rolls back the message', async () => {
    const state = await fixture(); const blocker = await state.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`client-mailbox:Steven:${state.alias}`]);
    const input = command(state.alias);
    const outcome = state.repository.publish(input).then(value => ({ value }), (error: unknown) => ({ error }));
    let blocked = false;
    try {
      for (let index = 0; index < 100; index += 1) {
        if ((await state.pool.query('SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND NOT granted')).rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await state.pool.query('INSERT INTO cauce_oauth_grant_revocations(grant_id) VALUES($1)', [state.first.identity.grantId]);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await outcome).toMatchObject({ error: { code: 'no_route' } });
    expect((await state.pool.query('SELECT * FROM messages WHERE request_id=$1', [input.request_id])).rowCount).toBe(0);
    expect((await state.pool.query('SELECT * FROM idempotency_keys WHERE idempotency_key=$1', [input.idempotency_key])).rowCount).toBe(0);
  });

  it('advertises mailboxes only to compatible adapters and materializes an agent message exactly once', async () => {
    const { first, repository, alias, pool } = await fixture();
    const request = () => ({ request_key: randomUUID(), room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }], body: { text: 'send a direct ping to Cronos' } });
    await first.operations.submit(request());
    const instance = 'mailbox-materializer';
    const lease = await repository.acquireLease('Steven', 'argos', instance, ['routing_targets_v1', HUMAN_MESSAGE_INITIATOR_CAPABILITY], 30000);
    if (!lease.epoch || !lease.connection_token) throw new Error('missing lease');
    const old = (await repository.claimDeliveries('Steven', 'argos', instance, lease.epoch, 1, 30000, 3, {}, lease.connection_token))[0];
    if (!old) throw new Error('missing delivery');
    expect(old.routing_targets?.some(target => target.alias === alias)).toBe(false);
    expect(DeliveryEnvelopeSchema.safeParse(old).success).toBe(true);
    await repository.ackDelivery(old.delivery_id, 'Steven', 'argos', { version: '3.0' as const, retryable: false, event_id: randomUUID(), claim_token: old.claim_token,
      attempt: old.attempt, instance_id: instance, epoch: lease.epoch, status: 'done',
      result: { output: { reply: 'legacy reply', messages: [], status: 'done', retryable: false, artifacts: [] } } });
    await first.operations.submit(request());
    const resumed = await repository.acquireLease('Steven', 'argos', instance, ['routing_targets_v1', 'client_mailbox_v1', HUMAN_MESSAGE_INITIATOR_CAPABILITY], 30000, { resume: true });
    if (!resumed.epoch || !resumed.connection_token) throw new Error('missing resumed lease');
    const current = (await repository.claimDeliveries('Steven', 'argos', instance, resumed.epoch, 1, 30000, 3, {}, resumed.connection_token))[0];
    if (!current) throw new Error('missing current delivery');
    expect(current.routing_targets?.find(target => target.alias === alias)).toMatchObject({ online: false,
      client_mailbox: { label: 'Cronos', available: true } });
    expect(DeliveryEnvelopeSchema.safeParse(current).success).toBe(true);
    const ack = { version: '3.0' as const, retryable: false, event_id: randomUUID(), claim_token: current.claim_token, attempt: current.attempt,
      instance_id: instance, epoch: resumed.epoch, status: 'done' as const,
      result: { output: { reply: 'stored ping', messages: [{ to: alias, body: 'fresh ping from agent' }],
        status: 'done', retryable: false, artifacts: [] } } };
    await repository.ackDelivery(current.delivery_id, 'Steven', 'argos', ack);
    await repository.ackDelivery(current.delivery_id, 'Steven', 'argos', ack);
    const mailbox = await first.operations.mailbox?.({});
    expect(mailbox?.items).toHaveLength(1);
    expect(mailbox?.items[0]).toMatchObject({ from: { alias: 'argos' }, text: 'fresh ping from agent', state: 'stored' });
    expect((await pool.query('SELECT * FROM delivery_acks WHERE delivery_id=$1', [mailbox?.items[0]?.delivery_id])).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM adapter_outbox WHERE delivery_id=$1 AND kind='wake'",
      [mailbox?.items[0]?.delivery_id])).rowCount).toBe(0);
  });

  it('stores agent roots without a consumer, ACK, wake or retained execution slot and returns them only to the connection', async () => {
    const { pool, first, alias, repository } = await fixture();
    const input = command(alias);
    const stored = await repository.publish(input, { agentRoot: true });
    expect(await repository.publish(input, { agentRoot: true })).toMatchObject({ message_id: stored.message_id, duplicate: true });
    const delivery = (await pool.query('SELECT * FROM deliveries WHERE id=$1', [stored.delivery_ids[0]])).rows[0] as Record<string, unknown>;
    expect(delivery).toMatchObject({ status: 'done', attempt: 0, consumer_instance_id: null, consumer_epoch: null,
      claim_token: null, result: { kind: 'client_mailbox', state: 'stored', label: 'Cronos', grant_id: first.identity.grantId } });
    expect((await pool.query('SELECT * FROM delivery_acks')).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM adapter_outbox WHERE adapter='gateway' AND kind='wake'")).rowCount).toBe(0);
    expect(await withTransaction(pool, client => openAgentRoots(client, 'Steven', 'argos'))).toEqual([]);
    expect(await first.operations.mailbox?.({})).toMatchObject({ label: 'Cronos',
      address: { tenant_id: 'Steven', alias }, reading_confirms_execution: false,
      items: [{ message_id: stored.message_id, from: { alias: 'argos' }, text: input.body.text, state: 'stored' }] });
    expect((await first.operations.inbox({})).mailbox?.items[0]?.message_id).toBe(stored.message_id);
    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 0, dead: 0, parked: 0 });
    await expect(repository.acquireLease('Steven', alias, 'fake-consumer', [], 10000)).rejects.toMatchObject({ code: 'invalid_actor' });
    expect((await pool.query('SELECT * FROM agents WHERE alias=$1', [alias])).rowCount).toBe(0);
    const list = await repository.listMessages('Steven', 'kant') as { items: { deliveries: unknown[] }[] };
    expect(list.items[0]?.deliveries[0]).toMatchObject({ client_mailbox: { label: 'Cronos', state: 'stored' } });
  });

  it('isolates grants with shared client id, humans with shared actor alias and rejects foreign mailbox cursors', async () => {
    const { pool, owner, first, alias, repository } = await fixture();
    await repository.publish(command(alias));
    await repository.publish(command(alias, 'second message'));
    const page = await first.operations.mailbox?.({ limit: 1 });
    expect(page?.next_cursor).toBeTruthy();
    const another = await connection(pool, owner);
    await ownedTransaction(pool, owner.humanId, client => mutateClientDelegation(client,
      { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias }, controlOptions,
      { operation: 'create', requestId: randomUUID(), label: 'Cronos', target: clientConnectionReference(issuer,
        controlOptions.resource, owner.humanId, 'Steven', another.identity.grantId) }));
    expect(await another.operations.mailbox?.({})).toMatchObject({ label: 'Cronos', items: [] });
    await expect(another.operations.mailbox?.({ cursor: page?.next_cursor ?? '' })).rejects.toMatchObject({ failure: { status_code: 400 } });
    const otherHuman = await seed(pool); const other = await connection(pool, otherHuman);
    const clients = (await pool.query<{ client_id: string }>('SELECT client_id FROM cauce_oauth_grants WHERE id=ANY($1::uuid[])',
      [[first.identity.grantId, other.identity.grantId]])).rows;
    expect(new Set(clients.map(row => row.client_id)).size).toBe(1);
    await ownedTransaction(pool, otherHuman.humanId, client => mutateClientDelegation(client,
      { humanId: otherHuman.humanId, tenantId: 'Steven', actorAlias: otherHuman.alias }, controlOptions,
      { operation: 'create', requestId: randomUUID(), label: 'Cronos', target: clientConnectionReference(issuer,
        controlOptions.resource, otherHuman.humanId, 'Steven', other.identity.grantId) }));
    expect(await other.operations.mailbox?.({})).toMatchObject({ label: 'Cronos', items: [] });
    await expect(other.operations.mailbox?.({ cursor: page?.next_cursor ?? '' })).rejects.toMatchObject({ failure: { status_code: 400 } });
    await expect(first.operations.receipt(page?.items[0]?.message_id ?? '')).rejects.toMatchObject({ failure: { status_code: 404 } });
    const next = await first.operations.mailbox?.({ cursor: page?.next_cursor ?? '' });
    expect(next?.items).toHaveLength(1);
    expect(next?.items[0]?.delivery_id).not.toBe(page?.items[0]?.delivery_id);
  });

  it('keeps stored messages and address across rename, closes on declaration revocation and grant revocation', async () => {
    const state = await fixture();
    await state.repository.publish(command(state.alias));
    const renamed = await ownedTransaction(state.pool, state.owner.humanId, client => mutateClientDelegation(client,
      { humanId: state.owner.humanId, tenantId: 'Steven', actorAlias: state.owner.alias }, controlOptions,
      { operation: 'rename', requestId: randomUUID(), label: 'Cronos v2', target: String(state.declaration.binding_id) }));
    expect(await state.first.operations.mailbox?.({})).toMatchObject({ label: 'Cronos v2', address: { alias: state.alias }, items: [{}] });
    await ownedTransaction(state.pool, state.owner.humanId, client => mutateClientDelegation(client,
      { humanId: state.owner.humanId, tenantId: 'Steven', actorAlias: state.owner.alias }, controlOptions,
      { operation: 'revoke', requestId: randomUUID(), target: String(renamed.binding_id) }));
    expect(await state.first.operations.mailbox?.({})).toBeNull();
    await expect(state.repository.publish(command(state.alias))).rejects.toMatchObject({ code: 'no_route' });
    expect((await state.pool.query('SELECT count(*)::integer AS n FROM deliveries')).rows[0]).toEqual({ n: 1 });
    await state.pool.query('INSERT INTO cauce_oauth_grant_revocations(grant_id) VALUES($1)',
      [state.first.identity.grantId]);
    await expect(state.first.operations.mailbox?.({})).rejects.toMatchObject({ failure: { status_code: 401 } });
  });

  it('rolls back oversized text and attachments, and does not authorize an invented mailbox address', async () => {
    const { repository, alias, pool } = await fixture();
    await expect(repository.publish(command(alias, 'x'.repeat(17000)))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repository.publish({ ...command(alias), body: { text: 'attachment', attachments_v1: [] } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repository.publish(command(clientMailboxAddress(randomUUID(), 'Steven')))).rejects.toMatchObject({ code: 'no_route' });
    expect((await pool.query('SELECT * FROM messages')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM idempotency_keys')).rowCount).toBe(0);
  });
});
