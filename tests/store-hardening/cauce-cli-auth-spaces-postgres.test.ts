import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type FleetOperationRequest } from '@cauce/protocol';
import { CauceRepository, FleetOperationsRepository } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';

interface CommandResult { code: number | null; stdout: string; stderr: string }
interface SavedSession { cookie: string; csrf_token: string; email: string; gateway: string; origin: string }
interface SpaceList { revision: number; agents: { tenant_id: string; alias: string; display_name: string | null }[] }
interface AuthState { authenticated: boolean; subject: string; expires_at: string; state: string }
interface OperationResult { state: string; operation: { id: string; status: string; applied_revision: number | null; request_sha256: string } }

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixturePassword = randomBytes(24).toString('base64url');
const incorrectPassword = randomBytes(24).toString('base64url');
const companyA = 'context_alpha';
const companyB = 'context_beta';
const tenantA = 'ContextAlpha';
const tenantB = 'ContextBeta';
const host = 'zz-canary-cli';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
function caseDatabase(): EmptyTestDatabase { if (current === undefined) throw new Error('test database not started'); return current; }
let app: FastifyInstance | undefined;
let directory: string | undefined;
let gateway: string;
let sessionA: string;
let sessionB: string;
let now: number;
let passwordHash: string | undefined;

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('CLI test database unavailable');
  current = await startTestCaseDatabase(database);
  await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(fixturePassword, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  await current.adminPool.query('INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES($1,$1,$2)', [host, companyA]);
  await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,
    container_name,runtime_user,home_directory,state_directory,systemd_user,lifecycle_state,enabled)
    VALUES($1,'cli_worker','cli-worker','codex',$2,'container','zz-cli-worker','dev','/home/dev',
      '/home/dev/.cauce/cli-worker','stev','ready',true)`, [tenantA, host]);
  await current.adminPool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES($1,'context-room','cli_worker','agent')`, [tenantA]);
  await current.adminPool.query("UPDATE agents SET primary_room_id='context-room' WHERE tenant_id=$1 AND alias='cli_worker'", [tenantA]);
  directory = await mkdtemp(join(root, '.delegados/v4/cauce-cli-fixture-'));
  await chmod(directory, 0o700);
  sessionA = join(directory, 'a.session'); sessionB = join(directory, 'b.session');
  now = Date.now();
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(current.pool),
    signingKey: randomBytes(32), now: () => now });
  app = await buildGateway({ pool: current.pool, repository: new CauceRepository(current.pool), authProvider: provider,
    logger: false, fleetOperationsRepository: new FleetOperationsRepository(current.pool),
    fleetCapability: { available: true, actions: ['create', 'update', 'retire'], placements: [{ host_id: host,
      modes: ['container'], runtime_users: ['dev'], systemd_users: ['stev'], home_roots: ['/home/dev'],
      state_roots: ['/home/dev/.cauce'] }] } });
  gateway = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await app?.close(); app = undefined;
  await current?.close(); current = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function run(args: string[], input?: string): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.CAUCE_GATEWAY_URL;
  delete env.CAUCE_CONSOLE_SESSION_FILE;
  return new Promise((resolve, reject) => {
    const process = spawn('bash', [join(root, 'ops/cli/cauce'), ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill('SIGKILL'); }, 35_000);
    process.stdout.setEncoding('utf8'); process.stderr.setEncoding('utf8');
    process.stdout.on('data', (data: string) => { stdout += data; });
    process.stderr.on('data', (data: string) => { stderr += data; });
    process.once('error', () => { clearTimeout(timer); reject(new Error('CLI fixture process failed to start')); });
    process.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('CLI fixture process timed out'));
      else resolve({ code, stdout, stderr });
    });
    process.stdin.on('error', () => undefined);
    process.stdin.end(input === undefined ? '' : `${input}\n`);
  });
}

