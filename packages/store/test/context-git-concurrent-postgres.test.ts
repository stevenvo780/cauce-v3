import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { ContextVersionStore } from '../src/context-version.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { contextCommitIdentity, contextRepositoryPrefix, type ContextTarget } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

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
let directory: string | undefined; let remote: string; let repository: string; let outsider: string; let broker: ContextGitBroker;

async function closeConcurrentFixture(testDatabase: Pick<EmptyTestDatabase, 'close'> | undefined,
  path: string | undefined): Promise<void> {
  try { await testDatabase?.close(); }
  finally { if (path !== undefined) await rm(path, { recursive: true, force: true }); }
}

function fixture(index: number) { return requireValue(fixtures[index], 'fixture'); }
function source(index: number) {
  const value = fixture(index);
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id });
}
const write = (index: number, alias: string, expected: number, content: string) =>
  store.write(source(index), fixture(index).tenant_id, alias,
    { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content }] });
async function syncAll(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    if ((await processContextOutbox(pool, { git: broker })).state === 'idle') return;
  }
  throw new Error('context outbox did not settle');
}
async function outsiderCommit(files: Record<string, string>): Promise<string> {
  await git(outsider, ['pull', '--quiet', '--ff-only', 'origin', 'main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(outsider, path)), { recursive: true }); await writeFile(join(outsider, path), content);
  }
  await git(outsider, ['add', '--', ...Object.keys(files)]);
  await git(outsider, ['commit', '--quiet', '-m', 'Outsider concurrent change']);
  await git(outsider, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main']);
  return git(outsider, ['rev-parse', 'HEAD']);
}
const remoteFile = (path: string) => git(remote, ['show', `refs/heads/main:${path}`]);
const outboxOf = async (target: ContextTarget) => requireValue((await pool.query<{ state: string; git_commit: string | null }>(
  `SELECT state,git_commit FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 ORDER BY version DESC LIMIT 1`,
  [target.company_id, target.tenant_id, target.alias])).rows[0], 'outbox');

describe('shared context broker with concurrent agents', () => {
  preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
  beforeEach(async () => {
    if (!database) throw new Error('database unavailable');
    current = await startTestCaseDatabase(database); pool = current.pool;
    fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
    directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-concurrent-')); await chmod(directory, 0o700);
    remote = join(directory, 'origin.git'); repository = join(directory, 'broker'); outsider = join(directory, 'outsider');
    await git(directory, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await git(directory, ['init', '--quiet', '--initial-branch=main', repository]); await chmod(repository, 0o700);
    await git(repository, ['commit', '--quiet', '--allow-empty', '-m', 'Initialize concurrent fixture']);
    await git(repository, ['remote', 'add', 'origin', remote]);
    await git(repository, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main']);
    await git(directory, ['clone', '--quiet', remote, outsider]);
    broker = new ContextGitBroker(repository);
  });
  afterEach(async () => {
    const testDatabase = current; const path = directory; current = undefined; directory = undefined;
    await closeConcurrentFixture(testDatabase, path);
  });
  afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

  it('fences two writers of one agent and syncs three agents of two companies without losing a folder, commit or author', async () => {
    const alpha = fixture(0); const beta = fixture(1);
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,'zz-canary-peer','codex',false)",
      [alpha.tenant_id]);
    const peer: ContextTarget = { company_id: alpha.company_id, tenant_id: alpha.tenant_id, alias: 'zz-canary-peer' };

    await Promise.all([
      write(0, alpha.alias, 0, 'Alpha director mission.'),
      write(0, 'zz-canary-peer', 0, 'Alpha peer mission.'),
      write(1, beta.alias, 0, 'Beta director mission.'),
    ]);
    const raced = await Promise.allSettled([
      write(0, alpha.alias, 1, 'Alpha director second mission.'),
      write(0, alpha.alias, 1, 'Alpha director competing mission.'),
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = requireValue(raced.find(result => result.status === 'rejected'), 'rejected writer');
    expect(rejected.reason).toMatchObject({ code: 'conflict' });
    const winner = await store.read(source(0), alpha.tenant_id, alpha.alias);
    expect(winner.version).toBe(2);

    await syncAll();
    const targets = [alpha, peer, beta];
    const tree = (await git(remote, ['ls-tree', '-r', '--name-only', 'refs/heads/main'])).split('\n');
    for (const target of targets) {
      const prefix = contextRepositoryPrefix(target);
      expect(tree).toEqual(expect.arrayContaining([`${prefix}/.cauce-version.json`, `${prefix}/context/mission.md`]));
      expect(await outboxOf(target)).toMatchObject({ state: 'synced' });
    }
    expect(await remoteFile(`${contextRepositoryPrefix(alpha)}/context/mission.md`)).toBe(
      requireValue(winner.files.find(file => file.path === 'context/mission.md'), 'winner mission').content);
    expect(await remoteFile(`${contextRepositoryPrefix(peer)}/context/mission.md`)).toBe('Alpha peer mission.');
    expect(await remoteFile(`${contextRepositoryPrefix(beta)}/context/mission.md`)).toBe('Beta director mission.');
    const entries = (await store.history(source(0), alpha.tenant_id, alpha.alias)).entries;
    expect(entries.map(entry => entry.version)).toEqual([2, 1]);
    expect(entries.every(entry => entry.actor_alias === 'owner')).toBe(true);
    const versions = (await pool.query<ContextTarget & { version: number; state: string; git_commit: string;
      digest: string; actor_alias: string }>(`SELECT company_id,tenant_id,alias,version::integer,state,git_commit,digest,actor_alias
      FROM agent_context_outbox JOIN agent_context_versions USING(company_id,tenant_id,alias,version)
      ORDER BY company_id,tenant_id,alias,version`)).rows;
    expect(versions).toHaveLength(4);
    expect(new Set(versions.map(version => version.git_commit)).size).toBe(4);
    const commits = (await git(remote, ['rev-list', 'refs/heads/main'])).split('\n');
    expect(commits).toHaveLength(5);
    for (const version of versions) {
      expect(version.state).toBe('synced');
      expect(commits).toContain(version.git_commit);
      const prefix = contextRepositoryPrefix(version);
      expect(JSON.parse(await git(remote, ['show', `${version.git_commit}:${prefix}/.cauce-version.json`]))).toMatchObject({
        company_id: version.company_id, tenant_id: version.tenant_id, alias: version.alias,
        version: version.version, digest: version.digest, actor_alias: version.actor_alias,
      });
      const owner = fixtures.find(item => item.company_id === version.company_id);
      if (!owner) throw new Error('owner absent');
      const identity = contextCommitIdentity({ company_id: version.company_id, actor_alias: version.actor_alias,
        actor_human_id: owner.human_id, actor_name: 'Synthetic owner' });
      expect(await git(remote, ['log', '-1', '--format=%an|%ae|%cn', version.git_commit]))
        .toBe(`${identity.name}|${identity.email}|Cauce context broker`);
      expect(await git(remote, ['log', '-1', '--format=%(trailers:key=Cauce-Actor-Alias,valueonly)', version.git_commit]))
        .toBe(version.actor_alias);
    }
  });

  it('keeps every agent folder when the remote advances another folder before the push', async () => {
    const alpha = fixture(0);
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,'zz-canary-peer','codex',false)",
      [alpha.tenant_id]);
    const peer: ContextTarget = { company_id: alpha.company_id, tenant_id: alpha.tenant_id, alias: 'zz-canary-peer' };
    await write(0, alpha.alias, 0, 'Director before divergence.');
    await write(0, 'zz-canary-peer', 0, 'Peer before divergence.');
    await syncAll();
    const outside = await outsiderCommit({
      [`${contextRepositoryPrefix(peer)}/context/notes.md`]: 'Outsider note in the peer folder.',
      'notes/shared.md': 'Shared outsider note.',
    });
    await write(0, alpha.alias, 1, 'Director after divergence.');
    await syncAll();
    expect(await outboxOf(alpha)).toMatchObject({ state: 'synced' });
    expect(await remoteFile(`${contextRepositoryPrefix(alpha)}/context/mission.md`)).toBe('Director after divergence.');
    expect(await remoteFile(`${contextRepositoryPrefix(peer)}/context/mission.md`)).toBe('Peer before divergence.');
    expect(await remoteFile(`${contextRepositoryPrefix(peer)}/context/notes.md`)).toBe('Outsider note in the peer folder.');
    expect(await remoteFile('notes/shared.md')).toBe('Shared outsider note.');
    expect((await git(remote, ['rev-list', 'refs/heads/main'])).split('\n')).toContain(outside);
  });
});

describe('concurrent context fixture cleanup', () => {
  it('closes the database when setup fails before creating a Git directory', async () => {
    const close = vi.fn(async () => undefined);
    await closeConcurrentFixture({ close }, undefined);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('removes the Git directory even when database closing fails', async () => {
    const path = await mkdtemp(join(tmpdir(), 'zz-canary-context-cleanup-'));
    const failure = new Error('database close failed');
    try {
      await expect(closeConcurrentFixture({ close: async () => { throw failure; } }, path)).rejects.toBe(failure);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(path, { recursive: true, force: true }); }
  });
});
