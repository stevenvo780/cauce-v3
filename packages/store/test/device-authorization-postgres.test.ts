import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations, createPool, lockCompanyAuthority, PostgresDeviceAuthorizationStore, purgeCompany, registerCompany, withTransaction,
  type DatabasePool, type DeviceAuthorizationDecision, type DeviceAuthorizationIdentity,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { provisionTestLogin, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let runtime: DatabasePool | undefined;
let store: PostgresDeviceAuthorizationStore;
let actors: CompanyIsolationFixture;
const stamp = 'a'.repeat(43);
const verify = (candidate: string): boolean => candidate === stamp;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  admin = current.adminPool;
  runtime = createPool(await provisionTestLogin(admin, current.adminUrl, 'cauce_device_test', 'cauce_runtime'));
  store = new PostgresDeviceAuthorizationStore(runtime);
  actors = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [actors.leon]);
});
afterEach(async () => { await runtime?.end(); runtime = undefined; await current?.close(); current = undefined; });
afterAll(async () => {
  if (database) { await database.pool.end(); await database.container.stop(); }
});

function actor(humanId = actors.leon, activeCompany = 'praxis'): DeviceAuthorizationIdentity {
  return { humanId, tenantId: 'PraxisHub', actorAlias: 'company_admin', activeCompany, credentialStamp: stamp };
}

async function pending(): Promise<{ device: string; user: string; id: string }> {
  const device = hash(randomUUID()); const user = hash(randomUUID());
  const request = await store.create({ deviceCodeHash: device, userCodeHash: user,
    clientName: 'zz-canary-device-cli', maskedIp: '192.0.2.0/24' });
  return { device, user, id: request.id };
}

function decision(userCodeHash: string, value: 'approve' | 'deny' = 'approve'): DeviceAuthorizationDecision {
  return { userCodeHash, decision: value, ...actor(), verifyCredentialStamp: verify, sessionExpiresAtMs: Date.now()+60_000 };
}

