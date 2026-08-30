import { afterEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import type { FastifyInstance } from 'fastify';
import {
  buildLoopbackHealthProbe,
  renderConsolePublishMetrics,
  renderWakePumpMetrics,
} from '../../services/gateway/src/health.js';
import { ConsolePublishTelemetry } from '../../services/gateway/src/console-publish-telemetry.js';
import { WakePumpTelemetry } from '../../services/gateway/src/wake-pump-telemetry.js';

/**
 * Tests for `services/gateway/src/health.ts`.
 *
 * `health.ts` exports three things that don't need a real Postgres:
 *   * `renderWakePumpMetrics` / `renderConsolePublishMetrics` — pure Prometheus formatters.
 *   * `buildLoopbackHealthProbe` + `registerHealthRoutes` — a tiny Fastify app exposing
 *     `/health/live`, `/health/ready` and (optionally) `/metrics`.
 *
 * Every branch of `readiness` is exercised here by driving `/health/ready` through
 * `app.inject` with controlled probes and a fake `DatabasePool`. None of these tests need
 * Postgres because the readiness function checks results, not rows: a `{ rows: [] }` reply is
 * enough to satisfy SELECT 1, and each per-schema probe is stubbed via its `*Probe` option.
 *
 * Coverage targets the file as a whole; the per-schema `probe*Path` re-exports already have
 * dedicated tests in `services/gateway/src/health-progress.test.ts` and friends.
 */

const answeringPool: DatabasePool = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as DatabasePool;

const tlsOffPool: DatabasePool = {
  query: async (sql: string) => {
    if (sql.includes('pg_stat_ssl')) return { rows: [{ ssl: false }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
} as unknown as DatabasePool;

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

function listeningDataApp(): Pick<FastifyInstance, 'server'> {
  return { server: { listening: true } as never };
}

describe('renderWakePumpMetrics', () => {
  it('emite el vocabulario fijo de estados, contadores y outcomes, sin labels de identidad', () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.markClaimed();
    telemetry.recordOutcome('sent');
    telemetry.finishCycle();

    const text = renderWakePumpMetrics(telemetry);

    expect(text).toMatch(/^# HELP cauce_gateway_wake_pump_state[\s\S]+\n$/u);
    expect(text).toContain('cauce_gateway_wake_pump_state{state="idle"} 1');
    expect(text).toContain('cauce_gateway_wake_pump_state{state="running"} 0');
    expect(text).toContain('cauce_gateway_wake_pump_state{state="stopping"} 0');
    expect(text).toContain('cauce_gateway_wake_pump_cycles_total 1');
    expect(text).toContain('cauce_gateway_wake_pump_claimed_total 1');
    expect(text).toContain('cauce_gateway_wake_pump_outcomes_total{result="sent"} 1');
    expect(text).toContain('cauce_gateway_wake_pump_outcomes_total{result="retry"} 0');
    expect(text).not.toMatch(/tenant_id|tenant=|alias=|event_id|claim_token/u);
  });

  it('rechaza un estado desconocido en la snapshot', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'paused' as 'idle',
        lastProgressAtMs: null,
        lastSuccessAtMs: null,
        consecutiveFailures: 0,
        counters: { cycles: 0, claimed: 0, sent: 0, retry: 0, dead: 0, fenced: 0, error: 0, cancelled: 0 },
      }),
    })).toThrow(/invalid state/u);
  });

  it('rechaza lastProgressAtMs negativo', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'idle',
        lastProgressAtMs: -1,
        lastSuccessAtMs: null,
        consecutiveFailures: 0,
        counters: { cycles: 0, claimed: 0, sent: 0, retry: 0, dead: 0, fenced: 0, error: 0, cancelled: 0 },
      }),
    })).toThrow(/invalid progress timestamp/u);
  });

  it('rechaza lastSuccessAtMs = Infinity', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'idle',
        lastProgressAtMs: null,
        lastSuccessAtMs: Number.POSITIVE_INFINITY,
        consecutiveFailures: 0,
        counters: { cycles: 0, claimed: 0, sent: 0, retry: 0, dead: 0, fenced: 0, error: 0, cancelled: 0 },
      }),
    })).toThrow(/invalid success timestamp/u);
  });

  it('rechaza un counter negativo en cycles', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'idle',
        lastProgressAtMs: null,
        lastSuccessAtMs: null,
        consecutiveFailures: 0,
        counters: { cycles: -1, claimed: 0, sent: 0, retry: 0, dead: 0, fenced: 0, error: 0, cancelled: 0 },
      }),
    })).toThrow(/invalid cycles counter/u);
  });

  it('rechaza consecutiveFailures que no es entero seguro', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'idle',
        lastProgressAtMs: null,
        lastSuccessAtMs: null,
        consecutiveFailures: 1.5,
        counters: { cycles: 0, claimed: 0, sent: 0, retry: 0, dead: 0, fenced: 0, error: 0, cancelled: 0 },
      }),
    })).toThrow(/invalid consecutive failures counter/u);
  });
});

