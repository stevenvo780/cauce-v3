import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { secretHash, type OAuthAuthorizationRequest } from './oauth-authorization-types.js';
import { readFile } from 'node:fs/promises';
import { applyMigrationsThrough, lockHumanIdentity, resolveHumanIdentity, CauceRepository, withAbortableTransaction,
  type DatabaseClient } from '@cauce/store';
import { waitForBlocked } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';
import { OAUTH_GRANT_TTL_SECONDS, PostgresOAuthStore } from './oauth-authorization-store.js';
import { lockOAuthAccess } from './oauth-grant-authority.js';
import Fastify from 'fastify';
import { PasswordAuthProvider } from './password-auth.js';
import { createOAuthPasswordSession } from './oauth-password-session.js';
import { createHumanMcpOperationsFactory } from './mcp-operations.js';
import { createHumanPublishAuthority, resolveHumanMcpAuthority } from './human-mcp-authority.js';
import { PostgresConsoleUserStore } from './console-users.js';

import { issuer, tokens, verify, key, context, database, intercept, seed, counts, consent, exchangeInput, authorized, revoked, shortGrace } from './oauth-postgres.fixtures.js';

const version = '045_mcp_oauth_authorization.sql';
const previousVersion = '044_human_mcp_identity.sql';
const downPath = new URL('../../../packages/store/migrations/down/045_mcp_oauth_authorization.sql', import.meta.url);

