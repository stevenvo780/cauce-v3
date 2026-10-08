import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ClientDelegationLabelSchema, HUMAN_MESSAGE_INITIATOR_CAPABILITY, HUMAN_CLIENT_PROVENANCE_CAPABILITY,
  HUMAN_CLIENT_DELEGATION_CAPABILITY, DeliveryEnvelopeSchema } from '@cauce/protocol';
import { CauceRepository, type DatabasePool, loadHumanClientProvenance, putHumanClientProvenance, clientConnectionReference, clientMailboxAddress } from '@cauce/store';
import { database, seed, connection, consoleApp, ownedTransaction, controlOptions, issuer, verify } from '../../../packages/store/test/human-client-provenance-postgres.fixtures.js';
import { mutateClientDelegation } from './client-delegation-control.js';
import { lockOAuthAccess } from './oauth-grant-authority.js';
import { lineageMessage } from '../../../packages/store/test/human-message-lineage-postgres.fixtures.js';
import { putHumanMessageInitiator } from '../../../packages/store/src/repository/messages/human-initiators.js';
import { projectHumanClientProvenance } from '../../../packages/store/src/repository/deliveries/client-provenance.js';

const path = '/v3/console/mcp/client-delegations';
const command = (requestKey = randomUUID()) => ({ request_key: requestKey, room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }], body: { text: 'synthetic provenance test' } });
const metadata = (id: string, humanId: string, grantId: string) => ({ messageId: id, humanId,
  tenantId: 'Steven', conversationId: `fixture-${grantId}` });
const wireRef = (humanId: string, grantId: string) => clientConnectionReference(issuer, controlOptions.resource, humanId, 'Steven', grantId);
const declaration = async (pool: Awaited<ReturnType<typeof database>>, owner: Awaited<ReturnType<typeof seed>>,
  grantId: string, label = 'Dots') => ownedTransaction(pool, owner.humanId, client => mutateClientDelegation(client,
  { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias }, controlOptions,
  { operation: 'create', requestId: randomUUID(), target: wireRef(owner.humanId, grantId), label }));

