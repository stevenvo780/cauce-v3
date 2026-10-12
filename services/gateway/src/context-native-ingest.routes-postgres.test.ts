import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextGitBroker, ContextVersionStore, lockCompanyAuthority, processContextOutbox,
  type DatabaseClient, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { PasswordAuthProvider } from './password-auth.js';
import { buildTestGateway, FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';

const execute = promisify(execFile);
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
let app: FastifyInstance | undefined; let directory: string | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function other() { const value = fixtures[1]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
async function gatewayFor(tenant: string, alias: string): Promise<FastifyInstance> {
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 19),
    fallback: new FixedAuthProvider(testPrincipal({ tenant_id: tenant, alias })) });
  return buildTestGateway({ pool, authProvider: provider });
}
async function applied(version: number): Promise<void> {
  await current?.adminPool.query(`UPDATE agent_context_state SET applied_version=$1 WHERE tenant_id='ContextAlpha' AND alias='director'`, [version]);
  await current?.adminPool.query(`UPDATE agent_context_outbox SET applied_at=clock_timestamp() WHERE tenant_id='ContextAlpha' AND alias='director' AND version=$1`, [version]);
}
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  await store.write(source, target().tenant_id, target().alias,
    { expected_version: 0, source: 'ui', files: [{ path: 'context/x.md', content: 'Server version one.' }] });
  await applied(1);
});
afterEach(async () => {
  await app?.close(); app = undefined; await current?.close(); current = undefined;
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const ingested = [{ path: 'context/x.md', content: 'Edited inside the agent space.' },
  { path: 'directives/local-note.md', content: 'Created inside the agent space.' }];

describe('native context ingest with real PostgreSQL and Git bare remote', () => {
  it('registers a local edit as version N+1 with native origin and alias author, and syncs it to the bare remote', async () => {
    app = await gatewayFor('ContextAlpha', 'director');
    const result = await app.inject({ method: 'POST', url: '/v3/context/ingest',
      payload: { base_version: 1, files: ingested } });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({ tenant_id: 'ContextAlpha', alias: 'director', version: 2, desired_version: 2, applied_version: 1 });
    expect((await pool.query(`SELECT source,actor_alias,actor_human_id FROM agent_context_versions
      WHERE tenant_id='ContextAlpha' AND alias='director' ORDER BY version`)).rows).toEqual([
      { source: 'ui', actor_alias: 'owner', actor_human_id: target().human_id },
      { source: 'native', actor_alias: 'director', actor_human_id: null }]);
    const history = await store.history(source, target().tenant_id, target().alias);
    expect(history.entries[0]).toMatchObject({ version: 2, source: 'native', actor_alias: 'director', actor_human_id: null });

    directory = await mkdtemp(join(tmpdir(), 'zz-canary-native-ingest-')); await chmod(directory, 0o700);
    await execute('git', ['init', '--initial-branch=main', directory]);
    const remote = join(directory, 'remote.git'); await execute('git', ['init', '--bare', remote]);
    await execute('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
    const git = new ContextGitBroker(directory);
    expect(await processContextOutbox(pool, { git }, target())).toMatchObject({ state: 'synced', version: 1 });
    expect(await processContextOutbox(pool, { git }, target())).toMatchObject({ state: 'pending', version: 2 });
    const commit = (await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim();
    const prefix = 'companies/context_alpha/tenants/ContextAlpha/agents/director';
    expect((await execute('git', ['--git-dir', remote, 'show', `main:${prefix}/context/x.md`])).stdout)
      .toBe('Edited inside the agent space.');
    expect((await execute('git', ['--git-dir', remote, 'show', `main:${prefix}/directives/local-note.md`])).stdout)
      .toBe('Created inside the agent space.');
    const marker = JSON.parse((await execute('git', ['--git-dir', remote, 'show', `main:${prefix}/.cauce-version.json`])).stdout) as Record<string, unknown>;
    expect(marker).toMatchObject({ version: 2, source: 'native', actor_alias: 'director', actor_human_id: null });
    const outbox = (await pool.query(`SELECT version::integer,state,git_commit FROM agent_context_outbox ORDER BY version`)).rows;
    expect(outbox).toEqual([{ version: 1, state: 'synced', git_commit: expect.stringMatching(/^[a-f0-9]{40}$/u) },
      { version: 2, state: 'synced', git_commit: commit }]);
  });

  it('is idempotent when the same edit is retried after a lost response', async () => {
    app = await gatewayFor('ContextAlpha', 'director');
    const payload = { base_version: 1, files: ingested };
    expect((await app.inject({ method: 'POST', url: '/v3/context/ingest', payload })).statusCode).toBe(202);
    const retry = await app.inject({ method: 'POST', url: '/v3/context/ingest', payload });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ version: 2, desired_version: 2 });
    expect((await pool.query(`SELECT count(*)::integer AS count FROM agent_context_versions`)).rows).toEqual([{ count: 2 }]);
  });

  it('keeps the local candidate unrecorded, returns 409 and exposes the conflict when the server advanced', async () => {
    await store.write(source, target().tenant_id, target().alias,
      { expected_version: 1, source: 'ui', files: [{ path: 'context/x.md', content: 'Advanced on the server.' }] });
    app = await gatewayFor('ContextAlpha', 'director');
    const result = await app.inject({ method: 'POST', url: '/v3/context/ingest',
      payload: { base_version: 1, files: ingested } });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ desired_version: 2, applied_version: 1, base_version: 1 });
    expect((await pool.query(`SELECT count(*)::integer AS count FROM agent_context_versions`)).rows).toEqual([{ count: 2 }]);
    const advancedFiles = (await pool.query(`SELECT files FROM agent_context_versions WHERE version=2`)).rows[0]?.files as { path: string; content: string }[];
    expect(advancedFiles.find(file => file.path === 'context/x.md')?.content).toBe('Advanced on the server.');
    const snapshot = await store.read(source, target().tenant_id, target().alias);
    expect(snapshot.application).toEqual({ state: 'error', last_error: 'native_context_conflict' });
    expect((await pool.query(`SELECT decision,metadata FROM audit_events WHERE action='context.native_conflict'`)).rows)
      .toEqual([{ decision: 'deny', metadata: expect.objectContaining({ base_version: 1, desired_version: 2 }) }]);
  });

  it('binds the target to the certificate principal and isolates companies', async () => {
    app = await gatewayFor('ContextBeta', 'director');
    const smuggled = await app.inject({ method: 'POST', url: '/v3/context/ingest',
      payload: { base_version: 0, files: ingested, tenant_id: 'ContextAlpha', alias: 'director' } });
    expect(smuggled.statusCode).toBe(400);
    const own = await app.inject({ method: 'POST', url: '/v3/context/ingest', payload: { base_version: 0, files: ingested } });
    expect(own.statusCode).toBe(202);
    expect(own.json()).toMatchObject({ company_id: 'context_beta', tenant_id: 'ContextBeta', version: 1 });
    expect((await pool.query(`SELECT count(*)::integer AS count FROM agent_context_versions WHERE company_id='context_alpha'`)).rows)
      .toEqual([{ count: 1 }]);
    expect(other().company_id).toBe('context_beta');
    await app.close();
    app = await gatewayFor('ContextAlpha', 'ghost');
    const ghost = await app.inject({ method: 'POST', url: '/v3/context/ingest', payload: { base_version: 0, files: ingested } });
    expect(ghost.statusCode).toBe(404);
  });

  it('rejects unsafe local files without recording a version', async () => {
    app = await gatewayFor('ContextAlpha', 'director');
    expect((await app.inject({ method: 'POST', url: '/v3/context/ingest',
      payload: { base_version: 1, files: [{ path: 'context/auth.json', content: 'x' }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v3/context/ingest',
      payload: { base_version: -1, files: ingested } })).statusCode).toBe(400);
    expect((await pool.query(`SELECT count(*)::integer AS count FROM agent_context_versions`)).rows).toEqual([{ count: 1 }]);
  });
});
