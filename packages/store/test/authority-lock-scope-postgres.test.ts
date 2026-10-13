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
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','kant','operator') ON CONFLICT DO NOTHING`);
  const platformTeam = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Platform fixture','operator','PraxisTeam','team_agent')`,
  [platformTeam, `${platformTeam}@example.test`, '$scrypt$' + 'x'.repeat(48)]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisTeam','team_agent','operator',ARRAY['read','control'])`, [platformTeam]);
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
  it.each([false, true])('commits configuration in another company while the first transaction stays open (shared platform actor: %s)', async sharedActor => {
    const repository = new ConfigurationRepository(pool);
    await withPair(async (first, second) => {
      const firstTenant = sharedActor ? 'Steven' : 'Miguel'; const firstAlias = sharedActor ? 'kant' : 'janus';
      const secondTenant = sharedActor ? 'Steven' : 'PraxisHub'; const secondAlias = sharedActor ? 'kant' : 'company_admin';
      const firstHuman = sharedActor ? actors.steven : actors.miguel;
      const secondHuman = sharedActor ? actors.steven : actors.leon;
      await repository.forTransaction(first).apply(firstTenant, firstAlias,
        { resource: 'room', action: 'create', tenant_id: 'Steven', id: 'lock-scope-humanizar', value: { enabled: true } },
        false, undefined, client => lockCompanyAuthority(client, { tenant: firstTenant, alias: firstAlias, humanId: firstHuman }));
      await second.query("SET LOCAL statement_timeout='2s'");
      const result = await repository.forTransaction(second).apply(secondTenant, secondAlias,
        { resource: 'room', action: 'create', tenant_id: 'PraxisHub', id: 'lock-scope-praxis', value: { enabled: true } },
        false, undefined, client => lockCompanyAuthority(client, {
          tenant: secondTenant, alias: secondAlias, humanId: secondHuman, requestedCompany: 'praxis',
        }));
      expect(result.applied).toBe(true);
      await second.query('COMMIT');
      expect((await admin.query("SELECT id FROM rooms WHERE id LIKE 'lock-scope-%' ORDER BY id")).rows)
        .toEqual([{ id: 'lock-scope-praxis' }]);
      expect((await admin.query("SELECT company_id FROM config_revisions WHERE operation->>'id' LIKE 'lock-scope-%'")).rows)
        .toEqual([{ company_id: 'praxis' }]);
      await first.query('COMMIT');
      expect((await admin.query("SELECT id FROM rooms WHERE id LIKE 'lock-scope-%' ORDER BY id")).rows)
        .toEqual([{ id: 'lock-scope-humanizar' }, { id: 'lock-scope-praxis' }]);
    });
  });

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

  it.each(['owner', 'platform'] as const)('G4 serializes direct account updates and preserves the last active %s', async kind => {
    const first = kind === 'owner' ? actors.miguel : actors.steven;
    const second = kind === 'owner' ? actors.steven : actors.platformTeam;
    await race(first, second, (client, humanId) => client.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]),
      { code: '23514', constraint: kind === 'owner' ? 'console_users_last_company_owner' : 'console_users_last_platform_admin' });
    expect(await qualifiedCount(kind)).toBe(1);
    expect((await admin.query<{ active: boolean }>('SELECT active FROM console_users WHERE id=$1', [second])).rows[0]?.active).toBe(true);
  });

  it('resolves authority in another company while a configuration writer holds its company guard', async () => {
    await withPair(async (first, second) => {
      await new ConfigurationRepository(pool).forTransaction(first).apply('Miguel', 'janus',
        { resource: 'room', action: 'create', tenant_id: 'Miguel', id: 'authority-read-room', value: { enabled: true } },
        false, undefined, client => lockCompanyAuthority(client, { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel }));
      await second.query("SET LOCAL statement_timeout='2s'");
      expect(await lockCompanyAuthority(second, { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon }))
        .toMatchObject({ role: 'company_owner', actingCompany: 'praxis' });
    });
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

  it('updates a room without platform holders while leaving the platform writer guard free', async () => {
    await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('unguarded-room','Miguel')");
    await withPair(async (first, _second) => {
      await new ConfigurationRepository(pool).forTransaction(first).apply('Miguel', 'janus',
        { resource: 'room', action: 'update', tenant_id: 'Miguel', id: 'unguarded-room', value: { enabled: false } },
        false, undefined, client => lockCompanyAuthority(client, { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel }));
      expect(await hasPlatformGuard(await pid(first))).toBe(false);
    });
  });

  it('makes a concurrent platform grant wait for an earlier configuration writer in its company', async () => {
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.platformTeam]);
    await withPair(async (first, second) => {
      const firstPid = await pid(first); const secondPid = await pid(second);
      await new ConfigurationRepository(pool).forTransaction(first).apply('PraxisHub', 'company_admin',
        { resource: 'membership', action: 'update', tenant_id: 'PraxisTeam', room_id: 'company-team', alias: 'team_agent', value: { enabled: false } },
        false, undefined, client => lockCompanyAuthority(client, { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon }));
      expect(await hasPlatformGuard(firstPid)).toBe(false);
      const outcome = rejection(second.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actors.platformTeam]));
      await observeBlocker(secondPid, firstPid);
      await first.query('COMMIT');
      expect(await outcome).toBeUndefined();
      await second.query('COMMIT');
      expect(await qualifiedCount('platform')).toBe(1);
      expect((await admin.query('SELECT human_id FROM platform_admins WHERE human_id=$1', [actors.platformTeam])).rowCount).toBe(1);
    }, { secondPool: admin });
  });

  it.each(['account', 'membership'] as const)('rechecks a newly committed platform grant after a blocked %s write', async kind => {
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.platformTeam]);
    const people = [actors.steven, actors.miguel, actors.leon, actors.platformTeam];
    const standing = () => admin.query<{ id: string; active: boolean; permissions: string[] }>(
      `SELECT person.id::text,person.active,home.permissions FROM console_users person
       JOIN human_tenant_memberships home ON home.human_id=person.id AND home.tenant_id=person.tenant_id
       WHERE person.id=ANY($1::uuid[]) ORDER BY person.id`, [people]);
    const before = (await standing()).rows;
    await withPair(async (first, second) => {
      const firstPid = await pid(first); const secondPid = await pid(second);
      await first.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actors.platformTeam]);
      expect(await hasPlatformGuard(firstPid)).toBe(true);
      expect((await admin.query('SELECT human_id FROM platform_admins WHERE human_id=$1', [actors.platformTeam])).rowCount).toBe(0);
      const outcome = rejection(kind === 'account'
        ? second.query('UPDATE console_users SET active=false WHERE id=$1', [actors.platformTeam])
        : stripControl(second, actors.platformTeam));
      await observeBlocker(secondPid, firstPid);
      await first.query('COMMIT');
      expect(await outcome).toMatchObject({
        code: kind === 'account' ? '40001' : 'conflict', message: 'platform authority changed; reload and retry',
      });
      await second.query('ROLLBACK');
      expect((await standing()).rows).toEqual(before);
      expect(await qualifiedCount('platform')).toBe(2);
      expect((await admin.query('SELECT human_id FROM platform_admins WHERE human_id=$1', [actors.platformTeam])).rowCount).toBe(1);
    }, { firstPool: admin });
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

  it('sets five-second authority timeouts only inside the transaction', async () => {
    await withPair(async (_first, second) => {
      await lockCompanyAuthority(second, { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon });
      expect((await second.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('5s');
      await second.query('COMMIT');
      expect((await second.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('0');
    });
  });

  it.each(['cauce_lock_owner_guard($1)', 'cauce_lock_platform_owner_guard()'])('rejects stale-snapshot isolation in %s', async guard => {
    await withPair(async (_first, second) => {
      await second.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await expect(second.query(`SELECT ${guard}`, guard.includes('$1') ? ['humanizar'] : []))
        .rejects.toMatchObject({ code: '40001', message: 'authority writes require read committed isolation' });
    });
  });
});
