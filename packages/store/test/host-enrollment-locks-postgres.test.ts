import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostEnrollmentRepository, hostEnrollmentMessage, hostKeyFingerprint, hostRequestMessage, lockCompanyAuthority, lockFleetRevision,
  registerCompany, type CompanyAuthoritySource, type DatabasePool, type HostInvitation, type RegisteredCompany } from '../src/index.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let north: RegisteredCompany;
let repository: HostEnrollmentRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  north = await registerCompany(pool, { email: 'locks@example.test', name: 'Locks', passwordHash: '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==',
    company: { slug: 'north', name: 'North' } });
  repository = new HostEnrollmentRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const source: () => CompanyAuthoritySource = () => client => lockCompanyAuthority(client, { tenant: north.hub.id, alias: 'owner', humanId: north.user.id });
function keys() { const pair = generateKeyPairSync('ed25519'); return { ...pair, encoded: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }; }
async function enrolled(hostId: string) {
  const pair = keys(); const invitation = await repository.invite(source(), { host_id: hostId, display_name: hostId });
  await repository.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token, public_key: pair.encoded,
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), pair.privateKey).toString('base64') });
  return { invitation, pair };
}
function signed(invitation: HostInvitation, pair: ReturnType<typeof keys>, path: string, payload: Record<string, unknown>) {
  const packet = { host_id: invitation.host_id, company_id: invitation.company_id, issued_at: Date.now(), nonce: randomBytes(32).toString('hex'),
    payload, proof: '' };
  packet.proof = sign(null, Buffer.from(hostRequestMessage('POST', path, packet)), pair.privateKey).toString('base64');
  return packet;
}
const heartbeat = (invitation: HostInvitation, pair: ReturnType<typeof keys>) => signed(invitation, pair, `/v3/fleet/hosts/${invitation.host_id}/heartbeat`,
  { platform: 'linux', cli_version: 'locks', docker_version: null, status: 'reachable' });
async function settled(promise: Promise<unknown>, waitMs: number): Promise<unknown> {
  return Promise.race([promise.then(() => 'accepted', (error: unknown) => error), delay(waitMs, 'waiting')]);
}
async function waitingForFleetRevision(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype='advisory' AND classid=0 AND objid=783003004 AND NOT granted`)).rows[0]?.n;
    if (waiting) return;
    await delay(25);
  }
  throw new Error('the signed request never waited for the fleet revision lock');
}
async function waitingForAuthorityReaders(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM console_users%'`)).rows[0]?.n;
    if (waiting !== undefined && waiting >= count) return;
    await delay(25);
  }
  throw new Error('the enrollment requests never waited for the authority row');
}

describe('host enrollment revocation locks', () => {
  it('answers a locked foreign invitation exactly like an absent invitation without waiting for its row', async () => {
    const south = await registerCompany(pool, { email: 'foreign-locks@example.test', name: 'Foreign locks',
      passwordHash: '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==', company: { slug: 'south', name: 'South' } });
    const foreign = await repository.invite(client => lockCompanyAuthority(client,
      { tenant: south.hub.id, alias: 'owner', humanId: south.user.id }), { host_id: 'south-locked', display_name: 'Foreign' });
    const absent = await repository.revoke(source(), randomUUID()).catch((error: unknown) => error);
    expect(absent).toMatchObject({ code: 'not_found', message: 'host invitation is unavailable' });
    const holder = await admin.connect(); let pending: ReturnType<HostEnrollmentRepository['revoke']> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM fleet_host_enrollments WHERE id=$1 FOR UPDATE', [foreign.enrollment_id]);
      pending = repository.revoke(source(), foreign.enrollment_id); pending.catch(() => undefined);
      expect(await settled(pending, 1_000)).toMatchObject({ code: 'not_found', message: (absent as Error).message });
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); await pending?.catch(() => undefined); }
    expect((await admin.query('SELECT state FROM fleet_host_enrollments WHERE id=$1', [foreign.enrollment_id])).rows).toEqual([{ state: 'pending' }]);
    expect((await admin.query("SELECT 1 FROM audit_events WHERE action='fleet_host.enrollment.revoke'")).rowCount).toBe(0);
  });

  it('keeps the invitation unlocked while claim and revoke wait for authority and finishes without a deadlock', async () => {
    const invitation = await repository.invite(source(), { host_id: 'north-authority_locked', display_name: 'Computer' });
    const pair = keys(); const holder = await admin.connect();
    let claim: ReturnType<HostEnrollmentRepository['claim']> | undefined;
    let revoke: ReturnType<HostEnrollmentRepository['revoke']> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT 1 FROM console_users WHERE id=$1 FOR UPDATE', [north.user.id]);
      claim = repository.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token, public_key: pair.encoded,
        proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), pair.privateKey).toString('base64') });
      claim.catch(() => undefined); await waitingForAuthorityReaders(1);
      revoke = repository.revoke(source(), invitation.enrollment_id); revoke.catch(() => undefined);
      await waitingForAuthorityReaders(2); await holder.query("SET LOCAL lock_timeout='1s'");
      expect((await holder.query('SELECT 1 FROM fleet_host_enrollments WHERE id=$1 FOR UPDATE', [invitation.enrollment_id])).rowCount).toBe(1);
      await holder.query('COMMIT');
      const results = await Promise.allSettled([claim, revoke]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
      expect((await admin.query('SELECT state FROM fleet_host_enrollments WHERE id=$1', [invitation.enrollment_id])).rows)
        .toEqual([{ state: results[0].status === 'fulfilled' ? 'enrolled' : 'revoked' }]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined); holder.release();
      await Promise.allSettled([claim, revoke].filter(request => request !== undefined));
    }
  });
});

