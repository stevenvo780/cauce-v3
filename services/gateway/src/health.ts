import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { withTransaction, type DatabasePool } from '@cauce/store';
import type { WakePumpTelemetry } from './wake-pump-telemetry.js';
import {
  consolePublishTelemetryVocabulary, type ConsolePublishTelemetry,
} from './console-publish-telemetry.js';
import {
  probeDeliveryAdmissionPath, probeWakePath,
} from './health/schema-delivery.js';
import {
  probeTerminalBrowserOwnerPath, probeTerminalClaimPath,
  probeTerminalRelayInstancePath,
} from './health/schema-terminal.js';
import { probeProfileRuntimePath } from './health/schema-profile-runtime.js';
import { probeShadowTargetPhasePath } from './health/schema-shadow-target-phase.js';
import {
  probeConsolePublishIntentPath,
} from './health/schema-console-publish-intent.js';

export {
  probeConsolePublishIntentPath,
  probeDeliveryAdmissionPath,
  probeProfileRuntimePath,
  probeShadowTargetPhasePath,
  probeTerminalBrowserOwnerPath,
  probeTerminalClaimPath,
  probeTerminalRelayInstancePath,
  probeWakePath,
};

export interface HealthOptions {
  pool: DatabasePool;
  logger?: boolean;
  requirePostgresTls?: boolean;
  /** The externally-facing data listener, distinct from the loopback health server. */
  dataApp?: Pick<FastifyInstance, 'server'>;
  /** A bounded, non-mutating probe of the tables used by the delivery ACK transaction. */
  ackProbe?: () => Promise<void>;
  /** Test override; production probes schema-015 delivery admission and its effective privileges. */
  deliveryAdmissionProbe?: () => Promise<void>;
  /** Aggregate, identity-free progress of the durable wake pump. */
  wakePumpTelemetry?: Pick<WakePumpTelemetry, 'snapshot'>;
  /** Aggregate, identity-free outcomes of the durable console publish protocol. */
  consolePublishTelemetry?: Pick<ConsolePublishTelemetry, 'snapshot'>;
  /**
   * Override for tests. Production deliberately omits it so readiness executes the concrete,
   * read-only schema-031 wake probe against the same pool as the pump.
   */
  wakeProbe?: () => Promise<void>;
  /** Test override; production probes schema-032 and its exact-fence CAS read-only. */
  terminalClaimProbe?: () => Promise<void>;
  /** Test override; production probes schema-033 browser admission and owner fencing. */
  terminalBrowserOwnerProbe?: () => Promise<void>;
  /** Test override; production probes schema-034 authenticated relay routing fences. */
  terminalRelayInstanceProbe?: () => Promise<void>;
  /** Test override; production probes schema-035 runtime profile expectations and adoption. */
  profileRuntimeProbe?: () => Promise<void>;
  /** Test override; production probes schema-036 shadow dispatch phase accounting. */
  shadowTargetPhaseProbe?: () => Promise<void>;
  /** Test override; production probes schema-037's durable console publish journal indexes. */
  consolePublishIntentProbe?: () => Promise<void>;
  /** How long a core wake cycle may go without a clean completion before readiness fails. */
  wakePumpMaxStaleMs?: number;
}

const wakeOutcomes = ['sent', 'retry', 'dead', 'fenced', 'error', 'cancelled'] as const;
const wakeStates = ['idle', 'running', 'stopping'] as const;

function metricValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`gateway wake telemetry returned an invalid ${label} counter`);
  }
  return value;
}

