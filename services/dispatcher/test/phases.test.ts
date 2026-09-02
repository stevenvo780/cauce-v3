import type { DatabasePool } from '@cauce/store';
import { describe, expect, it } from 'vitest';
import { runDispatcher } from '../src/index.js';
import { DispatcherMetrics } from '../src/metrics.js';
import { PhaseGuard, phaseBackoffMs, type DispatcherPhase } from '../src/phases.js';

type PoisonablePhase = 'stale_deliveries' | 'expired_jobs' | 'claim_jobs';

const phaseStatements: Readonly<Record<PoisonablePhase, RegExp>> = {
  stale_deliveries: /FROM deliveries d JOIN messages m/,
  expired_jobs: /FROM jobs\s+WHERE status='running' AND lease_until<now\(\)/,
  claim_jobs: /INSERT INTO job_lane_fairness/,
};

function stubPool(poisoned: readonly PoisonablePhase[]): {
  pool: DatabasePool;
  attempts: PoisonablePhase[];
} {
  const attempts: PoisonablePhase[] = [];
  const query = async (statement: unknown): Promise<{ rows: never[]; rowCount: number }> => {
    if (typeof statement === 'string') {
      for (const phase of Object.keys(phaseStatements) as PoisonablePhase[]) {
        if (!phaseStatements[phase].test(statement)) continue;
        attempts.push(phase);
        if (poisoned.includes(phase)) throw new Error(`poisoned ${phase}`);
      }
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, on: () => client, off: () => client, release: () => undefined };
  return { pool: { query, connect: async () => client } as unknown as DatabasePool, attempts };
}

function failureSamples(exposition: string): Record<string, number> {
  const samples: Record<string, number> = {};
  for (const line of exposition.split('\n')) {
    const matched = /^cauce_dispatcher_phase_failures_total\{phase="([a-z_]+)"\} (\d+)$/.exec(line);
    if (matched?.[1] !== undefined) samples[matched[1]] = Number(matched[2]);
  }
  return samples;
}

async function tickOnce(pool: DatabasePool, metrics: DispatcherMetrics): Promise<unknown[]> {
  const errors: unknown[] = [];
  const dispatcher = runDispatcher(pool, {
    pollMs: 60_000,
    chainSweepMs: 0,
    retentionIntervalMs: 0,
    metrics,
    onError: (error) => { errors.push(error); },
  });
  try {
    await dispatcher.tick();
  } finally {
    dispatcher.stop();
  }
  return errors;
}

describe('aislamiento de fases del segador', () => {
  for (const poisoned of ['stale_deliveries', 'expired_jobs', 'claim_jobs'] as const) {
    it(`sigue ejecutando las demás fases cuando ${poisoned} falla, y cuenta el fallo`, async () => {
      const { pool, attempts } = stubPool([poisoned]);
      const metrics = new DispatcherMetrics(pool, () => 1_000);

      const errors = await tickOnce(pool, metrics);

      expect(attempts).toContain(poisoned);
      for (const other of ['stale_deliveries', 'expired_jobs', 'claim_jobs'] as const) {
        if (other !== poisoned) expect(attempts).toContain(other);
      }
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe(`poisoned ${poisoned}`);
      const samples = failureSamples(await metrics.render(false));
      expect(samples[poisoned]).toBe(1);
      expect(Object.values(samples).reduce((total, value) => total + value, 0)).toBe(1);
      expect(metrics.progress()).toMatchObject({ failedTicks: 1, ready: false });
    });
  }

  it('mantiene sanas las fases restantes mientras la envenenada espera su backoff', async () => {
    const { pool, attempts } = stubPool(['expired_jobs']);
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      metrics,
      onError: () => undefined,
    });

    try {
      for (let tick = 0; tick < 4; tick += 1) await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }

    const count = (phase: PoisonablePhase): number =>
      attempts.filter((candidate) => candidate === phase).length;
    expect(count('expired_jobs')).toBe(1);
    expect(count('stale_deliveries')).toBe(4);
    expect(count('claim_jobs')).toBe(4);
    expect(failureSamples(await metrics.render(false)).expired_jobs).toBe(1);
  });
});

describe('backoff exponencial por fase', () => {
  it('duplica el retardo desde el intervalo del tick y lo topa en cinco minutos', () => {
    expect(phaseBackoffMs(0, 250)).toBe(0);
    expect(phaseBackoffMs(1, 250)).toBe(250);
    expect(phaseBackoffMs(2, 250)).toBe(500);
    expect(phaseBackoffMs(3, 250)).toBe(1_000);
    expect(phaseBackoffMs(11, 250)).toBe(256_000);
    expect(phaseBackoffMs(12, 250)).toBe(300_000);
    expect(phaseBackoffMs(80, 250)).toBe(300_000);
  });

  it('salta la fase hasta que vence su espera y la reanuda tras un acierto', async () => {
    let now = 0;
    const observed: DispatcherPhase[] = [];
    const guard = new PhaseGuard({
      baseMs: 100,
      now: () => now,
      onFailure: (phase) => { observed.push(phase); },
    });
    const failing = async (): Promise<never> => { throw new Error('poisoned'); };

    expect(await guard.run('expired_jobs', failing)).toMatchObject({ status: 'failed' });
    now = 99;
    expect(await guard.run('expired_jobs', failing)).toEqual({ status: 'skipped' });
    now = 100;
    expect(await guard.run('expired_jobs', failing)).toMatchObject({ status: 'failed' });
    now = 199;
    expect(await guard.run('expired_jobs', failing)).toEqual({ status: 'skipped' });
    now = 300;
    expect(await guard.run('expired_jobs', async () => 'recovered')).toEqual({
      status: 'ok', value: 'recovered',
    });
    expect(await guard.run('expired_jobs', async () => 'again')).toEqual({
      status: 'ok', value: 'again',
    });
    expect(observed).toEqual(['expired_jobs', 'expired_jobs']);
    expect(guard.consecutiveFailures('expired_jobs')).toBe(0);
  });
});
