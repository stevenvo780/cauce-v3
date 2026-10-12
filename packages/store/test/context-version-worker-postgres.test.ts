import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { ContextVersionStore } from '../src/context-version.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const execute = promisify(execFile);
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
let directory: string | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  await current.adminPool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('zz-canary-context-sync','Context sync fixture','context_alpha')");
  await current.adminPool.query("UPDATE agents SET host_id='zz-canary-context-sync' WHERE tenant_id='ContextAlpha' AND alias='director'");
  await store.write(source, target().tenant_id, target().alias,
    { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Use company scoped context.' }] });
});
afterEach(async () => {
  await current?.close(); current = undefined;
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
async function evidence() {
  const sync = (await pool.query<{ state: string; last_error: string | null; git_commit: string | null; attempts: number }>(
    'SELECT state,last_error,git_commit,attempts FROM agent_context_outbox')).rows;
  const events = (await pool.query<{ company_id: string; tenant_id: string; actor_alias: string; decision: string; metadata: Record<string, unknown> }>(
    "SELECT company_id,tenant_id,actor_alias,decision,metadata FROM audit_events WHERE action='context.sync' ORDER BY id")).rows;
  return { sync, events };
}

describe('safe diagnostics for durable context synchronization', () => {
  it.each([
    ['Authentication failed for https://fixture-token@github.invalid/private', 'context_git_authentication_failed'],
    ['Permission denied (publickey)', 'context_git_authentication_failed'],
    ['Could not resolve host: github.invalid', 'context_git_network_failed'],
    ['Connection refused', 'context_git_network_failed'],
    ['! [rejected] main -> main (non-fast-forward)', 'context_git_non_fast_forward'],
    ['! [rejected] main -> main (fetch first)', 'context_git_non_fast_forward'],
    ['Connection timed out', 'context_git_timeout'],
    ['context repository must be private and have real Git metadata', 'context_git_repository_not_private'],
  ])('persists a stable cause for %s', async (message, expected) => {
    expect(await processContextOutbox(pool, { git: { commit: async () => 'b'.repeat(40),
      push: async () => { throw new Error(message); } } }, target())).toMatchObject({ state: 'error', error: expected });
    const stored = await evidence();
    expect(stored.sync).toEqual([{ state: 'error', last_error: expected, git_commit: 'b'.repeat(40), attempts: 1 }]);
    expect(stored.events).toEqual([{ company_id: 'context_alpha', tenant_id: 'ContextAlpha', actor_alias: 'director', decision: 'info',
      metadata: { component: 'context', host_id: 'zz-canary-context-sync', target_tenant: 'ContextAlpha', target_alias: 'director',
        version: 1, git_commit: 'b'.repeat(40), state: 'error', error_code: expected } }]);
    expect(JSON.stringify(stored)).not.toContain('fixture-token');
  });
  it.each([
    [Object.assign(new Error('fixture secret'), { code: 'ETIMEDOUT' }), 'context_git_timeout'],
    [Object.assign(new Error('fixture secret'), { killed: true, signal: 'SIGTERM' }), 'context_git_timeout'],
    [Object.assign(new Error('fixture secret'), { code: 'ECONNRESET' }), 'context_git_network_failed'],
    [Object.assign(new Error('fixture secret'), { stderr: 'remote: Authentication failed' }), 'context_git_authentication_failed'],
    [Object.assign(new Error('fixture secret'), { stdout: '! [rejected] main (non-fast-forward)' }), 'context_git_non_fast_forward'],
    [new Error('arbitrary fixture-token detail'), 'context_push_failed'],
  ])('classifies structured failures without persisting command details %#', async (error, expected) => {
    await processContextOutbox(pool, { git: { commit: async () => 'b'.repeat(40), push: async () => { throw error; } } }, target());
    const stored = await evidence();
    expect(stored.sync[0]).toMatchObject({ state: 'error', last_error: expected });
    expect(stored.events[0]?.metadata).toMatchObject({ error_code: expected });
    expect(JSON.stringify(stored)).not.toContain('fixture secret');
    expect(JSON.stringify(stored)).not.toContain('fixture-token');
  });
  it('keeps the real Git commit after a token-bearing push rejection and clears the cause on retry', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-sync-')); await chmod(directory, 0o700);
    await execute('git', ['init', '--initial-branch=main', directory]);
    const remote = join(directory, 'remote.git'); await execute('git', ['init', '--bare', remote]);
    await execute('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
    const hook = join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, "#!/bin/sh\nprintf '%s\\n' 'Authentication failed for https://fixture-token@github.invalid/private' >&2\nexit 1\n", { mode: 0o700 });
    const git = new ContextGitBroker(directory);
    expect(await processContextOutbox(pool, { git }, target())).toMatchObject({ state: 'error', error: 'context_git_authentication_failed' });
    const failed = await evidence();
    expect(failed.sync[0]?.git_commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(JSON.stringify(failed)).not.toContain('fixture-token');
    await rm(hook); await store.retry(source, target().tenant_id, target().alias);
    expect(await processContextOutbox(pool, { git }, target())).toMatchObject({ state: 'pending', version: 1 });
    const recovered = await evidence();
    expect(recovered.sync[0]).toMatchObject({ state: 'synced', last_error: null, git_commit: failed.sync[0]?.git_commit, attempts: 2 });
    expect(recovered.events[1]?.metadata).toMatchObject({ state: 'synced', error_code: null, host_id: 'zz-canary-context-sync', component: 'context' });
    expect((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim()).toBe(failed.sync[0]?.git_commit);
  });
  it('rejects an unprotected broker repository before creating a Git commit', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-unprotected-'));
    await execute('git', ['init', '--initial-branch=main', directory]); await chmod(directory, 0o755);
    expect(await processContextOutbox(pool, { git: new ContextGitBroker(directory) }, target()))
      .toMatchObject({ state: 'error', error: 'context_git_repository_not_private' });
    expect((await evidence()).sync[0]).toMatchObject({ state: 'error', last_error: 'context_git_repository_not_private', git_commit: null });
  });
});
