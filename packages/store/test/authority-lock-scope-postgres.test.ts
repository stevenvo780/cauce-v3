import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertKeepsCompanyAuthority, ConfigurationRepository, lockCompanyAuthority,
  type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { QUALIFIED_PEOPLE_SQL } from '../src/configuration/control-holders.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture & { platformTeam: string };
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase({ requireOwnedContainer: true });
}, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','kant','operator') ON CONFLICT DO NOTHING`);
  const platformTeam = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Platform fixture','operator','PraxisTeam','team_agent')`,
  [platformTeam, `${platformTeam}@example.test`, '$scrypt$' + 'x'.repeat(48)]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisTeam','team_agent',ARRAY['read','control'])`, [platformTeam]);
  await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [platformTeam]);
  actors = { ...seeded, platformTeam };
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => {
  if (database) { await database.pool.end(); await database.container.stop(); }
});

async function withPair(
  work: (first: DatabaseClient, second: DatabaseClient) => Promise<void>,
  { firstPool = pool, secondPool = pool }: { firstPool?: DatabasePool; secondPool?: DatabasePool } = {},
): Promise<void> {
  const first = await firstPool.connect();
  const second = await secondPool.connect();
  try {
    await first.query('BEGIN'); await second.query('BEGIN');
    await work(first, second);
  } finally {
    await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
    first.release(); second.release();
  }
}

async function pid(client: DatabaseClient): Promise<number> {
  const value = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (value === undefined) throw new Error('backend pid absent');
  return value;
}

async function observeBlocker(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    const activity = (await admin.query<{ blockers: number[]; wait_event_type: string | null }>(
      'SELECT pg_blocking_pids(pid) AS blockers,wait_event_type FROM pg_stat_activity WHERE pid=$1', [waiter],
    )).rows[0];
    if (activity?.blockers.includes(blocker) && activity.wait_event_type === 'Lock') return;
  } while (Date.now() < deadline);
  throw new Error('the second writer never waited for the first writer');
}

function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => undefined, (error: unknown) => error);
}

async function hasPlatformGuard(clientPid: number): Promise<boolean> {
  return (await admin.query<{ held: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks
    WHERE pid=$1 AND locktype='advisory' AND classid=783003078 AND objid=0 AND objsubid=2
      AND mode='ExclusiveLock' AND granted) AS held`, [clientPid])).rows[0]?.held ?? false;
}

async function stripControl(client: DatabaseClient, humanId: string): Promise<void> {
  await client.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [humanId]);
  await assertKeepsCompanyAuthority(client, humanId);
}

async function race(
  firstHuman: string, secondHuman: string,
  write: (client: DatabaseClient, humanId: string) => Promise<unknown>, expected: Record<string, unknown>,
): Promise<void> {
  await withPair(async (first, second) => {
    const firstPid = await pid(first); const secondPid = await pid(second);
    await write(first, firstHuman);
    const outcome = rejection(write(second, secondHuman));
    await observeBlocker(secondPid, firstPid);
    await first.query('COMMIT');
    expect(await outcome).toMatchObject(expected);
    await second.query('ROLLBACK');
  });
}

async function qualifiedCount(kind: 'owner' | 'platform', company = 'humanizar'): Promise<number> {
  const query = kind === 'owner'
    ? "SELECT count(*)::int AS count FROM company_admins holder JOIN qualified person ON person.id=holder.human_id WHERE holder.company_id=$1 AND holder.role='owner'"
    : 'SELECT count(*)::int AS count FROM platform_admins holder JOIN qualified person ON person.id=holder.human_id';
  return (await admin.query<{ count: number }>(`WITH qualified AS (${QUALIFIED_PEOPLE_SQL}) ${query}`,
    kind === 'owner' ? [company] : [])).rows[0]?.count ?? 0;
}

describe('authority writer lock scope on PostgreSQL', () => {

  it('serializes post-write membership guards and rejects loss of the last qualified company owner', async () => {
    await race(actors.miguel, actors.steven, stripControl,
      { code: 'conflict', message: 'company humanizar must keep a qualified owner' });
    expect(await qualifiedCount('owner')).toBe(1);
    expect((await admin.query<{ permissions: string[] }>(
      'SELECT permissions FROM human_tenant_memberships WHERE human_id=$1', [actors.steven])).rows[0]?.permissions)
      .toEqual(['read', 'control']);
  });

  it('serializes platform membership guards across companies and rejects loss of the last qualified administrator', async () => {
    await race(actors.steven, actors.platformTeam, stripControl,
      { code: 'conflict', message: 'the platform must keep a qualified administrator' });
    expect(await qualifiedCount('platform')).toBe(1);
    expect(await qualifiedCount('owner', 'praxis')).toBe(1);
    expect((await admin.query<{ permissions: string[] }>(
      'SELECT permissions FROM human_tenant_memberships WHERE human_id=$1', [actors.platformTeam])).rows[0]?.permissions)
      .toEqual(['read', 'control']);
  });

  it('takes the platform writer guard for a holder mutation and rechecks a blocked actor after commit', async () => {
    await admin.query("UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND alias='kant' AND room_id<>'company-humanizar'");
    const repository = new ConfigurationRepository(pool);
    await withPair(async (first, second) => {
      const firstPid = await pid(first); const secondPid = await pid(second);
      await repository.forTransaction(first).apply('PraxisTeam', 'team_agent',
        { resource: 'membership', action: 'update', tenant_id: 'Steven', room_id: 'company-humanizar', alias: 'kant', value: { enabled: false } },
        false, undefined, client => lockCompanyAuthority(client, {
          tenant: 'PraxisTeam', alias: 'team_agent', humanId: actors.platformTeam, requestedCompany: 'humanizar',
        }));
      expect(await hasPlatformGuard(firstPid)).toBe(true);
      const outcome = rejection(repository.forTransaction(second).apply('Steven', 'kant',
        { resource: 'membership', action: 'update', tenant_id: 'PraxisTeam', room_id: 'company-team', alias: 'team_agent', value: { enabled: false } },
        false, undefined, client => lockCompanyAuthority(client, {
          tenant: 'Steven', alias: 'kant', humanId: actors.steven, requestedCompany: 'praxis',
        })));
      await observeBlocker(secondPid, firstPid);
      await first.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'forbidden' });
      await second.query('ROLLBACK');
      expect(await qualifiedCount('platform')).toBe(1);
      expect((await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM memberships WHERE tenant_id='PraxisTeam' AND room_id='company-team' AND alias='team_agent'",
      )).rows[0]?.enabled).toBe(true);
    });
  });

  it('bounds identity lock waits at five seconds and resets the timeout after rollback', async () => {
    await withPair(async (first, second) => {
      expect((await second.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('0');
      const firstPid = await pid(first); const secondPid = await pid(second);
      await first.query('SELECT id FROM console_users WHERE id=$1 FOR UPDATE', [actors.leon]);
      await second.query("SET LOCAL statement_timeout='8s'");
      const started = Date.now();
      const outcome = rejection(lockCompanyAuthority(second, { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon }));
      await observeBlocker(secondPid, firstPid);
      expect(await outcome).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      await second.query('ROLLBACK');
      expect((await second.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('0');
    });
  });
});
