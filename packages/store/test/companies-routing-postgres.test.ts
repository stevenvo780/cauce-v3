import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, withTransaction, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { clientMailboxAddress, clientMailboxRoutingTargets } from '../src/client-mailbox.js';
import { hubEdgeExistsSql, tenantReadableSql } from '../src/repository/acl-edges.js';
import { assertPublishRoute } from '../src/repository/config/publish-policy.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { linkCompanies, seedCompanyActors, seedCompanyFanin, seedCompanyHuman } from './companies-postgres.fixtures.js';
import { agentFaninWithheldText } from '../src/repository/agents/fanin/helpers.js';
import { routingAuthority } from '../../../services/gateway/src/terminal/authority.js';

class CompanyRoutingRepository extends CauceRepository {
  targets(client: DatabaseClient) { return this.routingTargets(client, 'Steven', 'company_admin'); }
  fanin(client: DatabaseClient, root: string) { return this.materializeAgentFanin(client, root); }
}
async function mailbox(tenant: string): Promise<string> {
  const human = await seedCompanyHuman(pool, tenant); const grant = randomUUID();
  const issuer = 'https://issuer.example.test';
  await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
    VALUES($1::uuid,'oauth',$2,$1::uuid::text)`, [human, issuer]);
  await pool.query(`INSERT INTO cauce_oauth_grants(id,human_id,issuer,resource,client_id,redirect_uri,
    scopes,binding_id,binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp,expires_at)
    SELECT $1,e.human_id,$2,$2||'/mcp','https://client.example.test','https://client.example.test/callback',
      ARRAY['cauce.read'],e.id,e.revision,m.revision,m.tenant_id,m.actor_alias,repeat('a',43),now()+interval '1 hour'
    FROM human_external_identities e JOIN human_tenant_memberships m ON m.human_id=e.human_id
    WHERE e.human_id=$3`, [grant, issuer, human]);
  await pool.query(`INSERT INTO human_oauth_client_delegations(local_oauth_grant_id,human_id,tenant_id,declared_by_human_id,label)
    VALUES($1,$2,$3,$2,'Company mailbox')`, [grant, human, tenant]);
  return clientMailboxAddress(grant, tenant);
}

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await seedCompanyActors(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('company-aware runtime routes', () => {
  it('rechecks a link for routing, control and readable ACL edges after revocation', async () => {
    const command = { tenant_id: 'Steven', room_id: 'company-humanizar', actor_alias: 'company_admin',
      recipients: [{ tenant_id: 'PraxisHub', alias: 'company_admin' }] };
    await expect(withTransaction(pool, client => assertPublishRoute(client, command, true))).rejects.toMatchObject({ code: 'forbidden' });
    await linkCompanies(pool);
    await withTransaction(pool, client => assertPublishRoute(client, command, true));
    expect((await pool.query(hubEdgeExistsSql('allow_control', 1, 2), ['Steven', 'PraxisHub'])).rowCount).toBe(1);
    const readable = (): Promise<{ rows: { visible: boolean }[] }> => pool.query(
      `SELECT ${tenantReadableSql('$1::text', '$2::text')} AS visible`, ['Steven', 'PraxisHub']);
    expect((await readable()).rows).toEqual([{ visible: true }]);
    await pool.query('DELETE FROM company_links');
    expect((await pool.query(hubEdgeExistsSql('allow_control', 1, 2), ['Steven', 'PraxisHub'])).rowCount).toBe(0);
    expect((await readable()).rows).toEqual([{ visible: false }]);
    await expect(withTransaction(pool, client => assertPublishRoute(client, command, true))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT from_tenant,enabled FROM acl_edges WHERE to_tenant='PraxisHub'")).rows)
      .toEqual([{ from_tenant: 'Steven', enabled: false }]);
  });
  it('withdraws terminal control and foreign message detail together with the link', async () => {
    await linkCompanies(pool); await seedCompanyFanin(pool);
    const response = (await pool.query<{ id: string }>("SELECT id FROM messages WHERE body->>'type'='agent.response'")).rows[0]?.id;
    if (!response) throw new Error('response absent');
    const repository = new CauceRepository(pool);
    const terminal = () => routingAuthority(pool, 'Steven', 'company_admin', 'PraxisHub', 'company_admin');
    expect(await terminal()).toMatchObject({ allowed: true, reason: 'acl_edge' });
    expect(await repository.getMessage(response, 'Steven', 'company_admin')).toHaveProperty('tenant_id', 'PraxisHub');
    await pool.query('DELETE FROM company_links');
    expect(await terminal()).toMatchObject({ allowed: false, reason: 'acl_edge_missing' });
    await expect(repository.getMessage(response, 'Steven', 'company_admin')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('limits administrative failure detail to the hub of the notice company', async () => {
    const notice = (await pool.query<{ id: string }>(`INSERT INTO agent_failure_notices(root_message_id,parent_tenant,parent_alias,
      child_tenant,child_alias,failure_signature,window_expires_at) VALUES($1,'Steven','kant','Isa','salva','fixture',now()+interval '1 hour')
      RETURNING id::text`, [randomUUID()])).rows[0];
    if (!notice) throw new Error('notice absent');
    const repository = new CauceRepository(pool);
    expect(await repository.failureNoticeDetail(notice.id, 'Steven', 'company_admin')).toHaveProperty('notice');
    await expect(repository.failureNoticeDetail(notice.id, 'PraxisHub', 'company_admin')).rejects.toMatchObject({ code: 'not_found' });
    const orphan = (await pool.query<{ id: string }>(`INSERT INTO agent_failure_notices(root_message_id,parent_tenant,parent_alias,
      child_tenant,child_alias,failure_signature,window_expires_at) VALUES($1,'DeletedTenant','kant','Isa','salva','fixture',now()+interval '1 hour')
      RETURNING id::text`, [randomUUID()])).rows[0];
    if (!orphan) throw new Error('orphan notice absent');
    expect(await repository.failureNoticeDetail(orphan.id, 'Steven', 'company_admin')).toHaveProperty('notice');
    await expect(repository.failureNoticeDetail(orphan.id, 'PraxisHub', 'company_admin')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('withdraws topology and agent and mailbox inventories when a company link is removed', async () => {
    const ownMailbox = await mailbox('Steven'); const foreignMailbox = await mailbox('PraxisHub');
    const repository = new CompanyRoutingRepository(pool);
    await linkCompanies(pool);
    const inventories = () => withTransaction(pool, async client => ({
      agents: await repository.targets(client), mailboxes: await clientMailboxRoutingTargets(client, 'Steven'),
    }));
    const linked = await inventories();
    expect(linked.agents).toContainEqual(expect.objectContaining({ tenant_id: 'PraxisHub' }));
    expect(linked.mailboxes.map(row => row.alias)).toEqual([foreignMailbox, ownMailbox]);
    expect((await repository.topology('Steven', 'company_admin')).tenants)
      .toContainEqual(expect.objectContaining({ id: 'PraxisHub' }));
    await pool.query('DELETE FROM company_links');
    const revoked = await inventories();
    expect(revoked.agents).not.toContainEqual(expect.objectContaining({ tenant_id: 'PraxisHub' }));
    expect(revoked.mailboxes.map(row => row.alias)).toEqual([ownMailbox]);
    const topology = await repository.topology('Steven', 'company_admin');
    expect(topology.tenants).not.toContainEqual(expect.objectContaining({ id: 'PraxisHub' }));
    expect(topology.acl_edges).not.toContainEqual(expect.objectContaining({ to_tenant: 'PraxisHub' }));
  });
  it('withholds a foreign response when the link is revoked before fanin materialization', async () => {
    await linkCompanies(pool); const root = await seedCompanyFanin(pool);
    await pool.query('DELETE FROM company_links');
    const repository = new CompanyRoutingRepository(pool);
    expect(await withTransaction(pool, client => repository.fanin(client, root))).toEqual({ hasFanout: true, scheduled: true });
    const message = (await pool.query<{ body: unknown }>(`SELECT body FROM messages
      WHERE body->>'type'='agent.fanin' AND body->'correlation'->>'root_message_id'=$1`, [root])).rows[0];
    expect(message?.body).toHaveProperty('fanin_data_v1.responses.0.untrusted_text', agentFaninWithheldText);
    expect(JSON.stringify(message?.body)).not.toContain('Foreign branch result');
  });
  it('holds the company link until committing a fanin that includes foreign text', async () => {
    await linkCompanies(pool); const root = await seedCompanyFanin(pool);
    const writer = await pool.connect(); const revoker = await pool.connect();
    let revocation: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN'); await revoker.query('BEGIN');
      const pid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (!pid) throw new Error('revoker backend absent');
      await new CompanyRoutingRepository(pool).fanin(writer, root);
      revocation = revoker.query('DELETE FROM company_links');
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1))>0 AS waiting', [pid])).rows[0]?.waiting, { timeout: 1500 }).toBe(true);
      await writer.query('COMMIT'); await revocation; await revoker.query('COMMIT');
      const message = (await pool.query<{ body: unknown }>(`SELECT body FROM messages
        WHERE body->>'type'='agent.fanin' AND body->'correlation'->>'root_message_id'=$1`, [root])).rows[0];
      expect(message?.body).toHaveProperty('fanin_data_v1.responses.0.untrusted_text', 'Foreign branch result');
      expect((await pool.query('SELECT 1 FROM company_links')).rowCount).toBe(0);
    } finally {
      await writer.query('ROLLBACK'); await revocation; await revoker.query('ROLLBACK');
      writer.release(); revoker.release();
    }
  });
});
