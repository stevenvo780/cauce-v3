import { afterAll, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import {
  assertDevelopmentDatabaseUrl,
  seedDevelopmentDatabase,
} from '../src/seed-dev-cli.js';
import {
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

interface SeedTrafficRow {
  actor_alias: string;
  delivery_id: string;
  message_id: string;
  recipient_alias: string;
  status: string;
  attempt: number;
}

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;

const guardTest = 'rejects databases outside the development and disposable-test namespaces';

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 180_000, [guardTest]);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

async function traffic(): Promise<SeedTrafficRow[]> {
  const result = await pool.query<SeedTrafficRow>(
    `SELECT m.actor_alias,d.recipient_alias,d.status,d.attempt,
            m.id::text AS message_id,d.id::text AS delivery_id
       FROM idempotency_keys i
       JOIN messages m ON m.id=i.message_id
       JOIN deliveries d ON d.message_id=m.id
      WHERE i.idempotency_key LIKE 'dev-seed:%'
      ORDER BY m.actor_alias,d.recipient_alias`,
  );
  return result.rows;
}

it(guardTest, () => {
  expect(() => {
    assertDevelopmentDatabaseUrl('postgresql://dev@localhost/cauce_dev');
  }).not.toThrow();
  expect(() => {
    assertDevelopmentDatabaseUrl('postgresql://test@localhost/cauce_test');
  }).not.toThrow();
  expect(() => {
    assertDevelopmentDatabaseUrl('postgresql://test@localhost/cauce_test_e123');
  }).not.toThrow();

  const unsafe = 'postgresql://operator:secret@db.internal/cauce_prod';
  expect(() => {
    assertDevelopmentDatabaseUrl(unsafe);
  }).toThrow('refusing to seed database "cauce_prod"');
  try {
    assertDevelopmentDatabaseUrl(unsafe);
  } catch (error) {
    expect(String(error)).not.toContain('operator:secret');
  }
});

it('seeds a real queue twice without duplicating effects or claiming terminal states', async () => {
  const logs: string[] = [];

  await expect(seedDevelopmentDatabase(database.url, (line) => logs.push(line))).resolves.toBe(1);
  const first = await traffic();
  expect(first.map(({ actor_alias, recipient_alias, status, attempt }) => (
    `${actor_alias}->${recipient_alias}:${status}:${String(attempt)}`
  ))).toEqual([
    'kant->zeus:leased:1',
    'kratos->zeus:pending:0',
    'zeus->kratos:pending:0',
  ]);

  await pool.query(
    `UPDATE connection_leases SET lease_until=now()-interval '1 second'
      WHERE tenant_id='Steven' AND alias='zeus' AND instance_id='dev-seed-consumer'`,
  );
  await expect(seedDevelopmentDatabase(database.url, (line) => logs.push(line))).resolves.toBe(0);
  const second = await traffic();
  expect(second).toEqual(first);

  const seedRows = await pool.query<{ messages: number; deliveries: number; wakes: number }>(
    `SELECT
       (SELECT count(*)::int FROM idempotency_keys WHERE idempotency_key LIKE 'dev-seed:%') AS messages,
       (SELECT count(*)::int FROM deliveries WHERE id=ANY($1::uuid[])) AS deliveries,
       (SELECT count(*)::int FROM adapter_outbox WHERE delivery_id=ANY($1::uuid[])) AS wakes`,
    [second.map((row) => row.delivery_id)],
  );
  expect(seedRows.rows[0]).toEqual({ messages: 3, deliveries: 3, wakes: 3 });

  const terminal = await pool.query<{ terminal: number; dead_letters: number }>(
    `SELECT
       (SELECT count(*)::int FROM deliveries
         WHERE id=ANY($1::uuid[]) AND status IN ('done','failed','retry','dead')) AS terminal,
       (SELECT count(*)::int FROM dead_letters WHERE delivery_id=ANY($1::uuid[])) AS dead_letters`,
    [second.map((row) => row.delivery_id)],
  );
  expect(terminal.rows[0]).toEqual({ terminal: 0, dead_letters: 0 });
  expect(logs).toContain('deliveries claimed by zeus: 1');
  expect(logs).toContain('seed traffic already initialized: no deliveries claimed');
});
