import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextVersionStore, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { ContextIngestClient } from '../../../packages/adapter-sdk/src/sdk/context-ingest-client.js';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { DevOnlyAuthProvider } from './auth.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { PasswordAuthProvider } from './password-auth.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let app: FastifyInstance | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  const store = new ContextVersionStore(pool);
  await store.write((client: DatabaseClient) => lockCompanyAuthority(client,
    { tenant: target().tenant_id, alias: 'owner', humanId: target().human_id }), target().tenant_id, target().alias,
  { expected_version: 0, source: 'ui', files: [{ path: 'context/notes/x.md', content: 'Server version one.' }] });
  await current.adminPool.query(`UPDATE agent_context_state SET applied_version=1 WHERE tenant_id='ContextAlpha' AND alias='director'`);
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool),
    signingKey: Buffer.alloc(32, 23), fallback: DevOnlyAuthProvider.forTests() });
  app = await buildTestGateway({ pool, authProvider: provider });
  await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => { await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function candidate(tenant: string, content: string): Promise<{ path: string; content: string }[]> {
  const files = (await pool.query(`SELECT files FROM agent_context_versions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1`, [tenant]))
    .rows[0]?.files as { path: string; content: string }[] ?? [];
  const next = files.map(file => file.path === 'context/notes/x.md' ? { ...file, content } : file);
  if (!next.some(file => file.path === 'context/notes/x.md')) next.push({ path: 'context/notes/x.md', content });
  return next;
}
function clientFor(tenant: string, alias: string): ContextIngestClient {
  if (!app) throw new Error('gateway absent');
  const address = app.server.address() as AddressInfo;
  return ContextIngestClient.fromRelayUrl(`ws://127.0.0.1:${String(address.port)}/v3/ws`,
    { developmentIdentity: { tenant_id: tenant, alias } });
}

describe('native context ingest over a real socket with the SDK client', () => {
  it('ingests, conflicts and isolates by the development identity headers', async () => {
    const client = clientFor('ContextAlpha', 'director');
    const ingested = await client.ingest({ base_version: 1, files: await candidate('ContextAlpha', 'Edited in the space.') });
    expect(ingested).toMatchObject({ state: 'ingested', context: { version: 2, tenant_id: 'ContextAlpha', alias: 'director' } });
    expect((await pool.query(`SELECT source,actor_alias FROM agent_context_versions WHERE version=2`)).rows)
      .toEqual([{ source: 'native', actor_alias: 'director' }]);
    const conflict = await client.ingest({ base_version: 1, files: await candidate('ContextAlpha', 'Stale base.') });
    expect(conflict).toEqual({ state: 'conflict', desired_version: 2, applied_version: 1 });

    const beta = clientFor('ContextBeta', 'director');
    const betaIngested = await beta.ingest({ base_version: 0, files: await candidate('ContextBeta', 'Beta local.') });
    expect(betaIngested).toMatchObject({ state: 'ingested', context: { version: 1, company_id: 'context_beta' } });
    expect((await pool.query(`SELECT count(*)::integer AS count FROM agent_context_versions WHERE company_id='context_alpha'`)).rows)
      .toEqual([{ count: 2 }]);
  });
});
