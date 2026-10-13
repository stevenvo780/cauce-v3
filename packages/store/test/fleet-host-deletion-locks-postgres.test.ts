import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentQuotaOperationsRepository, deleteFleetHost, FleetOperationsRepository, HostEnrollmentRepository,
  hostEnrollmentMessage, hostRequestMessage, lockCompanyAuthority, registerCompany,
  type CompanyAuthoritySource, type DatabaseClient, type DatabasePool, type RegisteredCompany,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const HOST = 'zz-canary-locks-host';
const quotaDescriptor = JSON.stringify({ schema_version: 1, harness: 'codex',
  operations: { execute: 'native-execution', quota: 'quota-collector' },
  context: { native_document: 'AGENTS.md', max_bytes: 65_536 },
  provider: { quota_argv: ['/usr/local/bin/zz-canary-quota-reader'] } });
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let company: RegisteredCompany;
let hosts: HostEnrollmentRepository;
let quota: AgentQuotaOperationsRepository;
let keys: ReturnType<typeof generateKeyPairSync>;
let descriptors: string; let approvalsFile: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  descriptors = await mkdtemp(join(tmpdir(), 'zz-canary-locks-descriptors-')); approvalsFile = join(descriptors, 'approvals.json');
  await writeFile(join(descriptors, 'codex.json'), quotaDescriptor);
  await writeFile(approvalsFile, JSON.stringify({ codex: createHash('sha256').update(quotaDescriptor).digest('hex') }));
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', approvalsFile);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', descriptors);
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.pool;
  company = await registerCompany(pool, { email: 'host-locks@example.test', name: 'Host locks',
    passwordHash: '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==', company: { slug: 'host_locks', name: 'Host locks' } });
  await admin().query('INSERT INTO platform_admins(human_id) VALUES($1)', [company.user.id]);
  hosts = new HostEnrollmentRepository(pool); quota = new AgentQuotaOperationsRepository(pool);
  keys = generateKeyPairSync('ed25519');
  const invitation = await hosts.invite(authority, { host_id: HOST, display_name: 'Lock host' });
  await hosts.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token,
    public_key: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64') });
});
afterEach(async () => {
  try { await current?.close(); } finally {
    current = undefined; vi.unstubAllEnvs();
    if (descriptors) await rm(descriptors, { recursive: true, force: true });
  }
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function admin() { return requireValue(current, 'case database').adminPool; }
const authority: CompanyAuthoritySource = client => lockCompanyAuthority(client,
  { tenant: company.hub.id, alias: 'owner', humanId: company.user.id });
function remove() { return deleteFleetHost(pool, HOST, 1, { authority, approvedHostIds: [] }); }
function gate() {
  let release: () => void = () => { throw new Error('gate is not initialized'); };
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
async function pid(client: DatabaseClient) {
  return requireValue((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'backend').pid;
}
async function blockedBy(blocker: number) {
  return (await admin().query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND $1=ANY(pg_blocking_pids(pid))`, [blocker])).rowCount !== 0;
}
function channelPacket() {
  const packet = { host_id: HOST, company_id: company.company.id, issued_at: Date.now(),
    nonce: randomBytes(32).toString('hex'), payload: { resource: 'fleet_operation', action: 'claim' }, proof: '' };
  packet.proof = sign(null, Buffer.from(hostRequestMessage('POST', `/v3/fleet/hosts/${HOST}/channel`, packet)), keys.privateKey).toString('base64');
  return packet;
}
async function placedReader() {
  await admin().query(`UPDATE fleet_host_identities SET capabilities='{"fleet_executor":true}',capabilities_seen_at=now() WHERE host_id=$1`, [HOST]);
  await admin().query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,runtime_mode,host_id,container_name,
    runtime_user,home_directory,state_directory,runtime_key,systemd_user)
    VALUES($1,'reader',true,'codex','container',$2,'zz-canary-locks-reader','dev','/home/dev','/home/dev/.cauce','zz-canary-locks-reader','stev')`,
  [company.hub.id, HOST]);
  return { tenant_id: company.hub.id, alias: 'reader' };
}

describe('fleet host deletion lock concurrency on PostgreSQL', () => {
  it('returns a Spanish conflict without partial effects when the host version changed', async () => {
    await expect(deleteFleetHost(pool, HOST, 0, { authority, approvedHostIds: [] })).rejects.toMatchObject({
      code: 'conflict', message: 'Otro operador cambió esta computadora; relee antes de reintentar.',
    });
    expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
    expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(1);
    expect((await admin().query("SELECT 1 FROM audit_events WHERE action='fleet_host.delete' AND metadata->>'host_id'=$1", [HOST])).rowCount).toBe(0);
  });

  it('returns conflict without partial effects when the host row lock times out', async () => {
    const holder = await admin().connect(); let deletion: Promise<void> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT host_id FROM fleet_hosts WHERE host_id=$1 FOR NO KEY UPDATE', [HOST]);
      const holderPid = await pid(holder);
      deletion = remove(); deletion.catch(() => undefined);
      await expect.poll(() => blockedBy(holderPid), { timeout: 1_500 }).toBe(true);
      await expect(deletion).rejects.toMatchObject({ code: 'conflict',
        message: 'La computadora tiene solicitudes u operaciones en curso; vuelve a intentar la baja.' });
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query("SELECT 1 FROM audit_events WHERE action='fleet_host.delete' AND metadata->>'host_id'=$1", [HOST])).rowCount).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); await deletion?.catch(() => undefined); }
    await remove();
    expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(0);
  }, 10_000);

  it('returns conflict without partial effects when the host row lock deadlocks', async () => {
    const holder = await admin().connect(); let deletion: Promise<void> | undefined;
    let authorityLock: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN; SET LOCAL deadlock_timeout='10s'");
      await holder.query('SELECT host_id FROM fleet_hosts WHERE host_id=$1 FOR NO KEY UPDATE', [HOST]);
      const holderPid = await pid(holder);
      const started = Date.now();
      deletion = remove(); deletion.catch(() => undefined);
      await expect.poll(() => blockedBy(holderPid), { timeout: 1_500 }).toBe(true);
      // The probe delays its detector so the deletion detects the cycle on the host lock.
      authorityLock = holder.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [company.hub.id]);
      authorityLock.catch(() => undefined);
      const results = await Promise.allSettled([deletion, authorityLock]);
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'conflict',
        message: 'La computadora tiene solicitudes u operaciones en curso; vuelve a intentar la baja.' } });
      expect(results[1]).toMatchObject({ status: 'fulfilled' });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query("SELECT 1 FROM audit_events WHERE action='fleet_host.delete' AND metadata->>'host_id'=$1", [HOST])).rowCount).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined); holder.release();
      await Promise.allSettled([deletion, authorityLock]);
    }
    await remove();
    expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(0);
  }, 10_000);

  it('returns conflict without partial effects when the identity row is occupied', async () => {
    const holder = await admin().connect(); let deletion: Promise<void> | undefined; let outcome: unknown = 'waiting';
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT host_id FROM fleet_host_identities WHERE host_id=$1 FOR NO KEY UPDATE', [HOST]);
      deletion = remove();
      deletion.then(() => { outcome = 'deleted'; }, (error: unknown) => { outcome = error; });
      await expect.poll(() => outcome, { timeout: 1_500 }).toMatchObject({ code: 'conflict' });
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query("SELECT 1 FROM audit_events WHERE action='fleet_host.delete' AND metadata->>'host_id'=$1", [HOST])).rowCount).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); await deletion?.catch(() => undefined); }
    await remove();
    expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(0);
  });

  it('lets the real signed channel claim fleet work while deletion waits for the authenticated host', async () => {
    const admitted = gate(); const proceed = gate(); let channelPid = 0;
    const request = hosts.request(HOST, 'POST', `/v3/fleet/hosts/${HOST}/channel`, channelPacket(), async client => {
      channelPid = await pid(client); admitted.release(); await proceed.wait;
      return new FleetOperationsRepository(pool).forTransaction(client).claim(`host-${HOST}`, HOST, 30_000, company.company.id);
    });
    request.catch(() => undefined);
    let deletion: Promise<void> | undefined;
    try {
      await admitted.wait; deletion = remove(); deletion.catch(() => undefined);
      await expect.poll(() => blockedBy(channelPid), { timeout: 5_000 }).toBe(true);
      proceed.release();
      const results = await Promise.allSettled([request, deletion]);
      expect(results).toEqual([{ status: 'fulfilled', value: null }, { status: 'fulfilled', value: undefined }]);
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(0);
      expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(0);
    } finally { proceed.release(); await Promise.allSettled([request, deletion]); }
  });

  it('returns conflict instead of deadlocking against the real enqueue of an expired quota operation', async () => {
    const target = await placedReader(); const card = await quota.snapshot(authority, target);
    const first = await quota.enqueue(authority, { ...target, expected_revision: card.revision, idempotency_key: 'zz-canary-locks-expired' });
    await admin().query("UPDATE agent_quota_operations SET expires_at=now()-interval '1 second' WHERE id=$1", [first.id]);
    await admin().query(`CREATE FUNCTION pause_expired_quota_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.idempotency_key='zz-canary-locks-expired' THEN PERFORM pg_advisory_xact_lock(783003099); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pause_expired_quota_enqueue AFTER UPDATE ON agent_quota_operations
        FOR EACH ROW EXECUTE FUNCTION pause_expired_quota_enqueue()`);
    const barrier = await admin().connect(); let enqueue: ReturnType<AgentQuotaOperationsRepository['enqueue']> | undefined;
    let deletion: Promise<void> | undefined; let deletionSettled = false;
    try {
      await barrier.query('BEGIN'); await barrier.query('SELECT pg_advisory_xact_lock(783003099)');
      const barrierPid = await pid(barrier);
      enqueue = quota.enqueue(authority, { ...target, expected_revision: card.revision, idempotency_key: 'zz-canary-locks-new' });
      enqueue.catch(() => undefined);
      await expect.poll(() => blockedBy(barrierPid), { timeout: 5_000 }).toBe(true);
      const enqueuePid = requireValue((await admin().query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [barrierPid])).rows[0], 'enqueue backend').pid;
      deletion = remove();
      deletion.then(() => { deletionSettled = true; }, () => { deletionSettled = true; });
      await expect.poll(async () => deletionSettled || await blockedBy(enqueuePid), { timeout: 5_000 }).toBe(true);
      await barrier.query('COMMIT');
      const results = await Promise.allSettled([deletion, enqueue]);
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
      expect(results[1]).toMatchObject({ status: 'fulfilled', value: { status: 'pending', duplicate: false } });
      expect((await admin().query('SELECT status,error_code FROM agent_quota_operations WHERE id=$1', [first.id])).rows)
        .toEqual([{ status: 'failed', error_code: 'EXPIRED' }]);
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
      expect((await admin().query("SELECT 1 FROM audit_events WHERE action='fleet_host.delete' AND metadata->>'host_id'=$1", [HOST])).rowCount).toBe(0);
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined); barrier.release();
      await Promise.allSettled([enqueue, deletion]);
    }
  });

  it('fences a real signed channel claim when deletion locks the host before the request', async () => {
    await admin().query(`CREATE FUNCTION pause_host_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(783003099); RETURN OLD; END $$;
      CREATE TRIGGER pause_host_deletion BEFORE DELETE ON fleet_hosts FOR EACH ROW EXECUTE FUNCTION pause_host_deletion()`);
    const barrier = await admin().connect(); let deletion: Promise<void> | undefined;
    let request: Promise<unknown> | undefined;
    try {
      await barrier.query('BEGIN'); await barrier.query('SELECT pg_advisory_xact_lock(783003099)');
      const barrierPid = await pid(barrier); deletion = remove(); deletion.catch(() => undefined);
      await expect.poll(() => blockedBy(barrierPid), { timeout: 5_000 }).toBe(true);
      const deletionPid = requireValue((await admin().query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [barrierPid])).rows[0], 'deletion backend').pid;
      request = hosts.request(HOST, 'POST', `/v3/fleet/hosts/${HOST}/channel`, channelPacket(),
        client => new FleetOperationsRepository(pool).forTransaction(client).claim(`host-${HOST}`, HOST, 30_000, company.company.id));
      request.catch(() => undefined);
      await expect.poll(() => blockedBy(deletionPid), { timeout: 5_000 }).toBe(true);
      await barrier.query('COMMIT');
      const results = await Promise.allSettled([deletion, request]);
      expect(results[0]).toEqual({ status: 'fulfilled', value: undefined });
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'forbidden' } });
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(0);
      expect((await admin().query('SELECT 1 FROM fleet_host_identities WHERE host_id=$1', [HOST])).rowCount).toBe(0);
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined); barrier.release();
      await Promise.allSettled([deletion, request]);
    }
  });

  it.each(['done', 'failed'] as const)('refuses deletion while the real quota host fence holds a %s operation', async status => {
    const target = await placedReader(); const card = await quota.snapshot(authority, target);
    await quota.enqueue(authority, { ...target, expected_revision: card.revision, idempotency_key: 'zz-canary-locks-terminal' });
    const claim = requireValue(await quota.claim('zz_canary_worker', HOST, 30_000, company.company.id), 'quota claim');
    if (status === 'done') {
      await quota.finish(claim, { status: 'unsupported', reason: 'quota_reader_unavailable', operation_id: claim.id,
        tenant: target.tenant_id, alias: target.alias, host_id: HOST, container_name: 'zz-canary-locks-reader', harness: 'codex',
        captured_at: new Date().toISOString() });
    } else await quota.fail(claim, 'STEP_FAILED');
    await admin().query('UPDATE agents SET enabled=false,retired_at=now(),purged_at=now() WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
    const holder = await pool.connect(); let deletion: Promise<void> | undefined; let outcome: unknown = 'waiting';
    try {
      await holder.query('BEGIN');
      await quota.assertHostScopeInTransaction(holder, claim, { host_id: HOST, company_id: company.company.id, allowTerminal: true });
      deletion = remove();
      deletion.then(() => { outcome = 'deleted'; }, (error: unknown) => { outcome = error; });
      await expect.poll(() => outcome, { timeout: 1_500 }).toMatchObject({ code: 'conflict' });
      expect((await admin().query('SELECT status FROM agent_quota_operations WHERE id=$1', [claim.id])).rows).toEqual([{ status }]);
      expect((await admin().query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [HOST])).rowCount).toBe(1);
    } finally { await holder.query('ROLLBACK'); holder.release(); await deletion?.catch(() => undefined); }
    await admin().query('UPDATE agents SET host_id=NULL WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias]);
    await remove();
    expect((await admin().query('SELECT 1 FROM agent_quota_operations WHERE id=$1', [claim.id])).rowCount).toBe(0);
  });
});
