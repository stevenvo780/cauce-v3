import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigLeafMutation } from '@cauce/protocol';
import {
  ConfigurationRepository, lockCompanyAuthority, lockCompanyConfiguration,
  type ConfigurationAuthorityResolver, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: ConfigurationRepository;
let actors: CompanyIsolationFixture & { isa: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query(`UPDATE memberships SET role='operator' WHERE (tenant_id,alias) IN (('Isa','salva'),('Miguel','janus'))`);
  const isa = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Isa','operator','Isa','salva')`, [isa, `${isa}@example.test`, '$scrypt$' + 'x'.repeat(48)]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'Isa','salva','operator',ARRAY['read','control'])`, [isa]);
  actors = { ...seeded, isa };
  repository = new ConfigurationRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function as(tenant: string, alias: string, humanId: string, requestedCompany?: string): ConfigurationAuthorityResolver {
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant, alias, humanId,
    ...(requestedCompany === undefined ? {} : { requestedCompany }) });
}
const steven = (company?: string) => as('Steven', 'kant', actors.steven, company);
const miguel = () => as('Miguel', 'janus', actors.miguel);
const leon = () => as('PraxisHub', 'company_admin', actors.leon);
const humanizarRoom = (name: string): ConfigLeafMutation => ({ resource: 'room', action: 'update', tenant_id: 'Steven', id: 'company-humanizar',
  value: { display_name: name } });
const praxisRoom = (id: string): ConfigLeafMutation => ({ resource: 'room', action: 'create', tenant_id: 'PraxisHub', id, value: {} });
const chain: ConfigLeafMutation = { resource: 'chain_policy', action: 'update', id: 'default', value: { max_fanout_per_turn: 9 } };