async function transaction(client: DatabaseClient, work: () => Promise<void>) {
  await client.query('BEGIN');
  try { await work(); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function pid(client: DatabaseClient) {
  const value = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (!value) throw new Error('missing fixture backend PID'); return value;
}
function barrier() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release };
}

 describe.sequential('OAuth durable PostgreSQL authority', () => {
  it('applies four empty tables and its checksum atomically, leaving 044 unchanged', async () => {
    const pool = await database(false);
    const broken = intercept(pool, async sql => sql.includes('CREATE DOMAIN cauce_oauth_scopes') ? `${sql}\nSELECT 1/0;` : undefined);
    await expect(applyMigrationsThrough(broken, version)).rejects.toThrow('division by zero');
    expect((await pool.query('SELECT to_regclass(\'cauce_oauth_grants\') AS name')).rows[0]).toEqual({ name: null });
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(0);
    await applyMigrationsThrough(pool, version);
    expect(await counts(pool)).toEqual({ requests: '0', grants: '0', codes: '0', tokens: '0' });
    await pool.query('TRUNCATE cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens,cauce_oauth_refresh_tokens,cauce_oauth_grant_revocations');
    expect(await counts(pool)).toEqual({ requests: '0', grants: '0', codes: '0', tokens: '0' });
    const rows = (await pool.query<{ version: string; source_sha256: string }>('SELECT version,source_sha256 FROM schema_migration_ledger WHERE version=ANY($1)', [[version, previousVersion]])).rows;
    for (const row of rows) {
      const source = await readFile(new URL(`../../../packages/store/migrations/${row.version}`, import.meta.url));
      expect(row.source_sha256).toBe(createHash('sha256').update(source).digest('hex'));
    }
    expect(rows).toHaveLength(2);
  });

  it('enforces scope, hash, challenge, stamp and TTL constraints and immutable authority', async () => {
    const pool = await database(version); const f = await authorized(pool);
    for (const invalid of ['{}', '{cauce.admin}', '{cauce.read,cauce.read}']) {
      await expect(pool.query('SELECT $1::cauce_oauth_scopes', [invalid])).rejects.toThrow();
    }
    for (const [column, value] of [['id_hash', 'not-a-hash'], ['challenge', 'short']]) {
      await expect(pool.query(`INSERT INTO cauce_oauth_requests SELECT ${column === 'id_hash' ? '$1' : "repeat('f',64)"},browser_hash,client_id,client_name,redirect_uri,resource,scopes,${column === 'challenge' ? '$1' : 'challenge'},state,created_at,expires_at,NULL FROM cauce_oauth_requests LIMIT 1`, [value])).rejects.toThrow();
    }
    await expect(pool.query(`INSERT INTO cauce_oauth_grants SELECT gen_random_uuid(),human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,tenant_id,actor_alias,'invalid',created_at,expires_at FROM cauce_oauth_grants`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO cauce_oauth_requests SELECT repeat('a',64),browser_hash,client_id,client_name,redirect_uri,resource,scopes,challenge,state,created_at,created_at+interval '5 minutes 1 microsecond',NULL FROM cauce_oauth_requests LIMIT 1`)).rejects.toThrow();
    await expect(pool.query('UPDATE cauce_oauth_grants SET credential_stamp=$1', ['z'.repeat(43)])).rejects.toThrow('immutable');
    await expect(pool.query('UPDATE cauce_oauth_codes SET consumed_at=NULL')).rejects.toThrow('immutable');
    await expect(pool.query('TRUNCATE cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens,cauce_oauth_refresh_tokens,cauce_oauth_grant_revocations')).rejects.toThrow('approved');
    await expect(pool.query('DELETE FROM cauce_oauth_grants')).rejects.toThrow('retention');
    expect(await f.store.validate(f.issued.identity)).toBe(true);
  });

  it('stores the original stamp and rejects a changed password with the same timestamp at every durable entry', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code');
    const original = (await pool.query<{ credential_stamp: string }>('SELECT credential_stamp FROM cauce_oauth_grants')).rows[0]?.credential_stamp;
    expect(original).toBe(f.session.credentialStamp);
    const pending = exchangeInput(f, approved.code);
    const issued = await f.store.exchange(pending, value => tokens.issue(value), context());
    const second = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(second, context());
    const secondConsent = await f.store.consent(second.idHash, second.browserHash, f.session, ['cauce.read'], context());
    if (!secondConsent.code) throw new Error('missing unused code');
    const unused = exchangeInput(f, secondConsent.code);
    const next = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(next, context());
    await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'replacement-fixture'.repeat(4)]);
    const user = await new PostgresConsoleUserStore(pool).findById(f.userId);
    expect(user?.password_changed_at_us).toBe(f.passwordChangedAtUs);
    await expect(f.store.consent(next.idHash, next.browserHash, f.session, ['cauce.read'], context())).rejects.toThrow();
    await expect(f.store.exchange(unused, value => tokens.issue(value), context())).rejects.toThrow();
    expect(await f.store.validate(issued.identity)).toBe(false);
    const authorize = createHumanPublishAuthority(issued.identity, { humanId: f.userId, tenantId: 'Steven', actorAlias: f.alias }, new AbortController().signal,
      { lock: lockHumanIdentity, verifyCredentialStamp: verify });
    await expect(withAbortableTransaction(pool, new AbortController().signal, async client => { await authorize(client); await client.query("INSERT INTO cauce_oauth_tokens VALUES(gen_random_uuid(),$1,clock_timestamp(),clock_timestamp()+interval '1 minute',NULL)", [issued.identity.grantId]); })).rejects.toThrow();
    expect(await counts(pool)).toEqual({ requests: '3', grants: '2', codes: '2', tokens: '1' });
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes WHERE code_hash=$1', [unused.codeHash])).rows[0]?.consumed_at).toBeNull();
  });

  it('uses the exact stamp returned by real PasswordAuth for a same-second PostgreSQL login', async () => {
    const pool = await database(); const f = await seed(pool);
    const originalUser = await new PostgresConsoleUserStore(pool).findById(f.userId);
    if (!originalUser) throw new Error('missing login fixture user');
    const loginNow = originalUser.password_changed_at;
    const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: key, now: () => loginNow,
      fallback: { name: 'fixture', mode: 'production', authenticateHttp: async () => { throw new Error('unexpected fallback'); }, authenticateHello: async () => { throw new Error('unexpected fallback'); } } });
    const app = Fastify(); app.post('/login', (request, reply) => provider.login(request, reply));
    const read = createOAuthPasswordSession({ provider });
    app.get('/oauth/continue', async request => {
      const original = await provider.verifiedConsoleSession(request);
      const session = await read(request);
      expect(session.credentialStamp).toBe(original?.credentialStamp);
      expect(session.issuedAt).toBe(Math.floor(originalUser.password_changed_at / 1000));
      return f.store.consent(f.request.idHash, f.request.browserHash, session, ['cauce.read'], context());
    });
    try {
      const user = await new PostgresConsoleUserStore(pool).findById(f.userId);
      const login = await app.inject({ method: 'POST', url: '/login', payload: { email: user?.email, password: 'fixture-only-passphrase' } });
      expect(login.statusCode).toBe(200);
      const response = await app.inject({ url: '/oauth/continue', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' } });
      expect(response.statusCode).toBe(200);
      expect((await counts(pool))?.grants).toBe('1');
    } finally { await app.close(); }
  });

  it('distinguishes the binding-owner FK from namespace, subject and tenant validation under locks', async () => {
    const pool = await database(); const f = await authorized(pool); const other = await seed(pool);
    const insert = `INSERT INTO cauce_oauth_grants SELECT $1,human_id,issuer,resource,client_id,redirect_uri,scopes,$2,binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp,created_at,expires_at FROM cauce_oauth_grants WHERE id=$3`;
    await expect(pool.query(insert, [randomUUID(), other.bindingId, f.issued.identity.grantId])).rejects.toMatchObject({ code: '23503' });
    for (const [namespace, subject] of [['https://wrong.example', f.userId], [issuer, 'wrong-subject']]) {
      const wrong = randomUUID();
      await pool.query(`INSERT INTO human_external_identities(id,human_id,provider,namespace,subject)
        VALUES($1,$2,'oauth',$3,$4)`, [wrong, f.userId, namespace, subject]);
      const incoherent = randomUUID(); await pool.query(insert, [incoherent, wrong, f.issued.identity.grantId]);
      const bad = { ...f.issued.identity, grantId: incoherent, tokenId: randomUUID() };
      await pool.query(`INSERT INTO cauce_oauth_tokens(id,grant_id,created_at,expires_at) VALUES($1,$2,clock_timestamp(),$3)`, [bad.tokenId, incoherent, new Date(bad.expiresAt * 1000)]);
      expect(await f.store.validate(bad)).toBe(false);
      expect((await pool.query('SELECT id FROM cauce_oauth_grants WHERE id=$1', [incoherent])).rowCount).toBe(1);
    }
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Isa',$1)", [f.alias]);
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'Isa',$2,'operator',ARRAY['read','route'])`, [f.userId, f.alias]);
    const wrongTenant = randomUUID();
    await pool.query(`INSERT INTO cauce_oauth_grants SELECT $1,human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,'Isa',actor_alias,credential_stamp,created_at,expires_at FROM cauce_oauth_grants WHERE id=$2`, [wrongTenant, f.issued.identity.grantId]);
    const bad = { ...f.issued.identity, grantId: wrongTenant, tokenId: randomUUID() };
    await pool.query(`INSERT INTO cauce_oauth_tokens(id,grant_id,created_at,expires_at) VALUES($1,$2,clock_timestamp(),$3)`, [bad.tokenId, wrongTenant, new Date(bad.expiresAt * 1000)]);
    expect(await f.store.validate(bad)).toBe(false);
  });

  it.each(['human_external_identities', 'human_tenant_memberships'])('never revives grants when %s reuses a revision, including a new store', async table => {
    const pool = await database(); const f = await authorized(pool);
    const where = table === 'human_external_identities' ? 'id=$1' : 'human_id=$1';
    const id = table === 'human_external_identities' ? f.bindingId : f.userId;
    await pool.query(`UPDATE ${table} SET enabled=false,revoked_at=clock_timestamp(),revision=1 WHERE ${where}`, [id]);
    expect(await f.store.validate(f.issued.identity)).toBe(false);
    await expect(pool.query(`UPDATE ${table} SET enabled=true,revoked_at=NULL,revision=1 WHERE ${where}`, [id])).rejects.toThrow('cannot decrease');
    await pool.query(`UPDATE ${table} SET enabled=true,revoked_at=NULL WHERE ${where}`, [id]);
    expect((await pool.query<{ revision: string }>(`SELECT revision::text FROM ${table} WHERE ${where}`, [id])).rows[0]?.revision).toBe('3');
    expect(await new PostgresOAuthStore(pool, issuer, verify).validate(f.issued.identity)).toBe(false);
  });

  it('takes account then binding locks before membership, and checks expiration after waiting', async () => {
    const pool = await database(); const f = await seed(pool); const locker = await pool.connect(); const observer = await pool.connect();
    let workerPid = 0; const entered = barrier();
    const wrapped = intercept(pool, async (sql, client) => {
      if (sql.includes('FROM human_external_identities') && sql.includes('FOR SHARE')) { workerPid = await pid(client); entered.release(); }
    });
    await locker.query('BEGIN'); await locker.query('SELECT id FROM human_external_identities WHERE id=$1 FOR UPDATE', [f.bindingId]);
    const shortSession = { ...f.session, expiresAt: (Date.now() + 250) / 1000 };
    const operation = new PostgresOAuthStore(wrapped, issuer, verify).consent(f.request.idHash, f.request.browserHash, shortSession, ['cauce.read'], context());
    const rejected = expect(operation).rejects.toThrow();
    try {
      await entered.promise; await waitForBlocked(observer, workerPid);
      await observer.query('BEGIN');
      await observer.query("SELECT human_id FROM human_tenant_memberships WHERE human_id=$1 FOR UPDATE NOWAIT", [f.userId]);
      await observer.query('ROLLBACK');
      await observer.query('SELECT pg_sleep(0.3)'); await locker.query('COMMIT'); await rejected;
      expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
    } finally { await locker.query('ROLLBACK'); await observer.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it('serializes two consents and two code exchanges into one durable result each', async () => {
    const pool = await database(); const f = await seed(pool);
    const approved = await Promise.allSettled([consent(f), consent(f)]);
    expect(approved.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const success = approved.find(value => value.status === 'fulfilled');
    if (success?.status !== 'fulfilled' || !success.value.code) throw new Error('missing successful consent');
    const input = exchangeInput(f, success.value.code);
    const results = await Promise.allSettled([f.store.exchange(input, value => tokens.issue(value), context()), f.store.exchange(input, value => tokens.issue(value), context())]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
    // El segundo canje del mismo code es reutilización: revoca el grant y el token que obtuvo el ganador.
    const winner = results.find(value => value.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing winning exchange');
    expect(await revoked(pool, winner.value.identity.grantId)).toBe(true);
    expect(await f.store.validate(winner.value.identity)).toBe(false);
  });

  it('publishes and reads a real MCP receipt with the local grant, then blocks a stale stamp before business effects', async () => {
    const pool = await database(); const f = await authorized(pool);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES('Steven','grp.steven',$1,'operator',true)`, [f.alias]);
    const repository = new CauceRepository(pool);
    const factory = createHumanMcpOperationsFactory({ repository, pool,
      identityStore: { resolve: (identity, signal) => resolveHumanIdentity(pool, identity, signal), lock: lockHumanIdentity, verifyCredentialStamp: verify },
      priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined });
    const operations = await factory.forRequest(f.issued.identity, new AbortController().signal);
    const command = { request_key: randomUUID(), room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }], body: { text: 'OAuth disposable MCP fixture' } };
    const published = await operations.submit(command);
    const receipt = await operations.receipt(published.message_id);
    expect(receipt.message_id).toBe(published.message_id);
    expect(receipt.deliveries).toHaveLength(1);
    const durable = await pool.query(`SELECT (SELECT count(*) FROM messages)::int AS messages,
      (SELECT count(*) FROM human_message_initiators)::int AS initiators,(SELECT count(*) FROM deliveries)::int AS deliveries`);
    expect(durable.rows[0]).toEqual({ messages: 1, initiators: 1, deliveries: 1 });
    await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'fixture-rotation'.repeat(5)]);
    await expect(operations.submit({ ...command, request_key: randomUUID() })).rejects.toThrow();
    await expect(operations.receipt(published.message_id)).rejects.toThrow();
    expect((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM messages')).rows[0]?.count).toBe(1);
  });

  it.each(['request', 'code', 'grant'] as const)('rejects %s expiration while waiting on the corresponding row lock', async kind => {
    const pool = await database(); const f = await seed(pool); const modified = intercept(pool, async sql => {
      if (kind === 'request') return sql.replace("at+interval '5 minutes'", "at+interval '250 milliseconds'");
      if (kind === 'code') return sql.replace("at+interval '60 seconds'", "at+interval '250 milliseconds'");
      return sql.replace("date_trunc('second',at)+make_interval(secs=>$14)", "at+make_interval(secs=>$14*0)+interval '250 milliseconds'");
    });
    const store = new PostgresOAuthStore(modified, issuer, verify);
    const request = { ...f.request, idHash: secretHash(randomUUID()) };
    await store.createRequest(request, context());
    const approved = kind === 'request' ? undefined : await store.consent(request.idHash, request.browserHash, f.session, ['cauce.read'], context());
    const grant = kind === 'grant' ? (await pool.query<{ id: string }>('SELECT id FROM cauce_oauth_grants LIMIT 1')).rows[0]?.id : undefined;
    const locker = await pool.connect(); const observer = await pool.connect();
    const entered = barrier(); let workerPid = 0;
    const wrapped = intercept(pool, async (sql, client) => {
      const target = kind === 'request' ? 'FROM cauce_oauth_requests WHERE' : kind === 'code' ? 'SELECT challenge,consumed_at' : 'FROM cauce_oauth_grants g';
      if (sql.includes(target) && sql.includes('FOR ')) { workerPid = await pid(client); entered.release(); }
    });
    const table = kind === 'request' ? 'cauce_oauth_requests' : kind === 'code' ? 'cauce_oauth_codes' : 'cauce_oauth_grants';
    const column = kind === 'request' ? 'id_hash' : kind === 'code' ? 'code_hash' : 'id';
    const id = kind === 'request' ? request.idHash : kind === 'code' ? secretHash(approved?.code ?? '') : grant;
    await locker.query('BEGIN'); await locker.query(`SELECT ${column} FROM ${table} WHERE ${column}=$1 FOR UPDATE`, [id]);
    const waitingStore = new PostgresOAuthStore(wrapped, issuer, verify);
    const work = kind === 'request' ? waitingStore.consent(request.idHash, request.browserHash, f.session, ['cauce.read'], context())
      : waitingStore.exchange(exchangeInput(f, approved?.code ?? ''), value => tokens.issue(value), context());
    const rejection = expect(work).rejects.toThrow();
    try {
      await entered.promise; await waitForBlocked(observer, workerPid); await observer.query('SELECT pg_sleep(0.3)');
      await locker.query('COMMIT'); await rejection;
      expect((await counts(pool))?.tokens).toBe('0');
      if (kind === 'request') expect((await counts(pool))?.grants).toBe('0');
    } finally { await locker.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it.each(['before checkout', 'during lock', 'after insert'])('aborts consent %s without partial durable rows', async point => {
    const pool = await database(); const f = await seed(pool); const controller = new AbortController();
    const signal = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    if (point === 'before checkout') controller.abort();
    const wrapped = intercept(pool, async sql => { if (point === 'during lock' && sql.includes('FOR SHARE')) controller.abort(); },
      async sql => { if (point === 'after insert' && sql.includes('INSERT INTO cauce_oauth_codes')) controller.abort(); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_requests')).rows[0]?.consumed_at).toBeNull();
  });

  it.each(['consent', 'exchange'] as const)('cancels %s while PostgreSQL confirms the worker is blocked on a lock', async operation => {
    const pool = await database(); const f = await seed(pool);
    const approved = operation === 'exchange' ? await consent(f) : undefined;
    const grantId = operation === 'exchange' ? (await pool.query<{ id: string }>('SELECT id FROM cauce_oauth_grants')).rows[0]?.id : undefined;
    const controller = new AbortController(); const entered = barrier(); let workerPid = 0;
    const wrapped = intercept(pool, async (sql, client) => {
      const target = operation === 'consent' ? 'FROM human_external_identities' : 'FROM cauce_oauth_grants g';
      if (sql.includes(target) && sql.includes('FOR SHARE')) { workerPid = await pid(client); entered.release(); }
    });
    const locker = await pool.connect(); const observer = await pool.connect(); await locker.query('BEGIN');
    if (operation === 'consent') await locker.query('SELECT id FROM human_external_identities WHERE id=$1 FOR UPDATE', [f.bindingId]);
    else await locker.query('SELECT id FROM cauce_oauth_grants WHERE id=$1 FOR UPDATE', [grantId]);
    const store = new PostgresOAuthStore(wrapped, issuer, verify); const signal = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const work = operation === 'consent' ? store.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], signal)
      : store.exchange(exchangeInput(f, approved?.code ?? ''), value => tokens.issue(value), signal);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await entered.promise; await waitForBlocked(observer, workerPid); controller.abort(); await rejected;
      expect((await counts(pool))?.tokens).toBe('0');
      if (operation === 'consent') expect((await counts(pool))?.grants).toBe('0');
      else expect((await observer.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    } finally { await locker.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it.each(['before checkout', 'after insert'] as const)('aborts exchange %s without consuming its code', async point => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const controller = new AbortController();
    if (point === 'before checkout') controller.abort();
    const wrapped = intercept(pool, undefined, async sql => { if (sql.includes('INSERT INTO cauce_oauth_tokens')) controller.abort(); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(exchangeInput(f, approved.code), value => tokens.issue(value),
      { signal: controller.signal, deadlineMs: Date.now() + 10_000 })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await counts(pool))?.tokens).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
  });

  it('determines a failed COMMIT by observing rollback and allows the unconsumed code to retry', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    const wrapped = intercept(pool, async sql => { if (sql === 'COMMIT') throw new Error('fixture commit was not sent'); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), context())).rejects.toThrow('not sent');
    expect((await counts(pool))?.tokens).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).resolves.toHaveProperty('identity');
  });

  it('rolls back signing failure and observes a confirmed commit after a lost response', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    await expect(f.store.exchange(input, () => { throw new Error('fixture signing failure'); }, context())).rejects.toThrow('signing failure');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    const controller = new AbortController();
    const wrapped = intercept(pool, undefined, async sql => { if (sql === 'COMMIT') controller.abort(); });
    const issued = await new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), { signal: controller.signal, deadlineMs: Date.now() + 10_000 });
    expect(issued.identity.grantId).toBeDefined();
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
    expect(await f.store.validate(issued.identity)).toBe(true);
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
    expect(await revoked(pool, issued.identity.grantId)).toBe(true);
    expect(await f.store.validate(issued.identity)).toBe(false);
    await expect(f.store.refresh({ tokenHash: secretHash(issued.refreshToken), clientId: f.request.clientId, resource: tokens.resource,
      scopes: undefined }, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
  });

  it.each(['down first', 'insert first'])('serializes INSERT/down with locks before checking emptiness: %s', async order => {
    const pool = await database(version); const down = await readFile(downPath, 'utf8');
    const split = down.indexOf('DO $$'); const prefix = down.slice(0, split); const rest = down.slice(split);
    const request: OAuthAuthorizationRequest = { idHash: secretHash(randomUUID()), browserHash: secretHash(randomUUID()), clientId: 'https://client.example/doc', clientName: 'Fixture',
      redirectUri: 'https://client.example/callback', resource: tokens.resource, scopes: ['cauce.read'], challenge: 'x'.repeat(43), state: null };
    const client = await pool.connect(); let observer: DatabaseClient | undefined;
    const reached = barrier(); const resume = barrier(); let workerPid = 0;
    const controller = new AbortController();
    type InsertionOutcome = { status: 'fulfilled' } | { status: 'rejected'; code: string | undefined };
    let insertionResult: Promise<InsertionOutcome> | undefined;
    let lockingResult: Promise<boolean> | undefined;
    const wrapped = intercept(pool, async (sql, connection) => {
      if (sql === 'SELECT pg_advisory_xact_lock_shared(783_003_003)') {
        workerPid = await pid(connection); if (order === 'down first') reached.release();
      }
    }, async sql => { if (order === 'insert first' && sql.includes('INSERT INTO cauce_oauth_requests')) { reached.release(); await resume.promise; } });
    const store = new PostgresOAuthStore(wrapped, issuer, verify);
    try {
      observer = await pool.connect(); await client.query('BEGIN');
      const downPid = await pid(client);
      if (order === 'down first') await client.query(prefix);
      const insertion = store.createRequest(request, { signal: controller.signal, deadlineMs: Date.now() + 10_000 }).then<InsertionOutcome, InsertionOutcome>(
        () => ({ status: 'fulfilled' }),
        (error: unknown) => ({ status: 'rejected', code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined }),
      );
      insertionResult = insertion;
      await Promise.race([reached.promise, insertion.then(() => { throw new Error('fixture insertion settled before reaching its lock barrier'); })]);
      if (order === 'down first') {
        await waitForBlocked(observer, workerPid);
        expect((await observer.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [workerPid])).rows[0]?.blockers).toContain(downPid);
        await client.query(rest); await client.query('COMMIT');
        expect(await insertionResult).toEqual({ status: 'rejected', code: '42P01' });
        expect((await observer.query<{ name: string | null }>("SELECT to_regclass('cauce_oauth_requests') AS name")).rows[0]?.name).toBeNull();
      } else {
        lockingResult = client.query(prefix).then(() => true, () => false);
        await waitForBlocked(observer, downPid);
        expect((await observer.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [downPid])).rows[0]?.blockers).toContain(workerPid);
        resume.release(); expect(await insertionResult).toEqual({ status: 'fulfilled' }); expect(await lockingResult).toBe(true);
        await expect(client.query(rest)).rejects.toThrow('data-retention'); await client.query('ROLLBACK');
        expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
        expect((await observer.query<{ id_hash: string }>('SELECT id_hash FROM cauce_oauth_requests')).rows).toEqual([{ id_hash: request.idHash }]);
      }
    } finally {
      resume.release(); controller.abort(); let rolledBack = false;
      try { await client.query('ROLLBACK'); rolledBack = true; }
      finally { await Promise.all([insertionResult, lockingResult]); client.release(!rolledBack); observer?.release(); }
    }
  });

  it('observes an uncertain COMMIT through another connection and rejects replay', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    const wrapped = intercept(pool, undefined, async sql => { if (sql === 'COMMIT') throw new Error('fixture lost commit acknowledgement'); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), context())).rejects.toThrow('lost commit acknowledgement');
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
  });

  it('does not grant runtime DELETE, TRUNCATE or DDL privileges through the migration', async () => {
    const pool = await database();
    await pool.query('CREATE ROLE oauth_fixture_runtime');
    try {
      await pool.query('GRANT SELECT,INSERT,UPDATE ON cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens TO oauth_fixture_runtime');
      const result = await pool.query<{ insert: boolean; delete: boolean; truncate: boolean; owner: boolean }>(`SELECT
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','INSERT') AS insert,
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','DELETE') AS delete,
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','TRUNCATE') AS truncate,
        tableowner='oauth_fixture_runtime' AS owner FROM pg_tables WHERE tablename='cauce_oauth_grants'`);
      expect(result.rows[0]).toEqual({ insert: true, delete: false, truncate: false, owner: false });
    } finally { await pool.query('DROP OWNED BY oauth_fixture_runtime'); await pool.query('DROP ROLE oauth_fixture_runtime'); }
  });

  it('creates the local binding at consent and resolves a fresh console user end to end without manual inserts', async () => {
    const pool = await database(); const f = await seed(pool, false);
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [f.userId])).rowCount).toBe(0);
    const approved = await consent(f);
    if (!approved.code) throw new Error('missing code');
    const binding = (await pool.query<{ namespace: string; subject: string; enabled: boolean }>(
      'SELECT namespace,subject,enabled FROM human_external_identities WHERE human_id=$1', [f.userId])).rows;
    expect(binding).toEqual([{ namespace: issuer, subject: f.userId, enabled: true }]);
    const issued = await f.store.exchange(exchangeInput(f, approved.code), value => tokens.issue(value), context());
    expect(issued.identity.subject).toBe(f.userId);
    expect(await f.store.validate(issued.identity)).toBe(true);
    const authority = await resolveHumanMcpAuthority({ pool }, issued.identity, new AbortController().signal);
    expect(authority).toMatchObject({ userId: f.userId, scopes: ['cauce.read', 'cauce.publish'],
      principal: { tenant_id: 'Steven', alias: f.alias, operator_id: `console:${f.userId}`, channel: 'human-mcp' } });
    const second = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(second, context());
    expect((await f.store.consent(second.idHash, second.browserHash, f.session, ['cauce.read'], context())).code).toBeDefined();
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [f.userId])).rowCount).toBe(1);
  });

  it('refuses consent for a revoked or foreign binding and leaves no grant behind', async () => {
    const pool = await database(); const revoked = await seed(pool, false); const foreign = await seed(pool, false);
    await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject,enabled,revoked_at)
      VALUES ($1::uuid,'oauth',$2,$1::text,false,clock_timestamp())`, [revoked.userId, issuer]);
    await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
      VALUES ($1,'oauth',$2,$3)`, [revoked.userId, issuer, foreign.userId]);
    for (const f of [revoked, foreign]) await expect(consent(f)).rejects.toThrow('access_denied');
    expect((await counts(pool))?.grants).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_requests WHERE consumed_at IS NOT NULL')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [foreign.userId])).rowCount).toBe(0);
  });

  it('persists dynamic clients, reads them back and purges only stale never-granted registrations past the soft cap', async () => {
    const pool = await database(); const f = await seed(pool);
    const registered = await f.store.registerClient({ clientName: 'Inspector', redirectUris: ['http://localhost/oauth/callback'],
      grantTypes: ['authorization_code', 'refresh_token'] }, context());
    expect(registered.clientId).toMatch(/^cauce-dcr-/u);
    expect(await f.store.registeredClient(registered.clientId, context())).toEqual({ clientId: registered.clientId,
      clientName: 'Inspector', redirectUris: ['http://localhost/oauth/callback'] });
    expect(await f.store.registeredClient('cauce-dcr-00000000-0000-4000-8000-000000000000', context())).toBeUndefined();
    await expect(pool.query("INSERT INTO cauce_oauth_clients(id,client_id,metadata) VALUES (gen_random_uuid(),'https://x.example/c','{}')")).rejects.toThrow();
    await pool.query(`INSERT INTO cauce_oauth_clients(id,client_id,metadata,created_at)
      SELECT gen_random_uuid(),'cauce-dcr-'||gen_random_uuid(),'{"redirect_uris":["http://localhost/cb"]}',clock_timestamp()-interval '2 days'
      FROM generate_series(1,1000)`);
    const used = (await pool.query<{ client_id: string }>('SELECT client_id FROM cauce_oauth_clients WHERE client_id<>$1 ORDER BY created_at LIMIT 1', [registered.clientId])).rows[0]?.client_id;
    await consent(f);
    await pool.query(`INSERT INTO cauce_oauth_grants SELECT gen_random_uuid(),human_id,issuer,resource,$1,redirect_uri,scopes,binding_id,binding_revision,
      membership_revision,tenant_id,actor_alias,credential_stamp,created_at,expires_at FROM cauce_oauth_grants LIMIT 1`, [used]);
    await f.store.registerClient({ clientName: null, redirectUris: ['https://app.example/cb'], grantTypes: ['authorization_code'] }, context());
    const remaining = (await pool.query<{ total: number; kept: boolean; fresh: boolean }>(`SELECT count(*)::int AS total,
      bool_or(client_id=$1) AS kept,bool_or(client_id=$2) AS fresh FROM cauce_oauth_clients`, [used, registered.clientId])).rows[0];
    expect(remaining).toEqual({ total: 902, kept: true, fresh: true });
  });

  it('rotates refresh tokens under grant locks, storing only hashes bounded by the grant', async () => {
    const pool = await database(); const f = await authorized(pool);
    const refresh = (token: string, overrides: Partial<{ clientId: string }> = {}) => f.store.refresh({ tokenHash: secretHash(token),
      clientId: f.request.clientId, resource: tokens.resource, scopes: undefined, ...overrides }, value => tokens.issue(value), context());
    await expect(refresh(f.issued.refreshToken, { clientId: 'https://other.example/doc' })).rejects.toThrow('invalid_grant');
    const next = await refresh(f.issued.refreshToken);
    expect(next.identity.grantId).toBe(f.issued.identity.grantId);
    expect(next.refreshToken).not.toBe(f.issued.refreshToken);
    expect(await f.store.validate(next.identity)).toBe(true);
    const rows = (await pool.query<{ token_hash: string; consumed: boolean; bounded: boolean }>(`SELECT r.token_hash,r.consumed_at IS NOT NULL AS consumed,
      r.expires_at=g.expires_at AS bounded FROM cauce_oauth_refresh_tokens r JOIN cauce_oauth_grants g ON g.id=r.grant_id ORDER BY r.created_at`)).rows;
    expect(rows).toEqual([{ token_hash: secretHash(f.issued.refreshToken), consumed: true, bounded: true },
      { token_hash: secretHash(next.refreshToken), consumed: false, bounded: true }]);
    const third = await refresh(next.refreshToken);
    expect(await f.store.validate(third.identity)).toBe(true);
    await expect(pool.query('UPDATE cauce_oauth_refresh_tokens SET consumed_at=NULL')).rejects.toThrow('immutable');
    await expect(pool.query('DELETE FROM cauce_oauth_refresh_tokens')).rejects.toThrow('retention');
  });

  it('recovers a lost refresh response and converges concurrent retries on one successor', async () => {
    const pool = await database(); const f = await authorized(pool);
    const refresh = (token: string) => f.store.refresh({ tokenHash: secretHash(token), clientId: f.request.clientId,
      resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context());
    const next = await refresh(f.issued.refreshToken);
    const recovered = await refresh(f.issued.refreshToken);
    expect(recovered.refreshToken).toBe(next.refreshToken);
    expect(await f.store.validate(recovered.identity)).toBe(true);
    expect(await revoked(pool, f.issued.identity.grantId)).toBe(false);
    expect(await f.store.validate(next.identity)).toBe(true);
    expect(await f.store.validate((await refresh(next.refreshToken)).identity)).toBe(true);
    const other = await authorized(pool);
    const raced = await Promise.allSettled([1, 2].map(() => other.store.refresh({ tokenHash: secretHash(other.issued.refreshToken),
      clientId: other.request.clientId, resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context())));
    const winner = raced.find(value => value.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing winning refresh');
    expect(raced.filter(value => value.status === 'rejected')).toHaveLength(0);
    expect(raced.every(value => value.status === 'fulfilled' && value.value.refreshToken === winner.value.refreshToken)).toBe(true);
    expect(await revoked(pool, other.issued.identity.grantId)).toBe(false);
    expect(await other.store.validate(winner.value.identity)).toBe(true);
    await expect(other.store.refresh({ tokenHash: secretHash(winner.value.refreshToken), clientId: other.request.clientId,
      resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context())).resolves.toHaveProperty('refreshToken');
  });

  it('revokes the whole grant when a rotated refresh token is replayed after the grace window', async () => {
    const pool = await database(); const f = await authorized(pool);
    const store = new PostgresOAuthStore(shortGrace(pool), issuer, verify);
    const refresh = (token: string) => store.refresh({ tokenHash: secretHash(token), clientId: f.request.clientId,
      resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context());
    const next = await refresh(f.issued.refreshToken);
    await pool.query('SELECT pg_sleep(0.3)');
    await expect(refresh(f.issued.refreshToken)).rejects.toThrow('invalid_grant');
    expect(await revoked(pool, f.issued.identity.grantId)).toBe(true);
    await expect(refresh(next.refreshToken)).rejects.toThrow('invalid_grant');
    expect(await f.store.validate(next.identity)).toBe(false);
    await expect(pool.query('DELETE FROM cauce_oauth_grant_revocations')).rejects.toThrow('permanent');
    await expect(pool.query('UPDATE cauce_oauth_grant_revocations SET revoked_at=clock_timestamp()')).rejects.toThrow('permanent');
  });

  it.each(['manual', 'reuse'] as const)('commits a %s revocation while an MCP call holds FOR SHARE on the grant', async kind => {
    const pool = await database(); const f = await authorized(pool);
    const store = new PostgresOAuthStore(shortGrace(pool), issuer, verify);
    const next = await store.refresh({ tokenHash: secretHash(f.issued.refreshToken), clientId: f.request.clientId,
      resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context());
    await pool.query('SELECT pg_sleep(0.3)');
    const holder = await pool.connect();
    try {
      // La misma autoridad que retiene una lectura o publicación MCP hasta su COMMIT.
      await holder.query('BEGIN');
      await lockOAuthAccess(holder, next.identity, issuer, tokens.resource, verify);
      const started = Date.now();
      if (kind === 'manual') await f.store.revoke(f.issued.identity.grantId, f.session, context());
      else await expect(store.refresh({ tokenHash: secretHash(f.issued.refreshToken), clientId: f.request.clientId,
        resource: tokens.resource, scopes: undefined }, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(true);
      expect(await f.store.validate(next.identity)).toBe(false);
      expect((await f.store.grants(f.session, context()))[0]?.revoked).toBe(true);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });

  it('fixes the grant lifetime from consent, independent of the console cookie, and refresh never outlives it', async () => {
    const pool = await database(); const f = await seed(pool);
    const lifetime = async (grantId: string) => (await pool.query<{ seconds: number }>(
      'SELECT ceil(extract(epoch FROM expires_at-created_at))::int AS seconds FROM cauce_oauth_grants WHERE id=$1', [grantId])).rows[0]?.seconds;
    const almostExpired = { ...f.session, expiresAt: Math.floor(Date.now() / 1000) + 30 };
    const approved = await f.store.consent(f.request.idHash, f.request.browserHash, almostExpired, ['cauce.read'], context());
    if (!approved.code) throw new Error('missing code');
    const issued = await f.store.exchange(exchangeInput(f, approved.code), value => tokens.issue(value), context());
    expect(await lifetime(issued.identity.grantId)).toBe(OAUTH_GRANT_TTL_SECONDS.default);
    const next = await f.store.refresh({ tokenHash: secretHash(issued.refreshToken), clientId: f.request.clientId, resource: tokens.resource,
      scopes: undefined }, value => tokens.issue(value), context());
    expect((await pool.query<{ bounded: boolean }>(`SELECT bool_and(r.expires_at=g.expires_at) AS bounded FROM cauce_oauth_refresh_tokens r
      JOIN cauce_oauth_grants g ON g.id=r.grant_id`)).rows[0]?.bounded).toBe(true);
    expect(next.identity.expiresAt * 1000).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
    const configured = new PostgresOAuthStore(pool, issuer, verify, { grantTtlSeconds: 300 });
    const second = { ...f.request, idHash: secretHash(randomUUID()) };
    await configured.createRequest(second, context());
    const short = await configured.consent(second.idHash, second.browserHash, f.session, ['cauce.read'], context());
    if (!short.code) throw new Error('missing code');
    const shortIssued = await configured.exchange(exchangeInput(f, short.code), value => tokens.issue(value), context());
    expect(await lifetime(shortIssued.identity.grantId)).toBe(300);
    await expect(pool.query(`INSERT INTO cauce_oauth_grants SELECT gen_random_uuid(),human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,
      binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp,created_at,created_at+interval '30 days 1 second'
      FROM cauce_oauth_grants LIMIT 1`)).rejects.toThrow();
  });

  it.each(['revoked grant', 'disabled console user', 'changed password', 'revoked membership', 'revoked binding'] as const)(
    'refuses refresh for a %s without issuing tokens', async (change) => {
      const pool = await database(); const f = await authorized(pool);
      if (change === 'revoked grant') await f.store.revoke(f.issued.identity.grantId, f.session, context());
      if (change === 'disabled console user') await pool.query('UPDATE console_users SET active=false WHERE id=$1', [f.userId]);
      if (change === 'changed password') await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'refresh-rotation'.repeat(5)]);
      if (change === 'revoked membership') await pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [f.userId]);
      if (change === 'revoked binding') await pool.query('UPDATE human_external_identities SET enabled=false,revoked_at=clock_timestamp() WHERE id=$1', [f.bindingId]);
      await expect(f.store.refresh({ tokenHash: secretHash(f.issued.refreshToken), clientId: f.request.clientId, resource: tokens.resource,
        scopes: undefined }, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
      expect(await counts(pool)).toMatchObject({ tokens: '1' });
      expect((await pool.query('SELECT 1 FROM cauce_oauth_refresh_tokens WHERE consumed_at IS NOT NULL')).rowCount).toBe(0);
    },
  );

  it('purges expired requests, codes and tokens opportunistically on insert without touching live rows or grants', async () => {
    const pool = await database(); const f = await seed(pool);
    const short = intercept(pool, async sql => sql.replace("at+interval '5 minutes'", "at+interval '200 milliseconds'")
      .replace("at+interval '60 seconds'", "at+interval '200 milliseconds'"));
    const store = new PostgresOAuthStore(short, issuer, verify);
    const stale = { ...f.request, idHash: secretHash(randomUUID()) };
    await store.createRequest(stale, context());
    const expiring = { ...f.request, idHash: secretHash(randomUUID()) };
    await store.createRequest(expiring, context());
    await store.consent(expiring.idHash, expiring.browserHash, f.session, ['cauce.read'], context());
    await pool.query('SELECT pg_sleep(0.3)');
    const fresh = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(fresh, context());
    expect((await pool.query<{ id_hash: string }>('SELECT id_hash FROM cauce_oauth_requests ORDER BY id_hash')).rows.map(row => row.id_hash).sort())
      .toEqual([f.request.idHash, fresh.idHash].sort());
    const approved = await consent(f);
    expect(await counts(pool)).toEqual({ requests: '2', grants: '2', codes: '1', tokens: '0' });
    if (!approved.code) throw new Error('missing code');
    await f.store.exchange(exchangeInput(f, approved.code), value => tokens.issue(value), context());
    expect(await counts(pool)).toEqual({ requests: '2', grants: '2', codes: '1', tokens: '1' });
  });

  it('drops only empty OAuth tables atomically and preserves the human ledger', async () => {
    const pool = await database(version); const client = await pool.connect();
    try { await transaction(client, async () => { await client.query(await readFile(downPath, 'utf8')); }); }
    finally { client.release(); }
    expect((await pool.query("SELECT to_regclass('cauce_oauth_grants') AS oauth,to_regclass('human_external_identities') AS human")).rows[0]).toEqual({ oauth: null, human: 'human_external_identities' });
    for (const table of ['schema_migrations', 'schema_migration_ledger']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE version=$1`, [version])).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE version=$1`, [previousVersion])).rowCount).toBe(1);
    }
    await applyMigrationsThrough(pool, version);
    expect(await counts(pool)).toEqual({ requests: '0', grants: '0', codes: '0', tokens: '0' });
    expect((await pool.query("SELECT to_regclass('cauce_oauth_refresh_tokens') AS refresh,to_regclass('cauce_oauth_clients') AS clients")).rows[0])
      .toEqual({ refresh: 'cauce_oauth_refresh_tokens', clients: 'cauce_oauth_clients' });
    await pool.query("INSERT INTO schema_migrations(version) VALUES ('999_fixture_later.sql')");
    const later = await pool.connect();
    try { await expect(transaction(later, async () => { await later.query(await readFile(downPath, 'utf8')); })).rejects.toThrow('later migration'); }
    finally { later.release(); }
  });
});
