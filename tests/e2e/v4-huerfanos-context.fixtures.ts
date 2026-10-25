import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { ContextGitBroker, contextDigest, type ContextVersion } from '@cauce/store';
import { PREFIX, RUN, type OrphansFixture, type OrphansPlan, type TestContextPlanItem } from './v4-huerfanos.fixtures.js';
import { checkedResource } from './v4-huerfanos-volumes.fixtures.js';

const execute = promisify(execFile);
const environment = { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
  GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid' };

export interface OrphansContextBroker {
  root: string; remote: string;
  git(args: string[], input?: string): Promise<string>;
  assertUnmaterialized(): Promise<void>;
  close(): Promise<void>;
}

export async function seedDetachedContext(broker: OrphansContextBroker, company: string) {
  const files = [{ path: 'context/mission.md', content: 'Synthetic context retained in reversible Git history.' }];
  const version: ContextVersion = { company_id: company, tenant_id: 'CanaryContext', alias: 'zz-canary-context',
    version: 1, files, digest: contextDigest(files), source: 'ui', restored_from: null,
    actor_human_id: randomUUID(), actor_alias: 'owner', created_at: new Date().toISOString() };
  const publisher = new ContextGitBroker(broker.root);
  const commit = await publisher.commit(version);
  await publisher.push(commit);
  await broker.assertUnmaterialized();
  return { company, commit, tree: await broker.git(['rev-parse', `${commit}:companies/${company}`]),
    path: `companies/${company}`, digest: version.digest };
}

export async function contextPlatformFixture(fixture: OrphansFixture): Promise<OrphansFixture> {
  const inserted = await fixture.computer.pool.query(`INSERT INTO platform_admins(human_id)
    SELECT id FROM console_users WHERE email=$1 RETURNING human_id`, [`${fixture.company}@example.test`]);
  expect(inserted.rowCount).toBe(1);
  const switched = await fixture.computer.app.inject({ method: 'POST', url: '/v3/auth/session/company',
    headers: { ...fixture.session }, payload: { company_id: 'humanizar' } });
  expect(switched.statusCode, 'synthetic platform session could not select Humanizar').toBe(200);
  const body = switched.json<{ csrf_token: string; authority: { role: string; acting_company: string } }>();
  expect(body.authority).toMatchObject({ role: 'platform_admin', acting_company: 'humanizar' });
  const cookies = switched.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [cookies])
    .map(value => value.split(';', 1)[0]).join('; ');
  expect(cookie).not.toBe('');
  const session = { ...fixture.session, cookie, 'x-csrf-token': body.csrf_token };
  const request = async (method: string, path: string, payload?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(fixture.computer.gatewayUrl + path, { method, redirect: 'error',
      headers: { ...session, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (!response.ok) throw new Error(`context cleanup API ${method} ${path} returned ${String(response.status)}`);
    return await response.json() as Record<string, unknown>;
  };
  const authority = (await request('GET', '/v3/auth/session')).authority;
  expect(authority).toMatchObject({ role: 'platform_admin', acting_company: 'humanizar' });
  const target = `zz-canary-h10b-context-${RUN}`;
  expect((await fixture.computer.pool.query('SELECT id FROM companies WHERE id=$1', [target])).rowCount).toBe(0);
  return { ...fixture, session, company: 'humanizar', request };
}

export async function exerciseOrphanContexts(fixture: OrphansFixture, broker: OrphansContextBroker,
  capture: (actor: OrphansFixture, name: string) => Promise<unknown>) {
  await expect.poll(async () => (await fixture.computer.pool.query<{ pending: number }>(
    "SELECT count(*)::integer AS pending FROM agent_context_outbox WHERE company_id=$1 AND state<>'synced'", [fixture.company])).rows[0]?.pending,
  { timeout: 30_000, interval: 500 }).toBe(0);
  const actor = await contextPlatformFixture(fixture);
  const target = await seedDetachedContext(broker, `zz-canary-h10b-context-${RUN}`);
  const protectedContext = await seedDetachedContext(broker, fixture.company);
  await expect(fixture.request('POST', '/v3/console/context-repository/retirements/preview',
    { company_id: target.company, action: 'retire' })).rejects.toThrow('returned 403');
  const candidate = (action: 'retire' | 'restore', company = target.company, retirement?: string): TestContextPlanItem => ({
    id: `context-${action}`, kind: 'test_context', company_id: company, action,
    pin: { head: null, preview_sha256: null }, ...(retirement ? { retirement_commit: retirement } : {}),
  });
  const plan = (item: TestContextPlanItem): OrphansPlan => ({ version: 1, company_id: 'humanizar', expected_revision: 0, items: [item] });
  const sealed = async (item: TestContextPlanItem, name: string) => {
    const discovery = await checkedResource(actor, plan(item), `${name}-discovery`);
    const observed = discovery.items[0];
    expect(observed).toMatchObject({ status: 'retained', reason_code: 'preview_review_required' });
    if (!observed?.head || !observed.preview_sha256) throw new Error('context discovery lacks HEAD or preview pin');
    item.pin = { head: observed.head, preview_sha256: observed.preview_sha256 };
    await capture(actor, `${name}-discovery`);
    return plan(item);
  };
  const before = await broker.git(['rev-parse', 'main']);
  const referenced = await checkedResource(actor, plan(candidate('retire', fixture.company)), 'context-referenced', true);
  expect(referenced.items[0]).toMatchObject({ status: 'retained', reason_code: 'dependencies_present' });
  expect(await broker.git(['rev-parse', 'main'])).toBe(before);
  await capture(actor, 'context-referenced');
  const initialPlan = await sealed(candidate('retire'), 'context-initial');
  const stale = structuredClone(initialPlan);
  const staleItem = stale.items[0];
  if (staleItem?.kind !== 'test_context') throw new Error('context plan has another kind');
  staleItem.pin.preview_sha256 = 'f'.repeat(64);
  const staleResult = await checkedResource(actor, stale, 'context-stale-pin', true, 1);
  expect(staleResult.items[0]?.reason_code).toBe('preview_changed');
  const withoutSimulation = await checkedResource(actor, initialPlan, 'context-no-simulation', true, 1);
  expect(withoutSimulation.items[0]?.reason_code).toBe('fresh_simulation_required');
  expect(await broker.git(['rev-parse', 'main'])).toBe(before);
  await capture(actor, 'context-stale-pin'); await capture(actor, 'context-no-simulation');
  expect((await checkedResource(actor, initialPlan, 'context-head-changed')).items[0]?.status).toBe('would_change');
  const advance = await seedDetachedContext(broker, `zz-canary-h10b-advance-${RUN}`);
  const changed = await checkedResource(actor, initialPlan, 'context-head-changed', true, 1);
  expect(changed.items[0]?.reason_code).toBe('preview_changed');
  expect(await broker.git(['rev-parse', 'main'])).toBe(advance.commit);
  await capture(actor, 'context-head-changed');
  const retire = await sealed(candidate('retire'), 'context-retire');
  const simulated = await checkedResource(actor, retire, 'context-retire');
  expect(simulated.items[0]?.status).toBe('would_change');
  expect(simulated.external_mutations).toBe(false);
  expect(await broker.git(['rev-parse', 'main'])).toBe(advance.commit);
  const retired = await checkedResource(actor, retire, 'context-retire', true);
  expect(retired.items[0]).toMatchObject({ status: 'retired', context_receipt: { pushed: true, tree_oid: target.tree } });
  const retirement = retired.items[0]?.context_receipt;
  if (!retirement) throw new Error('context retirement lacks a durable receipt');
  expect(await broker.git(['rev-parse', 'main'])).toBe(retirement.commit);
  expect(await broker.git(['rev-parse', 'main^'])).toBe(advance.commit);
  expect(await broker.git(['ls-tree', '-r', '--name-only', 'main', '--', target.path])).toBe('');
  expect(await broker.git(['rev-parse', `${target.commit}:${target.path}`])).toBe(target.tree);
  expect(await broker.git(['rev-parse', `main:${protectedContext.path}`])).toBe(protectedContext.tree);
  await broker.git(['merge-base', '--is-ancestor', target.commit, retirement.commit]);
  const retiredReplay = await checkedResource(actor, retire, 'context-retire', true);
  expect(retiredReplay.items[0]).toMatchObject({ status: 'retired', idempotent_replay: true,
    context_receipt: { operation_id: retirement.operation_id, commit: retirement.commit } });
  expect(await broker.git(['rev-parse', 'main'])).toBe(retirement.commit);
  await capture(actor, 'context-retire');
  const restore = await sealed(candidate('restore', target.company, retirement.commit), 'context-restore');
  expect((await checkedResource(actor, restore, 'context-restore')).items[0]?.status).toBe('would_change');
  const restored = await checkedResource(actor, restore, 'context-restore', true);
  expect(restored.items[0]).toMatchObject({ status: 'restored', context_receipt: { pushed: true, tree_oid: target.tree } });
  const restoration = restored.items[0]?.context_receipt;
  if (!restoration) throw new Error('context restoration lacks a durable receipt');
  expect(await broker.git(['rev-parse', 'main'])).toBe(restoration.commit);
  expect(await broker.git(['rev-parse', 'main^'])).toBe(retirement.commit);
  expect(await broker.git(['rev-parse', `main:${target.path}`])).toBe(target.tree);
  expect(await broker.git(['rev-parse', `main:${protectedContext.path}`])).toBe(protectedContext.tree);
  expect(await broker.git(['--git-dir', broker.remote, 'rev-parse', 'main'])).toBe(restoration.commit);
  await broker.git(['merge-base', '--is-ancestor', retirement.commit, restoration.commit]);
  const restoredReplay = await checkedResource(actor, restore, 'context-restore', true);
  expect(restoredReplay.items[0]).toMatchObject({ status: 'restored', idempotent_replay: true,
    context_receipt: { operation_id: restoration.operation_id, commit: restoration.commit } });
  expect(await broker.git(['rev-parse', 'main'])).toBe(restoration.commit);
  expect((await fixture.computer.pool.query('SELECT id FROM companies WHERE id=$1', [target.company])).rowCount).toBe(0);
  await capture(actor, 'context-restore');
  await broker.assertUnmaterialized();
  return { target, protected_context: protectedContext, stale: staleResult, changed_head: changed, referenced,
    retired, retired_replay: retiredReplay, restored, restored_replay: restoredReplay };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('context broker port unavailable');
  await new Promise<void>((done, reject) => server.close(error => { if (error) reject(error); else done(); }));
  return address.port;
}

function daemonReady(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}

async function stopDaemon(daemon: ChildProcess | undefined): Promise<void> {
  if (daemon?.exitCode !== null) return;
  const stopped = new Promise<void>(done => { daemon.once('exit', () => { done(); }); });
  daemon.kill('SIGTERM');
  await stopped;
}

export async function startOrphansContextBroker(): Promise<OrphansContextBroker> {
  const directory = await mkdtemp(join(tmpdir(), `${PREFIX}-context-`));
  const root = join(directory, 'broker'), remote = join(directory, 'origin.git');
  let daemon: ChildProcess | undefined;
  const git = async (args: string[], input?: string) => {
    const pending = execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
      env: environment, timeout: 20_000, maxBuffer: 2_097_152,
    });
    if (input !== undefined) pending.child.stdin?.end(input);
    return (await pending).stdout.trim();
  };
  const close = async () => { try { await stopDaemon(daemon); } finally { await rm(directory, { recursive: true, force: true }); } };
  try {
    await mkdir(root, { mode: 0o700 });
    await execute('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--bare', '--initial-branch=main', remote], { env: environment });
    await git(['init', '--template=', '--initial-branch=main']);
    await chmod(root, 0o700);
    const port = await unusedPort();
    await git(['remote', 'add', 'origin', `git://127.0.0.1:${String(port)}/origin.git`]);
    daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${directory}`,
      '--listen=127.0.0.1', `--port=${String(port)}`], { env: environment, stdio: 'ignore' });
    await expect.poll(() => daemonReady(port), { timeout: 10_000 }).toBe(true);
    return { root, remote, git, close,
      async assertUnmaterialized() {
        expect(await readdir(root)).toEqual(['.git']);
        expect(await stat(join(root, '.git/index')).then(() => true, () => false)).toBe(false);
      },
    };
  } catch (error) { await close(); throw error; }
}
