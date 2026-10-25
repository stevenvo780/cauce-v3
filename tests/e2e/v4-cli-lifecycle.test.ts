import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@cauce/protocol';
import { applyMigrations, createPool, FleetOperationsRepository, withTransaction, type CompanyTransferBundle, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { runCli, type CliResult } from './v4-rupturas-terminal-cli.fixtures.js';

interface Session { cookie: string; csrf_token: string }
interface Inventory { revision: number; agents: { alias: string; display_name: string | null }[]; operations: { id: string; status: string }[] }
interface Change { revision: number; applied: boolean; dry_run: boolean; rolled_back_revision_id: number | null }
interface Queued { state: string; operation: { id: string; status: string; request_sha256: string } }
interface Snapshot { version: number; desired_version: number; applied_version: number; digest: string; files: { path: string; content: string }[] }

const owner = 'e2e-a9-cli-1025b';
const prefix = `zz-canary-${owner}`;
const run = randomUUID().slice(0, 8);
const root = resolve(import.meta.dirname, '../..');
const receipts = join(root, '.delegados/v4/recibos', owner);
const company = 'context_alpha';
const tenant = 'ContextAlpha';
const email = `${company}@dev.example`;
const host = `${prefix}-${run}`;
const worker = `${prefix}-worker`;
const retiring = `${prefix}-retire`;
const password = randomBytes(24).toString('base64url');
const wrongPassword = randomBytes(24).toString('base64url');
const secrets = [password, wrongPassword];
let directory = '';
let sessionFile = '';
let databaseUrlFile = '';
let gateway = '';
let database: StartedTestContainer | undefined;
let pool: DatabasePool | undefined;
let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
let closing: Promise<void> | undefined;

function db(): DatabasePool { if (!pool) throw new Error('owned CLI PostgreSQL is unavailable'); return pool; }
function decode(raw: string): unknown { return JSON.parse(raw) as unknown; }
async function privateFile(name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}
function safe(result: CliResult): void {
  const output = result.stdout + result.stderr;
  expect(secrets.some(secret => output.includes(secret)), 'CLI output exposed private fixture material').toBe(false);
  expect(/"(?:cookie|csrf_token|password|password_hash)"\s*:/u.test(output)).toBe(false);
}
async function command<T>(args: string[], input = ''): Promise<T> {
  const result = await runCli(args, input);
  safe(result);
  expect(result.code, result.stderr).toBe(0);
  return decode(result.stdout) as T;
}
async function rememberSession(): Promise<Session> {
  const session = decode(await readFile(sessionFile, 'utf8')) as Session;
  secrets.push(session.cookie, session.csrf_token);
  return session;
}
async function receipt(name: string, evidence: Record<string, boolean | number | string>): Promise<void> {
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  await writeFile(join(receipts, `${name}.json`), JSON.stringify({ owner, ...evidence }, null, 2) + '\n', { mode: 0o600 });
}
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = await rememberSession();
  const response = await fetch(gateway + path, { method, headers: { Origin: gateway, Cookie: session.cookie,
    'X-CSRF-Token': session.csrf_token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, `real gateway returned HTTP ${String(response.status)}`).toBe(true);
  return await response.json() as T;
}
function spaces<T>(operation: string, args: string[] = []): Promise<T> {
  return command(['spaces', operation, '--tenant', tenant, '--session-file', sessionFile, ...args]);
}
function context<T>(operation: string, args: string[] = []): Promise<T> {
  return command(['context', '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile,
    '--tenant', tenant, '--alias', worker, operation, ...args]);
}
async function platformRaw(operation: string, args: string[] = [], currentPassword = password): Promise<CliResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('bash', [join(root, 'ops/cli/cauce'), 'platform', operation, '--email', email,
      '--company', company, '--database-url-file', databaseUrlFile, ...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: directory, CAUCE_PROJECT_ROOT: root,
        CAUCE_PLATFORM_PASSWORD: currentPassword, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('platform CLI did not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('platform CLI exceeded its deadline'));
      else resolveResult({ code, stdout, stderr });
    });
  });
}
async function platform<T>(operation: string, args: string[] = []): Promise<T> {
  const result = await platformRaw(operation, args); safe(result); expect(result.code, result.stderr).toBe(0);
  return decode(result.stdout) as T;
}
function close(): Promise<void> {
  closing ??= (async () => {
    const activeApp = app; app = undefined;
    const activePool = pool; pool = undefined;
    const activeDatabase = database; database = undefined;
    const activeDirectory = directory; directory = '';
    try { await activeApp?.close(); }
    finally {
      try { await activePool?.end(); }
      finally {
        try { await activeDatabase?.stop(); }
        finally { if (activeDirectory) await rm(activeDirectory, { recursive: true, force: true }); }
      }
    }
  })();
  return closing;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('CLI E2E requires owned PostgreSQL and real routes');
  directory = await mkdtemp(join(tmpdir(), `${prefix}-`)); await chmod(directory, 0o700);
  try {
    const databasePassword = randomBytes(24).toString('base64url'); secrets.push(databasePassword);
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`${prefix}-${run}`).withLabels({ 'cauce.e2e.owner': owner })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: databasePassword })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    const url = `postgresql://cauce_test:${encodeURIComponent(databasePassword)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`;
    secrets.push(url); pool = createPool(url); await applyMigrations(pool); await seedSyntheticCompanyContexts(url);
    await pool.query('UPDATE console_users SET password_hash=$1', [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 })]);
    await pool.query('INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [email]);
    await pool.query('INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES($1,$1,$2)', [host, company]);
    await withTransaction(pool, async client => {
      for (const alias of [worker, retiring]) {
        await client.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,
          container_name,runtime_user,home_directory,state_directory,systemd_user,lifecycle_state,enabled)
          VALUES($1,$2,$2,'codex',$3,'container',$2,'dev','/home/dev','/home/dev/.cauce','stev','ready',true)`, [tenant, alias, host]);
        await client.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'context-room',$2,'agent')", [tenant, alias]);
        await client.query("UPDATE agents SET primary_room_id='context-room' WHERE tenant_id=$1 AND alias=$2", [tenant, alias]);
      }
    });
    app = await buildGateway({ pool, logger: false,
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) }),
      fleetOperationsRepository: new FleetOperationsRepository(pool), fleetCapability: { available: true,
        actions: ['create', 'update', 'retire'], placements: [{ host_id: host, modes: ['container'], runtime_users: ['dev'],
          systemd_users: ['stev'], home_roots: ['/home/dev'], state_roots: ['/home/dev/.cauce'] }] },
    });
    gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    sessionFile = join(directory, 'operator.session'); databaseUrlFile = await privateFile('database-url', url);
    await command(['login', '--gateway', gateway, '--email', email, '--password-stdin', '--session-file', sessionFile], `${password}\n`);
    await rememberSession();
  } catch (error) { await close(); throw error; }
}, 180_000);
afterAll(close, 60_000);

describe.sequential('cauce lifecycle CLI against an owned real gateway and PostgreSQL', () => {
  it('logs in, renews, checks status and retains its private session after rejected credentials', async () => {
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    expect(await command(['login', '--status', '--session-file', sessionFile])).toMatchObject({ authenticated: true, home_tenant: tenant });
    expect(await command(['login', '--renew', '--password-stdin', '--session-file', sessionFile], `${password}\n`))
      .toMatchObject({ authenticated: true, state: 'renewed' });
    await rememberSession();
    const before = await readFile(sessionFile, 'utf8');
    const denied = await runCli(['login', '--renew', '--password-stdin', '--session-file', sessionFile], `${wrongPassword}\n`);
    safe(denied); expect(denied.code).toBe(1); expect(denied.stderr).toContain('HTTP 401');
    expect((await readFile(sessionFile, 'utf8')) === before).toBe(true);
    expect(await api('GET', '/v3/auth/session')).toMatchObject({ authenticated: true });
    await receipt('login', { login: true, renewal: true, private_mode: true, rejected_credentials_preserve_session: true });
  });

  it('previews, creates, lists, edits and retires a registry draft with durable CAS receipts', async () => {
    const alias = `${prefix}-draft`;
    const initial = await spaces<Inventory>('list');
    const input = await privateFile('registry-create.json', { display_name: `${prefix} draft`, harness_id: 'codex' });
    const args = ['--alias', alias, '--registry-only', '--input', input, '--expected-revision', String(initial.revision)];
    expect(await spaces('create', args)).toMatchObject({ state: 'preview', registry_only: true });
    expect((await db().query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(0);
    expect(await spaces('create', [...args, '--apply'])).toMatchObject({ state: 'registry_applied' });
    expect((await db().query('SELECT enabled,runtime_key,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
      .toEqual([{ enabled: false, runtime_key: null, lifecycle_state: 'draft' }]);
    const created = await spaces<Inventory>('list', ['--alias', alias]);
    expect(created.agents).toEqual([expect.objectContaining({ alias, display_name: `${prefix} draft` })]);
    const edit = ['spaces', 'edit', '--tenant', tenant, '--session-file', sessionFile, '--alias', alias, '--registry-only',
      '--input', await privateFile('registry-edit.json', { display_name: `${prefix} edited` }), '--expected-revision', String(created.revision), '--apply'];
    expect(await command(edit)).toMatchObject({ state: 'registry_applied' });
    const stale = await runCli(edit); safe(stale); expect(stale.code).toBe(1); expect(stale.stderr).toContain('La revisión cambió');
    const edited = await spaces<Inventory>('list', ['--alias', alias]);
    expect(edited.agents[0]?.display_name).toBe(`${prefix} edited`);
    expect(await spaces('retire', ['--alias', alias, '--registry-only', '--expected-revision', String(edited.revision), '--apply']))
      .toMatchObject({ state: 'registry_applied', message: 'Registro eliminado. No se ejecutó ninguna operación física.' });
    expect((await db().query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(0);
    expect((await spaces<Inventory>('list', ['--alias', alias])).agents).toEqual([]);
    expect((await db().query('SELECT id FROM config_revisions WHERE company_id=$1', [company])).rowCount).toBe(3);
    await receipt('spaces-registry', { preview: true, created_disabled: true, edited: true, stale_rejected: true, retired: true, revisions: 3 });
  });

  it('runs platform show, catalog preview/change/CAS/rollback and a private export/import plan', async () => {
    const initial = await platform<{ revision: number }>('show');
    const role = `${prefix}-catalog`;
    const mutation = await privateFile('catalog.json', { resource: 'role_policy', action: 'create', role,
      value: { allow_read: true } });
    const change = ['--mutation-file', mutation, '--expected-revision', String(initial.revision)];
    expect(await platform('change', [...change, '--dry-run'])).toMatchObject({ applied: false, dry_run: true });
    expect((await db().query('SELECT role FROM role_policies WHERE role=$1', [role])).rowCount).toBe(0);
    const applied = await platform<Change>('change', [...change, '--apply']); expect(applied.applied).toBe(true);
    expect((await db().query('SELECT allow_read,allow_route,allow_control,allow_notify FROM role_policies WHERE role=$1', [role])).rows)
      .toEqual([{ allow_read: true, allow_route: false, allow_control: false, allow_notify: false }]);
    const stale = await platformRaw('change', [...change, '--apply']); safe(stale); expect(stale.code).toBe(1); expect(stale.stderr).toContain('falló (conflict)');
    const rollback = ['--revision', String(applied.revision), '--expected-revision', String(applied.revision)];
    expect(await platform('rollback', [...rollback, '--dry-run'])).toMatchObject({ applied: false });
    const rolled = await platform<Change>('rollback', [...rollback, '--apply']); expect(rolled.rolled_back_revision_id).toBe(applied.revision);
    expect((await db().query('SELECT role FROM role_policies WHERE role=$1', [role])).rowCount).toBe(0);
    const bundleFile = join(directory, 'export.json');
    const exported = await platformRaw('export', ['--output', bundleFile]); safe(exported); expect(exported.code).toBe(0);
    expect(exported.stdout).toContain('Archivo privado creado'); expect((await stat(bundleFile)).mode & 0o777).toBe(0o600);
    const bundle = decode(await readFile(bundleFile, 'utf8')) as CompanyTransferBundle;
    const { bundle_sha256: _priorHash, ...payload } = bundle;
    const importedRoom = `${prefix}-imported`;
    payload.records.rooms.push({ tenant_id: tenant, id: importedRoom, display_name: importedRoom, enabled: true });
    const changedBundle = await privateFile('import.json', { ...payload, bundle_sha256: sha256Hex(payload) });
    const planFile = join(directory, 'plan.json');
    const planned = await platformRaw('plan-import', ['--bundle-file', changedBundle, '--expected-revision', String(rolled.revision), '--output', planFile]);
    safe(planned); expect(planned.code).toBe(0); expect((await stat(planFile)).mode & 0o777).toBe(0o600);
    const imports = ['--bundle-file', changedBundle, '--plan-file', planFile];
    expect(await platform('import', [...imports, '--dry-run'])).toMatchObject({ applied: false, dry_run: true });
    expect((await db().query('SELECT id FROM rooms WHERE tenant_id=$1 AND id=$2', [tenant, importedRoom])).rowCount).toBe(0);
    expect(await platform('import', [...imports, '--apply'])).toMatchObject({ applied: true, physical_effect_verified: false });
    expect((await db().query('SELECT display_name FROM rooms WHERE tenant_id=$1 AND id=$2', [tenant, importedRoom])).rows).toEqual([{ display_name: importedRoom }]);
    const denied = await platformRaw('show', [], wrongPassword); safe(denied); expect(denied.code).toBe(1); expect(denied.stderr).toContain('La operación de plataforma falló');
    await receipt('platform', { catalog_preview: true, catalog_persisted: true, stale_rejected: true, rollback: true,
      private_export: true, private_plan: true, import_preview: true, import_persisted: true, physical_effect_verified: false });
  }, 180_000);

  it('queues create, edit and retire once and rereads exact durable operations without claiming physical completion', async () => {
    const current = await spaces<Inventory>('list');
    for (const [operation, kind, alias] of [['create', 'create', `${prefix}-new`], ['edit', 'update', worker], ['retire', 'retire', retiring]] as const) {
      const parameters = operation === 'retire' ? {} : { runtime_key: alias, harness_id: 'codex', primary_room_id: 'context-room',
        memberships: [{ room_id: 'context-room', role: 'agent' }], placement: { host_id: host, mode: 'container', container_name: alias,
          runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce', systemd_user: 'stev' } };
      const request = { kind, target: { resource: 'agent', tenant_id: tenant, alias }, parameters,
        expected_revision: current.revision, idempotency_key: `${prefix}-${operation}` };
      const args = ['--alias', alias, '--expected-revision', String(current.revision), '--idempotency-key', request.idempotency_key,
        ...(operation === 'retire' ? [] : ['--input', await privateFile(`physical-${operation}.json`, parameters)])];
      expect(await spaces(operation, args)).toMatchObject({ state: 'preview', preview: { can_apply: true, request_sha256: sha256Hex(request) } });
      const queued = await spaces<Queued>(operation, [...args, '--apply']);
      expect(queued).toMatchObject({ state: 'queued', operation: { status: 'queued', request_sha256: sha256Hex(request) } });
      expect((await spaces<Queued>(operation, [...args, '--apply'])).operation.id).toBe(queued.operation.id);
      expect((await db().query('SELECT kind,status,applied_revision,request_hash FROM fleet_operations WHERE id=$1', [queued.operation.id])).rows)
        .toEqual([{ kind, status: 'queued', applied_revision: null, request_hash: sha256Hex(request) }]);
      expect((await spaces<Inventory>('list', ['--alias', alias])).operations).toEqual([expect.objectContaining({ id: queued.operation.id, status: 'queued' })]);
    }
    expect((await db().query('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, `${prefix}-new`])).rowCount).toBe(0);
    expect((await db().query('SELECT enabled,lifecycle_state,retired_at FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, retiring])).rows)
      .toEqual([{ enabled: true, lifecycle_state: 'ready', retired_at: null }]);
    await receipt('spaces-operations', { create_queued: true, edit_queued: true, retire_queued: true, idempotency: true, physical_effect_verified: false });
  });

  it('enrolls an isolated host, reuses its identity and persists a signed heartbeat', async () => {
    const enrolledHost = `${prefix}-enrolled`;
    const invitation = await api<{ invitation_token: string; nonce: string }>('POST', '/v3/console/fleet/hosts/enrollments',
      { host_id: enrolledHost, display_name: enrolledHost });
    secrets.push(invitation.invitation_token, invitation.nonce);
    const stateRoot = join(directory, 'hosts');
    const enrollment = ['hosts', 'enroll', '--gateway', gateway, '--invitation-stdin', '--state-root', stateRoot];
    expect(await command(enrollment, JSON.stringify(invitation))).toMatchObject({ host_id: enrolledHost, state: 'enrolled', executor_ready: false });
    const identityDirectory = join(stateRoot, company, enrolledHost);
    const identityBefore = await readFile(join(identityDirectory, 'identity.json'), 'utf8');
    expect(await command(enrollment, JSON.stringify(invitation))).toMatchObject({ host_id: enrolledHost, state: 'enrolled' });
    expect((await readFile(join(identityDirectory, 'identity.json'), 'utf8')) === identityBefore).toBe(true);
    expect((await stat(identityDirectory)).mode & 0o777).toBe(0o700);
    expect(await command(['hosts', 'heartbeat', '--identity-directory', identityDirectory])).toMatchObject({ host_id: enrolledHost });
    expect((await db().query('SELECT state FROM fleet_host_enrollments WHERE company_id=$1 AND host_id=$2', [company, enrolledHost])).rows).toEqual([{ state: 'enrolled' }]);
    expect((await db().query('SELECT (last_seen_at IS NOT NULL) AS seen FROM fleet_host_identities WHERE company_id=$1 AND host_id=$2', [company, enrolledHost])).rows).toEqual([{ seen: true }]);
    const status = await runCli(['hosts', 'status', '--identity-directory', identityDirectory, '--install-root', join(directory, 'installed')]); safe(status);
    const systemdAvailable = await access('/usr/bin/systemctl').then(() => true, () => false);
    if (systemdAvailable) { expect(status.code).toBe(3); expect(decode(status.stdout)).toMatchObject({ executor_ready: false, reason: 'setup_required' }); }
    else { expect(status.code).toBe(1); expect(status.stderr).toContain('no se pudo completar hosts status'); expect(status.stderr).toContain('ENOENT'); }
    const missing = await runCli(['hosts', 'status', '--state-root', join(directory, 'absent-hosts')]); safe(missing); expect(missing.code).toBe(1);
    expect((await db().query('SELECT count(*)::integer AS count FROM fleet_host_identities WHERE host_id=$1', [enrolledHost])).rows).toEqual([{ count: 1 }]);
    await receipt('hosts', { enrolled: true, enrollment_reused: true, private_identity: true, signed_heartbeat_persisted: true,
      status_exercised: true, systemd_available: systemdAvailable, executor_ready: false });
  });

  it('reads, edits, diffs, restores and privately exports context while preserving unavailable application state', async () => {
    const first = 'Synthetic CLI mission one.'; const second = 'Synthetic CLI mission two.';
    expect(await context('read')).toMatchObject({ version: 0, applied_version: 0 });
    const input = await privateFile('context-one.json', [{ path: 'context/mission.md', content: first }]);
    const edit = ['--expected-version', '0', '--input', input];
    expect(await context('edit', edit)).toMatchObject({ version: 1, desired_version: 1, applied_version: 0 });
    const stale = await runCli(['context', '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile,
      '--tenant', tenant, '--alias', worker, 'edit', ...edit]); safe(stale); expect(stale.code).toBe(1); expect(stale.stderr).toContain('HTTP 409');
    expect(await context('edit', ['--expected-version', '1', '--input', await privateFile('context-two.json', [{ path: 'context/mission.md', content: second }])]))
      .toMatchObject({ version: 2, applied_version: 0 });
    expect(await context('history')).toMatchObject({ entries: [{ version: 2 }, { version: 1 }] });
    expect(await context('history', ['--before', '2'])).toMatchObject({ entries: [{ version: 1 }] });
    expect(await context('diff', ['--from-version', '1', '--to-version', '2'])).toMatchObject({ from: 1, to: 2,
      files: [expect.objectContaining({ path: 'context/mission.md', before: first, after: second, change: 'modified' })] });
    const restored = await context<Snapshot>('restore', ['--expected-version', '2', '--version', '1']);
    expect(restored).toMatchObject({ version: 3, desired_version: 3, applied_version: 0 });
    expect(restored.files).toEqual(expect.arrayContaining([{ path: 'context/mission.md', content: first }]));
    expect(await context('retry')).toMatchObject({ version: 3, applied_version: 0 });
    expect(await context('status')).toMatchObject({ version: 3, applied_version: 0 });
    const exportDirectory = join(directory, 'context-export');
    expect(await context('export', ['--directory', exportDirectory])).toMatchObject({ state: 'exported', version: 3, digest: restored.digest });
    expect((await stat(join(exportDirectory, 'context/mission.md'))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(exportDirectory, 'context/mission.md'), 'utf8')) === first).toBe(true);
    const apply = await runCli(['context', '--gateway', gateway, '--origin', gateway, '--session-file', sessionFile,
      '--tenant', tenant, '--alias', worker, 'apply']); safe(apply); expect(apply.code).toBe(1); expect(apply.stderr).toContain('HTTP 503');
    expect(await api('GET', `/v3/console/context/agents/${tenant}/${worker}`)).toMatchObject({ version: 3, digest: restored.digest, applied_version: 0 });
    expect((await db().query('SELECT version::integer,source,restored_from::integer FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 ORDER BY version', [tenant, worker])).rows)
      .toEqual([{ version: 1, source: 'cli', restored_from: null }, { version: 2, source: 'cli', restored_from: null }, { version: 3, source: 'restore', restored_from: 1 }]);
    await receipt('context', { read: true, edited_versions: 2, stale_rejected: true, history: true, diff: true, restored: true,
      retried: true, status: true, private_export: true, unavailable_application_rejected: true, applied_version: 0 });
  });
});
