import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const task = 'e2e-a10-contextos-1025b';
const run = randomUUID().slice(0, 8);
const owner = syntheticPerson('repository', run);
const alias = `zz-canary-repo-${run}`;
const evidence = resolve('.delegados/v4/recibos', task, 'repository-runtime');
const mission = 'Contexto guardado antes de recuperar el remoto de laboratorio.';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
const initialDeadlineFactor = process.env.CAUCE_PLAZOS_FACTOR;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let directory = '';
let broker = '';
let remote = '';
let port = 0;
let daemon: ChildProcess | undefined;
let tenant = '';
const active = () => { if (!fixture) throw new Error('repository fixture is not initialized'); return fixture; };
const contextPath = () => `/v3/console/context/agents/${tenant}/${alias}`;
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

async function capture(page: V4Page, name: string): Promise<void> {
  for (const [layout, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(evidence, `repository-${name}-${layout}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function showVersions(page: V4Page): Promise<V4Locator> {
  await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
  const region = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
  await region.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
  return region;
}

async function storedSync(): Promise<{ state: string; git_commit: string | null; pushed_at: Date | null; last_error: string | null; attempts: number }> {
  const result = await active().database.pool.query<{
    state: string; git_commit: string | null; pushed_at: Date | null; last_error: string | null; attempts: number;
  }>('SELECT state,git_commit,pushed_at,last_error,attempts FROM agent_context_outbox WHERE tenant_id=$1 AND alias=$2 AND version=1', [tenant, alias]);
  const row = result.rows[0];
  if (!row) throw new Error('context outbox row missing');
  return row;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('isolated real PostgreSQL and mocks=false required');
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  directory = await mkdtemp(join(tmpdir(), `zz-canary-${task}-`));
  broker = join(directory, 'broker'); remote = join(directory, 'origin.git');
  await Promise.all([mkdir(broker, { mode: 0o700 }), mkdir(evidence, { recursive: true })]);
  await git(directory, ['init', '--bare', '--initial-branch=main', remote]);
  await git(broker, ['init', '--initial-branch=main']);
  await chmod(broker, 0o700);
  port = await unusedPort();
  await git(broker, ['remote', 'add', 'origin', `git://127.0.0.1:${String(port)}/origin.git`]);
  const previous = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = broker;
  try { fixture = await startConsoleFunctionalFixture(); }
  finally {
    if (previous === undefined) delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
    else process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = previous;
  }
  await writeFile(join(evidence, 'repository-resources.json'), JSON.stringify({
    run, postgres: fixture.database.container.getId(), browser: fixture.browserContainer,
    browserImage: fixture.browserRuntime.image, browserImageId: fixture.browserRuntime.imageId,
  }, null, 2), { mode: 0o600 });
}, 600_000);

afterAll(async () => {
  try { await fixture?.close(); }
  finally {
    if (daemon?.exitCode === null) {
      const stopped = new Promise<void>(done => { daemon?.once('exit', () => { done(); }); });
      daemon.kill('SIGTERM');
      await stopped;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    if (initialDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
    else process.env.CAUCE_PLAZOS_FACTOR = initialDeadlineFactor;
  }
}, 180_000);

describe('repositorio de contexto con Chromium, PostgreSQL y Git reales', () => {
  it('muestra Git sin vincular, conserva el guardado y commit con el remoto caído y reintenta el envío', async () => {
    const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(page, 'repository-owner');
    try {
      const registration = await openRegistration(page, active().baseUrl);
      await fillRegistration(registration, owner);
      await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      const identity = await active().database.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
      tenant = identity.rows[0]?.tenant_id ?? '';
      expect(tenant).not.toBe('');
      await active().database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
        VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6)`,
      [tenant, alias, `zz-canary-${run}`, join(directory, 'agent'), join(directory, 'agent/state'), owner.company.slug]);
      await active().database.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, alias]);
      errors.expectHttpError(`/v3/console/spaces/${tenant}/${alias}/backups`, 404);
      await page.goto(`${active().baseUrl}/messages/${tenant}/${alias}?view=context`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: `Perfil y contexto de ${alias}`, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('tab', { name: 'Git', exact: true }).click();
      await page.getByText('Esta instancia todavía no tiene un repositorio Git vinculado por el servidor.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByLabel('Commit completo', { exact: true }).count()).toBe(0);
      await capture(page, 'unconfigured');
      const versions = await showVersions(page);
      await versions.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
      await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(mission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 1 · Consola/u).waitFor({ timeout: 20_000 });
      await expect.poll(async () => (await storedSync()).last_error, { timeout: 30_000 }).toBe('context_git_network_failed');
      await versions.getByRole('button', { name: 'Releer versiones', exact: true }).click();
      await versions.getByText('Error de sincronización', { exact: true }).waitFor({ timeout: 20_000 });
      await versions.getByText(/Los cambios siguen guardados y pendientes de sincronización/u).waitFor();
      const failed = await storedSync();
      expect(failed.git_commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(failed.pushed_at).toBeNull();
      const prefix = `companies/${owner.company.slug}/tenants/${tenant}/agents/${alias}`;
      expect(await git(broker, ['show', `${failed.git_commit ?? ''}:${prefix}/context/mission.md`])).toBe(mission);
      expect((await apiGet(page, contextPath())).body).toMatchObject({ version: 1,
        files: [{ path: 'context/mission.md', content: mission }],
        sync: { state: 'error', git_commit: failed.git_commit, pushed_at: null, last_error: 'context_git_network_failed' } });
      expect(await versions.getByText('Sincronizado', { exact: true }).count()).toBe(0);
      await capture(page, 'remote-down');
      await versions.getByRole('button', { name: 'Reintentar sincronización', exact: true }).click();
      await versions.getByText('Sincronización solicitada.', { exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => {
        const row = await storedSync();
        return row.state === 'error' && row.attempts > failed.attempts;
      }, { timeout: 30_000 }).toBe(true);
      expect(await storedSync()).toMatchObject({ state: 'error', git_commit: failed.git_commit, pushed_at: null,
        last_error: 'context_git_network_failed' });

      daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${directory}`,
        '--listen=127.0.0.1', `--port=${String(port)}`], { stdio: 'ignore' });
      await expect.poll(daemonReady, { timeout: 10_000 }).toBe(true);
      await versions.getByRole('button', { name: 'Reintentar sincronización', exact: true }).click();
      await versions.getByText('Sincronización solicitada.', { exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => (await storedSync()).state, { timeout: 30_000 }).toBe('synced');
      await versions.getByRole('button', { name: 'Releer versiones', exact: true }).click();
      await versions.getByText('Sincronizado', { exact: true }).waitFor({ timeout: 20_000 });
      const synced = await storedSync();
      expect(synced.git_commit).toBe(failed.git_commit);
      expect(synced.pushed_at).not.toBeNull();
      expect(synced.last_error).toBeNull();
      expect(synced.attempts).toBeGreaterThan(failed.attempts);
      expect(await git(remote, ['show', `main:${prefix}/context/mission.md`])).toBe(mission);
      const persisted = await apiGet(page, contextPath());
      expect(persisted.status).toBe(200);
      expect(persisted.body).toMatchObject({ version: 1, files: [{ path: 'context/mission.md', content: mission }],
        sync: { state: 'synced', git_commit: failed.git_commit } });
      expect((await active().database.pool.query('SELECT version FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rowCount).toBe(1);
      errors.expectHttpError(`/v3/console/spaces/${tenant}/${alias}/backups`, 404);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = await showVersions(page);
      await reloaded.getByText('Sincronizado', { exact: true }).waitFor({ timeout: 20_000 });
      await reloaded.getByLabel('Archivo', { exact: true }).selectOption('context/mission.md');
      expect(await reloaded.getByLabel('Contenido de context/mission.md', { exact: true }).inputValue()).toBe(mission);
      await capture(page, 'synced');
      await writeFile(join(evidence, 'repository-recovery.json'), JSON.stringify({
        run, transport: 'git-daemon-over-loopback', remote: 'owned-bare-repository', github: 'not-exercised',
        version: 1, failed, synced, remoteCommit: await git(remote, ['rev-parse', 'main']),
      }, null, 2), { mode: 0o600 });

      errors.assertClean();
    } catch (cause) {
      await page.screenshot({ path: join(evidence, 'repository-failure.png') }).catch(() => undefined);
      throw new Error(`repository flow failed at ${page.url()}: ${await bodySnippet(page)} || ${JSON.stringify(errors.trace.slice(-12))}`, { cause });
    }
  }, 180_000);
});
