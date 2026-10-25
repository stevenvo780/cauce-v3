import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { startContextBackupFixture } from './context-backup-browser.fixtures.js';
import {
  asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const task = 'c4-sincronizacion-recuperacion-1025';
const run = randomUUID().slice(0, 8);
const evidenceRoot = resolve('.delegados/v4/recibos', task, run);
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startContextBackupFixture>> | undefined;
let directory = '';
let broker = '';
let remote = '';
let port = 0;
let daemon: ChildProcess | undefined;
const active = () => { if (!fixture) throw new Error('recuperacion fixture is not initialized'); return fixture; };
const git = async (root: string, args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid' }, timeout: 20_000,
})).stdout.trim();

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('canary TCP port unavailable');
  await new Promise<void>((done, reject) => server.close(error => { if (error) reject(error); else done(); }));
  return address.port;
}
async function daemonReady(): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}
async function startDaemon(): Promise<void> {
  daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${directory}`,
    '--listen=127.0.0.1', `--port=${String(port)}`], { stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (!await daemonReady()) {
    if (Date.now() > deadline) throw new Error('git daemon did not start');
    await new Promise(done => { setTimeout(done, 100); });
  }
}
async function stopDaemon(): Promise<void> {
  if (daemon?.exitCode !== null) { daemon = undefined; return; }
  const stopped = new Promise<void>(done => { daemon?.once('exit', () => { done(); }); });
  daemon.kill('SIGTERM');
  await stopped;
  daemon = undefined;
}
interface Scenario { tenant: string; alias: string; prefix: string; page: V4Page; email: string; password: string }
async function createAgentViaConsole(label: string): Promise<Scenario> {
  const person = syntheticPerson(label, run);
  const alias = `zz-canary-${label}-${run}`;
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, `recuperacion-${label}`);
  const registration = await openRegistration(page, active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const identity = await active().database.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email]);
  const tenant = identity.rows[0]?.tenant_id ?? '';
  if (!tenant) throw new Error('registered tenant missing');
  await active().database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6)`,
  [tenant, alias, `zz-canary-${run}`, join(directory, `agent-${label}`), join(directory, `agent-${label}/state`), person.company.slug]);
  await active().database.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, alias]);
  return { tenant, alias, prefix: `companies/${person.company.slug}/tenants/${tenant}/agents/${alias}`, page,
    email: person.email, password: person.password };
}
async function openVersions(scenario: Scenario) {
  await scenario.page.goto(`${active().baseUrl}/messages/${scenario.tenant}/${scenario.alias}?view=context`, { waitUntil: 'domcontentloaded' });
  await scenario.page.getByRole('heading', { name: `Perfil y contexto de ${scenario.alias}`, exact: true }).waitFor({ timeout: 20_000 });
  await scenario.page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
  const region = scenario.page.getByRole('region', { name: 'Versiones de contexto', exact: true });
  await region.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
  return region;
}
async function syncState(tenant: string, alias: string, version: number) {
  const result = await active().database.pool.query<{ state: string; git_commit: string | null }>(
    'SELECT state,git_commit FROM agent_context_outbox WHERE tenant_id=$1 AND alias=$2 AND version=$3', [tenant, alias, version]);
  return result.rows[0];
}
async function cliSession(scenario: Scenario, label: string): Promise<string> {
  const home = join(directory, `cli-${label}`);
  await mkdir(home, { mode: 0o700 });
  const sessionFile = join(home, 'operator.session');
  const origin = new URL(active().baseUrl);
  const ca = await readFile(active().pki.ca.cert);
  const body = JSON.stringify({ email: scenario.email, password: scenario.password });
  const result = await new Promise<{ cookie: string; csrf: string }>((done, fail) => {
    const req = httpsRequest({ host: origin.hostname, port: origin.port, path: '/v3/auth/login', method: 'POST', ca,
      headers: { 'content-type': 'application/json', origin: active().baseUrl } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { authenticated?: unknown; csrf_token?: unknown };
          const cookie = (res.headers['set-cookie'] ?? []).map(value => value.split(';')[0] ?? '').filter(Boolean).join('; ');
          if (res.statusCode !== 200 || parsed.authenticated !== true || typeof parsed.csrf_token !== 'string' || !cookie) {
            fail(new Error(`CLI session login rejected with ${String(res.statusCode)}`)); return;
          }
          done({ cookie, csrf: parsed.csrf_token });
        } catch (error) { fail(error instanceof Error ? error : new Error('CLI session login unreadable')); }
      });
    });
    req.on('error', fail);
    req.end(body);
  });
  await writeFile(sessionFile, JSON.stringify({ version: 1, gateway: active().baseUrl, origin: active().baseUrl,
    cookie: result.cookie, csrf_token: result.csrf }) + '\n', { mode: 0o600 });
  return sessionFile;
}
async function cauceContext(sessionFile: string, tenant: string, alias: string, args: string[]) {
  return execute('bash', [join(process.cwd(), 'ops/cli/cauce'), 'context', '--gateway', active().baseUrl, '--origin', active().baseUrl,
    '--session-file', sessionFile, '--ca-file', active().pki.ca.cert, '--tenant', tenant, '--alias', alias, ...args],
  { env: { PATH: process.env.PATH, HOME: directory, CAUCE_PROJECT_ROOT: process.cwd() }, timeout: 60_000 });
}
async function saveFromConsole(scenario: Scenario, path: string, content: string, versionLabel: RegExp) {
  const region = await openVersions(scenario);
  const existing = region.getByLabel(`Contenido de ${path}`, { exact: true });
  if (await existing.count() === 0) {
    await region.getByLabel('Nuevo archivo', { exact: true }).fill(path);
    await region.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
  }
  await region.getByLabel(`Contenido de ${path}`, { exact: true }).fill(content);
  await region.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
  await region.getByText(versionLabel).waitFor({ timeout: 20_000 });
  return region;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('isolated real PostgreSQL and mocks=false required');
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  directory = await mkdtemp(join(tmpdir(), `zz-canary-${task}-`));
  broker = join(directory, 'broker'); remote = join(directory, 'origin.git');
  await Promise.all([mkdir(broker, { mode: 0o700 }), mkdir(evidenceRoot, { recursive: true })]);
  await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
  await git(broker, ['init', '--initial-branch=main']);
  await chmod(broker, 0o700);
  port = await unusedPort();
  await git(broker, ['remote', 'add', 'origin', `git://127.0.0.1:${String(port)}/origin.git`]);
  await startDaemon();
  const previous = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = broker;
  try { fixture = await startContextBackupFixture(); }
  finally {
    if (previous === undefined) delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
    else process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = previous;
  }
}, 600_000);

