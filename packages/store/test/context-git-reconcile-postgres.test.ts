import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { ContextVersionStore, ingestNativeContextVersion } from '../src/context-version.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { contextRepositoryPrefix } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const execute = promisify(execFile);
const environment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'zz-canary-outsider', GIT_AUTHOR_EMAIL: 'zz-canary-outsider@cauce.invalid',
  GIT_COMMITTER_NAME: 'zz-canary-outsider', GIT_COMMITTER_EMAIL: 'zz-canary-outsider@cauce.invalid',
};
async function git(directory: string, args: string[]): Promise<string> {
  return (await execute('git', ['-C', directory, ...args], { env: environment, encoding: 'utf8', timeout: 20_000 })).stdout.trim();
}

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
let directory: string; let remote: string; let repository: string; let outsider: string; let broker: ContextGitBroker;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-reconcile-')); await chmod(directory, 0o700);
  remote = join(directory, 'origin.git'); repository = join(directory, 'broker'); outsider = join(directory, 'outsider');
  await git(directory, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  await git(directory, ['init', '--quiet', '--initial-branch=main', repository]); await chmod(repository, 0o700);
  await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'Initialize reconcile fixture']);
  await git(repository, ['remote', 'add', 'origin', remote]);
  await git(repository, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main']);
  await git(directory, ['clone', '--quiet', remote, outsider]);
  broker = new ContextGitBroker(repository);
});
afterEach(async () => { await current?.close(); current = undefined; await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const write = (expected: number, content: string) => store.write(source, target().tenant_id, target().alias,
  { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content }] });
