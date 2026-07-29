import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS, DEFAULT_RETENTION_AUDIT_RENEWAL_MS,
  DEFAULT_RETENTION_BATCH,
} from '@cauce/store';

export const DEFAULT_ACK_DEADLINE_MS = 30_000;
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/**
 * Cada cuánto se poda la observabilidad. 5 min y no cada tick (250 ms): el barrido es
 * mantenimiento, no camino caliente, y a 250 ms serían 345.600 DELETE por día para recuperar el
 * mismo espacio que 288.
 *
 * `CAUCE_RETENTION_INTERVAL_MS=0` lo APAGA. Es la única variable de este parche que acepta cero,
 * y es la palanca de emergencia: deja de borrar sin revertir el esquema ni redesplegar código.
 */
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60_000;
/** P0-4 — vigía de cadenas mudas. La justificación de cada número está en el store. */
export const DEFAULT_CHAIN_SWEEP_MS = 60_000;
export const DEFAULT_CHAIN_IDLE_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_CHAIN_SETTLED_GRACE_MS = 15 * 60 * 1_000;
export const DEFAULT_CHAIN_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_CHAIN_SWEEP_LIMIT = 5;

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
  /** Techo de vida total de un intento. Ver `DEFAULT_DELIVERY_LEASE_CAP_MS` en el store. */
  leaseCapMs: number;
  leaseCapGraceMs: number;
  retentionIntervalMs: number;
  retentionAckRenewalMs: number;
  retentionAckMs: number;
  retentionAuditRenewalMs: number;
  retentionAuditMs: number;
  retentionBatch: number;
  chainSweepMs: number;
  chainIdleMs: number;
  chainSettledGraceMs: number;
  chainMaxAgeMs: number;
  chainSweepLimit: number;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Igual que `positiveInteger` pero admite 0, el valor con el que se apaga el vigía. */
function nonNegativeInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
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
  const leaseCapMs = positiveInteger(
    environment, 'CAUCE_DELIVERY_LEASE_CAP_MS', DEFAULT_DELIVERY_LEASE_CAP_MS,
  );
  // Un techo por debajo del plazo de ACK mataría TODA entrega antes de su primera renovación:
  // el arranque le pondría el plazo en now()+30min, el LEAST lo recortaría al techo ya vencido y
  // el reaper la declararía muerta por techo en el tick siguiente. La flota entera dejaría de
  // trabajar y el síntoma —"todo muere por techo agotado"— parecería un bug del guarda nuevo.
  // Falla al arrancar, que es donde se ve.
  if (leaseCapMs < ackDeadlineMs) {
    throw new Error(
      'CAUCE_DELIVERY_LEASE_CAP_MS must be equal to or greater than CAUCE_ACK_DEADLINE_MS',
    );
  }
  const retentionAckRenewalMs = positiveInteger(
    environment, 'CAUCE_RETENTION_ACK_RENEWAL_MS', DEFAULT_RETENTION_ACK_RENEWAL_MS,
  );
  const retentionAckMs = positiveInteger(
    environment, 'CAUCE_RETENTION_ACK_MS', DEFAULT_RETENTION_ACK_MS,
  );
  const retentionAuditRenewalMs = positiveInteger(
    environment, 'CAUCE_RETENTION_AUDIT_RENEWAL_MS', DEFAULT_RETENTION_AUDIT_RENEWAL_MS,
  );
  const retentionAuditMs = positiveInteger(
    environment, 'CAUCE_RETENTION_AUDIT_MS', DEFAULT_RETENTION_AUDIT_MS,
  );
  if (retentionAckRenewalMs > retentionAckMs || retentionAuditRenewalMs > retentionAuditMs) {
    throw new Error(
      'renewal retention windows must be shorter than or equal to the general retention windows',
    );
  }
  const chainIdleMs = positiveInteger(environment, 'CHAIN_IDLE_MS', DEFAULT_CHAIN_IDLE_MS);
  const chainMaxAgeMs = positiveInteger(environment, 'CHAIN_MAX_AGE_MS', DEFAULT_CHAIN_MAX_AGE_MS);
  // Una ventana de rastreo más corta que el plazo de inactividad deja un agujero garantizado:
  // la raíz envejecería fuera del barrido antes de poder vencer, y el silencio volvería.
  if (chainMaxAgeMs < chainIdleMs) {
    throw new Error('CHAIN_MAX_AGE_MS must be equal to or greater than CHAIN_IDLE_MS');
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
    leaseCapMs,
    leaseCapGraceMs: positiveInteger(
      environment, 'CAUCE_DELIVERY_LEASE_CAP_GRACE_MS', DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS,
    ),
    retentionIntervalMs: nonNegativeInteger(
      environment, 'CAUCE_RETENTION_INTERVAL_MS', DEFAULT_RETENTION_INTERVAL_MS,
    ),
    retentionAckRenewalMs,
    retentionAckMs,
    retentionAuditRenewalMs,
    retentionAuditMs,
    retentionBatch: positiveInteger(
      environment, 'CAUCE_RETENTION_BATCH', DEFAULT_RETENTION_BATCH,
    ),
    chainSweepMs: nonNegativeInteger(environment, 'CHAIN_SWEEP_MS', DEFAULT_CHAIN_SWEEP_MS),
    chainIdleMs,
    chainSettledGraceMs: positiveInteger(
      environment, 'CHAIN_SETTLED_GRACE_MS', DEFAULT_CHAIN_SETTLED_GRACE_MS
    ),
    chainMaxAgeMs,
    chainSweepLimit: positiveInteger(environment, 'CHAIN_SWEEP_LIMIT', DEFAULT_CHAIN_SWEEP_LIMIT),
  };
}
