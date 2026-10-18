import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { lockCompanyAuthority, settleContextApplications, withTransaction, type ContextVersion, type DatabaseClient,
  type DatabasePool } from '../src/index.js';
import { ContextGitBroker } from '../src/context-git.js';
import { ContextVersionStore, lockContextTarget } from '../src/context-version.js';
import { CONTEXT_APPLICATION_CONCURRENCY, processContextOutbox } from '../src/context-version-worker.js';
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
  if (current) await settleContextApplications(current.pool);
  await current?.close(); current = undefined;
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function target(index = 0) { const value = fixtures[index]; if (!value) throw new Error('fixture absent'); return value; }
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
    expect(recovered.events).toHaveLength(2);
    expect((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim()).toBe(failed.sync[0]?.git_commit);
  });
  it('pushes holding neither the outbox row nor the schema lock, so the ACK and a migration go through meanwhile', async () => {
    let pushing!: () => void; const started = new Promise<void>(resolve => { pushing = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    const run = processContextOutbox(pool, { git: { commit: async () => 'b'.repeat(40),
      push: async () => { pushing(); await released; } } }, target());
    await started;
    const migration = await pool.connect();
    try {
      // The ACK order: the target lock first, then the outbox row of the version.
      await withTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout='1s'");
        await lockContextTarget(client, target());
        await client.query("UPDATE agent_context_outbox SET apply_error='native_context_conflict' WHERE tenant_id=$1", [target().tenant_id]);
      });
      await migration.query('BEGIN');
      expect((await migration.query('SELECT pg_try_advisory_xact_lock(783_003_003) AS locked')).rows).toEqual([{ locked: true }]);
    } finally { await migration.query('ROLLBACK'); migration.release(); release(); }
    expect(await run).toEqual({ state: 'pending', version: 1 });
    expect((await pool.query('SELECT state,git_commit,apply_error FROM agent_context_outbox')).rows)
      .toEqual([{ state: 'synced', git_commit: 'b'.repeat(40), apply_error: 'native_context_conflict' }]);
  });
  it('rejects an unprotected broker repository before creating a Git commit', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zz-canary-context-unprotected-'));
    await execute('git', ['init', '--initial-branch=main', directory]); await chmod(directory, 0o755);
    expect(await processContextOutbox(pool, { git: new ContextGitBroker(directory) }, target()))
      .toMatchObject({ state: 'error', error: 'context_git_repository_not_private' });
    expect((await evidence()).sync[0]).toMatchObject({ state: 'error', last_error: 'context_git_repository_not_private', git_commit: null });
  });
});

