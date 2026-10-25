import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ingestNativeContextVersion } from '@cauce/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { startContextBackupFixture } from './context-backup-browser.fixtures.js';
import {
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson,
} from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const task = 'c6-autor-humano-1025';
const run = randomUUID().slice(0, 8);
const owner = syntheticPerson('autor', run);
const alias = `zz-canary-autor-${run}`;
const evidence = resolve('.delegados/v4/recibos', task, run);
const mission = 'Contexto inicial guardado por la persona.';
const agentNote = 'Nota escrita por el agente, sin persona.';
const agentPath = 'context/notes/agent.md';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startContextBackupFixture>> | undefined;
let directory = '';
let broker = '';
let remote = '';
let port = 0;
let daemon: ChildProcess | undefined;
let tenant = '';
const active = () => {
  if (!fixture) throw new Error('autor-humano fixture is not initialized');
  return fixture;
};
const git = async (root: string, args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
  env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid',
  },
  timeout: 20_000,
})).stdout.trim();
const prefix = () => `companies/${owner.company.slug}/tenants/${tenant}/agents/${alias}`;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('canary TCP port unavailable');
  await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done(); }); });
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
    state: string; git_commit: string | null; actor_alias: string; actor_human_id: string | null;
    source: string; company_id: string;
  }>(`SELECT outbox.state,outbox.git_commit,version.actor_alias,version.actor_human_id,version.source,version.company_id
      FROM agent_context_outbox outbox JOIN agent_context_versions version
        ON (version.company_id,version.tenant_id,version.alias,version.version)
         = (outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version)
      WHERE outbox.tenant_id=$1 AND outbox.alias=$2 AND outbox.version=$3`, [tenant, alias, version]);
  return result.rows[0];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
function storedFiles(value: unknown): { path: string; content: string }[] {
  if (!isUnknownList(value)) throw new Error('stored context files are not a list');
  return value.map(file => {
    if (!isRecord(file)) throw new Error('stored context file is not an object');
    const path = file.path;
    const content = file.content;
    if (typeof path !== 'string' || typeof content !== 'string') throw new Error('stored context file lacks path or content');
    return { path, content };
  });
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('isolated real PostgreSQL and mocks=false required');
  }
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  directory = await mkdtemp(join(tmpdir(), `zz-canary-${task}-`));
  broker = join(directory, 'broker');
  remote = join(directory, 'origin.git');
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

describe('autor humano de una versión de contexto', () => {
  it('muestra el nombre de la persona, firma el commit con ese autor y deja al agente como agente', async () => {
    const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(page, 'autor-humano');
    try {
      const registration = await openRegistration(page, active().baseUrl);
      await fillRegistration(registration, owner);
      await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      const identity = await active().database.pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
      tenant = identity.rows[0]?.tenant_id ?? '';
      expect(tenant).not.toBe('');
      await active().database.pool.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
         VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6)`,
        [tenant, alias, `zz-canary-${run}`, join(directory, 'agent'), join(directory, 'agent/state'), owner.company.slug]);
      await active().database.pool.query(
        "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, alias]);

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
      const personHash = createHash('sha256').update(first.actor_human_id).digest('hex').slice(0, 12);
      const personEmail = `persona-${personHash}@${first.company_id}.cauce.invalid`;
      expect(await git(remote, ['log', '-1', '--format=%an', first.git_commit])).toBe(owner.name);
      expect(await git(remote, ['log', '-1', '--format=%ae', first.git_commit])).toBe(personEmail);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Actor-Alias,valueonly)', first.git_commit])).toBe(first.actor_alias);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Version,valueonly)', first.git_commit])).toContain(`${prefix()}@1:`);
      expect(personEmail).not.toContain(owner.email);
      expect(personEmail).not.toContain(first.actor_human_id);

      const stored = await active().database.pool.query<{ files: unknown }>(
        'SELECT files FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 AND version=1', [tenant, alias]);
      const files = storedFiles(stored.rows[0]?.files);
      expect(files.some(file => file.path === 'context/mission.md' && file.content === mission)).toBe(true);
      const ingested = await ingestNativeContextVersion(active().database.pool, tenant, alias, {
        base_version: 1, files: [...files, { path: agentPath, content: agentNote }],
      });
      expect(ingested.state).toBe('ingested');
      await expect.poll(async () => (await syncRow(2))?.state, { timeout: 30_000 }).toBe('synced');
      const second = await syncRow(2);
      if (!second?.git_commit) throw new Error('agent version lacks a commit');
      expect(second.source).toBe('native');
      expect(second.actor_human_id).toBeNull();
      expect(second.actor_alias).toBe(alias);
      expect(second.git_commit).not.toBe(first.git_commit);
      expect(await git(remote, ['log', '-1', '--format=%an', first.git_commit])).toBe(owner.name);
      expect(await git(remote, ['log', '-1', '--format=%ae', first.git_commit])).toBe(personEmail);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Actor-Alias,valueonly)', first.git_commit])).toBe(first.actor_alias);
      expect(await git(remote, ['log', '-1', '--format=%an', second.git_commit])).toBe(alias);
      expect(await git(remote, ['log', '-1', '--format=%ae', second.git_commit])).toBe(`${alias}@${second.company_id}.cauce.invalid`);
      const agentBody = await git(remote, ['log', '-1', '--format=%B', second.git_commit]);
      expect(agentBody).toContain('Cauce-Version:');
      expect(agentBody).not.toContain('Cauce-Actor-Alias:');
      expect(await git(remote, ['show', `main:${prefix()}/${agentPath}`])).toBe(agentNote);

      await page.goto(`${active().baseUrl}/messages/${tenant}/${alias}?view=context`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
      await region.getByText(`Versión 1 · Consola · ${owner.name}`).waitFor({ timeout: 20_000 });
      await region.getByText(`Versión 2 · Nativo (en el espacio) · agente ${alias}`).waitFor({ timeout: 20_000 });
      const visible = await region.innerText();
      expect(visible).not.toContain(owner.email);
      expect(visible).not.toContain(first.actor_human_id);
      await writeFile(join(evidence, 'autor-humano.json'), JSON.stringify({
        run, tenant, alias, person: owner.name, personCommit: first.git_commit, agentCommit: second.git_commit,
        personAuthor: owner.name, agentAuthor: alias,
      }, null, 2), { mode: 0o600 });
      errors.assertClean();
    } catch (cause) {
      await page.screenshot({ path: join(evidence, 'autor-humano-failure.png') }).catch(() => undefined);
      throw new Error(`autor-humano flow failed at ${page.url()}: ${await bodySnippet(page)} || ${JSON.stringify(errors.trace.slice(-12))}`, { cause });
    }
  }, 300_000);
});
