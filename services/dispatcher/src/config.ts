export const DEFAULT_ACK_DEADLINE_MS = 30_000;
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

export interface DispatcherConfig {
  pollMs: number;
  ackDeadlineMs: number;
  ackTimeoutMs: number;
  interactiveBurst: number;
  jobLeaseMs: number;
  /**
   * Palanca de emergencia para volver al reaper viejo, que reintentaba a ciegas toda garra
   * vencida. Apagada por defecto: reintentar una entrega que consta que YA había arrancado
   * vuelve a pagar una corrida entera de un modelo de suscripción, y ese fue el 71% del
   * desperdicio medido el 2026-07-27 en los agentes con harness codex.
   */
  retryStartedDeliveries: boolean;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function configuredDispatcher(environment: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const ackDeadlineMs = positiveInteger(
    environment,
    'CAUCE_ACK_DEADLINE_MS',
    DEFAULT_ACK_DEADLINE_MS,
  );
  const ackTimeoutMs = positiveInteger(environment, 'ACK_TIMEOUT_MS', DEFAULT_ACK_TIMEOUT_MS);
  if (ackTimeoutMs < ackDeadlineMs) {
    throw new Error('ACK_TIMEOUT_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS');
  }
  return {
    pollMs: positiveInteger(environment, 'DISPATCHER_POLL_MS', 250),
    ackDeadlineMs,
    ackTimeoutMs,
    interactiveBurst: positiveInteger(environment, 'INTERACTIVE_BURST', 3),
    jobLeaseMs: positiveInteger(environment, 'JOB_LEASE_MS', 30_000),
    // Sólo el '1' explícito la prende. Cualquier otra cosa (vacío, '0', basura) deja el
    // comportamiento seguro, que es el que ahorra cuota.
    retryStartedDeliveries: environment.CAUCE_RETRY_STARTED_DELIVERIES === '1',
  };
}
