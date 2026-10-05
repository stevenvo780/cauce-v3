import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestDatabase, resetTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { createConsoleCredentialStamp } from '../console-credential-stamp.js';
import { authorityContinuityCommitment, encodeTerminalSubject, type AuthorityContinuityPayload } from './authority-continuity.js';
import { TerminalSessionAuthority, terminalDatabaseNow } from './session-authority.js';
import { registerTerminalControlPlane } from './plugin.js';
import { AgentRegistry } from './registry.js';
import { createConsoleSecurityHook } from '../console-security.js';
import { verifyTicketSignature, deriveAliasKey } from './tickets.js';
import { renewRelayClaim } from './relay-proxy/claim-transition.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
const key = randomBytes(32);
const users = new MemoryConsoleUserStore();
const provider = new PasswordAuthProvider({ users, signingKey: key });
const authority = new TerminalSessionAuthority(provider, randomBytes(32));
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase(); pool = database.pool;
  console.info(`terminal-authority container ${database.container.getId()}`);
});
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE terminal_control_holds,terminal_sessions,console_users CASCADE');
  await pool.query(`INSERT INTO agents(tenant_id,alias,container_name,runtime_user,home_directory,state_directory,harness_id,enabled)
    VALUES('Steven','kant','actor','dev','/home/dev','/state/kant','codex',true),('Steven','argos','target','claw','/home/claw','/state/argos','codex',true)`);
  await pool.query(`INSERT INTO rooms(id,tenant_id) VALUES('authority-room','Steven') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
    ('Steven','authority-room','kant','operator'),('Steven','authority-room','argos','agent')
    ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET enabled=true,role=EXCLUDED.role`);
});
afterAll(async () => {
  if (database === undefined) return;
  try { await pool.end(); } finally { await database.container.stop(); }
});

