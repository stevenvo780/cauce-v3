import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { PostgresShadowRepository } from '../src/repository.js';
import type { ShadowEnvelope } from '../src/types.js';

function poolWithQuery(
  operation: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>,
): DatabasePool {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return operation(sql);
    }),
    release: vi.fn(),
  });
  return { connect: vi.fn(async () => client) } as unknown as DatabasePool;
}

describe('PostgresShadowRepository health', () => {
  it('reports durable failed/dead/processing rows with bounded numeric parsing', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("status='failed'");
      expect(sql).toContain("status='dead'");
      expect(sql).toContain("status='processing'");
      expect(sql).toContain("status='pending'");
      return { rows: [{
        pending: '4', failed: '2', dead: '1', processing: '3', owned_processing: '1',
        oldest_ready_seconds: '12.5',
      }], rowCount: 1 };
    });
    const repository = new PostgresShadowRepository(poolWithQuery(query));
    await expect(repository.health()).resolves.toEqual({
      pending: 4, failed: 2, dead: 1, processing: 3, owned_processing: 1,
      orphaned_processing: 2, oldest_ready_seconds: 12.5,
    });
    expect(query.mock.calls[0]?.[0]).toContain('claim_expires_at>now()');
  });

  it('fails closed when PostgreSQL returns a missing or invalid aggregate', async () => {
    const pool = poolWithQuery(vi.fn(async () => ({ rows: [{
        pending: '0', failed: '-1', dead: '0', processing: '0', owned_processing: '0',
        oldest_ready_seconds: '0',
      }], rowCount: 1 })));
    await expect(new PostgresShadowRepository(pool).health()).rejects.toThrow('invalid counts');
  });

  it('tears down a hung health query within the shutdown budget', async () => {
    let rejectQuery: ((error: Error) => void) | undefined;
    let enteredQuery: (() => void) | undefined;
    const queryEntered = new Promise<void>((resolve) => { enteredQuery = resolve; });
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn((sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: 0 });
        enteredQuery?.();
        return new Promise((_resolve, reject) => { rejectQuery = reject; });
      }),
      release: vi.fn((destroy?: boolean) => {
        if (destroy) rejectQuery?.(new Error('client destroyed'));
      }),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const controller = new AbortController();
    const operation = new PostgresShadowRepository(pool).health(controller.signal);
    await queryEntered;
    const started = performance.now();

    controller.abort(new Error('shutdown'));

    await expect(operation).rejects.toThrow('shutdown');
    expect(performance.now() - started).toBeLessThan(250);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('tears down a hung mapping begin before it can cross the target boundary', async () => {
    let rejectQuery: ((error: Error) => void) | undefined;
    let enteredInsert: (() => void) | undefined;
    const insertEntered = new Promise<void>((resolve) => { enteredInsert = resolve; });
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn((sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: 0 });
        enteredInsert?.();
        return new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
      }),
      release: vi.fn((destroy?: boolean) => {
        if (destroy) rejectQuery?.(new Error('client destroyed'));
      }),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;
    const envelope: ShadowEnvelope = {
      direction: 'v2-to-v3',
      source_event_id: 'source-1',
      tenant_id: 'Steven',
      correlation: { request_id: 'request-1', trace_id: 'trace-1' },
      payload: {},
      expects_human_reply: false,
    };
    const controller = new AbortController();
    const operation = new PostgresShadowRepository(pool).begin(envelope, 'shadow', controller.signal);
    await insertEntered;
    const started = performance.now();

    controller.abort(new Error('shutdown-before-target'));

    await expect(operation).rejects.toThrow('shutdown-before-target');
    expect(performance.now() - started).toBeLessThan(250);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
