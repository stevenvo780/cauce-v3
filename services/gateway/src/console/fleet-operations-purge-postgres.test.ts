import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { requireValue } from '../../../../packages/store/test/helpers.js';
import { purgeFixture, purgeRequest, PURGE_ACTOR_SUBJECT } from '../../../../packages/store/test/fleet-purge-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { bindHumanPrincipal } from '../auth.js';
import { FixedAuthProvider, buildTestGateway, testPrincipal } from '../test-support/gateway-doubles.js';

const path = '/v3/console/fleet/operations';
const headers = { origin: 'http://localhost' };
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let app: FastifyInstance | undefined;

async function closePurgeFixture(gateway: { close(): Promise<void> } | undefined,
  testDatabase: Pick<EmptyTestDatabase, 'close'> | undefined): Promise<void> {
  try { await gateway?.close(); }
  finally { await testDatabase?.close(); }
}

describe('purge confirmation through the real operation repository', () => {
  preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
  beforeEach(async () => {
    if (!database) throw new Error('test database missing');
    current = await startTestCaseDatabase(database); pool = current.pool;
    await purgeFixture(pool, current.adminPool);
    app = await buildTestGateway({ fleetOperationsRepository: new FleetOperationsRepository(pool),
      authProvider: new FixedAuthProvider(bindHumanPrincipal(testPrincipal({ tenant_id: 'Steven', alias: 'purge_operator',
        roles: ['operator'], permissions: ['read', 'control'] }), PURGE_ACTOR_SUBJECT.slice('console:'.length))) });
  });
  afterEach(async () => {
    const gateway = app; const testDatabase = current; app = undefined; current = undefined;
    await closePurgeFixture(gateway, testDatabase);
  });
  afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

  it('rejects missing or inexact confirmation with 400 and no operation or event', async () => {
    const gateway = requireValue(app, 'test gateway');
    for (const parameters of [{}, { confirm_alias: 'other' }, { confirm_alias: 'PURGE_AGENT' },
      { confirm_alias: ' purge_agent' }, { confirm_alias: 'purge_agent ' }]) {
      const response = await gateway.inject({ method: 'POST', url: path, headers, payload: { ...purgeRequest(), parameters } });
      expect(response.statusCode).toBe(400);
      expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM fleet_operation_events')).rowCount).toBe(0);
    }
  });
  it('enqueues the confirmed request once and returns its exact hash on retries', async () => {
    const gateway = requireValue(app, 'test gateway');
    const input: FleetOperationRequest = { ...purgeRequest(), parameters: { confirm_alias: 'purge_agent' } };
    const replies: { operation_id: string; operation: FleetOperation }[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await gateway.inject({ method: 'POST', url: path, headers, payload: input });
      expect(response.statusCode).toBe(202);
      const receipt = response.json<{ operation_id: string; operation: FleetOperation }>(); replies.push(receipt);
      expect(receipt.operation.request_sha256).toBe(sha256Hex(input));
    }
    expect(replies[1]?.operation_id).toBe(replies[0]?.operation_id);
    expect((await pool.query('SELECT request FROM fleet_operations')).rows).toEqual([{ request: input }]);
    expect((await pool.query('SELECT id FROM fleet_operation_events')).rowCount).toBe(1);
    const changed = await gateway.inject({ method: 'POST', url: path, headers,
      payload: { ...input, parameters: { confirm_alias: 'other' } } });
    expect(changed.statusCode).toBe(400);
    expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(1);
  });
});

describe('purge fixture cleanup', () => {
  it('closes the database when setup fails before gateway creation', async () => {
    const close = vi.fn(async () => undefined);
    await closePurgeFixture(undefined, { close });
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('closes the database even when gateway closing fails', async () => {
    const failure = new Error('gateway close failed'); const close = vi.fn(async () => undefined);
    await expect(closePurgeFixture({ close: async () => { throw failure; } }, { close })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
});