async function seed(seconds = 60): Promise<AuthorityContinuityPayload> {
  const humanId = randomUUID(); const passwordHash = '$scrypt$' + randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,
    role,tenant_id,alias,active,password_changed_at)
    VALUES($1,$2,$2,$3,'Fixture','operator','Steven','kant',true,'epoch')`,
  [humanId, `${humanId}@example.invalid`, passwordHash]);
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'Steven','kant','operator',ARRAY['read','route','control'])`, [humanId]);
  users.put({ id: humanId, email: `${humanId}@example.invalid`, display_name: 'Fixture',
    role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true, password_hash: passwordHash, password_changed_at: 0 });
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthorityContinuityPayload = { version: 2, sessionId: randomUUID(), requestId: randomUUID(),
    semanticDigest: randomBytes(32).toString('hex'), origin: { kind: 'human', humanId,
      loginSid: randomBytes(24).toString('base64url'), actor: { tenantId: 'Steven', alias: 'kant' },
      credentialStamp: createConsoleCredentialStamp(key, { userId: humanId, passwordHash, passwordChangedAtUs: '0' }),
      issuedAtSeconds: now, expiresAtSeconds: now + seconds } };
  const claim = randomBytes(32);
  await pool.query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,
    container,runtime_user,mode,ticket_sha256,reason,issued_at,expires_at,consumed_at,
    request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
    relay_instance_id,relay_boot_id,relay_claim_sha256,relay_claim_epoch,relay_claimed_at,relay_claim_expires_at)
    VALUES($1,'old-email',true,$2,'Steven','argos','target','claw','shell',$3,'authority fixture',
    clock_timestamp(),clock_timestamp()+interval '30 seconds',clock_timestamp(),$4,$5,$3,1,$6,$7,$8,1,clock_timestamp(),
    clock_timestamp()+interval '30 seconds')`, [payload.sessionId, encodeTerminalSubject(payload.origin),
    randomBytes(32), payload.requestId, authorityContinuityCommitment(payload), 'a'.repeat(64),
    randomUUID(), claim]);
  return payload;
}

async function pid(client: DatabaseClient): Promise<number> {
  const value = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (value === undefined) throw new Error('missing PID'); return value;
}
async function waiting(processId: number): Promise<void> {
  for (let n = 0; n < 200; n += 1) {
    const state = (await pool.query<{ waiting: boolean }>(
      "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [processId],
    )).rows[0];
    if (state?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected a real PostgreSQL lock wait');
}

async function blockedMutation(payload: AuthorityContinuityPayload, sql: string, values: unknown[]): Promise<void> {
  const holder = await pool.connect(); const writer = await pool.connect();
  let write: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await authority.lockSession(holder, payload, new CauceRepository(pool));
    await writer.query('BEGIN'); const writerPid = await pid(writer);
    write = writer.query(sql, values); await waiting(writerPid);
    await holder.query('ROLLBACK'); await write; await writer.query('COMMIT');
    await expect(withTransaction(pool, (client) => authority.lockSession(client, payload, new CauceRepository(pool)))).rejects.toThrow();
  } finally {
    await holder.query('ROLLBACK'); if (write !== undefined) await write;
    await writer.query('ROLLBACK'); holder.release(); writer.release();
  }
}

describe('terminal original authority under PostgreSQL fences', () => {
  it.each([
    ['account', 'UPDATE console_users SET active=false WHERE id=$1'],
    ['membership', "UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1"],
    ['account role', "UPDATE console_users SET role='reader' WHERE id=$1"],
    ['member role', "UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'] WHERE human_id=$1"],
    ['credential', 'UPDATE console_users SET password_hash=$2 WHERE id=$1'],
  ])('serializes %s revocation against the same transaction', async (_name, sql) => {
    const original = await seed(); if (original.origin.kind !== 'human') throw new Error('human expected');
    await blockedMutation(original, sql, sql.includes('$2')
      ? [original.origin.humanId, '$scrypt$' + randomBytes(32).toString('base64url')] : [original.origin.humanId]);
  });
  it('serializes technical CONTROL revocation', async () => {
    const original = await seed();
    await blockedMutation(original, "UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND alias='kant'", []);
  });
  it('serializes a cross-tenant CONTROL edge revocation over the entire cohort', async () => {
    const original = await seed();
    await pool.query(`INSERT INTO agents(tenant_id,alias,container_name,runtime_user,home_directory,state_directory,harness_id,enabled)
      VALUES('Miguel','shared-peer','target','dev','/home/dev','/state/shared','codex',true)`);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('authority-miguel','Miguel')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias) VALUES('Miguel','authority-miguel','shared-peer')");
    await pool.query("UPDATE acl_edges SET enabled=true,allow_control=true,allow_route=true WHERE from_tenant='Steven' AND to_tenant='Miguel'");
    await blockedMutation(original, "UPDATE acl_edges SET allow_control=false WHERE from_tenant='Steven' AND to_tenant='Miguel'", []);
  });
  it('rolls back a guarded transition with its original authority locks', async () => {
    const original = await seed();
    await expect(withTransaction(pool, async (client) => {
      await authority.lockSession(client, original, new CauceRepository(pool));
      await client.query('UPDATE terminal_sessions SET browser_owner_generation=2 WHERE id=$1', [original.sessionId]);
      throw new Error('transaction fixture rollback');
    })).rejects.toThrow('transaction fixture rollback');
    expect((await pool.query<{ generation: string }>('SELECT browser_owner_generation::text AS generation FROM terminal_sessions WHERE id=$1', [original.sessionId])).rows[0]?.generation).toBe('1');
  });
  it('denies expiry that crosses a real terminal row lock wait and rolls back the operation', async () => {
    const original = await seed(2); const holder = await pool.connect(); const waiter = await pool.connect();
    let result: Promise<{ error: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM terminal_sessions WHERE id=$1 FOR UPDATE', [original.sessionId]);
      await waiter.query('BEGIN'); const waiterPid = await pid(waiter);
      result = authority.lockSession(waiter, original, new CauceRepository(pool))
        .then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      await waiting(waiterPid);
      await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))+0.05)', [original.origin.expiresAtSeconds]);
      await holder.query('COMMIT'); expect((await result).error).toMatchObject({ code: 'forbidden' });
      await waiter.query('ROLLBACK');
      const row = (await pool.query<{ epoch: string }>('SELECT relay_claim_epoch::text AS epoch FROM terminal_sessions WHERE id=$1', [original.sessionId])).rows[0];
      expect(row?.epoch).toBe('1');
    } finally {
      await holder.query('ROLLBACK'); if (result !== undefined) await result;
      await waiter.query('ROLLBACK'); holder.release(); waiter.release();
    }
  });
  it('blocks a new co-located placement until authorization transaction ends', async () => {
    const original = await seed(); const holder = await pool.connect(); const writer = await pool.connect();
    let inserted: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN'); await authority.lockSession(holder, original, new CauceRepository(pool));
      await writer.query('BEGIN'); const writerPid = await pid(writer);
      inserted = writer.query("INSERT INTO agents(tenant_id,alias,container_name,runtime_user,home_directory,state_directory,harness_id,enabled) VALUES('Miguel','new-peer','target','dev','/home/dev','/state/new-peer','codex',true)");
      await waiting(writerPid); await holder.query('ROLLBACK'); await inserted; await writer.query('COMMIT');
      await expect(withTransaction(pool, (client) => authority.lockSession(client, original, new CauceRepository(pool)))).rejects.toThrow();
    } finally {
      await holder.query('ROLLBACK'); if (inserted !== undefined) await inserted;
      await writer.query('ROLLBACK'); holder.release(); writer.release();
    }
  });
  it('keeps human identity independent from email and caps renewal at original expiration', async () => {
    const original = await seed(); if (original.origin.kind !== 'human') throw new Error('human expected');
    await pool.query('UPDATE console_users SET email=$2,email_normalized=$2 WHERE id=$1', [original.origin.humanId, 'new-email@example.invalid']);
    await withTransaction(pool, async (client) => {
      const deadline = await authority.lockSession(client, original, new CauceRepository(pool));
      const row = (await client.query<{ relay_boot_id: string; relay_claim_sha256: Buffer }>('SELECT relay_boot_id,relay_claim_sha256 FROM terminal_sessions WHERE id=$1', [original.sessionId])).rows[0];
      if (row === undefined) throw new Error('missing claim');
      const renewed = await renewRelayClaim(client, { sid: original.sessionId, claimSha256: row.relay_claim_sha256,
        claimEpoch: '1', identity: { relay_instance_id: 'a'.repeat(64), relay_boot_id: row.relay_boot_id },
        claimLeaseSeconds: 900, sessionTtlSeconds: 900, sessionMaxTotalSeconds: null, authorityExpiresAt: deadline });
      expect(renewed?.relay_claim_expires_at).toEqual(deadline);
      await terminalDatabaseNow(client, deadline);
    });
  });
});

function cookie(payload: AuthorityContinuityPayload, differentSid = false): string {
  if (payload.origin.kind !== 'human') throw new Error('human expected');
  const origin = payload.origin;
  return `__Host-cauce_session=${signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console',
    sub: origin.humanId, sid: differentSid ? randomBytes(24).toString('base64url') : origin.loginSid,
    csrf: randomBytes(24).toString('base64url'), iat: origin.issuedAtSeconds, exp: origin.expiresAtSeconds,
    credential_stamp: origin.credentialStamp })}`;
}

async function httpFixture(payload: AuthorityContinuityPayload) {
  if (payload.origin.kind !== 'human') throw new Error('human expected');
  await pool.query('DELETE FROM terminal_sessions WHERE id=$1', [payload.sessionId]);
  const directory = await mkdtemp(join(tmpdir(), 'cauce-authority-http-'));
  const grantsFile = join(directory, 'grants.json'); const master = randomBytes(32);
  const relayToken = randomBytes(32).toString('base64url'); const relayId = randomBytes(32).toString('hex');
  const boot = randomUUID(); const registry = new AgentRegistry();
  registry.observe({ relay_instance_id: relayId, relay_boot_id: boot }, [{ tenant_id: 'Steven', alias: 'argos',
    container_id: 'target', generation: 'gen-fixture', image_id: `sha256:${randomBytes(32).toString('hex')}`,
    runtime_user: 'claw', runtime_uid: 1000, harness: 'codex', modes: ['shell', 'harness_rw'], connected_since: new Date().toISOString() }]);
  const app = Fastify({ logger: false });
  try {
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [{
      operator: `${payload.origin.humanId}@example.invalid`, tenant_id: 'Steven', alias: 'argos', modes: ['shell', 'harness_rw'],
    }] }));
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: ['https://console.test'] }));
    await registerTerminalControlPlane(app, { pool, authProvider: provider, registry,
      config: { wsPath: '/v3/console/terminal/ws', ticketKey: master, relayToken, relayInstanceIds: new Set([relayId]),
        grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 3600,
        claimLeaseSeconds: 150, writableTuiEnabled: true, controlHoldSeconds: 900, maxSessionsPerOperator: 10, operatorHeader: 'x-cauce-operator', operators: new Set() },
      measuredFacts: { factsFor: async () => undefined },
      governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'fixture' }) },
      relayPeerInstanceId: () => relayId });
    await app.ready();
  } catch (error) { await app.close(); await rm(directory, { recursive: true }); throw error; }
  return { app, master, relayToken, relayId, boot, close: async () => {
    try { await app.close(); } finally { await rm(directory, { recursive: true }); }
  } };
}

async function expectTokenFreeAudits(actions: readonly string[], tokens: readonly string[]): Promise<void> {
  const rows = (await pool.query<{ action: string; metadata: unknown }>('SELECT action,metadata FROM audit_events')).rows;
  for (const action of actions) expect(rows.some((row) => row.action === action)).toBe(true);
  for (const row of rows) {
    const encoded = JSON.stringify(row.metadata);
    expect(/(?:ac2\.|r2\.|"(?:authority_proof|resume_token)"\s*:)/u.test(encoded), row.action).toBe(false);
    for (const token of tokens) expect(encoded.includes(token), row.action).toBe(false);
  }
}

describe('HTTP terminal continuity with authenticated cookie and real PostgreSQL', () => {
  it('recovers the original admission, preserves OPEN v1 and blocks proofless renewal without audit', async () => {
    const original = await seed(60); const fixture = await httpFixture(original);
    const headers = { origin: 'https://console.test', cookie: cookie(original) };
    const body = { tenant_id: 'Steven', alias: 'argos', mode: 'shell', reason: 'continuity HTTP fixture',
      rows: 24, cols: 80, request_id: randomUUID(), owner_token: randomUUID() };
    try {
      const opened = await fixture.app.inject({ method: 'POST', url: '/v3/console/terminal/sessions', headers, payload: body });
      expect(opened.statusCode).toBe(201);
      const receipt = opened.json<{ session_id: string; authority_proof: string; ticket: string }>();
      expect(receipt.authority_proof.startsWith('ac2.')).toBe(true);
      expect(verifyTicketSignature(receipt.ticket, deriveAliasKey(fixture.master, 'Steven', 'argos')).sub).toBe('Steven:kant');
      const recovered = await fixture.app.inject({ method: 'POST', url: '/v3/console/terminal/sessions', headers, payload: body });
      expect(recovered.statusCode).toBe(201); expect(recovered.json()).toMatchObject({ ...receipt, receipt_recovered: true });
      const before = (await pool.query('SELECT id FROM audit_events')).rows.length;
      const relayHeaders = { authorization: `Bearer ${fixture.relayToken}` };
      const identity = { relay_instance_id: fixture.relayId, relay_boot_id: fixture.boot };
      for (const [route, data] of [
        ['consume', { ...identity, ticket: receipt.ticket, claim_token: randomUUID() }],
        ['authz', { ...identity, claim_token: randomUUID(), claim_epoch: '1' }],
        ['resume', { ...identity, claim_token: randomUUID(), resume_token: 'r1.legacy' }],
      ] as const) {
        const missing = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/${route}`,
          headers: relayHeaders, payload: data }); expect(missing.statusCode).toBeGreaterThanOrEqual(400);
        const oversized = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/${route}`,
          headers: relayHeaders, payload: { ...data, authority_proof: 'ac2.' + 'x'.repeat(4096) } });
        expect(oversized.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect((await pool.query('SELECT id FROM audit_events')).rows.length).toBe(before);
      const claimToken = randomUUID();
      const consumed = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/consume`,
        headers: relayHeaders, payload: { ...identity, ticket: receipt.ticket, claim_token: claimToken, authority_proof: receipt.authority_proof } });
      expect(consumed.statusCode).toBe(200); const grant = consumed.json<{ resume_token: string; claim_epoch: string }>();
      expect(grant.resume_token.startsWith('r2.')).toBe(true);
      const renewed = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/authz`,
        headers: relayHeaders, payload: { ...identity, claim_token: claimToken, claim_epoch: grant.claim_epoch, authority_proof: receipt.authority_proof } });
      expect(renewed.statusCode).toBe(200);
      const resumed = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/resume`,
        headers: relayHeaders, payload: { ...identity, claim_token: claimToken, claim_epoch: grant.claim_epoch,
          resume_token: grant.resume_token, authority_proof: receipt.authority_proof } });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ authority_proof: receipt.authority_proof });
      await expectTokenFreeAudits(['terminal.session.consume', 'terminal.session.resume'], [receipt.authority_proof, grant.resume_token]);
      const lease = (await pool.query<{ expires: Date }>('SELECT relay_claim_expires_at AS expires FROM terminal_sessions WHERE id=$1', [receipt.session_id])).rows[0];
      expect(lease?.expires.getTime()).toBeLessThanOrEqual(original.origin.expiresAtSeconds * 1000);
      const otherLogin = await fixture.app.inject({ method: 'POST', url: `/v3/console/terminal/sessions/${receipt.session_id}/owner`,
        headers: { ...headers, cookie: cookie(original, true) }, payload: { request_id: body.request_id,
          expected_owner_generation: '1', owner_token: randomUUID(), authority_proof: receipt.authority_proof } });
      expect(otherLogin.statusCode).toBe(403);
      const history = await fixture.app.inject({ method: 'GET', url: '/v3/console/terminal/sessions',
        headers: { ...headers, cookie: cookie(original, true) } });
      expect(history.statusCode).toBe(200); expect(history.json()).toMatchObject({ items: [expect.objectContaining({ session_id: receipt.session_id })] });
      const closed = await fixture.app.inject({ method: 'DELETE', url: `/v3/console/terminal/sessions/${receipt.session_id}`,
        headers: { ...headers, cookie: cookie(original, true) }, payload: { request_id: body.request_id, owner_generation: '1', owner_token: body.owner_token } });
      expect(closed.statusCode).toBe(204);
    } finally { await fixture.close(); }
  });
});

