import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { FleetReadModel } from './fleet-read-model.js';

interface QueryStep {
  readonly match: RegExp;
  readonly rows: readonly Record<string, unknown>[];
}

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A deterministic Pool double. The real PostgreSQL/MCP wire is covered by
 * tests/integration/mcp-fleet-monitor-tools.test.ts; these tests pin every mapping and selector
 * without turning missing DATABASE_URL into seven silent skips.
 */
function scriptedPool(...steps: readonly QueryStep[]): {
  readonly pool: DatabasePool;
  readonly calls: QueryCall[];
} {
  const pending = [...steps];
  const calls: QueryCall[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const step = pending.shift();
    if (!step) throw new Error(`unexpected query: ${sql}`);
    expect(sql).toMatch(step.match);
    return { rows: [...step.rows] };
  };
  return { pool: { query } as unknown as DatabasePool, calls };
}

describe('FleetReadModel', () => {
  it('lists enabled catalog aliases even before they have a delivery or lease', async () => {
    const future = new Date('2099-01-01T00:00:00.000Z');
    const activity = new Date('2026-08-25T12:00:00.000Z');
    const fake = scriptedPool({
      match: /SELECT alias FROM agents[\s\S]*enabled = true/u,
      rows: [{
        alias: 'kant', active_instance_id: 'instance-1', lease_expires_at: future,
        epoch: '7', last_activity: activity,
      }],
    });

    const result = await new FleetReadModel(fake.pool, 'Steven').fleetStatus('kant');

    expect(fake.calls[0]?.params).toEqual(['Steven', 'kant']);
    expect(result).toEqual({
      available: true,
      data: [{
        alias: 'kant', active_instance_id: 'instance-1', lease_alive: true, epoch: 7,
        lease_expires_at: future.toISOString(), last_activity: activity.toISOString(),
        available: true,
      }],
    });
  });

  it('maps deliveries and clamps the public limit', async () => {
    const createdAt = new Date('2026-08-25T12:00:00.000Z');
    const fake = scriptedPool({
      match: /FROM deliveries d/u,
      rows: [{
        id: 'delivery-1', message_id: 'message-1', recipient_alias: 'kant', status: 'done',
        attempt: 1, max_attempts: 3, created_at: createdAt, root_message_id: 'root-1',
      }],
    });

    const result = await new FleetReadModel(fake.pool, 'Steven').deliveries('kant', 'done', 50_000);

    expect(fake.calls[0]?.params).toEqual(['Steven', 'kant', 'done', 1_000]);
    expect(result.data[0]).toMatchObject({
      id: 'delivery-1', status: 'done', root_message_id: 'root-1',
      created_at: createdAt.toISOString(), available: true,
    });
  });

  it('follows a root message and preserves the durable hop_count instead of the array index', async () => {
    const createdAt = new Date('2026-08-25T12:00:00.000Z');
    const fake = scriptedPool({
      match: /correlation->>'root_message_id' = \$2/u,
      rows: [{
        hop_count: 7, source_alias: 'kant', source_tenant: 'Steven', target_alias: 'socrates',
        target_tenant: 'Steven', status: 'materialized', created_at: createdAt,
        rejection_code: null,
      }],
    });

    const result = await new FleetReadModel(fake.pool, 'Steven').chain(undefined, 'root-1');

    expect(fake.calls[0]?.params).toEqual([null, 'root-1', 'Steven']);
    expect(result).toMatchObject({
      available: true,
      root_message_id: 'root-1',
      data: [{ hop: 7, source_alias: 'kant', target_alias: 'socrates' }],
    });
    expect(result).not.toHaveProperty('trace_id');
  });

  it('uses trace_id when both chain selectors are present', async () => {
    const fake = scriptedPool({ match: /aom\.trace_id = \$1/u, rows: [] });
    const result = await new FleetReadModel(fake.pool, 'Steven').chain('trace-1', 'root-1');
    expect(fake.calls[0]?.params).toEqual(['trace-1', 'root-1', 'Steven']);
    expect(result).toEqual({ data: [], available: true, trace_id: 'trace-1' });
  });

  it('scopes the chain to the caller tenant so a cross-tenant delegation does not leak', async () => {
    const fake = scriptedPool({
      match: /source_tenant = \$3 OR aom\.target_tenant = \$3/u,
      rows: [],
    });

    await new FleetReadModel(fake.pool, 'Miguel').chain('trace-1');

    expect(fake.calls[0]?.params).toEqual(['trace-1', null, 'Miguel']);
  });

  it('does not query when chain has no selector', async () => {
    const fake = scriptedPool();
    await expect(new FleetReadModel(fake.pool, 'Steven').chain()).resolves.toEqual({
      data: [], available: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it('normalizes PostgreSQL bigint dead-letter counts and returns recent examples', async () => {
    const createdAt = new Date('2026-08-25T12:00:00.000Z');
    const fake = scriptedPool(
      { match: /GROUP BY aom\.rejection_code/u, rows: [{ rejection_code: 'target_absent', count: '2' }] },
      { match: /LIMIT 3/u, rows: [{
        id: 'delivery-1', recipient_alias: 'missing', created_at: createdAt,
        rejection_code: 'target_absent',
      }] },
    );

    const result = await new FleetReadModel(fake.pool, 'Steven').deadLetters();

    expect(result).toEqual({
      available: true,
      data: [{
        cause: 'target_absent', count: 2,
        recent_examples: [{
          delivery_id: 'delivery-1', alias: 'missing', created_at: createdAt.toISOString(),
          rejection_code: 'target_absent',
        }],
      }],
    });
  });

  it('computes health from enabled agents and terminal delivery outcomes', async () => {
    const fake = scriptedPool(
      { match: /FROM agents agent/u, rows: [{ live: '2', total: '2' }] },
      { match: /GROUP BY status/u, rows: [
        { status: 'done', count: '10' },
        { status: 'pending', count: '200' },
      ] },
    );

    const result = await new FleetReadModel(fake.pool, 'Steven').health();

    expect(result.summary).toBe('Flota: 2 alias, 2 vivos (healthy), 100% entregas OK');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });

  it('fails closed on malformed database counters', async () => {
    const fake = scriptedPool({ match: /FROM agents agent/u, rows: [{ live: 'NaN', total: '2' }] });
    await expect(new FleetReadModel(fake.pool, 'Steven').health()).rejects.toThrow(
      /health read model query failed: live alias count/u,
    );
  });

  it('labels query failures with the tool that became unavailable', async () => {
    const pool = {
      query: async () => { throw new Error('database offline'); },
    } as unknown as DatabasePool;
    await expect(new FleetReadModel(pool, 'Steven').fleetStatus()).rejects.toThrow(
      'fleet_status read model query failed: database offline',
    );
  });
});