/** Prometheus text with a fixed label vocabulary and no tenant, alias, event or claim identity. */
export function renderWakePumpMetrics(
  telemetry: Pick<WakePumpTelemetry, 'snapshot'>
): string {
  const snapshot = telemetry.snapshot();
  if (!wakeStates.includes(snapshot.state)) {
    throw new Error('gateway wake telemetry returned an invalid state');
  }
  if (snapshot.lastProgressAtMs !== null
      && (!Number.isFinite(snapshot.lastProgressAtMs) || snapshot.lastProgressAtMs < 0)) {
    throw new Error('gateway wake telemetry returned an invalid progress timestamp');
  }
  if (snapshot.lastSuccessAtMs !== null
      && (!Number.isFinite(snapshot.lastSuccessAtMs) || snapshot.lastSuccessAtMs < 0)) {
    throw new Error('gateway wake telemetry returned an invalid success timestamp');
  }
  metricValue(snapshot.consecutiveFailures, 'consecutive failures');
  const lines = [
    '# HELP cauce_gateway_wake_pump_state Current wake-pump lifecycle state.',
    '# TYPE cauce_gateway_wake_pump_state gauge',
  ];
  for (const state of wakeStates) {
    lines.push(`cauce_gateway_wake_pump_state{state="${state}"} ${snapshot.state === state ? 1 : 0}`);
  }
  lines.push(
    '# HELP cauce_gateway_wake_pump_last_progress_timestamp_seconds Unix time of the last wake-pump progress.',
    '# TYPE cauce_gateway_wake_pump_last_progress_timestamp_seconds gauge',
    `cauce_gateway_wake_pump_last_progress_timestamp_seconds ${(snapshot.lastProgressAtMs ?? 0) / 1_000}`,
    '# HELP cauce_gateway_wake_pump_last_success_timestamp_seconds Unix time of the last clean wake-pump cycle.',
    '# TYPE cauce_gateway_wake_pump_last_success_timestamp_seconds gauge',
    `cauce_gateway_wake_pump_last_success_timestamp_seconds ${(snapshot.lastSuccessAtMs ?? 0) / 1_000}`,
    '# HELP cauce_gateway_wake_pump_consecutive_failures Consecutive wake-pump cycles with fenced or error outcomes.',
    '# TYPE cauce_gateway_wake_pump_consecutive_failures gauge',
    `cauce_gateway_wake_pump_consecutive_failures ${snapshot.consecutiveFailures}`,
    '# HELP cauce_gateway_wake_pump_cycles_total Completed or attempted wake-pump polling cycles.',
    '# TYPE cauce_gateway_wake_pump_cycles_total counter',
    `cauce_gateway_wake_pump_cycles_total ${metricValue(snapshot.counters.cycles, 'cycles')}`,
    '# HELP cauce_gateway_wake_pump_claimed_total Durable wake events claimed by the gateway.',
    '# TYPE cauce_gateway_wake_pump_claimed_total counter',
    `cauce_gateway_wake_pump_claimed_total ${metricValue(snapshot.counters.claimed, 'claimed')}`,
    '# HELP cauce_gateway_wake_pump_outcomes_total Wake-pump outcomes by bounded result.',
    '# TYPE cauce_gateway_wake_pump_outcomes_total counter',
  );
  for (const result of wakeOutcomes) {
    lines.push(
      `cauce_gateway_wake_pump_outcomes_total{result="${result}"} ${metricValue(snapshot.counters[result], result)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Fixed-label console journal counters; no operator or message material reaches Prometheus. */
export function renderConsolePublishMetrics(
  telemetry: Pick<ConsolePublishTelemetry, 'snapshot'>,
): string {
  const counters = telemetry.snapshot();
  const expected = new Set(consolePublishTelemetryVocabulary.map(
    (event) => `${event.operation}:${event.result}`,
  ));
  if (Object.keys(counters).length !== expected.size
      || Object.keys(counters).some((key) => !expected.has(key))) {
    throw new Error('gateway console publish telemetry returned an unknown counter');
  }
  const lines = [
    '# HELP cauce_gateway_console_publish_operations_total Durable console publish protocol request outcomes.',
    '# TYPE cauce_gateway_console_publish_operations_total counter',
  ];
  for (const event of consolePublishTelemetryVocabulary) {
    const key = `${event.operation}:${event.result}`;
    lines.push(
      `cauce_gateway_console_publish_operations_total{operation="${event.operation}",result="${event.result}"} ${metricValue(counters[key] ?? -1, `console publish ${key}`)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function readiness(options: HealthOptions, reply: FastifyReply): Promise<unknown> {
  try {
    await options.pool.query('SELECT 1');
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
  }
  if (options.requirePostgresTls === true) {
    try {
      const encrypted = await options.pool.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
      );
      if (encrypted.rows[0]?.ssl !== true) {
        return reply.code(503).send({ status: 'not_ready', reason: 'postgres_tls_required' });
      }
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
    }
  }
  if (options.dataApp !== undefined && !options.dataApp.server.listening) {
    return reply.code(503).send({ status: 'not_ready', reason: 'data_listener_down' });
  }
  try {
    await options.ackProbe?.();
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'ack_path_unavailable' });
  }
  if (options.wakePumpTelemetry !== undefined) {
    const maximum = options.wakePumpMaxStaleMs ?? 60_000;
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_configuration_invalid' });
    }
    try {
      await (options.deliveryAdmissionProbe?.() ?? probeDeliveryAdmissionPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'delivery_admission_path_unavailable',
      });
    }
    try {
      await (options.terminalClaimProbe?.() ?? probeTerminalClaimPath(options.pool));
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'terminal_claim_path_unavailable' });
    }
    try {
      await (options.terminalBrowserOwnerProbe?.() ?? probeTerminalBrowserOwnerPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'terminal_browser_owner_path_unavailable',
      });
    }
    try {
      await (options.terminalRelayInstanceProbe?.() ?? probeTerminalRelayInstancePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'terminal_relay_instance_path_unavailable',
      });
    }
    try {
      await (options.profileRuntimeProbe?.() ?? probeProfileRuntimePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'profile_runtime_path_unavailable',
      });
    }
    try {
      await (options.shadowTargetPhaseProbe?.() ?? probeShadowTargetPhasePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'shadow_target_phase_path_unavailable',
      });
    }
    try {
      await (options.consolePublishIntentProbe?.()
        ?? probeConsolePublishIntentPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'console_publish_intent_path_unavailable',
      });
    }
    try {
      await (options.wakeProbe?.() ?? probeWakePath(options.pool));
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_path_unavailable' });
    }
    const snapshot = options.wakePumpTelemetry.snapshot();
    const now = Date.now();
    if (snapshot.state === 'stopping') {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_stopping' });
    }
    if (snapshot.lastProgressAtMs === null) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_not_started' });
    }
    if (!Number.isFinite(snapshot.lastProgressAtMs)
        || snapshot.lastProgressAtMs < 0 || snapshot.lastProgressAtMs > now + maximum
        || now - snapshot.lastProgressAtMs > maximum) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_stalled' });
    }
    if (snapshot.lastSuccessAtMs === null
        || !Number.isFinite(snapshot.lastSuccessAtMs)
        || snapshot.lastSuccessAtMs < 0 || snapshot.lastSuccessAtMs > now + maximum
        || now - snapshot.lastSuccessAtMs > maximum) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_degraded' });
    }
  }
  return { status: 'ready' };
}

/**
 * Exercises relation availability and query permissions for both sides of the ACK ledger without
 * selecting payloads or identities and without mutating a delivery.
 */
export async function probeAckPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    await client.query(
      `SELECT 1 FROM deliveries d
       LEFT JOIN delivery_acks a ON a.delivery_id=d.id
       LIMIT 1`
    );
  });
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => readiness(options, reply));
  const wakeTelemetry = options.wakePumpTelemetry;
  const consoleTelemetry = options.consolePublishTelemetry;
  if (wakeTelemetry !== undefined || consoleTelemetry !== undefined) {
    app.get('/metrics', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${wakeTelemetry === undefined ? '' : renderWakePumpMetrics(wakeTelemetry)}${
        consoleTelemetry === undefined ? '' : renderConsolePublishMetrics(consoleTelemetry)
      }`));
  }
}

/** Internal health/metrics app. Callers choose the bind; it contains no data or identity routes. */
export async function buildLoopbackHealthProbe(options: HealthOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  registerHealthRoutes(app, options);
  return app;
}