describe('browser control retains the exact original authority', () => {
  it('takes and releases the hold in one transaction; stale owner and renewal above origin fail', async () => {
    const original = await seed(60); const fixture = await httpFixture(original);
    const headers = { origin: 'https://console.test', cookie: cookie(original) };
    const body = { tenant_id: 'Steven', alias: 'argos', mode: 'harness_rw', reason: 'take real authority fixture',
      rows: 24, cols: 80, request_id: randomUUID(), owner_token: randomUUID() };
    try {
      const opened = await fixture.app.inject({ method: 'POST', url: '/v3/console/terminal/sessions', headers, payload: body });
      expect(opened.statusCode).toBe(201);
      const receipt = opened.json<{ session_id: string; authority_proof: string; ticket: string }>();
      const consume = await fixture.app.inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${receipt.session_id}/consume`,
        headers: { authorization: `Bearer ${fixture.relayToken}` }, payload: { relay_instance_id: fixture.relayId,
          relay_boot_id: fixture.boot, ticket: receipt.ticket, claim_token: randomUUID(), authority_proof: receipt.authority_proof } });
      expect(consume.statusCode).toBe(200);
      const path = `/v3/console/terminal/sessions/${receipt.session_id}`;
      const owner = { request_id: body.request_id, owner_generation: '1', owner_token: body.owner_token };
      const count = (await pool.query('SELECT id FROM audit_events')).rows.length;
      for (const [route, data] of [['extend', owner], ['control', { ...owner, action: 'take', reason: body.reason }],
        ['owner', { request_id: body.request_id, expected_owner_generation: '1', owner_token: randomUUID() }]] as const) {
        const denied = await fixture.app.inject({ method: 'POST', url: `${path}/${route}`, headers, payload: data });
        expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect((await pool.query('SELECT id FROM audit_events')).rows.length).toBe(count);
      const taken = await fixture.app.inject({ method: 'POST', url: `${path}/control`, headers,
        payload: { ...owner, authority_proof: receipt.authority_proof, action: 'take', reason: body.reason } });
      expect(taken.statusCode).toBe(200);
      expect(Date.parse(taken.json<{ expires_at: string }>().expires_at)).toBeLessThanOrEqual(original.origin.expiresAtSeconds * 1000);
      const conflicting = await fixture.app.inject({ method: 'POST', url: `${path}/control`, headers,
        payload: { ...owner, authority_proof: receipt.authority_proof, action: 'take', reason: body.reason } });
      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json()).toMatchObject({ reason: 'control_held', held_by: `${original.origin.kind === 'human' ? original.origin.humanId : ''}@example.invalid` });
      expect((await pool.query('SELECT id FROM terminal_control_holds WHERE released_at IS NULL')).rows).toHaveLength(1);
      expect((await pool.query<{ metadata: { reason: string } }>(
        "SELECT metadata FROM audit_events WHERE action='terminal.control_taken' AND decision='deny'",
      )).rows[0]?.metadata.reason).toBe('control_held');
      const newOwner = randomUUID();
      const rotated = await fixture.app.inject({ method: 'POST', url: `${path}/owner`, headers,
        payload: { request_id: body.request_id, expected_owner_generation: '1', owner_token: newOwner, authority_proof: receipt.authority_proof } });
      expect(rotated.statusCode).toBe(200); expect(rotated.json()).toMatchObject({ owner_generation: '2' });
      const stale = await fixture.app.inject({ method: 'POST', url: `${path}/control`, headers,
        payload: { ...owner, authority_proof: receipt.authority_proof, action: 'release' } });
      expect(stale.statusCode).toBe(409);
      const fenced = { request_id: body.request_id, owner_generation: '2', owner_token: newOwner,
        authority_proof: receipt.authority_proof };
      const extension = await fixture.app.inject({ method: 'POST', url: `${path}/extend`, headers, payload: fenced });
      expect(extension.statusCode).toBe(409); expect(extension.json()).toMatchObject({ reason: 'extension_exhausted' });
      const released = await fixture.app.inject({ method: 'POST', url: `${path}/control`, headers,
        payload: { ...fenced, action: 'release' } });
      expect(released.statusCode).toBe(200); expect(released.json()).toMatchObject({ released: true });
      expect((await pool.query('SELECT id FROM terminal_control_holds WHERE released_at IS NULL')).rows).toHaveLength(0);
      await expectTokenFreeAudits(['terminal.session.consume', 'terminal.control_taken', 'terminal.control_released'], [receipt.authority_proof]);
    } finally { await fixture.close(); }
  });
});