describe('durable human client provenance', () => {
  it('selects the exact verified grant, ignores body hints and preserves the first root after reconsent', async () => {
    const pool = await database(); const owner = await seed(pool);
    const first = await connection(pool, owner); const second = await connection(pool, owner);
    const firstRef = await first.operations.connectionIdentity?.(); const secondRef = await second.operations.connectionIdentity?.();
    expect(firstRef).not.toEqual(secondRef);
    expect(JSON.stringify(firstRef)).not.toContain(first.identity.grantId);
    await declaration(pool, owner, first.identity.grantId);
    const input = { ...command(), body: { text: 'synthetic provenance test', client_id: 'Forged', client_label: 'Imposter' } };
    const receipt = await first.operations.submit(input);
    const retry = await second.operations.submit(input);
    expect(retry.message_id).toBe(receipt.message_id);
    const stored = (await pool.query<{ local_oauth_grant_id: string; initiating_human_id: string }>('SELECT * FROM human_message_client_provenance WHERE root_message_id=$1', [receipt.message_id])).rows[0];
    expect(stored).toMatchObject({ local_oauth_grant_id: first.identity.grantId, initiating_human_id: owner.humanId });
    const client = await pool.connect();
    try { expect(await loadHumanClientProvenance(client, receipt.message_id)).toMatchObject({
      client: { client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' }, declaration: { label: 'Dots' } }); }
    finally { client.release(); }
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM messages')).rows[0]?.n).toBe(1);
  });

  it('keeps label creation, rename, revoke and lost-response retries atomic and owner-only', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const other = await seed(pool); const otherConnection = await connection(pool, other);
    const web = await consoleApp(pool, owner); const otherWeb = await consoleApp(pool, other);
    const payload = { request_id: randomUUID(), connection_ref: wireRef(owner.humanId, c.identity.grantId), label: 'Dots' };
    const send = () => web.app.inject({ method: 'POST', url: path, headers: web.headers, payload });
    const created = await send(); expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ label: 'Dots', display_label: 'Dots por cuenta de Fixture human' });
    expect((await send()).json()).toEqual(created.json());
    expect((await otherWeb.app.inject({ method: 'POST', url: path, headers: otherWeb.headers, payload })).statusCode).toBe(404);
    expect((await web.app.inject({ method: 'POST', url: path, headers: web.headers,
      payload: { ...payload, label: 'Other' } })).statusCode).toBe(409);
    const list = await web.app.inject({ url: path, headers: web.headers });
    expect(list.statusCode).toBe(200); expect(JSON.stringify(list.json())).not.toContain(otherConnection.identity.grantId);
    expect(list.json<{ items: { connection_ref: string }[] }>().items.map(x => x.connection_ref)).toEqual([payload.connection_ref]);
    expect(list.json<{ items: { mailbox: unknown }[] }>().items.map(x => x.mailbox))
      .toEqual([{ tenant_id: 'Steven', alias: clientMailboxAddress(c.identity.grantId, 'Steven') }]);
    const root = await c.operations.submit(command());
    const binding = created.json<{ binding_id: string }>().binding_id;
    const renamePayload = { request_id: randomUUID(), label: 'Dots v2' };
    const renamed = await web.app.inject({ method: 'POST', url: `${path}/${binding}/rename`, headers: web.headers, payload: renamePayload });
    expect(renamed.statusCode).toBe(200);
    expect((await web.app.inject({ method: 'POST', url: `${path}/${binding}/rename`, headers: web.headers, payload: renamePayload })).json()).toEqual(renamed.json());
    expect((await web.app.inject({ method: 'POST', url: `${path}/${binding}/rename`, headers: web.headers,
      payload: { ...renamePayload, request_id: randomUUID() } })).statusCode).toBe(409);
    const newBinding = renamed.json<{ binding_id: string }>().binding_id;
    expect((await web.app.inject({ method: 'POST', url: `${path}/${newBinding}/revoke`, headers: web.headers,
      payload: { request_id: randomUUID() } })).statusCode).toBe(200);
    expect((await web.app.inject({ url: path, headers: web.headers })).json<{ items: { mailbox: unknown }[] }>()
      .items.map(x => x.mailbox)).toEqual([null]);
    const client = await pool.connect();
    try { expect((await loadHumanClientProvenance(client, root.message_id)).declaration?.label).toBe('Dots'); }
    finally { client.release(); }
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM human_client_delegation_operations')).rows[0]?.n).toBe(3);
    expect((await pool.query<{ n: number }>("SELECT count(*)::integer AS n FROM audit_events WHERE action LIKE 'mcp.client_delegation.%'")).rows[0]?.n).toBe(3);
  });

  it('requires a console cookie, same origin and CSRF and rejects bearer self-declaration', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const web = await consoleApp(pool, owner);
    const payload = { request_id: randomUUID(), connection_ref: wireRef(owner.humanId, c.identity.grantId), label: 'Dots' };
    for (const headers of [{ origin: issuer }, { ...web.headers, 'x-csrf-token': '' },
      { ...web.headers, origin: 'https://evil.example' }, { ...web.headers, authorization: 'Bearer synthetic' },
      { cookie: web.headers.cookie, 'x-csrf-token': web.headers['x-csrf-token'] }]) {
      expect((await web.app.inject({ method: 'POST', url: path, headers, payload })).statusCode).toBe(403);
    }
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM human_oauth_client_delegations')).rows[0]?.n).toBe(0);
  });

  it('does not inherit a declaration on a new grant and rejects changed owner credentials', async () => {
    const pool = await database(); const owner = await seed(pool); const first = await connection(pool, owner);
    await declaration(pool, owner, first.identity.grantId);
    const next = await connection(pool, owner); const receipt = await next.operations.submit(command());
    const client = await pool.connect();
    try { expect((await loadHumanClientProvenance(client, receipt.message_id)).declaration).toBeUndefined(); }
    finally { client.release(); }
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [owner.humanId]);
    await expect(first.operations.submit(command())).rejects.toMatchObject({ failure: { status_code: 401 } });
  });

  it('blocks mutation and populated TRUNCATE of every new durable table, including CASCADE', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    await declaration(pool, owner, c.identity.grantId); await c.operations.submit(command());
    for (const table of ['human_message_client_provenance', 'human_oauth_client_delegations', 'human_client_delegation_operations']) {
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow('permanent');
      await expect(pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow('permanent');
    }
    await expect(pool.query('UPDATE human_message_client_provenance SET local_oauth_grant_id=NULL')).rejects.toThrow('permanent');
    await expect(pool.query("UPDATE human_oauth_client_delegations SET label='Forged'")).rejects.toThrow('permanent');
    await expect(pool.query("UPDATE human_client_delegation_operations SET request_hash=repeat('a',64)")).rejects.toThrow('permanent');
  });

  it('enforces grant owner and self-root foreign keys and rolls back failed roots', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const other = await seed(pool); const wrong = await connection(pool, other);
    const badRoot = async (grantId: string, child = false) => ownedTransaction(pool, owner.humanId, async client => {
      const root = await lineageMessage(client); const id = child ? await lineageMessage(client) : root;
      await putHumanMessageInitiator(client, { ...metadata(root, owner.humanId, grantId), messageTenantId: 'Steven', rootMessageId: root });
      if (child) await putHumanMessageInitiator(client, { ...metadata(id, owner.humanId, grantId), messageTenantId: 'Steven', rootMessageId: root });
      await putHumanClientProvenance(client, metadata(id, owner.humanId, grantId), { kind: 'oauth_client',
        verification: 'local_grant', issuer, clientId: 'https://chatgpt.com/oauth/client.json', grantId, instance: 'unknown' });
    });
    await expect(badRoot(wrong.identity.grantId)).rejects.toThrow('foreign key');
    await expect(badRoot(c.identity.grantId, true)).rejects.toThrow('foreign key');
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM messages')).rows[0]?.n).toBe(0);
  });

  it('preserves existing nonblocking grant revocation and historical provenance', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const receipt = await c.operations.submit(command());
    const client = await pool.connect(); await client.query('BEGIN');
    try {
      const proof = await lockOAuthAccess(client, c.identity, issuer, c.identity.audience, verify);
      await pool.query("SET statement_timeout='2000ms'");
      await pool.query('INSERT INTO cauce_oauth_grant_revocations(grant_id) VALUES($1)', [c.identity.grantId]);
      expect(proof).toMatchObject({ grantId: c.identity.grantId });
      expect((await loadHumanClientProvenance(client, receipt.message_id)).client.kind).toBe('oauth_client');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await expect(c.operations.connectionIdentity?.()).rejects.toMatchObject({ failure: { status_code: 401 } });
    await expect(c.operations.submit(command())).rejects.toMatchObject({ failure: { status_code: 401 } });
  });

  it('projects each capability independently, follows lineage and leaves claim eligibility unchanged', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    await declaration(pool, owner, c.identity.grantId); const receipt = await c.operations.submit(command());
    const client = await pool.connect();
    try {
      const root = (await client.query<{ conversation_id: string }>('SELECT * FROM human_message_initiators WHERE message_id=$1', [receipt.message_id])).rows[0];
      if (!root) throw new Error('missing root initiator');
      const child = await lineageMessage(client);
      await putHumanMessageInitiator(client, { messageId: child, messageTenantId: 'Steven', humanId: owner.humanId,
        tenantId: 'Steven', rootMessageId: receipt.message_id, conversationId: root.conversation_id });
      const rows = [{ id: randomUUID(), message_id: child }];
      expect((await projectHumanClientProvenance(client, rows, [], 'Steven')).size).toBe(0);
      const projection = (await projectHumanClientProvenance(client, rows, [HUMAN_CLIENT_PROVENANCE_CAPABILITY,
        HUMAN_CLIENT_DELEGATION_CAPABILITY], 'Steven')).get(rows[0]?.id ?? '');
      expect(projection).not.toHaveProperty('human_initiator');
      expect(projection?.human_client_provenance?.root_message_id).toBe(receipt.message_id);
      expect(projection?.human_client_delegation?.label).toBe('Dots');
      expect(JSON.stringify(projection)).not.toContain(c.identity.grantId);
    } finally { client.release(); }
    const instance = 'owned-test-client';
    const lease = await c.repository.acquireLease('Steven', 'argos', instance, [HUMAN_MESSAGE_INITIATOR_CAPABILITY], 30000);
    if (!lease.epoch || !lease.connection_token) throw new Error('missing fixture lease');
    const rolledBack = rollbackClaims(pool);
    const claimed = await rolledBack.claimDeliveries('Steven', 'argos', instance, lease.epoch, 10, 30000,
      3, {}, lease.connection_token);
    expect(claimed.map(row => row.message_id)).toEqual([receipt.message_id]);
    expect(claimed[0]).not.toHaveProperty('human_client_provenance');
    expect(DeliveryEnvelopeSchema.safeParse(claimed[0]).success).toBe(true);
    const resumed = await c.repository.acquireLease('Steven', 'argos', instance, [HUMAN_MESSAGE_INITIATOR_CAPABILITY,
      HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY], 30000, { resume: true });
    if (!resumed.epoch || !resumed.connection_token) throw new Error('missing resumed fixture lease');
    const enriched = await c.repository.claimDeliveries('Steven', 'argos', instance, resumed.epoch, 10, 30000,
      3, {}, resumed.connection_token);
    expect(enriched.map(row => row.delivery_id)).toEqual(claimed.map(row => row.delivery_id));
    expect(enriched[0]?.human_client_delegation?.label).toBe('Dots');
    expect(enriched[0]?.human_client_provenance?.root_message_id).toBe(receipt.message_id);
    expect(DeliveryEnvelopeSchema.safeParse(enriched[0]).success).toBe(true);
  });

  it('captures unknown external OAuth and preserves legacy unknown without backfill', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const external = await c.factory.forRequest({ kind: 'oauth', issuer, subject: owner.humanId,
      audience: c.identity.audience, expiresAt: c.identity.expiresAt, scopes: c.identity.scopes }, new AbortController().signal);
    expect(await external.connectionIdentity?.()).toEqual({ client: { kind: 'unknown' }, connection_ref: null, expires_at: null });
    const receipt = await external.submit(command());
    const client = await pool.connect();
    try {
      expect(await loadHumanClientProvenance(client, receipt.message_id)).toEqual({ client: { kind: 'unknown' } });
      expect(await loadHumanClientProvenance(client, randomUUID())).toEqual({ client: { kind: 'unknown' } });
      const project = (messageId: string) => projectHumanClientProvenance(client,
        [{ id: messageId, message_id: messageId }], [HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY], 'Steven');
      expect((await project(receipt.message_id)).get(receipt.message_id)).toEqual({
        human_client_provenance: { root_message_id: receipt.message_id, client: { kind: 'unknown' } },
      });
      const historical = await lineageMessage(client, 'Steven', 'human-mcp');
      await putHumanMessageInitiator(client, { messageId: historical, messageTenantId: 'Steven', humanId: owner.humanId,
        tenantId: 'Steven', rootMessageId: historical, conversationId: 'historical-mcp' });
      expect((await project(historical)).get(historical)).toEqual({
        human_client_provenance: { root_message_id: historical, client: { kind: 'unknown' } },
      });
      expect((await client.query('SELECT * FROM human_message_client_provenance WHERE root_message_id=$1', [historical])).rowCount).toBe(0);
      const consoleRoot = await lineageMessage(client, 'Steven', 'console');
      const consoleIdentity = { messageId: consoleRoot, messageTenantId: 'Steven', humanId: owner.humanId,
        tenantId: 'Steven', rootMessageId: consoleRoot, conversationId: 'historical-console' };
      await putHumanMessageInitiator(client, consoleIdentity);
      await putHumanClientProvenance(client, consoleIdentity, undefined);
      const misleadingChild = await lineageMessage(client, 'Steven', 'human-mcp');
      await putHumanMessageInitiator(client, { ...consoleIdentity, messageId: misleadingChild });
      expect((await project(consoleRoot)).get(consoleRoot)).toEqual({});
      expect((await project(misleadingChild)).get(misleadingChild)).toEqual({});
      expect((await client.query('SELECT * FROM human_message_client_provenance WHERE root_message_id=$1', [consoleRoot])).rowCount).toBe(1);
    } finally { client.release(); }
  });

  it('serializes simultaneous owner declarations and rolls back a rename with its audit and receipt', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const create = () => declaration(pool, owner, c.identity.grantId);
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const binding = (await pool.query<{ id: string }>('SELECT id FROM human_oauth_client_delegations WHERE revoked_at IS NULL')).rows[0];
    if (!binding) throw new Error('missing active declaration');
    await expect(ownedTransaction(pool, owner.humanId, async client => {
      await mutateClientDelegation(client, { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias },
        controlOptions, { operation: 'rename', requestId: randomUUID(), target: binding.id, label: 'Dots v2' });
      throw new Error('synthetic crash before commit');
    })).rejects.toThrow('synthetic crash');
    expect((await pool.query<{ label: string }>('SELECT label FROM human_oauth_client_delegations WHERE revoked_at IS NULL')).rows)
      .toEqual([{ label: 'Dots' }]);
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM human_client_delegation_operations')).rows[0]?.n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::integer AS n FROM audit_events WHERE action LIKE 'mcp.client_delegation.%'")).rows[0]?.n).toBe(1);
  });

  it('keeps the authenticated OAuth revoke path nonblocking while a label transaction holds its owner and grant locks', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    await ownedTransaction(pool, owner.humanId, async client => {
      await mutateClientDelegation(client, { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias },
        controlOptions, { operation: 'create', requestId: randomUUID(), target: wireRef(owner.humanId, c.identity.grantId), label: 'Dots' });
      await owner.store.revoke(c.identity.grantId, owner.session,
        { signal: new AbortController().signal, deadlineMs: Date.now() + 2000 });
    });
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM cauce_oauth_grant_revocations')).rows[0]?.n).toBe(1);
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM human_oauth_client_delegations')).rows[0]?.n).toBe(1);
    await expect(c.operations.submit(command())).rejects.toMatchObject({ failure: { status_code: 401 } });
  });

  it('allows an empty down migration and refuses any destructive rollback once history exists', async () => {
    const pool = await database();
    const down = await readFile(new URL('../../../packages/store/migrations/down/046_human_client_provenance.sql', import.meta.url), 'utf8');
    const up = await readFile(new URL('../../../packages/store/migrations/046_human_client_provenance.sql', import.meta.url), 'utf8');
    await pool.query(down); await pool.query(up);
    const owner = await seed(pool); const c = await connection(pool, owner);
    await declaration(pool, owner, c.identity.grantId);
    await expect(pool.query(down)).rejects.toThrow('populated provenance schema cannot be removed');
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM human_oauth_client_delegations')).rows[0]?.n).toBe(1);
  });

  it('rejects hostile labels equally in protocol and PostgreSQL', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    for (const label of ['', ' Dots', 'Dots ', 'Dots\n', 'Do\u202ets', 'Dóts', 'Do\u0301ts', '<script>', 'x'.repeat(129), 'Dots\u0001']) {
      expect(ClientDelegationLabelSchema.safeParse(label).success).toBe(false);
      await expect(pool.query(`INSERT INTO human_oauth_client_delegations(local_oauth_grant_id,human_id,tenant_id,declared_by_human_id,label)
        VALUES($1,$2,'Steven',$2,$3)`, [c.identity.grantId, owner.humanId, label])).rejects.toThrow('check constraint');
    }
    expect(ClientDelegationLabelSchema.safeParse('Dots').success).toBe(true);
  });
});

function rollbackClaims(pool: DatabasePool): CauceRepository {
  const proxy = new Proxy(pool, { get(target, field) {
    if (field === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === 'query') return (sql: string, values?: unknown[]) => connection.query(sql === 'COMMIT' ? 'ROLLBACK' : sql, values);
        const member: unknown = Reflect.get(connection, property);
        return typeof member === 'function' ? member.bind(connection) as unknown : member;
      } });
    };
    const member: unknown = Reflect.get(target, field);
    return typeof member === 'function' ? member.bind(target) as unknown : member;
  } });
  return new CauceRepository(proxy);
}
