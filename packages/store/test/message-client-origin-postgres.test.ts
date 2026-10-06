import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientConnectionReference } from '../src/human-client-provenance.js';
import { putHumanClientProvenance } from '../src/human-client-provenance.js';
import { insertDelivery } from '../src/repository/messages/_insert.js';
import { lineageMessage, lineageRoot } from './human-message-lineage-postgres.fixtures.js';
import { database, seed, connection, ownedTransaction, controlOptions, issuer } from './human-client-provenance-postgres.fixtures.js';
import { mutateClientDelegation } from '../../../services/gateway/src/client-delegation-control.js';

const command = () => ({ request_key: randomUUID(), room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }],
  body: { text: 'synthetic client origin test', client_origin: { delegation_label: 'Forged' } } });

describe('console durable message client attribution', () => {
  it('projects the exact grant snapshot in list and detail and retains its historical label after rename and revoke', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const target = clientConnectionReference(issuer, controlOptions.resource, owner.humanId, 'Steven', c.identity.grantId);
    const mutate = (operation: 'create' | 'rename' | 'revoke', ref: string, label?: string) =>
      ownedTransaction(pool, owner.humanId, client => mutateClientDelegation(client,
        { humanId: owner.humanId, tenantId: 'Steven', actorAlias: owner.alias }, controlOptions,
        { operation, requestId: randomUUID(), target: ref, ...(label === undefined ? {} : { label }) }));
    const binding = await mutate('create', target, 'Cronos');
    const root = await c.operations.submit(command());
    const expected = { client: { kind: 'oauth_client', verification: 'local_grant', issuer,
      client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' }, delegation_label: 'Cronos' };
    const check = async () => {
      const detail = await c.repository.getMessage(root.message_id, 'Steven', owner.alias);
      const list = await c.repository.listMessages('Steven', owner.alias);
      const row = (list.items as Record<string, unknown>[]).find(item => item.message_id === root.message_id);
      expect(detail.client_origin).toEqual(expected); expect(row?.client_origin).toEqual(expected);
      expect(detail).toMatchObject({ actor_alias: 'kant', author: { kind: 'human', display_name: 'Fixture human' } });
      expect(JSON.stringify(detail.client_origin)).not.toContain(c.identity.grantId);
      expect(JSON.stringify(detail.client_origin)).not.toContain(owner.humanId);
    };
    await check();
    const renamed = await mutate('rename', String(binding.binding_id), 'Cronos v2');
    const renamedRoot = await c.operations.submit(command());
    expect((await c.repository.getMessage(renamedRoot.message_id, 'Steven', 'argos')).client_origin)
      .toEqual({ ...expected, delegation_label: 'Cronos v2' });
    await mutate('revoke', String(renamed.binding_id)); await check();
    const later = await c.operations.submit(command());
    expect((await c.repository.getMessage(later.message_id, 'Steven', owner.alias)).client_origin)
      .toEqual({ ...expected, delegation_label: null });
    const next = await connection(pool, owner);
    const reconsent = await next.operations.submit(command());
    expect((await next.repository.getMessage(reconsent.message_id, 'Steven', owner.alias)).client_origin)
      .toEqual({ ...expected, delegation_label: null });
  });

  it('keeps historical MCP clients unknown and does not infer clients from agent or direct console messages', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const client = await pool.connect();
    try {
      for (const channel of ['human-mcp', 'console', null]) {
        const id = await lineageMessage(client, 'Steven', channel);
        await client.query(`UPDATE messages SET body=$2::jsonb,origin=$3::jsonb WHERE id=$1`,
          [id, JSON.stringify({ text: 'Cronos', client_origin: { delegation_label: 'Cronos' } }),
            JSON.stringify({ client_origin: { delegation_label: 'Cronos' } })]);
        const expected = channel === 'human-mcp' ? { client: { kind: 'unknown' }, delegation_label: null } : null;
        expect((await c.repository.getMessage(id, 'Steven', owner.alias)).client_origin).toEqual(expected);
        const list = await c.repository.listMessages('Steven', owner.alias);
        expect((list.items as Record<string, unknown>[]).find(item => item.message_id === id)?.client_origin).toEqual(expected);
      }
    } finally { client.release(); }
  });

  it('projects a stored unknown root and ignores provenance on a direct console root', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const client = await pool.connect();
    try {
      for (const channel of ['human-mcp', 'console']) {
        const id = await lineageMessage(client, 'Steven', channel);
        const root = await lineageRoot(pool, owner.humanId, id);
        await putHumanClientProvenance(client, root, undefined);
        expect((await c.repository.getMessage(id, 'Steven', 'argos')).client_origin).toEqual(
          channel === 'human-mcp' ? { client: { kind: 'unknown' }, delegation_label: null } : null);
      }
    } finally { client.release(); }
  });

  it('withholds client metadata from another tenant even when that tenant can read the message', async () => {
    const pool = await database(); const owner = await seed(pool); const c = await connection(pool, owner);
    const root = await c.operations.submit(command());
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Jhon','hegel') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Jhon','grp.jhon','hegel','operator')
      ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET enabled=true,role=EXCLUDED.role`);
    await pool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_read)
      VALUES('Jhon','Steven',true,true) ON CONFLICT(from_tenant,to_tenant)
      DO UPDATE SET enabled=true,allow_read=true`);
    const client = await pool.connect();
    try { await insertDelivery(client, { messageId: root.message_id, recipientTenant: 'Jhon', recipientAlias: 'hegel' }); }
    finally { client.release(); }
    expect((await c.repository.getMessage(root.message_id, 'Steven', owner.alias)).client_origin).toMatchObject({
      client: { kind: 'oauth_client' } });
    const detail = await c.repository.getMessage(root.message_id, 'Jhon', 'hegel');
    expect(detail.client_origin).toBeNull();
    const list = await c.repository.listMessages('Jhon', 'hegel');
    expect((list.items as Record<string, unknown>[]).find(item => item.message_id === root.message_id)?.client_origin).toBeNull();
  });
});
