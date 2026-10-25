import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, withTransaction, type DatabasePool } from '../src/index.js';
import { assertRuntimeLeaseIdentity, type RuntimeLeaseIdentity } from '../src/runtime-lease-identity.js';
import {
  closeTestDatabase, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;

const ALIAS = 'zz-canary-lease';
const RUNTIME = 'zz-canary-lease-runtime';
const CONTROLLER = 'zz-canary-controller';
const REMOTE = 'zz-canary-server2';
const LEGACY: RuntimeLeaseIdentity = { channel: 'adapter', sessionId: 'legacy-adapter', legacyHostId: CONTROLLER };
const MISMATCH = { code: 'forbidden', recoveryReason: 'consumer_placement_mismatch' };
const future = () => new Date(Date.now() + 120_000).toISOString();

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase({ requireOwnedContainer: true });
}, 180_000);

beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  caseDatabase = await startTestCaseDatabase(database);
  pool = caseDatabase.pool;
  repository = new CauceRepository(pool);
  await caseDatabase.adminPool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
    VALUES($1,'Controller','humanizar'),($2,'Remote host','humanizar')`, [CONTROLLER, REMOTE]);
});

afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { await closeTestDatabase(database); });

async function seedAgent(hostId: string | null, baselineHostId: string | null = null, mode: 'container' | null = null) {
  if (!caseDatabase) throw new Error('case database unavailable');
  await withTransaction(caseDatabase.adminPool, async (client) => {
    // Historical baselines must be initialized before the permanent identity guard first sees them.
    await client.query(`CREATE FUNCTION pg_temp.initialize_runtime_lease_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.baseline := true;
        NEW.baseline_state := current_setting('cauce_test.runtime_lease_baseline')::jsonb;
        RETURN NEW;
      END;
    $$`);
    await client.query(`CREATE TRIGGER test_runtime_lease_baseline BEFORE INSERT ON fleet_runtime_identities
      FOR EACH ROW WHEN (NEW.tenant_id='Steven' AND NEW.alias='zz-canary-lease'
        AND NEW.runtime_key='zz-canary-lease-runtime') EXECUTE FUNCTION pg_temp.initialize_runtime_lease_baseline()`);
    await client.query("SELECT set_config('cauce_test.runtime_lease_baseline',$1,true)",
      [JSON.stringify({ runtime_mode: null, host_id: baselineHostId })]);
    await client.query(`INSERT INTO agents(tenant_id,alias,runtime_key,host_id,runtime_mode,enabled,max_concurrent_deliveries,
        harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven',$1,$2,$3,$4,true,1,'codex','zz-canary-lease','test','/home/test','/home/test/.cauce')`,
    [ALIAS, RUNTIME, hostId, mode]);
    await client.query('DROP TRIGGER test_runtime_lease_baseline ON fleet_runtime_identities');
    await client.query('DROP FUNCTION pg_temp.initialize_runtime_lease_baseline()');
    await client.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES('Steven','grp.steven',$1,'agent')`, [ALIAS]);
  });
  expect((await pool.query<{ tgenabled: string }>(`SELECT tgenabled FROM pg_trigger
    WHERE tgname IN ('fleet_runtime_identity_permanent','agent_runtime_key_reservation') ORDER BY tgname`)).rows)
    .toEqual([{ tgenabled: 'O' }, { tgenabled: 'O' }]);
  expect((await pool.query<{ baseline: boolean; baseline_state: { host_id: string | null } }>(
    'SELECT baseline,baseline_state FROM fleet_runtime_identities WHERE runtime_key=$1', [RUNTIME])).rows)
    .toEqual([{ baseline: true, baseline_state: { runtime_mode: null, host_id: baselineHostId } }]);
}

function normalIdentity(overrides: Partial<RuntimeLeaseIdentity> = {}): RuntimeLeaseIdentity {
  return { ...LEGACY, sessionId: `adapter-${RUNTIME}`, normalRuntimeKey: RUNTIME,
    certificateFingerprint: 'a'.repeat(64), certificateExpiresAt: future(), hostId: REMOTE, expiresAt: future(), ...overrides };
}

async function assertIdentity(identity: RuntimeLeaseIdentity) {
  await withTransaction(pool, (client) => assertRuntimeLeaseIdentity(client, 'Steven', ALIAS, identity));
}

describe('runtime lease identity with PostgreSQL', () => {
  it.each([
    ['controller host', CONTROLLER, null],
    ['registered remote host', REMOTE, null],
    ['NULL current host', null, null],
    ['recorded matching host', REMOTE, REMOTE],
  ])('accepts V3 on %s', async (_name, currentHost, baselineHost) => {
    await seedAgent(currentHost, baselineHost);
    await expect(assertIdentity(LEGACY)).resolves.toBeUndefined();
    const lease = await repository.acquireLease('Steven', ALIAS, 'v3-consumer', [], 60_000, { identity: LEGACY });
    expect(lease).toMatchObject({ acquired: true, epoch: 1 });
    await expect(repository.heartbeat('Steven', ALIAS, 'v3-consumer', 1, 60_000,
      lease.connection_token, undefined, LEGACY)).resolves.toMatch(/T/u);
  });

  it.each([
    ['another registered host', REMOTE, CONTROLLER],
    ['the controller despite another recorded host', CONTROLLER, REMOTE],
  ])('rejects V3 moved to %s', async (_name, currentHost, baselineHost) => {
    await seedAgent(baselineHost, baselineHost);
    if (!caseDatabase) throw new Error('case database unavailable');
    await caseDatabase.adminPool.query('UPDATE agents SET host_id=$1 WHERE alias=$2', [currentHost, ALIAS]);
    await expect(assertIdentity(LEGACY)).rejects.toMatchObject(MISMATCH);
    await expect(repository.acquireLease('Steven', ALIAS, 'stale-v3', [], 60_000, { identity: LEGACY }))
      .rejects.toMatchObject(MISMATCH);
    expect((await pool.query('SELECT 1 FROM connection_leases WHERE alias=$1', [ALIAS])).rowCount).toBe(0);
  });

  it('accepts V4 with its valid normal certificate and host', async () => {
    await seedAgent(REMOTE, null, 'container');
    await expect(assertIdentity(normalIdentity())).resolves.toBeUndefined();
    await expect(repository.acquireLease('Steven', ALIAS, 'v4-consumer', [], 60_000, { identity: normalIdentity() }))
      .resolves.toMatchObject({ acquired: true, epoch: 1 });
  });

  it.each([
    ['a legacy V3 certificate', () => LEGACY],
    ['a certificate from another host', () => normalIdentity({ hostId: CONTROLLER })],
    ['rejected provenance', () => normalIdentity({ provenanceRejected: true })],
    ['an expired normal certificate', () => normalIdentity({ certificateExpiresAt: '2000-01-01T00:00:00.000Z' })],
    ['expired host authority', () => normalIdentity({ expiresAt: '2000-01-01T00:00:00.000Z' })],
    ['another runtime key', () => normalIdentity({ normalRuntimeKey: 'zz-canary-other' })],
    ['another authenticated session', () => normalIdentity({ sessionId: 'adapter-zz-canary-other' })],
  ])('rejects V4 with %s', async (_name, identity) => {
    await seedAgent(REMOTE, null, 'container');
    await expect(assertIdentity(identity())).rejects.toMatchObject(MISMATCH);
    await expect(repository.acquireLease('Steven', ALIAS, 'invalid-v4', [], 60_000, { identity: identity() }))
      .rejects.toMatchObject(MISMATCH);
    expect((await pool.query('SELECT 1 FROM connection_leases WHERE alias=$1', [ALIAS])).rowCount).toBe(0);
  });

  it('rejects explicit provenance rejection and non-adapter channels for V3 too', async () => {
    await seedAgent(REMOTE);
    await expect(assertIdentity({ ...LEGACY, provenanceRejected: true })).rejects.toMatchObject(MISMATCH);
    await expect(assertIdentity({ ...LEGACY, channel: 'console' })).rejects.toMatchObject(MISMATCH);
  });

  it('does not grant legacy admission to a new reservation without a V3 baseline', async () => {
    if (!caseDatabase) throw new Error('case database unavailable');
    await caseDatabase.adminPool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,host_id)
      VALUES('Steven',$1,$2,$3)`, [ALIAS, RUNTIME, REMOTE]);
    await expect(assertIdentity(LEGACY)).rejects.toMatchObject(MISMATCH);
  });

  it('fences a connected V3 on heartbeat after placement changes to V4', async () => {
    await seedAgent(REMOTE);
    const lease = await repository.acquireLease('Steven', ALIAS, 'v3-before-move', [], 60_000, { identity: LEGACY });
    if (!caseDatabase) throw new Error('case database unavailable');
    await caseDatabase.adminPool.query("UPDATE agents SET runtime_mode='container' WHERE alias=$1", [ALIAS]);
    await expect(repository.heartbeat('Steven', ALIAS, 'v3-before-move', 1, 60_000,
      lease.connection_token, undefined, LEGACY)).rejects.toMatchObject(MISMATCH);
    expect((await pool.query<{ metadata: { phase: string } }>(`SELECT metadata FROM audit_events
      WHERE actor_alias=$1 AND action='connection.lease.rejected' AND decision='deny'`, [ALIAS])).rows)
      .toEqual([{ metadata: { reason: 'consumer_placement_mismatch', phase: 'heartbeat' } }]);
  });

  it('keeps the seeded baseline immutable and the company host foreign key active', async () => {
    await seedAgent(REMOTE, REMOTE);
    if (!caseDatabase) throw new Error('case database unavailable');
    await expect(caseDatabase.adminPool.query(`UPDATE fleet_runtime_identities
      SET baseline_state='{}' WHERE runtime_key=$1`, [RUNTIME])).rejects.toThrow('fleet runtime identities are permanent');
    await expect(caseDatabase.adminPool.query('DELETE FROM fleet_hosts WHERE host_id=$1', [REMOTE]))
      .rejects.toMatchObject({ code: '23503', constraint: 'agents_host_company_fkey' });
    await expect(assertIdentity(LEGACY)).resolves.toBeUndefined();
  });

  it('auto-registers a host in a single-company catalog without proving V3 socket provenance', async () => {
    await seedAgent(REMOTE);
    if (!caseDatabase) throw new Error('case database unavailable');
    await caseDatabase.adminPool.query("UPDATE agents SET host_id='zz-canary-newhost' WHERE alias=$1", [ALIAS]);
    expect((await pool.query<{ company_id: string }>(
      "SELECT company_id FROM fleet_hosts WHERE host_id='zz-canary-newhost'")).rows).toEqual([{ company_id: 'humanizar' }]);
    await expect(assertIdentity(LEGACY)).resolves.toBeUndefined();
  });
});
