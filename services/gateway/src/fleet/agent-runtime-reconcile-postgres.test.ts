import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { FleetOperationsRepository, withTransaction, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPost } from './host-channel.fixtures.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { FleetExecutor } from './executor.js';
import { reconcileAgentRuntimes, type RuntimeDriftReceipt } from './agent-runtime-reconcile.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); });
beforeEach(async () => {
  if (!database) throw new Error('Test database is unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  app = Fastify(); registerHostChannelRoutes(app, pool);
});
afterEach(async () => { await app.close(); await current?.close(); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function waiting() {
  const company = await channelCompany(pool, 'runtime-drift'); const host = await channelHost(pool, company);
  expect((await channelPost(app, host, channelCapabilities())).statusCode).toBe(200);
  const repository = new FleetOperationsRepository(pool);
  const actor = { tenant: company.hub.id, alias: 'owner', subject: `console:${company.user.id}` };
  const operation = await repository.enqueue(actor.tenant, actor.alias, channelCreate(company, host, 'zz-canary-drift'), actor.subject);
  await new FleetExecutor(repository, { host: host.host_id, worker: 'runtime-drift-test',
    perform: async step => step === 'authenticate' ? { awaiting_auth: true, evidence: {} }
      : { evidence: { runtime_digest: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64), certificate_fingerprint: 'c'.repeat(64) } },
  }).runOnce();
  const read = () => repository.get(actor.tenant, actor.alias, operation.id, actor.subject);
  expect((await read()).status).toBe('awaiting_auth');
  const reconcile = (receipts: RuntimeDriftReceipt[] = [], identity = host, after?: string) => withTransaction(pool,
    client => reconcileAgentRuntimes(client, identity, receipts, after));
  const inspection = (await reconcile()).inspections[0];
  if (!inspection) throw new Error('Pending container inspection is unavailable');
  return { company, host, repository, actor, read, reconcile, inspection,
    receipt: { ...inspection.fence, error: 'RUNTIME_DRIFT' as const } };
}

it('persists drift once without a login reservation and preserves cancellation', async () => {
  const f = await waiting(); const before = await f.read();
  expect(f.inspection.execution.snapshot?.agents).toHaveLength(1);
  expect(f.inspection.execution.trusted_accounts).toMatchObject([{ id: 'runtime-drift-account' }]);
  expect((await pool.query("SELECT id FROM fleet_operation_events WHERE metadata ? 'provider_auth'")).rowCount).toBe(0);
  expect(await f.reconcile([f.receipt])).toEqual({ inspections: [], cursor: null });
  const drifted = await f.read();
  expect(drifted).toMatchObject({ status: 'awaiting_auth', version: before.version + 1,
    error: { code: 'RUNTIME_DRIFT', step: 'authenticate', retryable: false } });
  expect(await f.reconcile([f.receipt])).toEqual({ inspections: [], cursor: null });
  expect(await f.read()).toEqual(drifted);
  expect((await pool.query("SELECT id FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'runtime_drift'",
    [drifted.id])).rowCount).toBe(1);
  expect(await f.repository.cancel(f.actor.tenant, f.actor.alias, drifted.id, drifted.version, f.actor.subject))
    .toMatchObject({ status: 'cancelling' });
});

it.each(['operation_epoch', 'prepared_revision', 'scope_sha256'] as const)('ignores an obsolete %s fence', async field => {
  const f = await waiting(); const before = await f.read();
  const receipt = { ...f.receipt, [field]: field === 'scope_sha256' ? 'f'.repeat(64) : f.receipt[field] + 1 };
  expect((await f.reconcile([receipt])).inspections).toHaveLength(1);
  expect(await f.read()).toEqual(before);
});

it('does not expose or mark another host or company operation', async () => {
  const f = await waiting(); const before = await f.read();
  const otherHost = await channelHost(pool, f.company, 'runtime-drift-other');
  const company = await channelCompany(pool, 'foreign-drift'); const foreign = await channelHost(pool, company);
  expect(await f.reconcile([f.receipt], otherHost)).toEqual({ inspections: [], cursor: null });
  expect(await f.reconcile([f.receipt], foreign)).toEqual({ inspections: [], cursor: null });
  expect(await f.read()).toEqual(before);
});

it('ignores a receipt after cancellation or human authority revocation', async () => {
  const f = await waiting(); const before = await f.read();
  if (!current) throw new Error('Test database is unavailable');
  await current.adminPool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [f.company.user.id]);
  expect(await f.reconcile([f.receipt])).toEqual({ inspections: [], cursor: before.id });
  await current.adminPool.query('UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL WHERE human_id=$1', [f.company.user.id]);
  expect(await f.read()).toEqual(before);
  const cancelled = await f.repository.cancel(f.actor.tenant, f.actor.alias, before.id, before.version, f.actor.subject);
  expect(await f.reconcile([f.receipt])).toEqual({ inspections: [], cursor: null });
  expect(await f.read()).toEqual(cancelled);
});

it('advances and wraps the cursor through awaiting operations', async () => {
  const f = await waiting();
  const second = await f.repository.enqueue(f.actor.tenant, f.actor.alias,
    channelCreate(f.company, f.host, 'zz-canary-next', f.inspection.fence.prepared_revision), f.actor.subject);
  await new FleetExecutor(f.repository, { host: f.host.host_id, worker: 'runtime-drift-test',
    perform: async step => step === 'authenticate' ? { awaiting_auth: true, evidence: {} }
      : { evidence: { runtime_digest: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64), certificate_fingerprint: 'c'.repeat(64) } },
  }).runOnce();
  const [firstId, lastId] = [f.receipt.operation_id, second.id].sort();
  const next = await f.reconcile([], f.host, firstId);
  expect(next.inspections.map(value => value.fence.operation_id)).toEqual([lastId]);
  expect(next.cursor).toBe(lastId);
  const wrapped = await f.reconcile([], f.host, lastId);
  expect(wrapped.inspections.map(value => value.fence.operation_id)).toEqual([firstId, lastId]);
  expect(wrapped.cursor).toBe(lastId);
});
