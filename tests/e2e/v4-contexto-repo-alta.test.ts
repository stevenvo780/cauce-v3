import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson,
} from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const task = 'c3-repo-contextos-1025';
const run = randomUUID().slice(0, 8);
const owner = syntheticPerson('repoalta', run);
const alias = `zz-canary-alta-${run}`;
const evidence = resolve('.delegados/v4/recibos', task, run);
const mission = 'Contexto inicial guardado desde la consola.';
const cliNote = 'Nota añadida desde el CLI cauce context.';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startContextBackupFixture>> | undefined;
let directory = '';
let broker = '';
let remote = '';
let port = 0;
let daemon: ChildProcess | undefined;
let tenant = '';
const active = () => { if (!fixture) throw new Error('repo-alta fixture is not initialized'); return fixture; };
const git = async (root: string, args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid' }, timeout: 20_000,
})).stdout.trim();
const prefix = () => `companies/${owner.company.slug}/tenants/${tenant}/agents/${alias}`;

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
async function syncRow(version: number) {
  const result = await active().database.pool.query<{
    state: string; git_commit: string | null; actor_alias: string; actor_human_id: string | null; source: string;
  }>(`SELECT outbox.state,outbox.git_commit,version.actor_alias,version.actor_human_id,version.source
      FROM agent_context_outbox outbox JOIN agent_context_versions version
        ON (version.company_id,version.tenant_id,version.alias,version.version)
         = (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)
      WHERE outbox.tenant_id=$1 AND outbox.alias=$2 AND outbox.version=$3`, [tenant, alias, version]);
  return result.rows[0];
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
  daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${directory}`,
    '--listen=127.0.0.1', `--port=${String(port)}`], { stdio: 'ignore' });
  const daemonDeadline = Date.now() + 10_000;
  while (!await daemonReady()) {
    if (Date.now() > daemonDeadline) throw new Error('git daemon did not start');
    await new Promise(done => { setTimeout(done, 100); });
  }
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
    if (daemon?.exitCode === null) {
      const stopped = new Promise<void>(done => { daemon?.once('exit', () => { done(); }); });
      daemon.kill('SIGTERM');
      await stopped;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

describe('repo de contextos: alta, consola y CLI contra remoto de laboratorio', () => {
  it('crea el agente, publica por consola y por CLI y commitea con el humano autor', async () => {
    const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(page, 'repo-alta-owner');
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
      const before = await active().database.pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
      expect(before.rows).toEqual([{ count: 0 }]);
      await expect(git(remote, ['rev-parse', 'main'])).rejects.toThrow();

      await page.goto(`${active().baseUrl}/messages/${tenant}/${alias}?view=context`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: `Perfil y contexto de ${alias}`, exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
      const region = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
      await region.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
      await region.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
      await region.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      await region.getByLabel('Contenido de context/mission.md', { exact: true }).fill(mission);
      await region.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await region.getByText(`Versión 1 · Consola · ${owner.name}`).waitFor({ timeout: 20_000 });
      await expect.poll(async () => (await syncRow(1))?.state, { timeout: 30_000 }).toBe('synced');
      const first = await syncRow(1);
      if (!first?.git_commit || !first.actor_human_id) throw new Error('console version lacks human author or commit');
      expect(first.source).toBe('ui');
      expect(await git(remote, ['show', `main:${prefix()}/context/mission.md`])).toBe(mission);
      const personHash = createHash('sha256').update(first.actor_human_id).digest('hex').slice(0, 12);
      expect(await git(remote, ['log', '-1', '--format=%an', 'main', '--', prefix()])).toBe(owner.name);
      expect(await git(remote, ['log', '-1', '--format=%ae', 'main', '--', prefix()])).toBe(`persona-${personHash}@${owner.company.slug}.cauce.invalid`);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Actor-Alias,valueonly)', 'main'])).toBe(first.actor_alias);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Version,valueonly)', 'main'])).toContain(`${prefix()}@1:`);

      const cliHome = join(directory, 'cli-home');
      await mkdir(cliHome, { mode: 0o700 });
      const sessionFile = join(cliHome, 'operator.session');
      const cauce = join(process.cwd(), 'ops/cli/cauce');
      const cliEnv = { PATH: process.env.PATH, HOME: cliHome, CAUCE_PROJECT_ROOT: process.cwd() };
      const gateway = new URL(active().baseUrl);
      const loginCa = await readFile(active().pki.ca.cert);
      const loginBody = JSON.stringify({ email: owner.email, password: owner.password });
      const loginResult = await new Promise<{ cookie: string; csrf: string }>((done, fail) => {
        const req = httpsRequest({ host: gateway.hostname, port: gateway.port, path: '/v3/auth/login', method: 'POST',
          ca: loginCa, headers: { 'content-type': 'application/json', origin: active().baseUrl } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { authenticated?: unknown; csrf_token?: unknown };
              const setCookie = res.headers['set-cookie'] ?? [];
              const cookie = setCookie.map(value => value.split(';')[0] ?? '').filter(Boolean).join('; ');
              if (res.statusCode !== 200 || parsed.authenticated !== true || typeof parsed.csrf_token !== 'string' || !cookie) {
                fail(new Error(`CLI session login rejected with ${String(res.statusCode)}`));
                return;
              }
              done({ cookie, csrf: parsed.csrf_token });
            } catch (error) { fail(error instanceof Error ? error : new Error('CLI session login unreadable')); }
          });
        });
        req.on('error', fail);
        req.end(loginBody);
      });
      await writeFile(sessionFile, JSON.stringify({ version: 1, gateway: active().baseUrl, origin: active().baseUrl,
        cookie: loginResult.cookie, csrf_token: loginResult.csrf }) + '\n', { mode: 0o600 });
      const read = await execute('bash', [cauce, 'context', '--gateway', active().baseUrl, '--origin', active().baseUrl,
        '--session-file', sessionFile, '--ca-file', active().pki.ca.cert, '--tenant', tenant, '--alias', alias, 'read'],
      { env: cliEnv, timeout: 60_000 });
      const snapshot = JSON.parse(read.stdout) as { version: number; files: { path: string; content: string }[] };
      expect(snapshot.version).toBe(1);
      const inputPath = join(cliHome, 'files.json');
      await writeFile(inputPath, JSON.stringify([...snapshot.files, { path: 'context/cli-note.md', content: cliNote }]), { mode: 0o600 });
      await execute('bash', [cauce, 'context', '--gateway', active().baseUrl, '--origin', active().baseUrl,
        '--session-file', sessionFile, '--ca-file', active().pki.ca.cert, '--tenant', tenant, '--alias', alias,
        'edit', '--expected-version', '1', '--input', inputPath], { env: cliEnv, timeout: 60_000 });
      await expect.poll(async () => (await syncRow(2))?.state, { timeout: 30_000 }).toBe('synced');
      const second = await syncRow(2);
      if (!second?.git_commit || !second.actor_human_id) throw new Error('CLI version lacks human author or commit');
      expect(second.source).toBe('cli');
      expect(second.actor_alias).toBe(first.actor_alias);
      expect(await git(remote, ['show', `main:${prefix()}/context/cli-note.md`])).toBe(cliNote);
      expect(await git(remote, ['show', `main:${prefix()}/context/mission.md`])).toBe(mission);
      expect(await git(remote, ['log', '-1', '--format=%an', 'main', '--', prefix()])).toBe(owner.name);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Actor-Alias,valueonly)', 'main'])).toBe(second.actor_alias);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Version,valueonly)', 'main'])).toContain(`${prefix()}@2:`);
      expect(await git(remote, ['rev-list', '--count', 'main'])).toBe('2');
      await writeFile(join(evidence, 'repo-alta.json'), JSON.stringify({ run, tenant, alias,
        consoleCommit: first.git_commit, cliCommit: second.git_commit, author: second.actor_alias,
        remote: 'owned-bare-repository', transport: 'git-daemon-over-loopback', github: 'not-exercised' }, null, 2), { mode: 0o600 });
      errors.assertClean();
    } catch (cause) {
      await page.screenshot({ path: join(evidence, 'repo-alta-failure.png') }).catch(() => undefined);
      throw new Error(`repo-alta flow failed at ${page.url()}: ${await bodySnippet(page)} || ${JSON.stringify(errors.trace.slice(-12))}`, { cause });
    }
  }, 300_000);
});