async function waiting(query: string): Promise<number | null> {
  return (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query=$1", [query])).rowCount;
}

describe('per-company configuration revisions', () => {
  it('serializes writers of one company and never blocks another company', async () => {
    const blocker = await pool.connect();
    let humanizar: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await lockCompanyConfiguration(blocker, 'humanizar');
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const held = await pool.query<{ classid: string; objid: string; objsubid: number; mode: string }>(
        `SELECT classid::text,objid::text,objsubid,mode FROM pg_locks WHERE locktype='advisory' AND granted AND pid=$1 ORDER BY objsubid`, [pid]);
      const hash = (await pool.query<{ objid: string }>("SELECT (hashtext('humanizar')::bigint & 4294967295)::text AS objid")).rows[0]?.objid;
      expect(held.rows).toEqual([
        { classid: '0', objid: '783003004', objsubid: 1, mode: 'ShareLock' },
        { classid: '783003004', objid: hash, objsubid: 2, mode: 'ExclusiveLock' },
      ]);
      expect((await repository.apply('PraxisHub', 'company_admin', praxisRoom('parallel-room'), false, 0, leon())).applied).toBe(true);
      humanizar = repository.apply('Miguel', 'janus', humanizarRoom('Serialized'), false, undefined, miguel());
      await expect.poll(() => waiting('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))'), { timeout: 5000 }).toBe(1);
      const platform = repository.apply('Steven', 'kant', chain, false, undefined, steven());
      await expect.poll(() => waiting('SELECT pg_advisory_xact_lock($1::bigint)'), { timeout: 5000 }).toBe(1);
      await blocker.query('ROLLBACK');
      expect(await humanizar).toMatchObject({ applied: true });
      expect(await platform).toMatchObject({ applied: true });
    } finally { blocker.release(); await humanizar?.catch(() => undefined); }
  });

  it('lets a platform catalog write invalidate the previews of every company', async () => {
    const own = await repository.apply('PraxisHub', 'company_admin', praxisRoom('own-room'), false, 0, leon());
    expect((await repository.get('Miguel', 'janus', miguel())).revision).toBe(0);
    expect((await repository.get('PraxisHub', 'company_admin', leon())).revision).toBe(own.revision);
    const catalog = await repository.apply('Steven', 'kant', chain, false, 0, steven());
    for (const [tenant, alias, resolver, stale, mutation] of [
      ['Miguel', 'janus', miguel(), 0, humanizarRoom('Stale')], ['PraxisHub', 'company_admin', leon(), own.revision, praxisRoom('stale-room')],
    ] as const) {
      expect((await repository.get(tenant, alias, resolver)).revision).toBe(catalog.revision);
      await expect(repository.apply(tenant, alias, mutation, false, stale, resolver)).rejects.toMatchObject({ code: 'conflict' });
      expect((await repository.apply(tenant, alias, mutation, true, catalog.revision, resolver)).dry_run).toBe(true);
    }
  });

  it('answers not_found for a revision of another company, another tenant or the platform', async () => {
    const humanizar = await repository.apply('Miguel', 'janus', humanizarRoom('Changed'), false, 0, miguel());
    const platform = await repository.apply('Steven', 'kant', chain, false, undefined, steven());
    for (const [tenant, alias, resolver, revision] of [
      ['PraxisHub', 'company_admin', leon(), humanizar.revision], ['Isa', 'salva', as('Isa', 'salva', actors.isa), humanizar.revision],
      ['Miguel', 'janus', miguel(), platform.revision], ['PraxisHub', 'company_admin', leon(), platform.revision],
      ['PraxisHub', 'company_admin', leon(), 999_999],
    ] as const) {
      for (const dryRun of [true, false]) {
        await expect(repository.rollback(tenant, alias, revision, dryRun, undefined, resolver)).rejects.toMatchObject({ code: 'not_found' });
      }
    }
    expect((await repository.get('PraxisHub', 'company_admin', leon())).revisions).toEqual([]);
    expect((await repository.rollback('Steven', 'kant', platform.revision, false, undefined, steven())).applied).toBe(true);
    expect((await pool.query("SELECT display_name FROM rooms WHERE id='company-humanizar'")).rows).toEqual([{ display_name: 'Changed' }]);
  });

  it('records a platform switch in the affected company, where its owners see and undo it', async () => {
    const switched = await repository.apply('Steven', 'kant', praxisRoom('switched-room'), false, 0, steven('praxis'));
    expect((await pool.query(`SELECT actor_tenant,scope,company_id,platform_override,actor_human_id::text FROM config_revisions WHERE id=$1`,
      [switched.revision])).rows).toEqual([{ actor_tenant: 'Steven', scope: 'company', company_id: 'praxis', platform_override: true,
      actor_human_id: actors.steven }]);
    expect((await pool.query(`SELECT tenant_id,company_id,actor_human_id::text,metadata->>'platform_override' AS override FROM audit_events
      WHERE action='config.change'`)).rows).toEqual([{ tenant_id: 'Steven', company_id: 'praxis', actor_human_id: actors.steven, override: 'true' }]);
    expect((await repository.get('PraxisHub', 'company_admin', leon())).revisions)
      .toEqual([expect.objectContaining({ id: String(switched.revision), actor_tenant: 'Steven', platform_override: true })]);
    expect((await repository.get('Miguel', 'janus', miguel())).revisions).toEqual([]);
    await expect(repository.rollback('Steven', 'kant', switched.revision, false, undefined, steven())).rejects.toMatchObject({ code: 'not_found' });
    const undone = await repository.rollback('PraxisHub', 'company_admin', switched.revision, false, switched.revision, leon());
    expect((await pool.query('SELECT company_id,platform_override FROM config_revisions WHERE id=$1', [undone.revision])).rows)
      .toEqual([{ company_id: 'praxis', platform_override: false }]);
    expect((await pool.query("SELECT id FROM rooms WHERE id='switched-room'")).rows).toEqual([]);
  });

  it('never mixes platform catalogs and company resources in one batch', async () => {
    await expect(repository.apply('Steven', 'kant', { resource: 'batch', action: 'apply', mutations: [chain, humanizarRoom('Mixed')] },
      false, 0, steven())).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });
});
