import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { AgentPreferencesStore, CauceRepository, withTransaction, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { containerCohort, loadFleetPlacements, routingAuthority } from '../../../services/gateway/src/terminal/authority.js';
import { FleetReadModel } from '../../mcp-fleet-monitor/src/fleet-read-model.js';

/*
 * Canary of two companies that reuse the same quota host and the same container name. Traffic crossed
 * them under a link; the link is gone but the edge pair Steven<->PraxisHub is enabled again behind the
 * star guard, as a broken invariant would leave it. No read may cross; with a link the same reads do.
 */

const MONITOR_DIRECTORY = fileURLToPath(new URL('../../mcp-fleet-monitor/', import.meta.url));
const MONITOR_SERVER = fileURLToPath(new URL('../../mcp-fleet-monitor/src/server.ts', import.meta.url));

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let pool: DatabasePool;
let repository: CauceRepository;
let people: CompanyIsolationFixture;
let praxis: PraxisTraffic;

interface PraxisTraffic { inbound: string; internal: string; notice: string; orphan: string }

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  admin = current.adminPool; pool = current.pool; repository = new CauceRepository(pool);
  people = await seedCompanyIsolation(admin);
  praxis = await seedPraxisTraffic();
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function inserted(sql: string, params: unknown[]): Promise<string> {
  const id = (await admin.query<{ id: string }>(sql, params)).rows[0]?.id;
  if (id === undefined) throw new Error('fixture row absent');
  return id;
}
async function message(tenant: string, room: string, alias: string, trace: string = randomUUID()): Promise<string> {
  return inserted(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES($1,$2,$3,$4,$5,'{"text":"company canary"}'::jsonb,'batch') RETURNING id::text`,
  [randomUUID(), trace, tenant, room, alias]);
}
async function delivery(messageId: string, tenant: string, alias: string, status = 'pending'): Promise<string> {
  return inserted(`INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,terminal_at)
    VALUES($1,$2,$3,$4,CASE WHEN $4='done' THEN now() END) RETURNING id::text`, [messageId, tenant, alias, status]);
}
async function chainEdge(source: [string, string, string], target: [string, string]): Promise<void> {
  const [sourceTenant, room, sourceAlias] = source;
  const root = await message(sourceTenant, room, sourceAlias, 'shared-trace');
  const sourceDelivery = await delivery(root, sourceTenant, sourceAlias, 'done');
  const produced = await message(sourceTenant, room, sourceAlias, 'shared-trace');
  const producedDelivery = await delivery(produced, target[0], target[1]);
  await admin.query(`INSERT INTO agent_output_materializations(source_delivery_id,source_attempt,output_index,
    source_message_id,source_tenant,source_alias,target_tenant,target_alias,target_ref_hash,body_hash,status,
    produced_message_id,produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation)
    VALUES($1,1,0,$2,$3,$4,$5,$6,repeat('a',64),repeat('a',64),'materialized',$7,$8,$9,'shared-trace',1,8,$10::jsonb)`,
  [sourceDelivery, root, sourceTenant, sourceAlias, target[0], target[1], produced, producedDelivery, randomUUID(),
    JSON.stringify({ root_message_id: root })]);
}
let clock = Date.now() - 3_600_000;
function sample(host: string, account: string, remaining: number): QuotaSampleRequest {
  clock += 60_000;
  return { schema_version: 2, host, captured_at: new Date(clock).toISOString(),
    providers: [{ provider: 'codex', ok: true, available: true, available_groups: [], limiting_groups: [],
      windows: [{ group_key: 'default', window_key: 'week', remaining_percent: remaining, account_id: account,
        reset_at: new Date(Date.now() + 86_400_000).toISOString() }] }] };
}

/** Every surface gets one Praxis row a careless read would return to a Humanizar operator. */
async function seedPraxisTraffic(): Promise<PraxisTraffic> {
  await link();
  await admin.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
    VALUES('Steven','PraxisHub',true,true,true,true),('PraxisHub','Steven',true,true,true,true)`);
  const foreign = await message('PraxisHub', 'company-praxis', 'company_admin');
  const inbound = await delivery(foreign, 'Steven', 'kant');
  await admin.query(`INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,payload)
    SELECT 'PraxisHub','telegram','origin_relay',$1,request_id,id,$2,trace_id,'{}'::jsonb FROM messages WHERE id=$3`,
  [randomUUID(), inbound, foreign]);
  await admin.query('DELETE FROM company_links');
  await withTransaction(admin, async (client) => {
    await client.query('ALTER TABLE acl_edges DISABLE TRIGGER USER');
    await client.query("UPDATE acl_edges SET enabled=true WHERE 'PraxisHub' IN (from_tenant,to_tenant)");
    await client.query('ALTER TABLE acl_edges ENABLE TRIGGER USER');
  });
  const internal = await delivery(await message('PraxisHub', 'company-praxis', 'company_admin'), 'PraxisHub', 'company_admin');
  await admin.query("UPDATE deliveries SET status='leased',claimed_at=now() WHERE id=$1", [internal]);
  await chainEdge(['PraxisHub', 'company-praxis', 'company_admin'], ['PraxisTeam', 'team_agent']);
  await chainEdge(['Steven', 'company-humanizar', 'company_admin'], ['Steven', 'kant']);
  const notice = async (parent: string, child: string): Promise<string> => inserted(`INSERT INTO agent_failure_notices(
    root_message_id,parent_tenant,parent_alias,child_tenant,child_alias,failure_signature,window_expires_at)
    VALUES($1,$2,'company_admin',$3,'team_agent','canary',now()+interval '1 hour') RETURNING id::text`, [randomUUID(), parent, child]);
  await repository.acquireLease('PraxisHub', 'company_admin', 'praxis-runtime', ['jobs'], 600_000);
  await repository.acquireLease('Steven', 'kant', 'humanizar-runtime', [], 600_000);
  const preferences = new AgentPreferencesStore(pool);
  await preferences.setAppearance({ tenant_id: 'PraxisHub', alias: 'company_admin', glyph: null, hue: 30, style: 'orb',
    expected_revision: null }, { tenant_id: 'PraxisHub', alias: 'company_admin', display: 'Leon' });
  await preferences.addFavorite(people.leon, 'PraxisHub', 'PraxisHub', 'company_admin');
  await preferences.addFavorite(people.steven, 'Steven', 'Steven', 'kant');
  await repository.recordQuotaSample('PraxisHub', 'company_admin', sample('shared-quota', 'praxis-account', 0));
  await repository.recordQuotaSample('Steven', 'kant', sample('shared-quota', 'humanizar-account', 60));
  return { inbound, internal, notice: await notice('PraxisHub', 'PraxisTeam'), orphan: await notice('GoneTenant', 'Isa') };
}

