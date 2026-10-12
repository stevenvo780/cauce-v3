import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, withTransaction, type DatabasePool } from '../src/index.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';
import { recordTerminalAudit, type TerminalAuditEntry } from '../../../services/gateway/src/terminal/audit.js';
import { registerTerminalControlPlane } from '../../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../../services/gateway/src/terminal/registry.js';

const ORIGIN = 'http://localhost';
const PASSWORD = 'terminal-audit-fixture-password';
const HOST = 'zz-canary-terminal-alpha';
const MOVED_HOST = 'zz-canary-terminal-alpha-moved';
const FOREIGN_HOST = 'zz-canary-terminal-beta';
const RELAY = 'a'.repeat(64);
const BOOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RELAY_TOKEN = 'terminal-audit-relay-fixture-token';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let app: FastifyInstance | undefined;
let directory: string | undefined;
let passwordHash: string | undefined;
let headers: Record<string, string>;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  await current.adminPool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES
    ($1,$1,'context_alpha'),($2,$2,'context_alpha'),($3,$3,'context_beta')`, [HOST,MOVED_HOST,FOREIGN_HOST]);
  await pool.query(`UPDATE agents SET host_id=CASE company_id WHEN 'context_alpha' THEN $1 ELSE $2 END
    WHERE company_id IN ('context_alpha','context_beta')`, [HOST,FOREIGN_HOST]);
  const registry = new AgentRegistry();
  registry.observe({ relay_instance_id: RELAY, relay_boot_id: BOOT }, [{
    tenant_id: identity().tenant_id, alias: identity().alias, container_id: 'ws-director', generation: 'gen-fixture',
    image_id: 'sha256:' + 'c'.repeat(64), runtime_user: 'dev', runtime_uid: 1000,
    harness: 'codex', modes: ['shell','harness_rw'], connected_since: new Date().toISOString(),
  }]);
  directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-audit-'));
  const grantsFile = join(directory,'grants.json');
  await writeFile(grantsFile,JSON.stringify({ version: 1, grants: [{
    operator: 'context_alpha@dev.example', tenant_id: identity().tenant_id, alias: identity().alias,
    modes: ['shell','harness_rw'],
  }] }));
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) });
  app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: provider });
  await registerTerminalControlPlane(app, { pool, authProvider: provider, registry,
    config: { wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32), relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([RELAY]), grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900,
      sessionMaxTotalSeconds: 3600, claimLeaseSeconds: 150, writableTuiEnabled: true,
      controlHoldSeconds: 900, maxSessionsPerOperator: 10, operatorHeader: 'x-cauce-operator', operators: new Set() },
    measuredFacts: { factsFor: async () => undefined },
    governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'fixture' }) },
    relayPeerInstanceId: () => RELAY,
  });
  const login = await server().inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: 'context_alpha@dev.example', password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie']; const cookie = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!cookie) throw new Error('cookie unavailable');
  headers = { origin: ORIGIN, cookie: cookie.split(';')[0] ?? '', 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
});
afterEach(async () => {
  await app?.close(); app = undefined;
  if (directory) await rm(directory,{ recursive: true, force: true }); directory = undefined;
  await current?.close(); current = undefined;
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function server() { if (!app) throw new Error('gateway unavailable'); return app; }
function admin() { if (!current) throw new Error('case database unavailable'); return current.adminPool; }
function identity(index = 0) { const value = fixtures[index]; if (!value) throw new Error('identity unavailable'); return value; }
function body() { return { tenant_id: identity().tenant_id, alias: identity().alias, mode: 'harness_rw',
  cols: 80, rows: 24, request_id: randomUUID(), owner_token: randomUUID() }; }
interface Receipt { session_id: string; request_id: string; owner_generation: string; authority_proof: string; ticket: string }
async function open(request = body()): Promise<Receipt> {
  const response = await server().inject({ method: 'POST', url: '/v3/console/terminal/sessions', headers, payload: request });
  expect(response.statusCode,response.body).toBe(201); return response.json<Receipt>();
}
async function audits(sessionId?: string) {
  return (await pool.query<{ action: string; metadata: Record<string,unknown> }>(
    `SELECT action,metadata FROM audit_events WHERE action LIKE 'terminal.%'
      AND ($1::text IS NULL OR metadata->>'session_id'=$1) ORDER BY id`, [sessionId ?? null])).rows;
}
function relay(sid: string, action: string, payload: Record<string,unknown>) {
  return server().inject({ method: 'POST', url: `/v3/terminal/relay/sessions/${sid}/${action}`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: { relay_instance_id: RELAY, relay_boot_id: BOOT, ...payload } });
}
function followup(sessionId: string, metadata: Record<string,unknown> = {}): TerminalAuditEntry {
  return { tenant_id: identity().tenant_id, actor_alias: identity().alias, action: 'terminal.session.close', decision: 'info',
    metadata: { session_id: sessionId, target_tenant: identity().tenant_id, target_alias: identity().alias, ...metadata } };
}

describe('terminal audit metadata with signed HTTP sessions and real PostgreSQL', () => {
  it.each(['agent_document.read','agent_document.write','agent_document.denied','agent_profile.write'] as const)(
  'records context component for %s without trusting a supplied component', async action => {
    await recordTerminalAudit(pool, { tenant_id: identity().tenant_id, actor_alias: identity().alias,
      action, decision: 'info', metadata: { component: 'terminal', host_id: HOST } });
    const rows = await pool.query<{ metadata: Record<string,unknown> }>(
      'SELECT metadata FROM audit_events WHERE action=$1 ORDER BY id DESC LIMIT 1', [action]);
    expect(rows.rows[0]?.metadata).toMatchObject({ component: 'context', host_id: HOST });
  });

  it('records the resolved host throughout admission, relay, control, renewal and input closure', async () => {
    const request = body(); const receipt = await open(request);
    const owner = { request_id: request.request_id, owner_generation: receipt.owner_generation,
      owner_token: request.owner_token, authority_proof: receipt.authority_proof };
    const claimToken = randomUUID();
    const consume = await relay(receipt.session_id,'consume', { ticket: receipt.ticket, claim_token: claimToken,
      authority_proof: receipt.authority_proof });
    expect(consume.statusCode,consume.body).toBe(200);
    const grant = consume.json<{ claim_epoch: string; resume_token: string }>();
    const take = await server().inject({ method: 'POST', url: `/v3/console/terminal/sessions/${receipt.session_id}/control`,
      headers, payload: { ...owner, action: 'take' } });
    expect(take.statusCode,take.body).toBe(200);
    const extend = await server().inject({ method: 'POST', url: `/v3/console/terminal/sessions/${receipt.session_id}/extend`, headers, payload: owner });
    expect(extend.statusCode,extend.body).toBe(200);
    const resume = await relay(receipt.session_id,'resume',{ claim_token: claimToken, claim_epoch: grant.claim_epoch,
      resume_token: grant.resume_token, authority_proof: receipt.authority_proof });
    expect(resume.statusCode,resume.body).toBe(200);
    await pool.query('UPDATE agents SET host_id=$1 WHERE company_id=$2', [MOVED_HOST,identity().company_id]);
    const close = await relay(receipt.session_id,'close',{ claim_token: claimToken, claim_epoch: grant.claim_epoch,
      reason: 'fixture_closed', exit_code: 0, bytes_in: 17, bytes_out: 23,
      input_batches: 1, recording_sha256: 'd'.repeat(64), recording_capped: false });
    expect(close.statusCode,close.body).toBe(200);
    const rows = await audits(receipt.session_id);
    expect(new Set(rows.map(row => row.action))).toEqual(new Set(['terminal.session.request','terminal.session.consume',
      'terminal.control_taken','terminal.control_released','terminal.session.extended','terminal.session.resume',
      'terminal.session.input','terminal.session.close']));
    for (const row of rows) expect(row.metadata,row.action).toMatchObject({ host_id: HOST, component: 'terminal' });
    for (const token of [request.owner_token,receipt.ticket,receipt.authority_proof,grant.resume_token,claimToken,RELAY_TOKEN]) {
      expect(JSON.stringify(rows)).not.toContain(token);
    }
  });

  it('preserves the original admission host when recovering a receipt after placement changes', async () => {
    const request = body(); const receipt = await open(request);
    await pool.query('UPDATE agents SET host_id=$1 WHERE company_id=$2', [MOVED_HOST,identity().company_id]);
    expect((await open(request)).session_id).toBe(receipt.session_id);
    const rows = await audits(receipt.session_id);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.metadata).toMatchObject({ receipt_recovered: true, host_id: HOST, component: 'terminal' });
  });

  it('keeps historical admissions hostless after placement changes and receipt recovery', async () => {
    const request = body(); const receipt = await open(request);
    await admin().query(`UPDATE audit_events SET metadata=metadata-'host_id'-'component'
      WHERE metadata->>'session_id'=$1`, [receipt.session_id]);
    await pool.query('UPDATE agents SET host_id=$1 WHERE company_id=$2', [MOVED_HOST,identity().company_id]);
    await open(request);
    await recordTerminalAudit(pool,followup(receipt.session_id,{ host_id: MOVED_HOST }));
    const rows = await audits(receipt.session_id);
    for (const row of rows.slice(1)) expect(row.metadata).toMatchObject({ host_id: null, component: 'terminal' });
  });

  it('redacts hosts of unavailable targets before placement discovery', async () => {
    for (const target of [{ tenant_id: identity(1).tenant_id, alias: identity(1).alias },
      { tenant_id: identity().tenant_id, alias: 'unavailable' }]) {
      const response = await server().inject({ method: 'POST', url: '/v3/console/terminal/sessions', headers,
        payload: { ...body(), ...target } });
      expect(response.statusCode,response.body).toBe(404);
    }
    const rows = await audits(); expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.metadata).toMatchObject({ host_id: null, component: 'terminal', container: null, cohort: [] });
    expect(JSON.stringify(rows)).not.toContain(FOREIGN_HOST);
  });

  it('rejects admission evidence belonging to a different company', async () => {
    const receipt = await open();
    await admin().query('DELETE FROM audit_events WHERE metadata->>\'session_id\'=$1', [receipt.session_id]);
    await admin().query(`INSERT INTO audit_events(company_id,tenant_id,actor_alias,action,decision,metadata)
      VALUES($1,$2,$3,'terminal.session.request','allow',$4::jsonb)`, [identity(1).company_id,identity(1).tenant_id,identity(1).alias,
      JSON.stringify({ session_id: receipt.session_id, target_tenant: identity().tenant_id, target_alias: identity().alias,
        host_id: FOREIGN_HOST, component: 'terminal' })]);
    await recordTerminalAudit(pool,followup(receipt.session_id,{ host_id: HOST, component: 'backup' }));
    expect((await audits(receipt.session_id)).at(-1)?.metadata).toMatchObject({ host_id: null, component: 'terminal' });
  });

  it('rejects admission evidence from a different actor or outside its issuance window', async () => {
    const receipt = await open();
    await admin().query(`UPDATE audit_events SET actor_alias='another-actor'
      WHERE metadata->>'session_id'=$1`, [receipt.session_id]);
    await recordTerminalAudit(pool,followup(receipt.session_id));
    expect((await audits(receipt.session_id)).at(-1)?.metadata.host_id).toBeNull();
    await admin().query(`UPDATE audit_events SET actor_alias=$2,created_at=created_at-interval '2 minutes'
      WHERE action='terminal.session.request' AND metadata->>'session_id'=$1`, [receipt.session_id,identity().alias]);
    await recordTerminalAudit(pool,followup(receipt.session_id));
    expect((await audits(receipt.session_id)).at(-1)?.metadata.host_id).toBeNull();
  });

  it('bounds admission lookup through the tenant/time index amid unrelated audit history', async () => {
    const receipt = await open();
    await admin().query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,created_at)
      SELECT $1,$2,'fixture.unrelated','info',now()-interval '1 day' FROM generate_series(1,5000)
      UNION ALL SELECT $3,$4,'fixture.unrelated','info',now() FROM generate_series(1,5000)`,
    [identity().tenant_id,identity().alias,identity(1).tenant_id,identity(1).alias]);
    await admin().query('ANALYZE audit_events');
    const queries = vi.spyOn(pool,'query');
    try {
      await recordTerminalAudit(pool,followup(receipt.session_id));
      const lookup = queries.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes("SELECT audit.metadata->>'host_id' AS host_id"));
      if (typeof lookup?.[0] !== 'string') throw new Error('admission lookup was not executed');
      const plan = await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${lookup[0]}`,lookup[1] as unknown as unknown[]);
      const explanation = JSON.stringify(plan.rows);
      expect(explanation).toContain('audit_events_tenant_idx');
      expect(explanation).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"audit_events"/u);
      expect((await audits(receipt.session_id)).at(-1)?.metadata.host_id).toBe(HOST);
      console.info('TERMINAL_AUDIT_LOOKUP',JSON.stringify({ unrelatedRows:10000,index:'audit_events_tenant_idx',candidateLimit:1000 }));
    } finally { queries.mockRestore(); }
  });

  it('leaves the host unknown when the bounded admission candidate window is exhausted', async () => {
    const receipt = await open();
    await admin().query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,created_at)
      SELECT $1,$2,'fixture.unrelated','info',clock_timestamp() FROM generate_series(1,1000)`,
    [identity().tenant_id,identity().alias]);
    await recordTerminalAudit(pool,followup(receipt.session_id,{ host_id:MOVED_HOST }));
    expect((await audits(receipt.session_id)).at(-1)?.metadata.host_id).toBeNull();
  });

  it('normalizes unknown host evidence and uses the same transaction for the audit write', async () => {
    const receipt = await open();
    await admin().query(`UPDATE audit_events SET metadata=jsonb_set(metadata,'{host_id}','"zz-private-invalid/host"')
      WHERE metadata->>'session_id'=$1`, [receipt.session_id]);
    await recordTerminalAudit(pool,followup(receipt.session_id));
    expect((await audits(receipt.session_id)).at(-1)?.metadata).toMatchObject({ host_id: null, component: 'terminal' });
    const count = (await audits()).length;
    await expect(withTransaction(pool,async client => {
      await recordTerminalAudit(client,followup(receipt.session_id));
      throw new Error('transaction fixture failed');
    })).rejects.toThrow('transaction fixture failed');
    expect((await audits()).length).toBe(count);
  });
});
