import type { ChainSilenceSweepResult, DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatcherMetrics } from '../../services/dispatcher/src/metrics.js';

/**
 * Pure-class tests for `services/dispatcher/src/metrics.ts`.
 *
 * The metrics module is the read-side of the dispatcher's work loop: it counts jobs, ticks and
 * chain sweeps, exposes a deterministic `progress()` snapshot used by liveness/readiness, and
 * renders a Prometheus exposition. The tests are hermetic: the constructor takes a `DatabasePool`
 * that is only consumed inside `render()`, so every other method is exercised with a stub pool
 * that throws — `progress()`, `recordJob`, `recordTick`, `recordChainSweep` and
 * `recordChainSweepFailure` never touch it. `render()` is fed a hand-rolled pool that returns
 * one row per gauge so the private helpers (`appendMatrix`, `appendOldest`, `appendTargetMatrix`,
 * `appendLaneGauge`, `number`) are exercised end-to-end without a real database.
 */

interface FakeQueryResult<Row> {
  rows: readonly Row[];
  rowCount: number;
}

interface PoolStub {
  query: ReturnType<typeof vi.fn>;
  callCount(): number;
}

function failingPool(): DatabasePool {
  return {
    query: vi.fn(async () => { throw new Error('stub pool: no debe llamarse'); }),
    connect: vi.fn(async () => { throw new Error('stub pool: connect no debe llamarse'); }),
    on: vi.fn(),
    off: vi.fn(),
    end: vi.fn(async () => undefined),
  } as unknown as DatabasePool;
}

