/**
 * Regression of quota ingest (`recordQuotaSample`).
 *
 * `quota_collections` declares `UNIQUE (collector_tenant, host, captured_at)` (migration 013) and
 * the INSERT said `ON CONFLICT (host,captured_at)`. Postgres does not accept an ON CONFLICT
 * specification that does not match a unique index: it throws 42P10 and aborts the transaction.
 * That meant EVERY POST /v3/quotas/samples returned an error, which is why production had empty
 * `quota_window_state` and zero samples in 72 h with the collector running.
 *
 * This matters for account rotation: without samples there is no exhaustion detection, and
 * without that the selector has no way to know a subscription ran out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const CAPTURED_AT = new Date().toISOString();

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM quota_window_state`);
  await pool.query(`DELETE FROM quota_collections`);
});

function sample(overrides: Partial<QuotaSampleRequest> = {}): QuotaSampleRequest {
  return {
    schema_version: 1,
    host: 'kratos',
    captured_at: CAPTURED_AT,
    providers: [{
      provider: 'claude',
      ok: true,
      available: true,
      available_groups: [],
      limiting_groups: [],
      windows: [{
        group_key: 'default',
        window_key: 'session',
        remaining_percent: 63
      }]
    }],
    ...overrides
  };
}

describe('ingesta de cuotas', () => {
  it('acepta una corrida del recolector', async () => {
    const result = await repository.recordQuotaSample('Steven', 'zeus', sample());

    expect(result.duplicate).toBe(false);
    expect(result.accepted_windows).toBe(1);

    // The materialized state was written: it is what the selector reads to detect exhaustion.
    const state = await pool.query<{ collector_tenant: string }>(
      `SELECT collector_tenant FROM quota_window_state`
    );
    expect(state.rowCount).toBe(1);
    expect(state.rows[0]?.collector_tenant).toBe('Steven');
  });

  it('un reintento del MISMO recolector es idempotente', async () => {
    const first = await repository.recordQuotaSample('Steven', 'zeus', sample());
    const second = await repository.recordQuotaSample('Steven', 'zeus', sample());

    expect(second.duplicate).toBe(true);
    expect(second.collection_id).toBe(first.collection_id);

    const collections = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM quota_collections`);
    expect(collections.rows[0]?.n).toBe(1);
  });

  it('dos tenants con el MISMO nombre de host no comparten fila ni se ven el collection_id', async () => {
    // The key carries collector_tenant precisely because `host` is a string declared by the
    // collector: without the tenant, the second POST would be a "duplicate" of the first and one
    // tenant would inherit the run — and the link to the accounts — from the other.
    const steven = await repository.recordQuotaSample('Steven', 'zeus', sample());
    const miguel = await repository.recordQuotaSample('Miguel', 'kratos', sample());

    expect(miguel.duplicate).toBe(false);
    expect(miguel.collection_id).not.toBe(steven.collection_id);

    const collections = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM quota_collections`);
    expect(collections.rows[0]?.n).toBe(2);
  });
});