describe('renderConsolePublishMetrics', () => {
  it('emite una línea por cada combinación operación:resultado del vocabulario fijo', () => {
    const telemetry = new ConsolePublishTelemetry();
    telemetry.record({ operation: 'prepare', result: 'prepared' });
    telemetry.record({ operation: 'publish', result: 'committed' });
    telemetry.record({ operation: 'confirm', result: 'confirmed' });
    const text = renderConsolePublishMetrics(telemetry);

    expect(text).toContain('cauce_gateway_console_publish_operations_total{operation="prepare",result="prepared"} 1');
    expect(text).toContain('cauce_gateway_console_publish_operations_total{operation="prepare",result="committed"} 0');
    expect(text).toContain('cauce_gateway_console_publish_operations_total{operation="publish",result="committed"} 1');
    expect(text).toContain('cauce_gateway_console_publish_operations_total{operation="confirm",result="confirmed"} 1');
  });

  it('rechaza una snapshot con un counter ajeno al vocabulario', () => {
    const snapshot = {
      'prepare:prepared': 0, 'prepare:committed': 0, 'prepare:reconciliation_required': 0,
      'prepare:rate_limited': 0, 'prepare:error': 0, 'publish:committed': 0, 'publish:expired': 0,
      'publish:error': 0, 'confirm:confirmed': 0, 'confirm:error': 0,
      'smuggled:counter': 1,
    };
    expect(() => renderConsolePublishMetrics({ snapshot: () => snapshot }))
      .toThrow(/unknown counter/u);
  });

  it('rechaza una snapshot con menos claves que el vocabulario', () => {
    expect(() => renderConsolePublishMetrics({
      snapshot: () => ({ 'prepare:prepared': 0 }),
    })).toThrow(/unknown counter/u);
  });

  it('rechaza un counter que no es entero no negativo', () => {
    expect(() => renderConsolePublishMetrics({
      snapshot: () => ({
        'prepare:prepared': -1, 'prepare:committed': 0, 'prepare:reconciliation_required': 0,
        'prepare:rate_limited': 0, 'prepare:error': 0, 'publish:committed': 0, 'publish:expired': 0,
        'publish:error': 0, 'confirm:confirmed': 0, 'confirm:error': 0,
      }),
    })).toThrow(/invalid console publish prepare:prepared counter/u);
  });
});

describe('buildLoopbackHealthProbe / registerHealthRoutes', () => {
  it('responde 200 {status: live} en /health/live incluso si Postgres está caído', async () => {
    const down: DatabasePool = {
      query: async () => { throw new Error('connection refused'); },
    } as unknown as DatabasePool;
    app = await buildLoopbackHealthProbe({ pool: down });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'live' });
  });

  it('NO registra /metrics cuando no se pasa ni wakePumpTelemetry ni consolePublishTelemetry', async () => {
    app = await buildLoopbackHealthProbe({ pool: answeringPool, ackProbe: async () => undefined });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });

  it('registra /metrics con cache-control no-store cuando hay wake telemetry', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
      wakeProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('cauce_gateway_wake_pump_cycles_total');
  });
});

describe('readiness: PostgreSQL y TLS', () => {
  it('devuelve 503 postgres_unavailable cuando SELECT 1 falla, antes de tocar ackProbe', async () => {
    let ackCalls = 0;
    const down: DatabasePool = {
      query: async () => { throw new Error('ECONNREFUSED'); },
    } as unknown as DatabasePool;
    app = await buildLoopbackHealthProbe({
      pool: down,
      dataApp: listeningDataApp(),
      ackProbe: async () => { ackCalls += 1; },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'postgres_unavailable' });
    expect(ackCalls).toBe(0);
  });

  it('devuelve 503 postgres_tls_required cuando requirePostgresTls=true y pg_stat_ssl.ssl=false', async () => {
    app = await buildLoopbackHealthProbe({
      pool: tlsOffPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      requirePostgresTls: true,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'postgres_tls_required' });
  });

  it('devuelve 503 postgres_unavailable cuando pg_stat_ssl revienta con requirePostgresTls=true', async () => {
    const failing: DatabasePool = {
      query: async (sql: string) => {
        if (sql.includes('pg_stat_ssl')) throw new Error('relation does not exist');
        return { rows: [], rowCount: 0 };
      },
    } as unknown as DatabasePool;
    app = await buildLoopbackHealthProbe({
      pool: failing,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      requirePostgresTls: true,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'postgres_unavailable' });
  });

  it('NO consulta pg_stat_ssl cuando requirePostgresTls está undefined o false', async () => {
    const queries: string[] = [];
    const tracker: DatabasePool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as DatabasePool;
    app = await buildLoopbackHealthProbe({
      pool: tracker,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
    });
    await app.inject({ method: 'GET', url: '/health/ready' });
    expect(queries.some((sql) => sql.includes('pg_stat_ssl'))).toBe(false);
  });
});