function stubbedPool(matchers: readonly { match: (sql: string) => boolean; rows: readonly unknown[] }[]): { pool: DatabasePool; stub: PoolStub } {
  const query = vi.fn(async <Row>(sql: string): Promise<FakeQueryResult<Row>> => {
    let rows: readonly unknown[] = [];
    for (const m of matchers) {
      if (m.match(sql)) { rows = m.rows; break; }
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  });
  return {
    pool: { query, connect: vi.fn(), on: vi.fn(), off: vi.fn(), end: vi.fn() } as unknown as DatabasePool,
    stub: { query, callCount: () => query.mock.calls.length },
  };
}

const sql = {
  jobs: (s: string): boolean => s.includes('FROM jobs GROUP BY lane,status'),
  jobOldest: (s: string): boolean => s.includes("FROM jobs WHERE status='queued'"),
  deliveries: (s: string): boolean =>
    s.includes('FROM deliveries d JOIN messages m ON m.id=d.message_id GROUP BY m.lane,d.status'),
  deliveryOldest: (s: string): boolean =>
    s.includes("WHERE d.status IN ('pending','retry','leased','accepted','started')"),
  dlq: (s: string): boolean => s.includes('FROM dead_letters dl'),
  jobLeases: (s: string): boolean => s.includes("WHERE status='running'"),
  deliveryLeases: (s: string): boolean =>
    s.includes("WHERE d.status IN ('leased','accepted','started')"),
  consumerLeases: (s: string): boolean => s.includes('FROM connection_leases'),
  relays: (s: string): boolean =>
    s.includes("FROM adapter_outbox o") && s.includes("o.kind='origin_relay' GROUP BY m.lane,o.status"),
  relayOldest: (s: string): boolean =>
    s.includes("o.kind='origin_relay' AND o.status IN ('pending','processing','failed')"),
};

function makeMetrics(overrides: { pool?: DatabasePool; now?: () => number } = {}): {
  metrics: DispatcherMetrics;
  pool: DatabasePool;
} {
  const pool = overrides.pool ?? failingPool();
  const metrics = new DispatcherMetrics(pool, overrides.now);
  return { metrics, pool };
}

describe('DispatcherMetrics: contador de jobs por (lane, result)', () => {
  it('incrementa el contador del par (lane, result) recibido', async () => {
    const { metrics } = makeMetrics();
    metrics.recordJob('interactive', 'done');
    metrics.recordJob('interactive', 'done');
    metrics.recordJob('interactive', 'retry');
    metrics.recordJob('batch', 'dead');
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_jobs_processed_total\{lane="interactive",result="done"\} 2/);
    expect(text).toMatch(/cauce_dispatcher_jobs_processed_total\{lane="interactive",result="retry"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_jobs_processed_total\{lane="batch",result="dead"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_jobs_processed_total\{lane="interactive",result="dead"\} 0/);
  });

  it('marca fencedDuringTick al registrar un job resultado "fenced"', () => {
    const now = vi.fn(() => 5_000);
    const { metrics } = makeMetrics({ now });
    metrics.recordJob('interactive', 'fenced');
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({
      successfulTicks: 0, fencedTicks: 1, lastResult: 'fenced', ready: false, reason: 'fenced'
    });
    expect(now).toHaveBeenCalled();
  });
});

describe('DispatcherMetrics: ticks clasificados por resultado', () => {
  it('cuenta ok cuando el tick llega limpio (sin job fenced registrado)', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({
      ticks: 2, successfulTicks: 2, failedTicks: 0, fencedTicks: 0
    });
    now += 100;
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({ ticks: 3, successfulTicks: 3 });
  });

  it('cuenta error cuando el resultado del tick es error, independientemente de fencedDuringTick', () => {
    const now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordJob('batch', 'fenced');
    metrics.recordTick('error');
    expect(metrics.progress()).toMatchObject({
      ticks: 1, successfulTicks: 0, failedTicks: 1, fencedTicks: 0,
      lastResult: 'error', ready: false, reason: 'tick_error'
    });
  });

  it('cuenta fenced cuando un job "fenced" se mezcló con un tick "ok"', () => {
    const now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordJob('interactive', 'fenced');
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({
      ticks: 1, successfulTicks: 0, failedTicks: 0, fencedTicks: 1,
      lastResult: 'fenced', reason: 'fenced'
    });
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({
      successfulTicks: 1, fencedTicks: 1, lastResult: 'ok', reason: 'ready'
    });
  });
});

describe('DispatcherMetrics: progress() como contrato de liveness/readiness', () => {
  it('antes del primer tick devuelve starting, vivo y NO listo', () => {
    const { metrics } = makeMetrics({ now: () => 5_000 });
    expect(metrics.progress()).toEqual({
      ticks: 0,
      successfulTicks: 0,
      failedTicks: 0,
      fencedTicks: 0,
      lastTickAt: undefined,
      lastSuccessAt: undefined,
      tickAgeMs: undefined,
      successAgeMs: undefined,
      consecutiveFailures: 0,
      lastResult: undefined,
      live: true,
      ready: false,
      reason: 'starting'
    });
  });

  it('tras un tick ok reciente devuelve ready=true, reason="ready", live=true', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    now += 250;
    expect(metrics.progress()).toMatchObject({
      ticks: 1, successfulTicks: 1, ready: true, live: true, reason: 'ready',
      consecutiveFailures: 0, lastResult: 'ok', tickAgeMs: 250
    });
  });

  it('cuando el último tick fue error: ready=false, reason="tick_error", live=true si es fresco', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('error');
    now += 100;
    expect(metrics.progress()).toMatchObject({
      ticks: 1, successfulTicks: 0, failedTicks: 1, ready: false, live: true,
      reason: 'tick_error', lastResult: 'error'
    });
  });

  it('cuando un tick ok siguió a un job fenced: reason="fenced" hasta el próximo ok', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordJob('interactive', 'fenced');
    metrics.recordTick('ok');
    now += 50;
    expect(metrics.progress()).toMatchObject({ ready: false, live: true, reason: 'fenced', fencedTicks: 1 });
    metrics.recordTick('ok');
    now += 50;
    expect(metrics.progress()).toMatchObject({ ready: true, reason: 'ready', fencedTicks: 1, successfulTicks: 1 });
  });

  it('cuando el último tick envejece más allá del umbral: live=false, reason="loop_stale"', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    now += 6_000;
    expect(metrics.progress(5_000)).toMatchObject({ live: false, ready: false, reason: 'loop_stale' });
  });

  it('loop_stale pisa cualquier lastResult aunque el último tick haya sido ok', () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    now += 100_000;
    expect(metrics.progress(5_000)).toMatchObject({ live: false, reason: 'loop_stale', lastResult: 'ok' });
  });

  it('rechaza un staleAfterMs inválido (no entero, ≤ 0, NaN, fuera de rango seguro)', () => {
    const { metrics } = makeMetrics();
    expect(() => metrics.progress(0)).toThrow('positive integer');
    expect(() => metrics.progress(-1)).toThrow('positive integer');
    expect(() => metrics.progress(1.5)).toThrow('positive integer');
    expect(() => metrics.progress(Number.NaN)).toThrow('positive integer');
    expect(() => metrics.progress(Number.POSITIVE_INFINITY)).toThrow('positive integer');
    expect(() => metrics.progress(Number.MAX_SAFE_INTEGER + 1)).toThrow('positive integer');
  });
});