describe('signed host request locks', () => {
  it('rejects a forged proof before waiting for the computer row locks', async () => {
    const { invitation } = await enrolled('north-forged_laptop');
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM fleet_host_identities identity JOIN fleet_hosts host USING (host_id) WHERE identity.host_id=$1 FOR UPDATE',
        [invitation.host_id]);
      expect(await settled(repository.heartbeat(invitation.host_id, heartbeat(invitation, keys())), 3_000)).toMatchObject({ code: 'forbidden' });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect((await admin.query('SELECT 1 FROM fleet_host_request_nonces WHERE host_id=$1', [invitation.host_id])).rowCount).toBe(0);
  });

  it('admits a computer only after its proof verifies and before any nonce or report is written', async () => {
    const { invitation, pair } = await enrolled('north-quota_laptop');
    const admitted: string[] = []; const admit = (host: string) => { admitted.push(host); };
    await expect(repository.heartbeat(invitation.host_id, heartbeat(invitation, keys()), admit)).rejects.toMatchObject({ code: 'forbidden' });
    expect(admitted).toEqual([]);
    const spent = new Error('quota spent'); const refuse = () => { throw spent; };
    await expect(repository.heartbeat(invitation.host_id, heartbeat(invitation, pair), refuse)).rejects.toBe(spent);
    const setup = signed(invitation, pair, `/v3/fleet/hosts/${invitation.host_id}/setup`, { action: 'package' });
    await expect(repository.setupPackage(invitation.host_id, setup, () => 'built', refuse)).rejects.toBe(spent);
    expect((await admin.query('SELECT 1 FROM fleet_host_request_nonces WHERE host_id=$1', [invitation.host_id])).rowCount).toBe(0);
    expect((await admin.query('SELECT last_seen_at FROM fleet_host_identities WHERE host_id=$1', [invitation.host_id])).rows)
      .toEqual([{ last_seen_at: null }]);
    expect(await repository.heartbeat(invitation.host_id, heartbeat(invitation, pair), admit)).toMatchObject({ accepted: true });
    expect(await repository.setupPackage(invitation.host_id, setup, () => 'built', admit)).toBe('built');
    expect(admitted).toEqual([invitation.host_id, invitation.host_id]);
  });

  it('fences a verified request behind a concurrent key replacement and refuses the proof of the replaced key', async () => {
    const { invitation, pair } = await enrolled('north-rotated_laptop'); const next = keys();
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE fleet_host_identities SET public_key=$2,key_fingerprint=$3 WHERE host_id=$1',
        [invitation.host_id, next.encoded, hostKeyFingerprint(next.encoded)]);
      const pending = repository.heartbeat(invitation.host_id, heartbeat(invitation, pair));
      expect(await settled(pending, 500)).toBe('waiting');
      await holder.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    } finally { holder.release(); }
    expect(await repository.heartbeat(invitation.host_id, heartbeat(invitation, next))).toMatchObject({ accepted: true });
  });

  it('lets a fleet writer holding the revision lock read the computer while a signed request waits for that lock', async () => {
    const { invitation, pair } = await enrolled('north-channel_laptop');
    const path = `/v3/fleet/hosts/${invitation.host_id}/channel`;
    const writer = await pool.connect();
    let request: Promise<string> | undefined;
    try {
      await writer.query('BEGIN'); await lockFleetRevision(writer);
      request = repository.request(invitation.host_id, 'POST', path, signed(invitation, pair, path, { resource: 'fleet_operation', action: 'claim' }),
        async client => { await lockFleetRevision(client); return 'claimed'; });
      request.catch(() => undefined);
      await waitingForFleetRevision();
      await writer.query("SET LOCAL lock_timeout='5s'");
      for (const mode of ['KEY SHARE', 'SHARE']) {
        expect((await writer.query(`SELECT company_id FROM fleet_hosts WHERE host_id=$1 FOR ${mode}`, [invitation.host_id])).rows)
          .toEqual([{ company_id: 'north' }]);
      }
      await writer.query('COMMIT');
      expect(await request).toBe('claimed');
    } finally { await writer.query('ROLLBACK').catch(() => undefined); writer.release(); }
    expect(await repository.heartbeat(invitation.host_id, heartbeat(invitation, pair))).toMatchObject({ accepted: true });
  });
});