async function allowPoll(id: string): Promise<void> {
  await admin.query("UPDATE device_authorizations SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
}

describe('device authorization with real PostgreSQL', () => {
  it('persists hashes and request metadata, and issues only the approver identity once', async () => {
    const codes = await pending();
    expect(await store.lookup(codes.user)).toMatchObject({ id: codes.id, clientName: 'zz-canary-device-cli', maskedIp: '192.0.2.0/24', interval: 5 });
    expect(await store.decide(decision(codes.user))).toBe('approved');
    expect(await store.lookup(codes.user)).toBeUndefined();
    expect(await store.decide(decision(codes.user))).toBe('invalid_request');
    await allowPoll(codes.id);
    expect(await store.poll(codes.device, verify)).toEqual({ status: 'approved', ...actor() });
    expect(await store.poll(codes.device, verify)).toEqual({ status: 'invalid_grant' });
    const audit = (await admin.query<{ action: string; metadata: Record<string, unknown>; actor_human_id: string | null; company_id: string | null }>(
      "SELECT action,metadata,actor_human_id,company_id FROM audit_events WHERE action LIKE 'auth.device.%' ORDER BY id",
    )).rows;
    expect(audit.map(row => row.action)).toEqual(['auth.device.requested', 'auth.device.approved', 'auth.device.redeemed']);
    expect(audit[0]).toMatchObject({ actor_human_id: null, company_id: null });
    expect(audit[2]).toMatchObject({ actor_human_id: actors.leon, company_id: 'praxis' });
    expect(audit.every(row => Object.keys(row.metadata).join() === 'device_authorization_id')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(codes.device);
    expect(JSON.stringify(audit)).not.toContain(codes.user);
  });

  it('allows a single winner when two callers redeem the same grant concurrently', async () => {
    const codes = await pending();
    await store.decide(decision(codes.user)); await allowPoll(codes.id);
    const results = await Promise.all([store.poll(codes.device, verify), store.poll(codes.device, verify)]);
    expect(results.map(result => result.status).sort()).toEqual(['approved', 'invalid_grant']);
    expect((await admin.query("SELECT count(*)::int AS count FROM audit_events WHERE action='auth.device.redeemed'")).rows[0])
      .toEqual({ count: 1 });
  });

  it('denies permanently and cannot reapprove a rejected request', async () => {
    const codes = await pending();
    expect(await store.decide(decision(codes.user, 'deny'))).toBe('denied');
    expect(await store.decide(decision(codes.user))).toBe('invalid_request');
    expect(await store.poll(codes.device, verify)).toEqual({ status: 'access_denied' });
    expect((await admin.query("SELECT action FROM audit_events WHERE action='auth.device.denied'")).rowCount).toBe(1);
    await expect(admin.query("UPDATE device_authorizations SET state='approved' WHERE id=$1", [codes.id])).rejects.toThrow('immutable');
  });

  it('sweeps expired requests on reads and refuses authorization and redemption', async () => {
    const device = hash(randomUUID()); const user = hash(randomUUID());
    await admin.query(`INSERT INTO device_authorizations(device_code_hash,user_code_hash,client_name,masked_ip,created_at,expires_at)
      VALUES($1,$2,'zz-canary-expired','192.0.2.0/24',clock_timestamp()-interval '11 minutes',clock_timestamp()-interval '1 minute')`, [device, user]);
    expect(await store.lookup(user)).toBeUndefined();
    expect(await store.decide(decision(user))).toBe('expired_token');
    expect(await store.poll(device, verify)).toEqual({ status: 'expired_token' });
    expect((await admin.query('SELECT state FROM device_authorizations WHERE device_code_hash=$1', [device])).rows[0])
      .toEqual({ state: 'expired' });
  });

  it('stores slow_down and increasing intervals durably across store instances', async () => {
    const codes = await pending();
    expect(await store.poll(codes.device, verify)).toEqual({ status: 'slow_down', interval: 10 });
    if (!runtime) throw new Error('test database absent');
    const other = new PostgresDeviceAuthorizationStore(runtime);
    expect(await other.poll(codes.device, verify)).toEqual({ status: 'slow_down', interval: 15 });
    await allowPoll(codes.id);
    expect(await other.poll(codes.device, verify)).toEqual({ status: 'authorization_pending', interval: 15 });
    expect(await store.poll(hash(randomUUID()), verify)).toEqual({ status: 'invalid_grant' });
  });

  it('rejects a forged active company and invalid credential stamps before binding approval', async () => {
    const codes = await pending();
    await expect(store.decide({ ...decision(codes.user), activeCompany: 'humanizar' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(store.decide({ ...decision(codes.user), verifyCredentialStamp: () => false })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(store.decide({ ...decision(codes.user), sessionExpiresAtMs: Date.now()-1 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await store.lookup(codes.user)).toMatchObject({ id: codes.id });
    expect(await store.decide(decision(codes.user))).toBe('approved');
    await allowPoll(codes.id);
    expect(await store.poll(codes.device, () => false)).toEqual({ status: 'access_denied' });
  });

  it('revalidates person, membership revision and requested platform company before redemption', async () => {
    const codes = await pending(); await store.decide(decision(codes.user));
    await admin.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [actors.leon]);
    await allowPoll(codes.id);
    expect(await store.poll(codes.device, verify)).toEqual({ status: 'access_denied' });
    const disabled = await pending();
    await store.decide({ ...decision(disabled.user), humanId: actors.miguel, tenantId: 'Miguel', actorAlias: 'janus', activeCompany: 'humanizar' });
    await admin.query('UPDATE console_users SET active=false WHERE id=$1', [actors.miguel]);
    await allowPoll(disabled.id);
    expect(await store.poll(disabled.device, verify)).toEqual({ status: 'access_denied' });
    await admin.query('UPDATE console_users SET active=true WHERE id=$1', [actors.miguel]);
    const platform = await pending();
    const identity: DeviceAuthorizationIdentity = { humanId: actors.steven, tenantId: 'Steven', actorAlias: 'kant', activeCompany: 'praxis', credentialStamp: stamp };
    expect(await store.decide({ ...decision(platform.user), ...identity })).toBe('approved');
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actors.miguel]);
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.steven]);
    await allowPoll(platform.id);
    expect(await store.poll(platform.device, verify)).toEqual({ status: 'access_denied' });
  });

  it('does not revive grants after an account or membership is revoked and restored', async () => {
    const identity: DeviceAuthorizationIdentity = { humanId: actors.miguel, tenantId: 'Miguel', actorAlias: 'janus', activeCompany: 'humanizar', credentialStamp: stamp };
    const disabled = await pending();
    await store.decide({ ...decision(disabled.user), ...identity });
    await admin.query('UPDATE console_users SET active=false WHERE id=$1', [actors.miguel]);
    await admin.query('UPDATE console_users SET active=true WHERE id=$1', [actors.miguel]);
    await allowPoll(disabled.id);
    expect(await store.poll(disabled.device, verify)).toEqual({ status: 'access_denied' });
    const removed = await pending();
    await store.decide({ ...decision(removed.user), ...identity });
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [actors.miguel]);
    await admin.query('UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL WHERE human_id=$1', [actors.miguel]);
    await allowPoll(removed.id);
    expect(await store.poll(removed.device, verify)).toEqual({ status: 'access_denied' });
  });

  it('audits denial after a platform target company is purged without reviving or blocking the grant', async () => {
    const target = 'zz-canary-device-target';
    await registerCompany(admin, { email: 'zz-canary-device@example.test', name: 'Device owner',
      passwordHash: '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==', company: { slug: target, name: 'Device target' } });
    const codes = await pending();
    await store.decide({ ...decision(codes.user), humanId: actors.steven, tenantId: 'Steven', actorAlias: 'kant', activeCompany: target });
    await admin.query('SELECT cauce_platform_set_company_state($1,$2,$3)', [target, 'retired', actors.steven]);
    const directory = await mkdtemp(join(tmpdir(), 'zz-canary-device-purge-'));
    try {
      await withTransaction(admin, async client => {
        const authority = await lockCompanyAuthority(client, { humanId: actors.steven, tenant: 'Steven', alias: 'kant' });
        return purgeCompany(client, authority, target, { confirmation: target }, async (_snapshot, serialized) => {
          const path = join(directory, 'backup.json'); await writeFile(path, serialized, { mode: 0o600 }); return path;
        });
      });
      await allowPoll(codes.id);
      expect(await store.poll(codes.device, verify)).toEqual({ status: 'access_denied' });
      expect((await admin.query(`SELECT company_id,actor_human_id,tenant_id FROM audit_events
        WHERE action='auth.device.denied' AND metadata->>'device_authorization_id'=$1`, [codes.id])).rows[0])
        .toEqual({ company_id: null, actor_human_id: actors.steven, tenant_id: 'Steven' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps the down migration reversible and refuses to destroy a live authorization', async () => {
    const down = await readFile(new URL('../migrations/down/089_device_authorizations.sql', import.meta.url), 'utf8');
    const codes = await pending();
    await expect(withTransaction(admin, client => client.query(down))).rejects.toThrow('wait for pending device authorizations');
    expect(await store.lookup(codes.user)).toMatchObject({ id: codes.id });
    await store.decide(decision(codes.user, 'deny'));
    await withTransaction(admin, client => client.query(down));
    expect((await admin.query("SELECT to_regclass('device_authorizations') AS name")).rows[0]).toEqual({ name: null });
    await applyMigrations(admin);
    expect(await store.create({ deviceCodeHash: hash(randomUUID()), userCodeHash: hash(randomUUID()),
      clientName: 'zz-canary-reapplied', maskedIp: '192.0.2.0/24' })).toMatchObject({ interval: 5 });
  });
});