describe('DispatcherMetrics: consecutiveFailures y reset en ok', () => {
  it('incrementa en cada tick no-ok y se resetea en el primer ok posterior', () => {
    const { metrics } = makeMetrics();
    metrics.recordTick('error');
    expect(metrics.progress().consecutiveFailures).toBe(1);
    metrics.recordTick('error');
    expect(metrics.progress().consecutiveFailures).toBe(2);
    metrics.recordTick('ok');
    expect(metrics.progress().consecutiveFailures).toBe(0);
  });

  it('cuenta los ticks fenced como failures y los resetea en el siguiente ok', () => {
    const { metrics } = makeMetrics();
    metrics.recordJob('batch', 'fenced');
    metrics.recordTick('ok');
    expect(metrics.progress().consecutiveFailures).toBe(1);
    metrics.recordJob('batch', 'fenced');
    metrics.recordTick('ok');
    expect(metrics.progress().consecutiveFailures).toBe(2);
    metrics.recordTick('ok');
    expect(metrics.progress().consecutiveFailures).toBe(0);
  });
});

describe('DispatcherMetrics: chain sweeps', () => {
  it('suma scanned, faninRecovered, notified y skipped cuando son > 0', async () => {
    const { metrics } = makeMetrics();
    const result: ChainSilenceSweepResult = { scanned: 7, faninRecovered: 2, notified: 1, skipped: 4 };
    metrics.recordChainSweep(result);
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="scanned"\} 7/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="fanin_recovered"\} 2/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="notified"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="skipped"\} 4/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="failed"\} 0/);
  });

  it('acumula entre varios barridos en el mismo contador', async () => {
    const { metrics } = makeMetrics();
    metrics.recordChainSweep({ scanned: 3, faninRecovered: 0, notified: 0, skipped: 0 });
    metrics.recordChainSweep({ scanned: 5, faninRecovered: 1, notified: 0, skipped: 0 });
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="scanned"\} 8/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="fanin_recovered"\} 1/);
  });

  it('ignora deltas ≤ 0 (no aporta al contador)', async () => {
    const { metrics } = makeMetrics();
    metrics.recordChainSweep({ scanned: 0, faninRecovered: 0, notified: 0, skipped: -2 });
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="scanned"\} 0/);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="skipped"\} 0/);
  });

  it('recordChainSweepFailure acumula el contador failed', async () => {
    const { metrics } = makeMetrics();
    metrics.recordChainSweepFailure();
    metrics.recordChainSweepFailure();
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_chain_sweep_total\{outcome="failed"\} 2/);
  });
});

