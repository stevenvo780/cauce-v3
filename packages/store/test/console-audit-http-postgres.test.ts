import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway, FixedAuthProvider, testPrincipal } from '../../../services/gateway/src/test-support/gateway-doubles.js';

interface AuditItem {
  event_id: string; at: string; tenant_id: string | null; company_id: string;
  actor_alias: string | null; action: string; decision: string; trace_id: string | null;
  request_id: string | null; host_id: string | null; component: string | null; summary: string | null;
}
interface AuditPage { items: AuditItem[]; next_cursor: string | null }
interface AuditInput {
  id?: string; tenant?: string | null; actor?: string; company?: string | null;
  trace?: string; action?: string; at?: string; metadata?: Record<string, unknown>;
  message?: string; delivery?: string;
}
const PASSWORD = 'audit-http-fixture-password';
const ORIGIN = 'http://localhost';
const PRIVATE = 'zz-canary-audit-private-token';
const TIME = '2026-08-26T08:00:00Z';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let app: FastifyInstance | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;
let passwordHash: string | undefined; let cookie: string; let csrf: string;

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database'));
  pool = current.pool; fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  await current.adminPool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES
    ('zz-canary-audit-alpha','Audit alpha','context_alpha'),('zz-canary-audit-beta','Audit beta','context_beta');
    INSERT INTO tenants(id,company_id) VALUES('ContextPeer','context_alpha');`);
  app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 31),
  }) });
  await login();
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function fixture(index = 0) { return requireValue(fixtures[index], 'company fixture'); }
function server() { return requireValue(app, 'gateway'); }
function admin() { return requireValue(current, 'case database').adminPool; }
function sessionCookie(response: LightMyRequestResponse) {
  const value = response.headers['set-cookie'];
  return requireValue(Array.isArray(value) ? value[0] : value, 'session cookie').split(';', 1)[0] ?? '';
}
async function login(email = `${fixture().company_id}@dev.example`) {
  const response = await server().inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200); cookie = sessionCookie(response);
  csrf = response.json<{ csrf_token: string }>().csrf_token;
}
function audit(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  return server().inject({ method: 'GET', url: `/v3/console/audit${search ? `?${search}` : ''}`, headers: { cookie, ...headers } });
}
function page(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(200);
  return response.json<AuditPage>();
}
function ids(value: AuditPage) { return value.items.map(item => item.event_id); }
async function seedAudit(input: AuditInput = {}) {
  const result = await admin().query<{ id: string }>(`INSERT INTO audit_events
    (id,tenant_id,actor_alias,company_id,action,decision,trace_id,metadata,created_at,message_id,delivery_id)
    VALUES(COALESCE($1::bigint,nextval('audit_events_id_seq')),$2,$3,$4,$5,'allow',$6,$7::jsonb,$8::timestamptz,$9,$10) RETURNING id::text`,
  [input.id ?? null, input.tenant === undefined ? 'ContextAlpha' : input.tenant, input.actor ?? 'director',
    input.company ?? null, input.action ?? 'context.sync', input.trace ?? 'zz-canary-audit-chain',
    JSON.stringify(input.metadata ?? { state: 'synced' }), input.at ?? TIME, input.message ?? null, input.delivery ?? null]);
  return requireValue(result.rows[0], 'audit receipt').id;
}
async function createReader() {
  const result = await admin().query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('audit-reader@example.test','audit-reader@example.test',$1,'Reader','reader',$2,'owner') RETURNING id::text`,
  [passwordHash, fixture().tenant_id]);
  const human = requireValue(result.rows[0], 'reader').id;
  await admin().query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,$2,'owner',ARRAY['read'])`, [human, fixture().tenant_id]);
  await login('audit-reader@example.test');
}

describe('company audit HTTP with signed human authority and real PostgreSQL', () => {
  it('shows owners agent and sibling tenant events while enforcing explicit company attribution', async () => {
    const own = await seedAudit(); const sibling = await seedAudit({ tenant: 'ContextPeer', actor: 'peer-agent' });
    const company = await seedAudit({ tenant: null, actor: 'platform', company: 'context_alpha' });
    await seedAudit({ tenant: 'ContextBeta' }); await seedAudit({ company: 'context_beta' });
    const result = page(await audit());
    expect(ids(result)).toEqual([company, sibling, own]); expect(result.next_cursor).toBeNull();
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: sibling, tenant_id: 'ContextPeer', company_id: 'context_alpha', actor_alias: 'peer-agent' }),
      expect.objectContaining({ event_id: company, tenant_id: null, company_id: 'context_alpha' }),
    ]));
    expect(result.items.every(item => item.company_id === 'context_alpha')).toBe(true);
  });
  it('filters exact traces on the server before selecting a page, including long encoded traces', async () => {
    for (const trace of ['zz-canary/audit/trace', 't'.repeat(256)]) {
      const match = await seedAudit({ trace });
      await seedAudit({ trace: `${trace.slice(0, 200)}-other` }); await seedAudit({ tenant: 'ContextBeta', trace });
      const result = page(await audit({ trace_id: trace, limit: '1' }));
      expect(ids(result)).toEqual([match]); expect(result.next_cursor).toBeNull();
      expect(result.items[0]?.trace_id).toBe(trace);
    }
  });
  it('combines alias, action, inclusive dates and trace before cursor pagination', async () => {
    const lower = await seedAudit(); const upper = await seedAudit({ at: '2026-08-26T08:00:01Z' });
    await seedAudit({ actor: 'owner' }); await seedAudit({ action: 'delivery.ack' });
    await seedAudit({ at: '2026-08-26T07:59:59.999Z' }); await seedAudit({ at: '2026-08-26T08:00:01.001Z' });
    await seedAudit({ trace: 'different-trace' }); await seedAudit({ tenant: 'ContextBeta' });
    const query = { trace_id: 'zz-canary-audit-chain', alias: 'director', action: 'context.sync',
      from: TIME, to: '2026-08-26T08:00:01Z', limit: '1' };
    const first = page(await audit(query)); expect(ids(first)).toEqual([upper]); expect(first.next_cursor).toBe(upper);
    const second = page(await audit({ ...query, before: upper })); expect(ids(second)).toEqual([lower]); expect(second.next_cursor).toBeNull();
  });
  it('keeps cursor pages stable across equal timestamps and newly inserted events', async () => {
    const oldest = await seedAudit(); const middle = await seedAudit(); const latest = await seedAudit();
    const first = page(await audit({ limit: '2' })); expect(ids(first)).toEqual([latest, middle]); expect(first.next_cursor).toBe(middle);
    await seedAudit(); const second = page(await audit({ limit: '2', before: middle }));
    expect(ids(second)).toEqual([oldest]); expect(second.next_cursor).toBeNull();
  });
  it('preserves bigint identifiers and cursors above the JavaScript safe integer range', async () => {
    await seedAudit({ id: '9007199254740993' }); await seedAudit({ id: '9007199254740994' });
    const first = page(await audit({ limit: '1' })); expect(ids(first)).toEqual(['9007199254740994']);
    expect(first.next_cursor).toBe('9007199254740994');
    const second = page(await audit({ before: first.next_cursor ?? '', limit: '1' }));
    expect(ids(second)).toEqual(['9007199254740993']); expect(second.next_cursor).toBeNull();
  });
  it('projects company hosts and known components while excluding metadata and secrets', async () => {
    const safe = await seedAudit({ metadata: { host_id: 'zz-canary-audit-alpha', component: 'context', state: 'synced',
      token: PRIVATE, payload: { secret: PRIVATE }, session_id: PRIVATE, cause: PRIVATE } });
    const foreignHost = await seedAudit({ metadata: { host_id: 'zz-canary-audit-beta', component: PRIVATE, token: PRIVATE } });
    const response = await audit(); const result = page(response);
    expect(result.items).toEqual([
      expect.objectContaining({ event_id: foreignHost, host_id: null, component: null, summary: null, company_id: 'context_alpha' }),
      expect.objectContaining({ event_id: safe, host_id: 'zz-canary-audit-alpha', component: 'context', summary: '{"state":"synced"}' }),
    ]);
    expect(Object.keys(requireValue(result.items[0], 'audit item')).sort()).toEqual([
      'action', 'actor_alias', 'at', 'company_id', 'component', 'decision', 'event_id', 'host_id', 'request_id', 'summary', 'tenant_id', 'trace_id',
    ]);
    for (const forbidden of [PRIVATE, 'metadata', 'zz-canary-audit-beta']) expect(response.body).not.toContain(forbidden);
  });
  it('restricts platform administrators to the company selected by the signed session switch', async () => {
    await admin().query('INSERT INTO platform_admins(human_id) VALUES($1)', [fixture().human_id]); await login();
    const own = await seedAudit(); const foreign = await seedAudit({ tenant: 'ContextBeta' });
    expect(ids(page(await audit({ action: 'context.sync' })))).toEqual([own]);
    const switched = await server().inject({ method: 'POST', url: '/v3/auth/session/company',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf }, payload: { company_id: 'context_beta' } });
    expect(switched.statusCode).toBe(200); cookie = sessionCookie(switched);
    const result = page(await audit({ action: 'context.sync' })); expect(ids(result)).toEqual([foreign]);
    expect(result.items.every(item => item.company_id === 'context_beta')).toBe(true);
    await admin().query('DELETE FROM platform_admins WHERE human_id=$1', [fixture().human_id]);
    expect(ids(page(await audit({ action: 'context.sync' })))).toEqual([own]);
  });
  it('limits a human reader to the home tenant despite sharing an operator alias with its owner', async () => {
    const own = await seedAudit(); await seedAudit({ tenant: 'ContextPeer' }); await seedAudit({ tenant: 'ContextBeta' });
    await seedAudit({ company: 'context_beta' }); await createReader();
    const result = page(await audit()); expect(ids(result)).toEqual([own]);
    expect(result.items[0]?.company_id).toBe('context_alpha');
  });
  it('rejects a still signed session after its human membership is revoked', async () => {
    await seedAudit(); page(await audit());
    await admin().query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [fixture().human_id]);
    expect((await audit()).statusCode).toBe(403);
  });
  it('rejects human membership aliases that no longer match the signed home principal', async () => {
    await seedAudit(); page(await audit());
    await admin().query("UPDATE human_tenant_memberships SET actor_alias='director' WHERE human_id=$1", [fixture().human_id]);
    expect([403, 409]).toContain((await audit()).statusCode);
  });
  it('requires read permission even when the human remains a controlling company owner', async () => {
    await seedAudit(); await admin().query("UPDATE human_tenant_memberships SET permissions=ARRAY['control'] WHERE human_id=$1", [fixture().human_id]);
    expect((await audit()).statusCode).toBe(403);
  });
  it('rejects the old signed credential stamp when the durable password changes', async () => {
    await seedAudit(); page(await audit());
    const changed = await hashPassword('audit-http-replacement-password', { cost: 1_024, blockSize: 8, parallelism: 1 });
    await admin().query('UPDATE console_users SET password_hash=$1 WHERE id=$2', [changed, fixture().human_id]);
    expect([401, 403]).toContain((await audit()).statusCode);
  });
  it('ignores forged authority headers and rejects query attempts to change the active company', async () => {
    const own = await seedAudit(); await seedAudit({ tenant: 'ContextBeta' });
    const headers = { 'x-cauce-company': 'context_beta', 'x-cauce-tenant': 'ContextBeta', 'x-cauce-alias': 'owner',
      'x-cauce-human-id': fixture(1).human_id, 'x-cauce-role': 'platform_admin' };
    expect(ids(page(await audit({}, headers)))).toEqual([own]);
    expect((await audit({ company_id: 'context_beta' })).statusCode).toBe(422);
    const anonymous = await server().inject({ method: 'GET', url: '/v3/console/audit', headers });
    expect([401, 403]).toContain(anonymous.statusCode);
  });
  it('keeps authenticated non-console agents at own or participating events without promoting their aliases', async () => {
    const directorOwn = await seedAudit(); const ownerOwn = await seedAudit({ actor: 'owner' });
    await seedAudit({ tenant: 'ContextPeer' }); await seedAudit({ tenant: 'ContextBeta' });
    await seedAudit({ actor: 'unrelated', metadata: { recipient_alias: 'owner' } });
    const message = randomUUID(); const delivery = randomUUID();
    await admin().query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,$2,'zz-canary-audit-participating',$3,'context-room','director',$4::jsonb,'interactive')`,
    [message, randomUUID(), fixture().tenant_id, JSON.stringify({ type: 'command', text: PRIVATE })]);
    await admin().query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias)
      VALUES($1,$2,$3,'owner')`, [delivery, message, fixture().tenant_id]);
    const roomParticipant = await seedAudit({ tenant: 'ContextPeer', message });
    const deliveryParticipant = await seedAudit({ tenant: 'ContextPeer', actor: 'owner', delivery });
    await seedAudit({ tenant: 'ContextBeta', message, delivery });
    for (const alias of ['director', 'owner']) {
      await server().close();
      app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: new FixedAuthProvider(testPrincipal({
        tenant_id: fixture().tenant_id, alias, permissions: ['read'],
      })) });
      expect(ids(page(await audit({}, { 'x-cauce-company': 'context_beta', 'x-cauce-human-id': fixture().human_id })))).toEqual(
        alias === 'director' ? [roomParticipant, directorOwn] : [deliveryParticipant, roomParticipant, ownerOwn]);
    }
  });
  it('rejects malformed and duplicate server filters rather than widening or silently dropping them', async () => {
    const invalidQueries: Record<string, string>[] = [
      { limit: '0' }, { limit: '501' }, { before: '01' }, { before: '9223372036854775808' },
      { trace_id: '' }, { trace_id: 't'.repeat(257) }, { trace_id: 'bad\ntrace' }, { alias: 'owner%' },
      { action: 'context.*' }, { from: '2026-02-30T08:00:00Z' }, { to: '2026-08-26' },
      { from: '2026-08-26T08:00:00+00:00' }, { from: '2026-08-27T00:00:00Z', to: TIME },
    ];
    for (const query of invalidQueries) expect((await audit(query)).statusCode).toBe(422);
    const duplicate = await server().inject({ method: 'GET', url: '/v3/console/audit?trace_id=first&trace_id=second', headers: { cookie } });
    expect(duplicate.statusCode).toBe(422);
  });
});
