import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { PeopleAdminRepository } from './people-admin-store.js';
import type { PeopleAdminActor, PeopleAdminPerson } from './people-admin-schema.js';
import { encodeTerminalSubject } from '../terminal/authority-continuity.js';
import { verifyPassword } from '../password.js';
import { seedPeopleOAuth } from './people-admin-fixtures.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let actor: PeopleAdminActor; let owner: PeopleAdminPerson; let repository: PeopleAdminRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent'); current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('people-hub','Steven')");
  for (const alias of ['people-owner', 'people-target', 'people-second']) {
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id) VALUES('Steven',$1,'codex')", [alias]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','people-hub',$1,'operator')", [alias]);
  }
  const row = (await pool.query<PeopleAdminPerson>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('owner@example.test','owner@example.test',$1,'Owner','operator','Steven','people-owner')
    RETURNING id,email,display_name,role,tenant_id,alias,active,(extract(epoch from updated_at)*1000000)::numeric(20,0)::text AS revision`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!row) throw new Error('fixture owner absent'); owner = row;
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','people-owner','operator',ARRAY['read','control'])", [owner.id]);
  actor = { tenant_id: 'Steven', alias: 'people-owner', subject: `console:${owner.id}`,
    humanAuthority: async () => ({ humanId: owner.id, tenantId: 'Steven', actorAlias: 'people-owner' }) };
  repository = new PeopleAdminRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const person = () => ({ email: 'target@example.test', display_name: 'Target', role: 'reader' as const,
  tenant_id: 'Steven', alias: 'people-target', active: true, password: 'synthetic-private-passphrase' });

describe('human administration on PostgreSQL', () => {
  it('normalizes mixed-case emails before persistence and in create update and list receipts', async () => {
    const created = await repository.create(actor, { ...person(), email: '  TARGET@Example.TEST  ' });
    expect(created.email).toBe('target@example.test');
    expect((await pool.query('SELECT email,email_normalized FROM console_users WHERE id=$1', [created.id])).rows[0])
      .toEqual({ email: 'target@example.test', email_normalized: 'target@example.test' });
    const changed = await repository.update(actor, created.id, { expected_revision: created.revision, email: ' NEW@Target.TEST ' });
    expect(changed.email).toBe('new@target.test');
    expect((await pool.query('SELECT email,email_normalized FROM console_users WHERE id=$1', [created.id])).rows[0])
      .toEqual({ email: 'new@target.test', email_normalized: 'new@target.test' });
    expect((await repository.list(actor)).items.find(row => row.id === created.id)?.email).toBe('new@target.test');
  });
  it.each([
    ['membership disabled', "UPDATE memberships SET enabled=false WHERE tenant_id='Isa' AND alias='people-obsolete'"],
    ['room disabled', "UPDATE rooms SET enabled=false WHERE tenant_id='Isa' AND id='people-obsolete-room'"],
    ['tenant disabled', "UPDATE tenants SET enabled=false WHERE id='Isa'"],
    ['agent retired', "UPDATE agents SET enabled=false,retired_at=clock_timestamp() WHERE tenant_id='Isa' AND alias='people-obsolete'"],
  ])('retires and revokes a person with an obsolete %s while preserving the current administrator', async (_name, sql) => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('people-obsolete-room','Isa')");
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id) VALUES('Isa','people-obsolete','codex')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Isa','people-obsolete-room','people-obsolete','agent')");
    const created = await repository.create(actor, { ...person(), tenant_id: 'Isa', alias: 'people-obsolete' });
    const oauth = await seedPeopleOAuth(pool, created);
    await pool.query(sql);
    const retired = await repository.retire(actor, created.id, { expected_revision: created.revision });
    expect(retired.active).toBe(false);
    expect(BigInt(retired.revision)).toBeGreaterThan(BigInt(created.revision));
    expect((await pool.query('SELECT enabled,revoked_at IS NOT NULL AS revoked FROM human_tenant_memberships WHERE human_id=$1', [created.id])).rows[0])
      .toEqual({ enabled: false, revoked: true });
    expect((await pool.query('SELECT 1 FROM cauce_oauth_grant_revocations WHERE grant_id=$1', [oauth.identity.grantId])).rowCount).toBe(1);
    expect((await pool.query<{ active: boolean }>('SELECT active FROM console_users WHERE id=$1', [owner.id])).rows[0]?.active).toBe(true);
    expect(await oauth.store.validate(oauth.identity)).toBe(false);
    await expect(repository.restore(actor, retired.id, { expected_revision: retired.revision })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('creates hashed write-only credentials and lists exact metadata without private fields', async () => {
    const created = await repository.create(actor, person()); expect(created).toMatchObject({ active: true, role: 'reader' });
    const stored = (await pool.query<{ password_hash: string }>('SELECT password_hash FROM console_users WHERE id=$1', [created.id])).rows[0];
    expect(await verifyPassword(stored?.password_hash ?? '', person().password)).toBe(true);
    const listed = await repository.list(actor); expect(listed.items).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('password'); expect(JSON.stringify(listed)).not.toContain('$scrypt$');
    expect((await pool.query<{ enabled: boolean; permissions: string[] }>('SELECT enabled,permissions FROM human_tenant_memberships WHERE human_id=$1', [created.id])).rows[0])
      .toEqual({ enabled: true, permissions: ['read'] });
    expect(JSON.stringify((await pool.query('SELECT metadata FROM audit_events')).rows)).not.toContain(person().password);
  });
  it('rejects stale CAS and advances a precise string revision for a real update', async () => {
    const created = await repository.create(actor, person());
    const changed = await repository.update(actor, created.id, { expected_revision: created.revision, display_name: 'Changed' });
    expect(BigInt(changed.revision)).toBeGreaterThan(BigInt(created.revision));
    await expect(repository.update(actor, created.id, { expected_revision: created.revision, active: false })).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.list(actor)).items.find(row => row.id === created.id)?.active).toBe(true);
  });
  it('protects the last effective administrator rather than counting stale accounts or memberships', async () => {
    await pool.query("INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias) VALUES('stale@example.test','stale@example.test',$1,'Stale','operator','Steven','missing-alias')", ['$scrypt$' + 'x'.repeat(48)]);
    await expect(repository.retire(actor, owner.id, { expected_revision: owner.revision })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.update(actor, owner.id, { expected_revision: owner.revision, role: 'reader' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ active: boolean }>('SELECT active FROM console_users WHERE id=$1', [owner.id])).rows[0]?.active).toBe(true);
  });
  it('retires stable human terminal identities even after email rename and releases their control holds', async () => {
    const created = await repository.create(actor, person()); const sid = randomUUID();
    const subject = encodeTerminalSubject({ kind: 'human', humanId: created.id, loginSid: 'fixture-login-session', actor: { tenantId: 'Steven', alias: created.alias },
      credentialStamp: Buffer.alloc(32, 1).toString('base64url'), issuedAtSeconds: Math.floor(Date.now() / 1000), expiresAtSeconds: Math.floor(Date.now() / 1000) + 60 });
    await pool.query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,expires_at,
      request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id)
      VALUES($1,'old-email@example.test',true,$2,'Steven','people-target','fixture','shell',$3,'fixture',clock_timestamp()+interval '1 minute',$4,$3,$3,1,$5)`,
      [sid, subject, Buffer.alloc(32, 1), randomUUID(), 'a'.repeat(64)]);
    await pool.query(`INSERT INTO terminal_control_holds(session_id,tenant_id,alias,operator_id,reason,expires_at)
      VALUES($1,'Steven','people-target','old-email@example.test','fixture',clock_timestamp()+interval '1 minute')`, [sid]);
    const retired = await repository.retire(actor, created.id, { expected_revision: created.revision }); expect(retired.active).toBe(false);
    expect((await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM terminal_sessions WHERE id=$1', [sid])).rows[0]?.revoked_at).not.toBeNull();
    expect((await pool.query<{ released_at: Date | null }>('SELECT released_at FROM terminal_control_holds WHERE session_id=$1', [sid])).rows[0]?.released_at).not.toBeNull();
    expect((await pool.query<{ enabled: boolean }>('SELECT enabled FROM human_tenant_memberships WHERE human_id=$1', [created.id])).rows[0]?.enabled).toBe(false);
    const restored = await repository.restore(actor, created.id, { expected_revision: retired.revision }); expect(restored.active).toBe(true);
    await expect(repository.purge(actor, created.id, { expected_revision: restored.revision })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('revalidates current human permissions and cookie authority before committing', async () => {
    const revoked = { ...actor, humanAuthority: async () => { throw new Error('PRIVATE_COOKIE_STAMP'); } };
    await expect(repository.create(revoked, person())).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE console_users SET alias='people-second' WHERE id=$1", [owner.id]);
    await expect(repository.list(actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT 1 FROM console_users WHERE email_normalized='target@example.test'")).rowCount).toBe(0);
  });
  it('rejects missing effective aliases, private extra fields and duplicate emails without partial rows', async () => {
    await expect(repository.create(actor, { ...person(), alias: 'missing-alias' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.create(actor, { ...person(), password_hash: '$scrypt$forged' })).rejects.toMatchObject({ code: 'invalid_request' });
    await repository.create(actor, person());
    await expect(repository.create(actor, { ...person(), email: 'TARGET@example.test' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM console_users')).rows[0]?.n).toBe(2);
  });
  it('revokes OAuth access, refresh and client declarations permanently without deleting identities or history', async () => {
    const created = await repository.create(actor, person()); const oauth = await seedPeopleOAuth(pool, created);
    expect(await oauth.store.validate(oauth.identity)).toBe(true);
    const renamed = await repository.update(actor, created.id, { expected_revision: created.revision, display_name: 'Renamed' });
    expect(await oauth.store.validate(oauth.identity)).toBe(true);
    const retired = await repository.retire(actor, created.id, { expected_revision: renamed.revision });
    const restored = await repository.restore(actor, created.id, { expected_revision: retired.revision }); expect(restored.active).toBe(true);
    expect(await oauth.store.validate(oauth.identity)).toBe(false);
    await expect(oauth.store.refresh(oauth.refresh, () => { throw new Error('must not issue'); },
      { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 })).rejects.toMatchObject({ error: 'invalid_grant' });
    expect((await pool.query('SELECT 1 FROM cauce_oauth_grant_revocations WHERE grant_id=$1', [oauth.identity.grantId])).rowCount).toBe(1);
    expect((await pool.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM cauce_oauth_tokens WHERE id=$1', [oauth.identity.tokenId])).rows[0]?.revoked).toBe(true);
    expect((await pool.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM human_oauth_client_delegations WHERE human_id=$1', [created.id])).rows[0]?.revoked).toBe(true);
    expect((await pool.query('SELECT 1 FROM cauce_oauth_grants WHERE human_id=$1', [created.id])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM cauce_oauth_refresh_tokens WHERE grant_id=$1', [oauth.identity.grantId])).rowCount).toBe(1);
    expect((await pool.query<{ enabled: boolean }>('SELECT enabled FROM human_external_identities WHERE human_id=$1', [created.id])).rows[0]?.enabled).toBe(true);
  });
  it('serializes concurrent self-retirement so one effective administrator always survives', async () => {
    const second = await repository.create(actor, { ...person(), role: 'operator', alias: 'people-second' });
    const secondActor: PeopleAdminActor = { tenant_id: second.tenant_id, alias: second.alias, subject: `console:${second.id}`,
      humanAuthority: async () => ({ humanId: second.id, tenantId: second.tenant_id, actorAlias: second.alias }) };
    const results = await Promise.allSettled([repository.retire(actor, owner.id, { expected_revision: owner.revision }),
      repository.retire(secondActor, second.id, { expected_revision: second.revision })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::integer AS n FROM console_users WHERE active AND role='operator'")).rows[0]?.n).toBe(1);
  });
  it('purges only an inactive orphan with no references or historical events', async () => {
    const orphan = (await pool.query<PeopleAdminPerson>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
      VALUES('orphan@example.test','orphan@example.test',$1,'Orphan','reader','Steven','missing-alias',false)
      RETURNING id,email,display_name,role,tenant_id,alias,active,(extract(epoch from updated_at)*1000000)::numeric(20,0)::text AS revision`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
    if (!orphan) throw new Error('fixture orphan absent');
    const subject = encodeTerminalSubject({ kind: 'human', humanId: orphan.id, loginSid: 'fixture-login-session', actor: { tenantId: 'Steven', alias: orphan.alias },
      credentialStamp: Buffer.alloc(32, 1).toString('base64url'), issuedAtSeconds: Math.floor(Date.now() / 1000), expiresAtSeconds: Math.floor(Date.now() / 1000) + 60 });
    const terminalId = randomUUID();
    await pool.query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,expires_at,
      request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id,closed_at)
      VALUES($1,'previous-email@example.test',true,$2,'Steven','people-target','fixture','shell',$3,'fixture',clock_timestamp()+interval '1 minute',$4,$3,$3,1,$5,clock_timestamp())`,
      [terminalId, subject, Buffer.alloc(32, 1), randomUUID(), 'a'.repeat(64)]);
    await expect(repository.purge(actor, orphan.id, { expected_revision: orphan.revision })).rejects.toMatchObject({ code: 'conflict' });
    await pool.query('DELETE FROM terminal_sessions WHERE id=$1', [terminalId]);
    expect(await repository.purge(actor, orphan.id, { expected_revision: orphan.revision })).toEqual({ id: orphan.id, revision: orphan.revision, purged: true });
    expect((await pool.query('SELECT 1 FROM console_users WHERE id=$1', [orphan.id])).rowCount).toBe(0);
    const created = await repository.create(actor, person()); const retired = await repository.retire(actor, created.id, { expected_revision: created.revision });
    await expect(repository.purge(actor, retired.id, { expected_revision: retired.revision })).rejects.toMatchObject({ code: 'conflict' });
  });
});