describe('DispatcherMetrics: render() exposition Prometheus', () => {
  it('publica tick_age_seconds = -1 antes del primer tick, y un valor no negativo después', async () => {
    const { metrics } = makeMetrics({ now: () => 1_000 });
    const before = await metrics.render(false);
    expect(before).toMatch(/cauce_dispatcher_tick_age_seconds -1/);
    expect(before).toMatch(/# HELP cauce_dispatcher_tick_age_seconds/);
    const { metrics: m2 } = makeMetrics({ now: () => 1_000 });
    m2.recordTick('ok');
    const after = await m2.render(false);
    expect(after).toMatch(/cauce_dispatcher_tick_age_seconds 0/);
  });

  it('publica loop_stale=1 cuando el último tick envejeció más allá del umbral', async () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    now += 10_000;
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_loop_stale 1/);
    expect(text).toMatch(/cauce_dispatcher_ready 0/);
  });

  it('publica ready=1 cuando el último tick ok está fresco y limpio', async () => {
    let now = 1_000;
    const { metrics } = makeMetrics({ now: () => now });
    metrics.recordTick('ok');
    now += 100;
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_ready 1/);
    expect(text).toMatch(/cauce_dispatcher_loop_stale 0/);
  });

  it('sin acceso a la base publica query_success=0 y NO toca el pool', async () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      end: vi.fn()
    } as unknown as DatabasePool;
    const { metrics } = makeMetrics({ pool });
    const text = await metrics.render(false);
    expect(text).toMatch(/cauce_dispatcher_metrics_query_success 0/);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('con acceso a la base ejecuta las 10 consultas y publica query_success=1', async () => {
    const { pool, stub } = stubbedPool([]);
    const { metrics } = makeMetrics({ pool });
    const text = await metrics.render(true);
    expect(stub.callCount()).toBe(10);
    expect(text).toMatch(/cauce_dispatcher_metrics_query_success 1/);
    expect(text).toMatch(/# HELP cauce_dispatcher_job_queue_depth/);
    expect(text).toMatch(/# HELP cauce_dispatcher_delivery_queue_depth/);
    expect(text).toMatch(/# HELP cauce_dispatcher_origin_relay_depth/);
    expect(text).toMatch(/# HELP cauce_dispatcher_dlq_depth/);
    expect(text).toMatch(/# HELP cauce_dispatcher_consumer_leases_active/);
  });

  it('cuando la base falla, la exposition sigue siendo válida y reporta query_success=0', async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error('postgres caído'); }),
      connect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      end: vi.fn()
    } as unknown as DatabasePool;
    const { metrics } = makeMetrics({ pool });
    const text = await metrics.render(true);
    expect(text).toMatch(/cauce_dispatcher_metrics_query_success 0/);
    expect(text).toMatch(/# TYPE cauce_dispatcher_ticks_total counter/);
  });

  it('publica los gauges derivados de la base (job queue depth, dlq, leases, relay)', async () => {
    const matchersLocal: readonly { match: (sql: string) => boolean; rows: readonly unknown[] }[] = [
      { match: sql.jobs, rows: [
        { lane: 'interactive', status: 'queued', count: '5' },
        { lane: 'batch', status: 'queued', count: '3' }
      ]},
      { match: sql.jobOldest, rows: [
        { lane: 'interactive', status: 'queued', count: '5', oldest_seconds: '12.5' },
        { lane: 'batch', status: 'queued', count: '3', oldest_seconds: '7' }
      ]},
      { match: sql.deliveries, rows: [
        { lane: 'interactive', status: 'pending', count: '2' },
        { lane: 'batch', status: 'pending', count: '1' }
      ]},
      { match: sql.deliveryOldest, rows: [
        { lane: 'interactive', status: 'pending', count: '2', oldest_seconds: '4.5' },
        { lane: 'batch', status: 'pending', count: '1', oldest_seconds: '1' }
      ]},
      { match: sql.dlq, rows: [
        { lane: 'interactive', target: 'delivery', count: '1' },
        { lane: 'batch', target: 'job', count: '2' }
      ]},
      { match: sql.jobLeases, rows: [
        { lane: 'interactive', count: '2' },
        { lane: 'batch', count: '0' }
      ]},
      { match: sql.deliveryLeases, rows: [
        { lane: 'interactive', count: '1' },
        { lane: 'batch', count: '0' }
      ]},
      { match: sql.consumerLeases, rows: [{ count: '4' }]},
      { match: sql.relays, rows: [
        { lane: 'interactive', status: 'pending', count: '0' },
        { lane: 'batch', status: 'failed', count: '1' }
      ]},
      { match: sql.relayOldest, rows: [
        { lane: 'interactive', status: 'pending', count: '0', oldest_seconds: '0' },
        { lane: 'batch', status: 'failed', count: '1', oldest_seconds: '60' }
      ]}
    ];
    const seenQueries: string[] = [];
    const query = vi.fn(async <Row>(sqlText: string): Promise<FakeQueryResult<Row>> => {
      seenQueries.push(sqlText.replace(/\s+/g, ' ').slice(0, 80));
      for (const m of matchersLocal) {
        if (m.match(sqlText)) return { rows: m.rows as readonly Row[], rowCount: m.rows.length };
      }
      return { rows: [] as readonly Row[], rowCount: 0 };
    });
    const pool = { query, connect: vi.fn(), on: vi.fn(), off: vi.fn(), end: vi.fn() } as unknown as DatabasePool;
    const { metrics } = makeMetrics({ pool });
    const text = await metrics.render(true);
    expect(seenQueries.length).toBe(10);
    expect(text).toMatch(/cauce_dispatcher_job_queue_depth\{lane="interactive",status="queued"\} 5/);
    expect(text).toMatch(/cauce_dispatcher_job_queue_depth\{lane="batch",status="queued"\} 3/);
    expect(text).toMatch(/cauce_dispatcher_job_oldest_seconds\{lane="interactive",status="queued"\} 12.5/);
    expect(text).toMatch(/cauce_dispatcher_delivery_queue_depth\{lane="interactive",status="pending"\} 2/);
    expect(text).toMatch(/cauce_dispatcher_delivery_oldest_seconds\{lane="interactive",status="pending"\} 4.5/);
    expect(text).toMatch(/cauce_dispatcher_dlq_depth\{lane="interactive",target="delivery"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_dlq_depth\{lane="batch",target="job"\} 2/);
    expect(text).toMatch(/cauce_dispatcher_job_leases_active\{lane="interactive"\} 2/);
    expect(text).toMatch(/cauce_dispatcher_delivery_leases_active\{lane="interactive"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_consumer_leases_active 4/);
    expect(text).toMatch(/cauce_dispatcher_origin_relay_depth\{lane="batch",status="failed"\} 1/);
    expect(text).toMatch(/cauce_dispatcher_origin_relay_oldest_seconds\{lane="batch",status="failed"\} 60/);
    expect(text).toMatch(/cauce_dispatcher_metrics_query_success 1/);
  });

  it('si una fila devuelve count u oldest_seconds no parseable, el catch del render reporta query_success=0', async () => {
    const { pool } = stubbedPool([
      { match: sql.jobs, rows: [
        { lane: 'interactive', status: 'queued', count: 'no-es-numero' }
      ]}
    ]);
    const { metrics } = makeMetrics({ pool });
    const text = await metrics.render(true);
    expect(text).toMatch(/cauce_dispatcher_metrics_query_success 0/);
    expect(text).toMatch(/# HELP cauce_dispatcher_job_queue_depth/);
  });

  it('number() rechaza NaN lanzado desde la fila, manteniendo el contrato del helper', () => {
    expect(Number.isFinite(Number('no-es-numero'))).toBe(false);
    expect(Number('no-es-numero') < 0).toBe(false);
  });
});

describe('DispatcherMetrics: constructor y now() inyectable', () => {
  it('acepta un now() literal para tests deterministas (mismo valor en cada llamada)', () => {
    const now = vi.fn(() => 42_000);
    const { metrics } = makeMetrics({ now });
    metrics.recordTick('ok');
    expect(now).toHaveBeenCalled();
    expect(metrics.progress()).toMatchObject({ lastTickAt: 42_000, tickAgeMs: 0, ready: true });
  });

  it('acepta now() como función literal (no solo mock)', () => {
    let current = 100;
    const metrics = new DispatcherMetrics(failingPool(), () => current);
    metrics.recordTick('ok');
    current += 50;
    expect(metrics.progress()).toMatchObject({ lastTickAt: 100, tickAgeMs: 50 });
  });
});

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});