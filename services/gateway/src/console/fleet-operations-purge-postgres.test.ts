import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { purgeFixture, purgeRequest, PURGE_ACTOR_SUBJECT } from '../../../../packages/store/test/fleet-purge-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { bindHumanPrincipal } from '../auth.js';
import { FixedAuthProvider, buildTestGateway, testPrincipal } from '../test-support/gateway-doubles.js';

const path = '/v3/console/fleet/operations';
const headers = { origin: 'http://localhost' };
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await purgeFixture(pool, current.adminPool);
  app = await buildTestGateway({ fleetOperationsRepository: new FleetOperationsRepository(pool),
    authProvider: new FixedAuthProvider(bindHumanPrincipal(testPrincipal({ tenant_id: 'Steven', alias: 'purge_operator',
      roles: ['operator'], permissions: ['read', 'control'] }), PURGE_ACTOR_SUBJECT.slice('console:'.length))) });
});
afterEach(async () => { await app?.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('purge confirmation through the real operation repository', () => {
  it('rejects missing or inexact confirmation with 400 and no operation or event', async () => {
    for (const parameters of [{}, { confirm_alias: 'other' }, { confirm_alias: 'PURGE_AGENT' },
      { confirm_alias: ' purge_agent' }, { confirm_alias: 'purge_agent ' }]) {
      const response = await app.inject({ method: 'POST', url: path, headers, payload: { ...purgeRequest(), parameters } });
      expect(response.statusCode).toBe(400);
      expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM fleet_operation_events')).rowCount).toBe(0);
    }
  });
  it('enqueues the confirmed request once and returns its exact hash on retries', async () => {
    const input: FleetOperationRequest = { ...purgeRequest(), parameters: { confirm_alias: 'purge_agent' } };
    const replies: { operation_id: string; operation: FleetOperation }[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ method: 'POST', url: path, headers, payload: input });
      expect(response.statusCode).toBe(202);
      const receipt = response.json<{ operation_id: string; operation: FleetOperation }>(); replies.push(receipt);
      expect(receipt.operation.request_sha256).toBe(sha256Hex(input));
    }
    expect(replies[1]?.operation_id).toBe(replies[0]?.operation_id);
    expect((await pool.query('SELECT request FROM fleet_operations')).rows).toEqual([{ request: input }]);
    expect((await pool.query('SELECT id FROM fleet_operation_events')).rowCount).toBe(1);
    const changed = await app.inject({ method: 'POST', url: path, headers,
      payload: { ...input, parameters: { confirm_alias: 'other' } } });
    expect(changed.statusCode).toBe(400);
    expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(1);
  });
});