describe('readiness: data listener y ACK path', () => {
  it('devuelve 503 data_listener_down cuando el listener externo está cerrado', async () => {
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: { server: { listening: false } as never },
      ackProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'data_listener_down' });
  });

  it('NO exige dataApp si la opción no se pasó', async () => {
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      ackProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('devuelve 503 ack_path_unavailable cuando ackProbe tira', async () => {
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => { throw new Error('canceling statement due to lock timeout'); },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'ack_path_unavailable' });
  });
});

describe('readiness: wake pump telemetry', () => {
  it('responde ready=true si no se pasó wakePumpTelemetry (no entra al bloque del pump)', async () => {
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('devuelve 503 wake_pump_configuration_invalid cuando wakePumpMaxStaleMs no es entero ≥1', async () => {
    const telemetry = new WakePumpTelemetry();
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakePumpMaxStaleMs: 0,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_pump_configuration_invalid' });
  });

  it('devuelve 503 wake_pump_not_started cuando lastProgressAtMs nunca se asignó', async () => {
    const telemetry = new WakePumpTelemetry();
    let deliveryProbes = 0;
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => { deliveryProbes += 1; },
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_pump_not_started' });
    // La política es "falla cerrado": primero se prueban los schemas y solo después
    // se evalúa la telemetría, así que aquí deliveryAdmissionProbe sí corre.
    expect(deliveryProbes).toBe(1);
  });

  it('devuelve 503 wake_pump_stopping cuando el pump está parando', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    telemetry.markStopping();
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_pump_stopping' });
  });

  it('devuelve 503 wake_pump_stalled cuando lastProgressAtMs está en el futuro lejano', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const snapshot = telemetry.snapshot();
    Object.defineProperty(telemetry, 'lastProgressAtMs', { get: () => Number.MAX_SAFE_INTEGER });
    void snapshot;
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
      wakePumpMaxStaleMs: 60_000,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_pump_stalled' });
  });

  it('devuelve 503 wake_pump_degraded cuando lastProgressAtMs es fresco pero lastSuccessAtMs es null', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.recordOutcome('error');
    telemetry.finishCycle();
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_pump_degraded' });
  });

  it('responde ready=true cuando todas las sondas y la telemetría están sanas', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });
});

describe('readiness: cada probe de schema responde con su reason exacto', () => {
  function readyAppWithBrokenProbe(probeName: string): Promise<FastifyInstance> {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const stubThrow = async () => { throw new Error(`${probeName} broken`); };
    return buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: probeName === 'delivery_admission' ? stubThrow : async () => undefined,
      wakeProbe: probeName === 'wake' ? stubThrow : async () => undefined,
      terminalClaimProbe: probeName === 'terminal_claim' ? stubThrow : async () => undefined,
      terminalBrowserOwnerProbe: probeName === 'terminal_browser_owner' ? stubThrow : async () => undefined,
      terminalRelayInstanceProbe: probeName === 'terminal_relay_instance' ? stubThrow : async () => undefined,
      profileRuntimeProbe: probeName === 'profile_runtime' ? stubThrow : async () => undefined,
      consolePublishIntentProbe: probeName === 'console_publish_intent' ? stubThrow : async () => undefined,
    });
  }

  const cases = [
    { probe: 'delivery_admission', reason: 'delivery_admission_path_unavailable' },
    { probe: 'wake', reason: 'wake_path_unavailable' },
    { probe: 'terminal_claim', reason: 'terminal_claim_path_unavailable' },
    { probe: 'terminal_browser_owner', reason: 'terminal_browser_owner_path_unavailable' },
    { probe: 'terminal_relay_instance', reason: 'terminal_relay_instance_path_unavailable' },
    { probe: 'profile_runtime', reason: 'profile_runtime_path_unavailable' },
    { probe: 'console_publish_intent', reason: 'console_publish_intent_path_unavailable' },
  ] as const;

  for (const { probe, reason } of cases) {
    it(`rompe ${probe} → 503 ${reason}`, async () => {
      app = await readyAppWithBrokenProbe(probe);
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready', reason });
    });
  }
});

describe('readiness: orden de evaluación entre probes', () => {
  it('evalúa las sondas en el orden documentado: delivery_admission antes que wake', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const seen: string[] = [];
    app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => { seen.push('delivery_admission'); },
      terminalClaimProbe: async () => { seen.push('terminal_claim'); },
      terminalBrowserOwnerProbe: async () => { seen.push('terminal_browser_owner'); },
      terminalRelayInstanceProbe: async () => { seen.push('terminal_relay_instance'); },
      profileRuntimeProbe: async () => { seen.push('profile_runtime'); },
      consolePublishIntentProbe: async () => { seen.push('console_publish_intent'); },
      wakeProbe: async () => { seen.push('wake'); },
    });
    await app.inject({ method: 'GET', url: '/health/ready' });
    expect(seen).toEqual([
      'delivery_admission',
      'terminal_claim',
      'terminal_browser_owner',
      'terminal_relay_instance',
      'profile_runtime',
      'console_publish_intent',
      'wake',
    ]);
  });
});