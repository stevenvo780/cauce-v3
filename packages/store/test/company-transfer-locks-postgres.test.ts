import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@cauce/protocol';
import { boundAuthorityTimeouts, ConfigurationRepository, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { exportCompanyConfiguration, importCompanyConfiguration, planCompanyConfigurationImport } from '../src/company-transfer.js';
import type { CompanyTransferBundle } from '../src/company-transfer-model.js';
import { PeopleAdminRepository } from '../../../services/gateway/src/console/people-admin-store.js';
import type { PeopleAdminActor } from '../../../services/gateway/src/console/people-admin-schema.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let pool: DatabasePool;
let people: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase({ requireOwnedContainer: true }); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); admin = current.adminPool; pool = current.pool;
  people = await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [people.leon]);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function actor(humanId: string, tenant: string, alias: string): PeopleAdminActor {
  return { tenant_id: tenant, alias, subject: `console:${humanId}`,
    humanAuthority: async () => ({ humanId, tenantId: tenant, actorAlias: alias }) };
}
async function revision(humanId: string): Promise<string> {
  const value = (await admin.query<{ revision: string }>(
    'SELECT (extract(epoch FROM updated_at)*1000000)::numeric(20,0)::text AS revision FROM console_users WHERE id=$1', [humanId],
  )).rows[0]?.revision;
  if (value === undefined) throw new Error('person revision absent');
  return value;
}
async function waitForActivity(pid: number, predicate: (row: { blockers: number[]; wait_event: string | null }) => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  do {
    const row = (await admin.query<{ blockers: number[]; wait_event: string | null }>(
      'SELECT pg_blocking_pids(pid) AS blockers,wait_event FROM pg_stat_activity WHERE pid=$1', [pid],
    )).rows[0];
    if (row && predicate(row)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('expected database activity was not observed');
}
async function pid(client: DatabaseClient): Promise<number> {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
}
function borrowedPool(client: DatabaseClient): DatabasePool {
  return { connect: async () => new Proxy(client, { get(target, key) {
    if (key === 'release') return () => undefined;
    const value: unknown = Reflect.get(target, key);
    const bound: unknown = typeof value === 'function' ? value.bind(target) : value;
    return bound;
  } }) } as DatabasePool;
}

describe('company import and people authority lock concurrency', () => {
  it('commits configuration and people writes in B while an import in A lasts longer than five seconds', async () => {
    const platform = { humanId: people.steven, tenant: 'Steven', alias: 'kant', companyId: 'praxis' };
    const snapshot = await exportCompanyConfiguration(admin, platform);
    const { bundle_sha256: _hash, ...payload } = snapshot;
    const content = { ...payload, records: { ...snapshot.records, rooms: [...snapshot.records.rooms,
      { tenant_id: 'PraxisHub', id: 'slow-import-room', display_name: 'Slow import', enabled: true }] } };
    const bundle: CompanyTransferBundle = { ...content, bundle_sha256: sha256Hex(content) };
    const plan = await planCompanyConfigurationImport(admin, platform, bundle, 0);
    await admin.query(`CREATE FUNCTION slow_import_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$;
      CREATE TRIGGER slow_import_fixture BEFORE INSERT ON rooms FOR EACH ROW
        WHEN (NEW.id='slow-import-room') EXECUTE FUNCTION slow_import_fixture()`);
    const importer = await admin.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await importer.query('BEGIN');
      const importerPid = await pid(importer); const started = Date.now();
      outcome = importCompanyConfiguration(admin, platform, bundle, plan, false, { transactionClient: importer })
        .then(result => result, (error: unknown) => error);
      await waitForActivity(importerPid, row => row.wait_event === 'PgSleep');
      const written = await new ConfigurationRepository(pool).apply('Miguel', 'janus',
        { resource: 'room', action: 'create', tenant_id: 'Miguel', id: 'independent-room', value: { enabled: true } },
        false, undefined, client => lockCompanyAuthority(client, { tenant: 'Miguel', alias: 'janus', humanId: people.miguel }));
      expect(written.applied).toBe(true);
      const changed = await new PeopleAdminRepository(pool).update(actor(people.miguel, 'Miguel', 'janus'), people.miguel,
        { expected_revision: await revision(people.miguel), display_name: 'Independent write' });
      expect(changed.display_name).toBe('Independent write');
      expect(Date.now() - started).toBeLessThan(4_000);
      expect((await admin.query("SELECT id FROM rooms WHERE id='slow-import-room'")).rows).toEqual([]);
      expect(await outcome).toMatchObject({ applied: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(5_500);
      await importer.query('COMMIT');
      expect((await admin.query("SELECT id FROM rooms WHERE id='slow-import-room'")).rowCount).toBe(1);
    } finally {
      await outcome;
      await importer.query('ROLLBACK'); importer.release();
    }
  });

  it('takes the platform guard before the company guard in crossed people transactions', async () => {
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [people.miguel]);
    const blocker = await admin.connect();
    const writer = await pool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT cauce_lock_platform_owner_guard()');
      const blockerPid = await pid(blocker); const writerPid = await pid(writer);
      outcome = new PeopleAdminRepository(borrowedPool(writer)).retire(actor(people.steven, 'Steven', 'kant'), people.miguel,
        { expected_revision: await revision(people.miguel) }).then(result => result, (error: unknown) => error);
      await waitForActivity(writerPid, row => row.blockers.includes(blockerPid));
      await blocker.query("SET LOCAL lock_timeout='500ms'");
      await blocker.query("SELECT cauce_lock_owner_guard('humanizar')");
      await blocker.query('COMMIT');
      expect(await outcome).toMatchObject({ active: false });
    } finally {
      await blocker.query('ROLLBACK');
      await outcome;
      await writer.query('ROLLBACK'); blocker.release(); writer.release();
    }
  });

  it.each([
    ['100ms', '250ms', 1_200, '100ms', '250ms'],
    ['0', '30s', 1_200, '1200ms', '1200ms'],
    ['30s', '0', 5_000, '5s', '5s'],
  ] as const)('bounds finite and disabled caller timeouts (%s, %s)', async (statement, lock, maximum, expectedStatement, expectedLock) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)", [statement, lock]);
      await boundAuthorityTimeouts(client, maximum, true);
      expect((await client.query(`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)).rows)
        .toEqual([{ statement: expectedStatement, lock: expectedLock }]);
      await client.query('ROLLBACK');
      expect((await client.query(`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)).rows)
        .toEqual([{ statement: '0', lock: '0' }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('maps a real stale-snapshot rejection in people administration to conflict', async () => {
    const client = await pool.connect();
    try {
      await client.query("SET default_transaction_isolation='repeatable read'");
      await expect(new PeopleAdminRepository(borrowedPool(client)).list(actor(people.miguel, 'Miguel', 'janus')))
        .rejects.toMatchObject({ code: 'conflict' });
    } finally { await client.query('RESET default_transaction_isolation'); client.release(); }
  });

  it('rejects a newly committed platform grant instead of taking the platform guard after the company guard', async () => {
    const granter = await admin.connect(); const writer = await pool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await granter.query('BEGIN');
      const granterPid = await pid(granter); const writerPid = await pid(writer);
      const before = await revision(people.miguel);
      await granter.query('INSERT INTO platform_admins(human_id) VALUES($1)', [people.miguel]);
      outcome = new PeopleAdminRepository(borrowedPool(writer)).retire(actor(people.steven, 'Steven', 'kant'), people.miguel,
        { expected_revision: before }).then(result => result, (error: unknown) => error);
      await waitForActivity(writerPid, row => row.blockers.includes(granterPid));
      await granter.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'conflict' });
      expect(await revision(people.miguel)).toBe(before);
      expect((await admin.query('SELECT active FROM console_users WHERE id=$1', [people.miguel])).rows).toEqual([{ active: true }]);
      expect((await admin.query("SELECT 1 FROM audit_events WHERE action='people.update'")).rowCount).toBe(0);
    } finally {
      await granter.query('ROLLBACK'); await outcome;
      await writer.query('ROLLBACK'); granter.release(); writer.release();
    }
  });
});