describe('bounded dedicated application of the desired version', () => {
  const git = { commit: async () => 'b'.repeat(40), push: async () => undefined };
  const unconfirmed = (calls: number[]) => ({ apply: async (version: ContextVersion) => {
    calls.push(version.version); return { version: version.version, digest: version.digest };
  } });
  async function application(index = 0) {
    const row = (await pool.query<{ apply_error: string | null; leased: boolean; retry_in: number | null }>(`SELECT apply_error,
      apply_token IS NOT NULL AS leased,CASE WHEN isfinite(apply_retry_at) THEN EXTRACT(EPOCH FROM apply_retry_at-clock_timestamp())::float8 END AS retry_in
      FROM agent_context_outbox WHERE tenant_id=$1`, [target(index).tenant_id])).rows[0];
    if (!row) throw new Error('context outbox absent');
    return row;
  }
  it('stops after three unconfirmed attempts with growing waits until an operator asks again', async () => {
    const calls: number[] = []; const runtime = unconfirmed(calls); const waits: (number | null)[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await processContextOutbox(pool, { git, runtime }, target())).toEqual({ state: 'error', version: 1,
        error: attempt < 3 ? 'context_runtime_verification_failed' : 'context_runtime_attempts_exhausted' });
      waits.push((await application()).retry_in);
      expect(await processContextOutbox(pool, { git, runtime }, target())).toEqual({ state: 'idle' });
      await pool.query('UPDATE agent_context_outbox SET apply_retry_at=now() WHERE isfinite(apply_retry_at)');
    }
    expect(calls).toEqual([1, 1, 1]);
    expect(waits[0]).toBeGreaterThan(55); expect(waits[0]).toBeLessThanOrEqual(60);
    expect(waits[1]).toBeGreaterThan(115); expect(waits[1]).toBeLessThanOrEqual(120);
    expect(waits[2]).toBeNull();
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'idle' });
    await store.retry(source, target().tenant_id, target().alias);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'error', version: 1, error: 'context_runtime_verification_failed' });
    expect(calls).toEqual([1, 1, 1, 1]);
  });
  it('keeps at most four applications in flight and serves the next agent once one ends', async () => {
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
      home_directory,state_directory,max_concurrent_deliveries) VALUES('ContextAlpha','zz-canary-context','fake','zz-canary-context',
      true,'ws-zz-canary-context','dev','/home/dev','/home/dev/.cauce/dev',3)`);
    for (const [index, alias] of [[0, 'owner'], [0, 'zz-canary-context'], [1, 'director'], [1, 'owner']] as const) {
      const value = target(index);
      await store.write(client => lockCompanyAuthority(client, { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }),
        value.tenant_id, alias, { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: `Mission of ${alias}.` }] });
    }
    const releases = new Map<string, () => void>();
    const runtime = { apply: async (version: ContextVersion, waiting?: () => void) => {
      waiting?.(); await new Promise<void>(resolve => { releases.set(`${version.tenant_id}/${version.alias}`, resolve); });
      return { version: version.version, digest: version.digest };
    } };
    const leased = async () => (await pool.query<{ agent: string }>(`SELECT tenant_id||'/'||alias AS agent FROM agent_context_outbox
      WHERE apply_token IS NOT NULL ORDER BY 1`)).rows.map(row => row.agent);
    try {
      expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
      expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
      const first = await leased();
      expect(first).toHaveLength(CONTEXT_APPLICATION_CONCURRENCY);
      expect(releases.size).toBe(CONTEXT_APPLICATION_CONCURRENCY);
      releases.get(first[0] ?? '')?.();
      for (let retry = 0; retry < 100 && releases.size === CONTEXT_APPLICATION_CONCURRENCY; retry++) {
        await processContextOutbox(pool, { git, runtime });
        await new Promise<void>(resolve => { setTimeout(resolve, 10); });
      }
      expect(releases.size).toBe(CONTEXT_APPLICATION_CONCURRENCY + 1);
      expect(await leased()).toHaveLength(CONTEXT_APPLICATION_CONCURRENCY);
      expect(await leased()).not.toContain(first[0]);
    } finally { for (const resolve of releases.values()) resolve(); }
    await settleContextApplications(pool);
    expect(await leased()).toEqual([]);
  });
  it('sets an unreadable stored version aside without stopping the other agents', async () => {
    if (!current) throw new Error('database unavailable');
    const alpha = target(); const beta = target(1);
    await store.write(client => lockCompanyAuthority(client, { tenant: beta.tenant_id, alias: 'owner', humanId: beta.human_id }),
      beta.tenant_id, beta.alias, { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Second company.' }] });
    const scope = [alpha.company_id, alpha.tenant_id, alpha.alias];
    await current.adminPool.query(`INSERT INTO agent_context_versions(company_id,tenant_id,alias,version,files,digest,source,actor_human_id,
      actor_alias) VALUES($1,$2,$3,2,'[]'::jsonb,$4,'ui',$5,'owner')`, [...scope, 'c'.repeat(64), alpha.human_id]);
    await current.adminPool.query('UPDATE agent_context_state SET desired_version=2 WHERE company_id=$1 AND tenant_id=$2 AND alias=$3', scope);
    await current.adminPool.query('INSERT INTO agent_context_outbox(company_id,tenant_id,alias,version) VALUES($1,$2,$3,2)', scope);
    const calls: number[] = [];
    for (let run = 0; run < 3; run++) await processContextOutbox(pool, { git, runtime: unconfirmed(calls) });
    await settleContextApplications(pool);
    expect(calls).toEqual([1]);
    expect((await pool.query(`SELECT tenant_id,version::integer,state,last_error,apply_error FROM agent_context_outbox
      ORDER BY tenant_id,version`)).rows).toEqual([
      { tenant_id: 'ContextAlpha', version: 1, state: 'synced', last_error: null, apply_error: null },
      { tenant_id: 'ContextAlpha', version: 2, state: 'error', last_error: 'context_version_unreadable', apply_error: 'context_version_unreadable' },
      { tenant_id: 'ContextBeta', version: 1, state: 'synced', last_error: null, apply_error: 'context_runtime_verification_failed' },
    ]);
  });
});
