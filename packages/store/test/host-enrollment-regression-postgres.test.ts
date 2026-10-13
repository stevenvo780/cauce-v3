import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, HostEnrollmentRepository, hostEnrollmentMessage, lockCompanyAuthority, registerCompany,
  type CompanyAuthoritySource, type DatabasePool, type HostInvitation, type RegisteredCompany } from '../src/index.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { buildGateway } from '../../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { registerSetupOwner } from '../../../services/gateway/src/fleet/host-setup.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let north: RegisteredCompany;
let south: RegisteredCompany;
let repository: HostEnrollmentRepository;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const passwordHash = '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==';
  north = await registerCompany(pool, { email: 'north@example.test', name: 'North', passwordHash, company: { slug: 'north', name: 'North' } });
  south = await registerCompany(pool, { email: 'south@example.test', name: 'South', passwordHash, company: { slug: 'south', name: 'South' } });
  repository = new HostEnrollmentRepository(pool);
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const source = (company: RegisteredCompany): CompanyAuthoritySource => client => lockCompanyAuthority(client,
  { tenant: company.hub.id, alias: 'owner', humanId: company.user.id });
function proof(invitation: HostInvitation, pair = generateKeyPairSync('ed25519')) {
  return { invitation_token: invitation.invitation_token, public_key: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), pair.privateKey).toString('base64') };
}
async function waitForLock(predicate: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${predicate}`)).rowCount) return;
    await delay(25);
  }
  throw new Error('the enrollment request did not wait for the expected lock');
}

describe('host enrollment compatibility and company isolation', () => {
  it('accepts exactly the fleet host metadata limits and rejects larger invitations before persisting them', async () => {
    const invitation = await repository.invite(source(north), { host_id: 'north-boundary', display_name: 'n'.repeat(80), notes: 'x'.repeat(500) });
    await expect(repository.claim(invitation.enrollment_id, proof(invitation))).resolves.toMatchObject({ state: 'enrolled' });
    for (const metadata of [{ display_name: 'n'.repeat(81) }, { display_name: 'Valid', notes: 'x'.repeat(501) }]) {
      await expect(repository.invite(source(north), { host_id: 'north-oversized', ...metadata })).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect((await admin.query("SELECT 1 FROM fleet_host_enrollments WHERE host_id='north-oversized'")).rowCount).toBe(0);
  });

  it('enrolls a preexisting company computer without replacing its metadata, version or placements', async () => {
    await admin.query(`INSERT INTO fleet_hosts(host_id,company_id,display_name,notes,version,controller_status)
      VALUES('legacy-host','north','Existing computer','Keep these notes',7,'reachable')`);
    await admin.query("UPDATE agents SET host_id='legacy-host' WHERE tenant_id=$1 AND alias='owner'", [north.hub.id]);
    const before = (await admin.query("SELECT * FROM fleet_hosts WHERE host_id='legacy-host'")).rows;
    const invitation = await repository.invite(source(north), { host_id: 'legacy-host', display_name: 'Invitation name', notes: 'Invitation notes' });
    const claims = await Promise.all([1, 2].map(() => repository.claim(invitation.enrollment_id, proof(invitation, pair))));
    expect(claims[0]).toEqual(claims[1]);
    expect((await admin.query("SELECT * FROM fleet_hosts WHERE host_id='legacy-host'")).rows).toEqual(before);
    expect((await admin.query("SELECT host_id FROM agents WHERE tenant_id=$1 AND alias='owner'", [north.hub.id])).rows)
      .toEqual([{ host_id: 'legacy-host' }]);
    await expect(repository.invite(source(north), { host_id: 'legacy-host', display_name: 'Replacement' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await admin.query("SELECT count(*)::int AS n FROM fleet_host_identities WHERE host_id='legacy-host'")).rows).toEqual([{ n: 1 }]);
  });
  const pair = generateKeyPairSync('ed25519');

  it('answers foreign legacy computers exactly like absent computers and preserves their rows', async () => {
    await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('legacy-foreign','south','Foreign')");
    const before = (await admin.query("SELECT * FROM fleet_hosts WHERE company_id='south'")).rows;
    const rejected = await Promise.all(['legacy-foreign', 'legacy-absent'].map(host_id =>
      repository.invite(source(north), { host_id, display_name: 'Probe' }).catch((error: unknown) => error)));
    expect(rejected[0]).toMatchObject({ code: 'forbidden', message: (rejected[1] as Error).message });
    expect((await admin.query("SELECT * FROM fleet_hosts WHERE company_id='south'")).rows).toEqual(before);
  });

  it('does not reveal foreign registered hosts or pending invitations even within the caller naming partition', async () => {
    await admin.query("INSERT INTO platform_admins(human_id) VALUES($1)", [south.user.id]);
    await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('north-foreign','south','Foreign')");
    const foreign = await repository.invite(source(south), { host_id: 'north-pending', display_name: 'Foreign pending' });
    const before = (await admin.query("SELECT * FROM fleet_hosts WHERE company_id='south'")).rows;
    for (const host_id of ['north-foreign', 'north-pending', 'north-absent']) {
      expect(await repository.invite(source(north), { host_id, display_name: 'Probe' })).toMatchObject({ company_id: 'north', state: 'pending' });
    }
    expect((await admin.query('SELECT state FROM fleet_host_enrollments WHERE id=$1', [foreign.enrollment_id])).rows).toEqual([{ state: 'pending' }]);
    expect((await admin.query("SELECT * FROM fleet_hosts WHERE company_id='south'")).rows).toEqual(before);
  });

  it('refuses claiming a foreign or disabled computer without adding an identity or consuming the invitation', async () => {
    await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('north-foreign','south','Foreign')");
    for (const host_id of ['north-foreign', 'north-disabled']) {
      const invitation = await repository.invite(source(north), { host_id, display_name: 'Probe' });
      if (host_id === 'north-disabled') await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name,enabled) VALUES($1,'north','Disabled',false)", [host_id]);
      await expect(repository.claim(invitation.enrollment_id, proof(invitation))).rejects.toMatchObject({ code: 'forbidden', message: 'host invitation is unavailable' });
      expect((await admin.query('SELECT state FROM fleet_host_enrollments WHERE id=$1', [invitation.enrollment_id])).rows).toEqual([{ state: 'pending' }]);
      expect((await admin.query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [host_id])).rowCount).toBe(0);
    }
  });

  it('keeps concurrent invitations exclusive within one company and refuses replacing an existing identity', async () => {
    const invites = await Promise.allSettled([1, 2].map(() => repository.invite(source(north), { host_id: 'north-race', display_name: 'Race' })));
    const invitation = invites.find(result => result.status === 'fulfilled');
    if (invitation?.status !== 'fulfilled') throw new Error('invitation absent');
    expect(invites.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(invites.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const receipt = await repository.claim(invitation.value.enrollment_id, proof(invitation.value, pair));
    await expect(repository.claim(invitation.value.enrollment_id, proof(invitation.value))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await admin.query('SELECT key_fingerprint FROM fleet_host_identities WHERE host_id=$1', [receipt.host_id])).rows)
      .toEqual([{ key_fingerprint: receipt.key_fingerprint }]);
  });

  it('does not hold the invitation while waiting for a legacy host being removed or disabled', async () => {
    await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('legacy-locked','north','Existing')");
    const invitation = await repository.invite(source(north), { host_id: 'legacy-locked', display_name: 'Existing' });
    const holder = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query("SELECT 1 FROM fleet_hosts WHERE host_id='legacy-locked' FOR UPDATE");
      pending = repository.claim(invitation.enrollment_id, proof(invitation)).catch((error: unknown) => error);
      await waitForLock("query LIKE '%fleet_hosts%'");
      await holder.query("SET LOCAL lock_timeout='1s'");
      await holder.query("UPDATE fleet_host_enrollments SET state='revoked' WHERE id=$1", [invitation.enrollment_id]);
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ code: 'conflict' });
      expect((await admin.query("SELECT 1 FROM fleet_host_identities WHERE host_id='legacy-locked'")).rowCount).toBe(0);
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); await pending; }
  });

  it('refuses an invitation when a concurrent claim enrolls the host after its initial identity check', async () => {
    const first = await repository.invite(source(north), { host_id: 'north-interleaved', display_name: 'Computer' });
    await admin.query(`CREATE FUNCTION pause_enrollment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(783003179); RETURN NEW; END $$;
      CREATE TRIGGER pause_enrollment_insert BEFORE INSERT ON fleet_host_enrollments FOR EACH ROW EXECUTE FUNCTION pause_enrollment_insert()`);
    const holder = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783003179)');
      pending = repository.invite(source(north), { host_id: first.host_id, display_name: 'Replacement' })
        .then(() => ({ code: 'accepted' }), (error: unknown) => error);
      await waitForLock("query LIKE '%INSERT INTO fleet_host_enrollments%'");
      await repository.claim(first.enrollment_id, proof(first));
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ code: 'conflict' });
      expect((await admin.query("SELECT state FROM fleet_host_enrollments WHERE host_id='north-interleaved'")).rows).toEqual([{ state: 'enrolled' }]);
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); await pending; }
  });

  it('returns HTTP 400 for invalid metadata and HTTP 201 for a legacy computer owned by the session company', async () => {
    app = await buildGateway({ pool, repository: new CauceRepository(pool), consoleOrigins: ['http://localhost'], logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 59) }) });
    const owner = await registerSetupOwner(app, 'enrollment');
    const invite = (host_id: string, display_name: string, notes = '') => app!.inject({ method: 'POST',
      url: '/v3/console/fleet/hosts/enrollments', headers: { ...owner }, payload: { host_id, display_name, notes } });
    for (const [name, notes] of [['n'.repeat(81), ''], ['Valid', 'x'.repeat(501)]] as const) {
      const invalid = await invite('enrollment-invalid', name, notes);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'invalid_request', message: 'invalid host enrollment request' });
    }
    await admin.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('legacy-http','enrollment','Existing')");
    const accepted = await invite('legacy-http', 'Existing');
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ company_id: 'enrollment', state: 'pending' });
  });
});