function parsed(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { throw new Error('CLI returned invalid JSON'); }
}
async function saved(file: string): Promise<SavedSession> { return parsed(await readFile(file, 'utf8')) as SavedSession; }
async function safe(result: CommandResult): Promise<void> {
  const output = result.stdout + result.stderr;
  expect([fixturePassword, incorrectPassword].some(value => output.includes(value))).toBe(false);
  for (const file of [sessionA, sessionB]) {
    let session: SavedSession;
    try { session = await saved(file); } catch { continue; }
    expect([session.cookie, session.csrf_token].some(value => value.length > 0 && output.includes(value))).toBe(false);
  }
  expect(/"(?:cookie|csrf_token|password)"\s*:/u.test(result.stdout)).toBe(false);
}
async function success<T>(args: string[], input?: string): Promise<T> {
  const result = await run(args, input); await safe(result);
  expect(result.code, `CLI failed: ${result.stderr}`).toBe(0);
  return parsed(result.stdout) as T;
}
function login(file = sessionA, company = companyA): Promise<AuthState> {
  return success(['login', '--gateway', gateway, '--email', `${company}@dev.example`, '--password-stdin', '--session-file', file], fixturePassword);
}
function spaces<T>(command: string, args: string[] = [], file = sessionA, tenant = tenantA): Promise<T> {
  return success(['spaces', command, '--tenant', tenant, '--session-file', file, ...args]);
}
async function inputFile(name: string, value: unknown): Promise<string> {
  if (!directory) throw new Error('private CLI directory unavailable');
  const file = join(directory, `${name}.json`); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); return file;
}
async function foreignSnapshot(): Promise<string> {
  if (!current) throw new Error('CLI fixture database unavailable');
  const queries = [
    'SELECT * FROM companies WHERE id=$1', 'SELECT * FROM tenants WHERE company_id=$1',
    'SELECT source.* FROM rooms source JOIN tenants tenant ON tenant.id=source.tenant_id WHERE tenant.company_id=$1',
    'SELECT source.* FROM agents source JOIN tenants tenant ON tenant.id=source.tenant_id WHERE tenant.company_id=$1',
    'SELECT source.* FROM memberships source JOIN tenants tenant ON tenant.id=source.tenant_id WHERE tenant.company_id=$1',
    'SELECT source.* FROM agent_profiles source JOIN tenants tenant ON tenant.id=source.tenant_id WHERE tenant.company_id=$1',
    'SELECT * FROM config_revisions WHERE company_id=$1', 'SELECT * FROM fleet_operations WHERE company_id=$1',
  ];
  const rows = await Promise.all(queries.map(async query => {
    const result = await caseDatabase().adminPool.query<{ records: string[] }>(`SELECT COALESCE(array_agg(to_jsonb(row)::text
      ORDER BY to_jsonb(row)::text),ARRAY[]::text[]) AS records FROM (${query}) row`, [companyB]);
    return result.rows[0]?.records ?? [];
  }));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

describe('cauce CLI password sessions and spaces with a real PostgreSQL gateway', () => {
  it('stores a private reusable session and reports authenticated status without password or cookies', async () => {
    expect(await login()).toMatchObject({ authenticated: true, subject: `${companyA}@dev.example` });
    expect((await stat(sessionA)).mode & 0o777).toBe(0o600);
    expect((await stat(sessionA)).uid).toBe(process.getuid?.());
    const session = await saved(sessionA);
    expect(session.gateway).toBe(gateway); expect(session.origin).toBe(gateway);
    expect(session.cookie.startsWith('__Host-cauce_session=')).toBe(true);
    expect(typeof session.csrf_token === 'string' && session.csrf_token.length >= 32).toBe(true);
    const before = await readFile(sessionA, 'utf8');
    expect(await success<AuthState>(['login', '--status', '--session-file', sessionA]))
      .toMatchObject({ authenticated: true, home_tenant: tenantA, state: 'authenticated' });
    expect((await readFile(sessionA, 'utf8')) === before).toBe(true);
  });

  it('renews through real reauthentication and preserves the prior session after incorrect credentials', async () => {
    const initial = await login(); const before = await readFile(sessionA, 'utf8'); now += 60_000;
    const renewed = await success<AuthState>(['login', '--renew', '--password-stdin', '--session-file', sessionA], fixturePassword);
    expect(renewed).toMatchObject({ authenticated: true, state: 'renewed', subject: initial.subject });
    expect(Date.parse(renewed.expires_at) > Date.parse(initial.expires_at)).toBe(true);
    expect((await readFile(sessionA, 'utf8')) === before).toBe(false);
    expect((await stat(sessionA)).mode & 0o777).toBe(0o600);
    const valid = await readFile(sessionA, 'utf8');
    const rejected = await run(['login', '--renew', '--password-stdin', '--session-file', sessionA], incorrectPassword);
    await safe(rejected); expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('HTTP 401');
    expect((await readFile(sessionA, 'utf8')) === valid).toBe(true);
    expect(await success<AuthState>(['login', '--status', '--session-file', sessionA])).toMatchObject({ authenticated: true });
  });

  it('uses separate signed CLI sessions to list each company and rejects a foreign edit without changing B', async () => {
    await login(); await login(sessionB, companyB);
    for (const [file, tenant] of [[sessionA, tenantA], [sessionB, tenantB]]) {
      const list = await spaces<SpaceList>('list', [], file, tenant);
      expect(list.agents.length).toBeGreaterThan(0); expect(list.agents.every(agent => agent.tenant_id === tenant)).toBe(true);
    }
    const before = await foreignSnapshot();
    const value = await inputFile('foreign-edit', { display_name: 'Unauthorized CLI update' });
    const rejected = await run(['spaces', 'edit', '--tenant', tenantB, '--alias', 'director', '--registry-only',
      '--input', value, '--expected-revision', '0', '--apply', '--session-file', sessionA]);
    await safe(rejected); expect(rejected.code).toBe(1); expect(await foreignSnapshot()).toBe(before);
    expect(rejected.stdout.includes(tenantB)).toBe(false);
  });

  it('previews, creates, lists and edits only a disabled registry row with real configuration CAS receipts', async () => {
    await login(); const before = await foreignSnapshot(); const initial = await spaces<SpaceList>('list');
    const value = await inputFile('registry-create', { display_name: 'CLI draft', harness_id: 'codex', max_concurrent_deliveries: 2 });
    const create = ['--alias', 'cli_draft', '--registry-only', '--input', value, '--expected-revision', String(initial.revision)];
    expect(await spaces('create', create)).toMatchObject({ state: 'preview', registry_only: true });
    expect((await caseDatabase().pool.query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_draft'])).rows).toEqual([]);
    expect(await spaces('create', [...create, '--apply'])).toMatchObject({ state: 'registry_applied', registry_only: true });
    expect((await caseDatabase().pool.query('SELECT enabled,runtime_key,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_draft'])).rows)
      .toEqual([{ enabled: false, runtime_key: null, lifecycle_state: 'draft' }]);
    const listed = await spaces<SpaceList>('list', ['--alias', 'cli_draft']);
    expect(listed.agents).toEqual([expect.objectContaining({ alias: 'cli_draft', display_name: 'CLI draft' })]);
    const updated = await inputFile('registry-edit', { display_name: 'CLI edited' });
    const edit = ['--alias', 'cli_draft', '--registry-only', '--input', updated, '--expected-revision', String(listed.revision), '--apply'];
    expect(await spaces('edit', edit)).toMatchObject({ state: 'registry_applied', registry_only: true });
    const stale = await run(['spaces', 'edit', '--tenant', tenantA, '--session-file', sessionA, ...edit]);
    await safe(stale); expect(stale.code).toBe(1);
    expect((await caseDatabase().pool.query('SELECT display_name,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_draft'])).rows)
      .toEqual([{ display_name: 'CLI edited', enabled: false }]);
    expect((await caseDatabase().pool.query('SELECT company_id FROM config_revisions WHERE company_id=$1 ORDER BY id', [companyA])).rows)
      .toEqual([{ company_id: companyA }, { company_id: companyA }]);
    expect((await caseDatabase().pool.query('SELECT id FROM fleet_operations')).rows).toEqual([]);
    expect(await foreignSnapshot()).toBe(before);
  });

  it('queues a physical retirement once and reports its pending receipt without certifying runtime effects', async () => {
    await login(); const before = await foreignSnapshot(); const list = await spaces<SpaceList>('list');
    const args = ['--alias', 'cli_worker', '--expected-revision', String(list.revision), '--idempotency-key', 'cli-retire-operation'];
    expect(await spaces('retire', args)).toMatchObject({ state: 'preview' });
    expect((await caseDatabase().pool.query('SELECT id FROM fleet_operations')).rows).toEqual([]);
    const first = await spaces<OperationResult>('retire', [...args, '--apply']);
    expect(first).toMatchObject({ state: 'queued', operation: { status: 'queued', applied_revision: null } });
    const repeated = await spaces<OperationResult>('retire', [...args, '--apply']);
    expect(repeated.operation.id).toBe(first.operation.id);
    expect((await caseDatabase().pool.query('SELECT company_id,kind,status,applied_revision FROM fleet_operations')).rows)
      .toEqual([{ company_id: companyA, kind: 'retire', status: 'queued', applied_revision: null }]);
    expect((await caseDatabase().pool.query('SELECT enabled,retired_at,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_worker'])).rows)
      .toEqual([{ enabled: true, retired_at: null, lifecycle_state: 'ready' }]);
    expect(await spaces('list', ['--alias', 'cli_worker'])).toMatchObject({ operations: [expect.objectContaining({ id: first.operation.id, status: 'queued' })] });
    expect(await foreignSnapshot()).toBe(before);
  });

  it('previews and queues real create and edit requests with exact hashes while physical state remains unchanged', async () => {
    await login(); const before = await foreignSnapshot(); const list = await spaces<SpaceList>('list');
    const original = (await caseDatabase().pool.query('SELECT * FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_worker'])).rows;
    const parameters = (name: string) => ({ runtime_key: name.replaceAll('_', '-'), harness_id: 'codex',
      primary_room_id: 'context-room', memberships: [{ room_id: 'context-room', role: 'agent' }],
      placement: { host_id: host, mode: 'container' as const, container_name: `zz-${name.replaceAll('_', '-')}`,
        runtime_user: 'dev', home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${name.replaceAll('_', '-')}`,
        systemd_user: 'stev' } });
    for (const [command, kind, alias] of [['create', 'create', 'cli_pending'], ['edit', 'update', 'cli_worker']] as const) {
      const value = parameters(alias);
      if (command === 'edit') value.placement.container_name = 'zz-cli-worker';
      const file = await inputFile(`lifecycle-${command}`, value);
      const request: FleetOperationRequest = { kind, target: { resource: 'agent', tenant_id: tenantA, alias },
        parameters: value, expected_revision: list.revision, idempotency_key: `cli-${command}-operation` };
      const args = ['--alias', alias, '--input', file, '--expected-revision', String(list.revision),
        '--idempotency-key', request.idempotency_key];
      expect(await spaces(command, args)).toMatchObject({ state: 'preview',
        preview: { kind, can_apply: true, request_sha256: sha256Hex(request) } });
      const result = await spaces<OperationResult>(command, [...args, '--apply']);
      expect(result).toMatchObject({ state: 'queued', operation: { status: 'queued', applied_revision: null,
        kind, target: request.target, request_sha256: sha256Hex(request) } });
      expect((await spaces<OperationResult>(command, [...args, '--apply'])).operation.id).toBe(result.operation.id);
      expect((await caseDatabase().pool.query('SELECT request_hash FROM fleet_operations WHERE id=$1', [result.operation.id])).rows)
        .toEqual([{ request_hash: sha256Hex(request) }]);
    }
    expect((await caseDatabase().pool.query('SELECT kind,status,applied_revision FROM fleet_operations ORDER BY kind')).rows)
      .toEqual([{ kind: 'create', status: 'queued', applied_revision: null }, { kind: 'update', status: 'queued', applied_revision: null }]);
    expect((await caseDatabase().pool.query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_pending'])).rows).toEqual([]);
    expect((await caseDatabase().pool.query('SELECT alias FROM memberships WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_pending'])).rows).toEqual([]);
    expect((await caseDatabase().pool.query('SELECT * FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantA, 'cli_worker'])).rows).toEqual(original);
    expect((await caseDatabase().pool.query('SELECT id FROM config_revisions WHERE company_id=$1', [companyA])).rows).toEqual([]);
    expect(await foreignSnapshot()).toBe(before);
  });

  it('revalidates the original human when another company owner replays an identical visible operation', async () => {
    if (!current || !passwordHash) throw new Error('CLI human fixture unavailable');
    const secondEmail = 'cli_second_owner@dev.example';
    const second = (await current.adminPool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,
      password_hash,display_name,role,tenant_id,alias) VALUES($1,$1,$2,'Second CLI owner','operator',$3,'owner')
      RETURNING id::text`, [secondEmail, passwordHash, tenantA])).rows[0];
    if (!second) throw new Error('second CLI owner unavailable');
    await current.adminPool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,'owner','operator',ARRAY['read','control'])`, [second.id, tenantA]);
    await current.adminPool.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      VALUES($1,$2,'owner','import',$2)`, [companyA, second.id]);
    const firstHuman = (await current.adminPool.query<{ id: string }>('SELECT id::text FROM console_users WHERE email=$1',
      [`${companyA}@dev.example`])).rows[0];
    if (!firstHuman) throw new Error('original CLI owner unavailable');
    const actorSubject = `console:${firstHuman.id}`;
    await login();
    const list = await spaces<SpaceList>('list');
    const args = ['--alias', 'cli_worker', '--expected-revision', String(list.revision),
      '--idempotency-key', 'cli-human-retire-operation', '--apply'];
    const first = await spaces<OperationResult>('retire', args);
    expect(first).toMatchObject({ state: 'queued', operation: { actor: { actor_subject: actorSubject } } });
    await success<AuthState>(['login', '--gateway', gateway, '--email', secondEmail,
      '--password-stdin', '--session-file', sessionB], fixturePassword);
    expect(await spaces('list', ['--alias', 'cli_worker'], sessionB)).toMatchObject({ operations: [{
      id: first.operation.id, actor: { actor_subject: actorSubject } }] });
    const before = await foreignSnapshot();
    const rejected = await run(['spaces', 'retire', '--tenant', tenantA, '--session-file', sessionB, ...args]);
    await safe(rejected); expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('HTTP 409');
    expect((await current.pool.query('SELECT id::text,status FROM fleet_operations')).rows)
      .toEqual([{ id: first.operation.id, status: 'queued' }]);
    expect((await current.pool.query(`SELECT metadata->>'actor_subject' AS actor_subject
      FROM fleet_operation_events WHERE operation_id=$1 AND event='queued'`, [first.operation.id])).rows)
      .toEqual([{ actor_subject: actorSubject }]);
    expect((await spaces<OperationResult>('retire', args)).operation.id).toBe(first.operation.id);
    expect(await foreignSnapshot()).toBe(before);
  });
});