afterAll(async () => {
  try { await fixture?.close(); }
  finally {
    await stopDaemon();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

describe('recuperación de contextos: concurrencia, fallo y restauración', () => {
  it('consola y CLI con la misma base: una gana y la otra ve el conflicto sin perder contenido', async () => {
    const scenario = await createAgentViaConsole('conc');
    const session = await cliSession(scenario, 'conc');
    await saveFromConsole(scenario, 'context/mission.md', 'Base compartida.', /Versión 1 · Consola/u);
    await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 1))?.state, { timeout: 30_000 }).toBe('synced');
    const region = await openVersions(scenario);
    await region.getByLabel('Contenido de context/mission.md', { exact: true }).fill('Edición de consola en conflicto.');
    const read = await cauceContext(session, scenario.tenant, scenario.alias, ['read']);
    const snapshot = JSON.parse(read.stdout) as { version: number; files: { path: string; content: string }[] };
    expect(snapshot.version).toBe(1);
    const inputPath = join(directory, 'conc-files.json');
    await writeFile(inputPath, JSON.stringify(snapshot.files.map(file => file.path === 'context/mission.md'
      ? { ...file, content: 'Edición ganadora del CLI.' } : file)), { mode: 0o600 });
    await cauceContext(session, scenario.tenant, scenario.alias, ['edit', '--expected-version', '1', '--input', inputPath]);
    await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 2))?.state, { timeout: 30_000 }).toBe('synced');
    errors.expectHttpError(`/v3/console/context/agents/${scenario.tenant}/${scenario.alias}`, 409);
    await region.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    const conflict = region.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await conflict.innerText()).toContain('Edición ganadora del CLI.');
    expect(await conflict.innerText()).toContain('Edición de consola en conflicto.');
    const versions = await active().database.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2', [scenario.tenant, scenario.alias]);
    expect(versions.rows).toEqual([{ count: 2 }]);
    expect(await git(remote, ['show', `main:${scenario.prefix}/context/mission.md`])).toBe('Edición ganadora del CLI.');
    const trailers = await git(remote, ['log', '--format=%(trailers:key=Cauce-Version,valueonly)', 'main', '--', scenario.prefix]);
    expect(trailers.split('\n').filter(Boolean).map(line => line.replace(/:[a-f0-9]{64}$/u, '')))
      .toEqual([`${scenario.prefix}@2`, `${scenario.prefix}@1`]);
    errors.assertClean();
  }, 300_000);

  it('con el remoto caído guarda en base, lo muestra y drena solo al volver sin duplicados', async () => {
    const scenario = await createAgentViaConsole('fallo');
    await stopDaemon();
    try {
      const region = await saveFromConsole(scenario, 'context/mission.md', 'Guardado sin remoto.', /Versión 1 · Consola/u);
      await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 1))?.git_commit ?? null,
        { timeout: 30_000 }).not.toBeNull();
      const pending = await syncState(scenario.tenant, scenario.alias, 1);
      if (!pending?.git_commit || pending.state === 'synced') throw new Error('offline edit lacks pending local commit');
      await region.getByRole('button', { name: 'Releer versiones', exact: true }).click();
      await region.getByText('Error de sincronización', { exact: true }).waitFor({ timeout: 20_000 });
      await startDaemon();
      await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 1))?.state, { timeout: 120_000 }).toBe('synced');
    } finally { if (!daemon) await startDaemon(); }
    expect(await git(remote, ['show', `main:${scenario.prefix}/context/mission.md`])).toBe('Guardado sin remoto.');
    const trailer = await git(remote, ['log', '--format=%(trailers:key=Cauce-Version,valueonly)', 'main', '--', scenario.prefix]);
    expect(trailer.startsWith(`${scenario.prefix}@1:`)).toBe(true);
    errors.assertClean();
  }, 300_000);

  it('restaurar crea una versión nueva que llega al remoto sin reescribir la historia', async () => {
    const scenario = await createAgentViaConsole('restaura');
    const session = await cliSession(scenario, 'restaura');
    await saveFromConsole(scenario, 'context/mission.md', 'Contenido original.', /Versión 1 · Consola/u);
    await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 1))?.state, { timeout: 30_000 }).toBe('synced');
    const read = await cauceContext(session, scenario.tenant, scenario.alias, ['read']);
    const snapshot = JSON.parse(read.stdout) as { files: { path: string; content: string }[] };
    const inputPath = join(directory, 'restaura-files.json');
    await writeFile(inputPath, JSON.stringify(snapshot.files.map(file => file.path === 'context/mission.md'
      ? { ...file, content: 'Contenido cambiado por CLI.' } : file)), { mode: 0o600 });
    await cauceContext(session, scenario.tenant, scenario.alias, ['edit', '--expected-version', '1', '--input', inputPath]);
    await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 2))?.state, { timeout: 30_000 }).toBe('synced');
    const beforeRestore = await git(remote, ['rev-list', 'main', '--', scenario.prefix]);
    const region = await openVersions(scenario);
    await region.getByRole('button', { name: 'Restaurar versión 1', exact: true }).click();
    const confirmation = region.getByRole('region', { name: 'Confirmar restauración', exact: true });
    await confirmation.getByRole('button', { name: 'Confirmar restauración', exact: true }).click();
    await region.getByText(/Versión 3 · Restauración/u).waitFor({ timeout: 20_000 });
    await expect.poll(async () => (await syncState(scenario.tenant, scenario.alias, 3))?.state, { timeout: 30_000 }).toBe('synced');
    const afterRestore = await git(remote, ['rev-list', 'main', '--', scenario.prefix]);
    expect(afterRestore.split('\n').slice(1).join('\n')).toBe(beforeRestore);
    expect(afterRestore.split('\n')).toHaveLength(3);
    expect(await git(remote, ['show', `main:${scenario.prefix}/context/mission.md`])).toBe('Contenido original.');
    const history = await active().database.pool.query<{ version: string; source: string; restored_from: string | null }>(
      'SELECT version::text,source,restored_from::text FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 ORDER BY version',
      [scenario.tenant, scenario.alias]);
    expect(history.rows.map(row => ({ version: Number(row.version), source: row.source,
      restored_from: row.restored_from === null ? null : Number(row.restored_from) }))).toEqual([
      { version: 1, source: 'ui', restored_from: null },
      { version: 2, source: 'cli', restored_from: null },
      { version: 3, source: 'restore', restored_from: 1 },
    ]);
    errors.assertClean();
  }, 300_000);
});