const sync = () => processContextOutbox(pool, { git: broker }, target());
async function outbox() {
  return (await pool.query<{ state: string; git_commit: string | null; last_error: string | null; attempts: number }>(
    `SELECT state,git_commit,last_error,attempts FROM agent_context_outbox ORDER BY version DESC LIMIT 1`)).rows[0];
}
async function outsiderCommit(files: Record<string, string>): Promise<string> {
  await git(outsider, ['pull', '--quiet', '--ff-only', 'origin', 'main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(outsider, path)), { recursive: true }); await writeFile(join(outsider, path), content);
  }
  await git(outsider, ['add', '--', ...Object.keys(files)]);
  await git(outsider, ['commit', '--quiet', '-m', 'Outsider change']);
  await git(outsider, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main']);
  return git(outsider, ['rev-parse', 'HEAD']);
}
const remoteFile = (path: string) => git(remote, ['show', `refs/heads/main:${path}`]);
const parents = async (commit: string) => (await git(remote, ['rev-list', '--parents', '-n', '1', commit])).split(' ').slice(1);
const history = async () => (await git(remote, ['rev-list', 'refs/heads/main'])).split('\n');

describe('context broker reconciliation with a remote that advanced', () => {
  it('commits on top of the fetched remote, keeps the outsider commit and authors each version by its alias', async () => {
    const outside = await outsiderCommit({ 'notes/outsider.md': 'Outsider note.' });
    await write(0, 'Mission written by a person.');
    expect(await sync()).toMatchObject({ state: 'pending', version: 1 });
    const human = await outbox();
    expect(human).toMatchObject({ state: 'synced', last_error: null, attempts: 1 });
    if (!human?.git_commit) throw new Error('human version has no commit');
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(human.git_commit);
    expect(await parents(human.git_commit)).toEqual([outside]);
    expect(await remoteFile('notes/outsider.md')).toBe('Outsider note.');
    const [entry] = (await store.history(source, target().tenant_id, target().alias)).entries;
    expect(await git(remote, ['log', '-1', '--format=%an|%ae|%cn|%ce|%at', human.git_commit])).toBe(
      `owner|owner@context_alpha.cauce.invalid|Cauce context broker|context-broker@cauce.invalid|${String(Math.floor(Date.parse(entry?.created_at ?? '') / 1000))}`);

    const space = (await store.read(source, target().tenant_id, target().alias)).files;
    expect(await ingestNativeContextVersion(pool, target().tenant_id, target().alias,
      { base_version: 1, files: [...space, { path: 'context/notes/agent.md', content: 'Note written by the agent.' }] })).toMatchObject({ state: 'ingested' });
    await sync();
    const native = await outbox();
    expect(native).toMatchObject({ state: 'synced' });
    if (!native?.git_commit) throw new Error('native version has no commit');
    expect(await parents(native.git_commit)).toEqual([human.git_commit]);
    expect(await git(remote, ['log', '-1', '--format=%an <%ae>|%cn', native.git_commit]))
      .toBe(`${target().alias} <${target().alias}@context_alpha.cauce.invalid>|Cauce context broker`);
  });

  it.each([
    [1, 'Mission version two from PostgreSQL.'],
    [3, 'Outsider folder content.'],
  ])('merges a retained commit per agent folder when the remote holds version %i of it, losing no commit', async (outsideVersion, winner) => {
    const prefix = contextRepositoryPrefix(target());
    await write(0, 'Mission version one.');
    await sync();
    const first = (await outbox())?.git_commit;
    await write(1, 'Mission version two from PostgreSQL.');
    await git(repository, ['remote', 'set-url', 'origin', join(directory, 'unreachable.git')]);
    expect(await sync()).toMatchObject({ state: 'error', error: 'context_push_failed' });
    const retained = await outbox();
    if (!first || !retained?.git_commit) throw new Error('retained commit is missing');
    const outside = await outsiderCommit({ [`${prefix}/context/mission.md`]: 'Outsider folder content.',
      [`${prefix}/.cauce-version.json`]: JSON.stringify({ version: outsideVersion }), 'notes/other.md': 'Other folder.' });

    await git(repository, ['remote', 'set-url', 'origin', remote]);
    await store.retry(source, target().tenant_id, target().alias);
    expect(await sync()).toMatchObject({ state: 'pending', version: 2 });
    expect(await outbox()).toMatchObject({ state: 'synced', git_commit: retained.git_commit, last_error: null, attempts: 2 });
    const head = await git(remote, ['rev-parse', 'refs/heads/main']);
    expect(await parents(head)).toEqual([outside, retained.git_commit]);
    expect(await history()).toEqual(expect.arrayContaining([first, retained.git_commit, outside]));
    expect(await remoteFile(`${prefix}/context/mission.md`)).toBe(winner);
    expect(await remoteFile('notes/other.md')).toBe('Other folder.');
    expect(await git(remote, ['log', '-1', '--format=%an|%cn', head])).toBe('Cauce context broker|Cauce context broker');
  });

  it('refuses an unrelated remote history and keeps the local commit for a later retry', async () => {
    const unrelated = join(directory, 'unrelated.git');
    await git(directory, ['init', '--quiet', '--bare', '--initial-branch=main', unrelated]);
    const stranger = join(directory, 'stranger');
    await git(directory, ['init', '--quiet', '--initial-branch=main', stranger]);
    await git(stranger, ['commit', '--quiet', '--allow-empty', '-m', 'Unrelated root']);
    await git(stranger, ['push', '--quiet', unrelated, 'refs/heads/main:refs/heads/main']);
    const foreign = await git(stranger, ['rev-parse', 'HEAD']);
    await git(repository, ['remote', 'set-url', 'origin', unrelated]);
    await write(0, 'Mission for the wrong remote.');
    expect(await sync()).toMatchObject({ state: 'error', error: 'context_git_non_fast_forward' });
    const kept = await outbox();
    expect(kept).toMatchObject({ state: 'error', last_error: 'context_git_non_fast_forward' });
    expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(kept?.git_commit);
    expect(await git(unrelated, ['rev-parse', 'refs/heads/main'])).toBe(foreign);
  });

  it('rehearses the sync-failure drill: the preflight detects the failed push and passes again once the retry ends synced', async () => {
    const key = join(directory, 'deploy-key'); await writeFile(key, 'zz-canary-placeholder-not-a-key\n', { mode: 0o600 });
    await git(repository, ['config', 'core.sshCommand', `ssh -i ${key} -o IdentitiesOnly=yes`]);
    const preflight = async () => {
      const script = fileURLToPath(new URL('../../../ops/scripts/context-broker-preflight.py', import.meta.url));
      const run = await execute('python3', [script, '--repository', repository, '--uid', String(process.getuid?.() ?? -1)], { encoding: 'utf8', timeout: 60_000 })
        .then(result => ({ code: 0, stdout: result.stdout }), (error: { code?: number; stdout?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? '' }));
      const report = JSON.parse(run.stdout) as { checks: { check: string; ok: boolean }[] };
      return { code: run.code, failed: report.checks.filter(check => !check.ok).map(check => check.check) };
    };
    await write(0, 'Mission before the drill.'); await sync();
    expect(await preflight()).toEqual({ code: 0, failed: [] });

    await git(repository, ['remote', 'set-url', 'origin', join(directory, 'unreachable.git')]);
    await write(1, 'Mission written while the remote is down.');
    expect(await sync()).toMatchObject({ state: 'error', error: 'context_push_failed' });
    const retained = await outbox();
    expect(await preflight()).toMatchObject({ code: 1, failed: ['main_matches_origin', 'push_dry_run'] });
    await git(repository, ['remote', 'set-url', 'origin', remote]);
    const outside = await outsiderCommit({ 'notes/drill.md': 'The remote advanced during the outage.' });
    expect(await preflight()).toMatchObject({ code: 1, failed: ['main_matches_origin', 'push_dry_run'] });

    await store.retry(source, target().tenant_id, target().alias);
    await sync();
    const recovered = await outbox();
    expect(recovered).toMatchObject({ state: 'synced', git_commit: retained?.git_commit, last_error: null });
    expect(await preflight()).toEqual({ code: 0, failed: [] });
    expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe((await git(repository, ['ls-remote', 'origin', 'refs/heads/main'])).split(/\s/u)[0]);
    expect(await history()).toEqual(expect.arrayContaining([outside, retained?.git_commit]));
    expect(await remoteFile(`${contextRepositoryPrefix(target())}/context/mission.md`)).toBe('Mission written while the remote is down.');
  });
});