async function link(): Promise<void> {
  await admin.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [people.steven]);
}

/** What Steven/kant can read on every fleet surface, serialized to search for any Praxis identity. */
async function humanizarView(): Promise<Record<string, string>> {
  const reads: Record<string, unknown> = {
    quotas: await repository.quotaSnapshot('Steven', 'kant'),
    agents: await repository.listAgents('Steven', 'kant'),
    agent: await repository.getAgentByIdentity('PraxisHub', 'company_admin', 'Steven', 'kant') ?? null,
    presence: await repository.listPresence('Steven', 'kant'),
    adapters: await repository.listAdapters('Steven', 'kant'),
    queue: await repository.queueSnapshot('Steven', 'kant'),
    relays: await repository.listOriginRelays('Steven', 'kant'),
    activity: await repository.fleetActivity('Steven', 'kant'),
    appearances: await new AgentPreferencesStore(pool).listAppearances('Steven'),
  };
  return Object.fromEntries(Object.entries(reads).map(([surface, read]) => [surface, JSON.stringify(read)]));
}

describe('company read isolation', () => {
  it('returns no row of an unlinked company on any fleet read, and the same reads cross once linked', async () => {
    for (const [surface, read] of Object.entries(await humanizarView())) {
      expect(read, surface).not.toMatch(/Praxis|praxis/u);
      expect(read, surface).not.toContain(praxis.inbound);
    }
    await link();
    const linked = await humanizarView();
    for (const surface of ['quotas', 'agents', 'agent', 'presence', 'adapters', 'activity', 'appearances']) {
      expect(linked[surface], surface).toContain('PraxisHub');
    }
    for (const surface of ['queue', 'relays']) expect(linked[surface], surface).toContain(praxis.inbound);
  });

  it('keeps favorites inside the company of the person and of the viewer', async () => {
    const preferences = new AgentPreferencesStore(pool);
    expect(await preferences.listFavorites(people.leon, 'Steven')).toEqual([]);
    expect((await preferences.listFavorites(people.leon, 'PraxisHub')).map((row) => row.tenant_id)).toEqual(['PraxisHub']);
    expect((await preferences.listFavorites(people.steven, 'Steven')).map((row) => `${row.tenant_id}/${row.alias}`))
      .toEqual(['Steven/kant']);
    await expect(preferences.addFavorite(people.steven, 'Steven', 'PraxisHub', 'company_admin'))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('confines quota resumes and every report to the collector company, and ages out every company', async () => {
    const paused = (): Promise<{ id: string; paused: boolean }[]> => admin.query<{ id: string; paused: boolean }>(
      'SELECT id,paused_until IS NOT NULL AS paused FROM provider_accounts ORDER BY id').then((result) => result.rows);
    expect(await paused()).toEqual([{ id: 'humanizar-account', paused: false }, { id: 'praxis-account', paused: true }]);
    await admin.query("UPDATE quota_window_state SET remaining_percent=50 WHERE collector_tenant='PraxisHub'");
    await admin.query(`INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,received_at,schema_version)
      VALUES('shared-quota','PraxisHub','company_admin',now()-interval '40 days',now()-interval '40 days',1),
            ('shared-quota','Steven','kant',now()-interval '41 days',now()-interval '41 days',1)`);
    const humanizar = await repository.recordQuotaSample('Steven', 'kant', sample('shared-quota', 'humanizar-account', 55));
    expect(humanizar).toMatchObject({ resumed_accounts: [], pruned_collections: 1 });
    expect(await paused()).toEqual([{ id: 'humanizar-account', paused: false }, { id: 'praxis-account', paused: true }]);
    expect((await admin.query("SELECT 1 FROM quota_collections WHERE received_at < now()-interval '30 days'")).rowCount).toBe(0);
    const praxisRun = await repository.recordQuotaSample('PraxisHub', 'company_admin', sample('shared-quota', 'praxis-account', 50));
    expect(praxisRun).toMatchObject({ resumed_accounts: [{ account_id: 'praxis-account' }], pruned_collections: 0 });
  });

  it('withholds the failure detail and the chain counters of another company, and of tenants without one', async () => {
    await expect(repository.failureNoticeDetail(praxis.notice, 'Steven', 'company_admin')).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.failureNoticeDetail(praxis.orphan, 'Steven', 'company_admin')).rejects.toMatchObject({ code: 'not_found' });
    expect(await repository.failureNoticeDetail(praxis.notice, 'PraxisHub', 'company_admin')).toHaveProperty('notice');
    const chain = await repository.agentChain('shared-trace', 'Steven', 'company_admin');
    expect(chain).toMatchObject({ counters: { edges: 1, hidden_edges: 0 } });
    expect(JSON.stringify(chain)).not.toMatch(/Praxis/u);
    await link();
    expect(await repository.agentChain('shared-trace', 'Steven', 'company_admin')).toMatchObject({ counters: { hidden_edges: 1 } });
  });

  it('builds terminal cohorts per company and host and routes only along the company star', async () => {
    const cohort = containerCohort(await loadFleetPlacements(pool), 'Steven', 'kant').map((row) => `${row.tenant_id}/${row.alias}`);
    expect(cohort).toEqual(['Isa/salva', 'Miguel/janus', 'Steven/kant', 'Steven/zeus']);
    expect(containerCohort(await loadFleetPlacements(pool), 'PraxisHub', 'company_admin').map((row) => row.tenant_id))
      .toEqual(['PraxisHub']);
    const terminal = (): ReturnType<typeof routingAuthority> => routingAuthority(pool, 'Steven', 'kant', 'PraxisHub', 'company_admin');
    expect(await terminal()).toMatchObject({ allowed: false, reason: 'acl_edge_missing' });
    await link();
    expect(await terminal()).toMatchObject({ allowed: true, reason: 'acl_edge' });
  });

  it('keeps the fleet monitor on its tenant and never names the other tenants', async () => {
    const monitor = new FleetReadModel(pool, 'Steven');
    const deliveries = JSON.stringify(await monitor.deliveries());
    expect(JSON.stringify([await monitor.fleetStatus(), deliveries, await monitor.chain('shared-trace')]))
      .not.toMatch(new RegExp(`Praxis|team_agent|${praxis.internal}`, 'u'));
    // Pending outside WP-G: fleet-read-model.ts scopes deliveries by recipient alone, so the inbound delivery of an
    // unlinked company stays listed although queueSnapshot hides it. Flips to not.toContain with fleetReadableSql.
    expect(deliveries).toContain(praxis.inbound);
    const server = spawn(process.execPath, ['--import', 'tsx', MONITOR_SERVER], {
      cwd: MONITOR_DIRECTORY, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, DATABASE_URL: current?.url ?? '', CAUCE_TENANT_ID: 'NoSuchTenant' },
    });
    const errors: Buffer[] = [];
    server.stderr.on('data', (chunk: Buffer) => { errors.push(chunk); });
    const [code] = await once(server, 'exit') as [number | null];
    const stderr = Buffer.concat(errors).toString('utf8');
    expect(code).toBe(1);
    expect(stderr).toContain("CAUCE_TENANT_ID 'NoSuchTenant' is not a known tenant id");
    expect(stderr).not.toMatch(/PraxisHub|Miguel|Isa\b/u);
  }, 60_000);
});
