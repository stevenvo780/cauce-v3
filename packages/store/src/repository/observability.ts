import type { DeliveryState, Origin, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { withTransaction } from '../db.js';
import {
  agentWorkState, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, FLEET_ACTIVITY_QUERY, FLEET_ACTIVITY_FLAGS,
  FLEET_WORK_STATES, type FleetActivityFlag, type FleetWorkState
} from '../fleet-activity.js';
import { safeAuditSummary } from '../audit-summary.js';
import { DISABLED_DELEGATION_CAPS, type DelegationCaps } from '../delegation-guard.js';
import { BaseRepository } from './base.js';
import { StoreError } from './errors.js';
import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  leaseCapInstantSql, leaseCapMsSql, positiveMs, timeoutRetryBackoffSeconds,
  type ObservabilityRetentionPolicy, type ObservabilityRetentionResult, type StaleDeliveryPolicy
} from './observability/policy.js';

export {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  deliveryLeaseCapMs, timeoutRetryBackoffSeconds,
  type DeliveryLeaseCap, type ObservabilityRetentionPolicy, type ObservabilityRetentionResult,
  type StaleDeliveryPolicy
} from './observability/policy.js';


export interface DeliveryRow {
  id: string;
  message_id: string;
  recipient_tenant: Tenant;
  recipient_alias: string;
  status: DeliveryState;
  attempt: number;
  max_attempts: number;
  last_ack_rank: number;
  request_id: string;
  trace_id: string;
  tenant_id: Tenant;
  room_id: string;
  actor_alias: string;
  body: Record<string, unknown>;
  lane: 'interactive' | 'batch';
  priority: number;
  origin: Origin | null;
  auth_session_id: string | null;
  auth_channel: string | null;
  consumer_instance_id: string | null;
  consumer_epoch: string | null;
  claim_token: string | null;
  ack_deadline_at: Date | null;
}

/** Qué pasó con el aviso al origen cuando se rescató un resultado tardío. */
export type LateRelayDisposition = 'skipped' | 'inserted' | 'rewritten' | 'corrected';

/** Privacy-bounded operational DLQ row.  No message, delivery, outbox or provider id is exposed. */
export interface OperationalDlqItem {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly tenantId: Tenant;
  readonly kind: string;
  readonly adapter: string | null;
  readonly disposition: 'ambiguous' | 'safe_retry' | 'missing_final' | 'auth'
    | 'expected_offline' | 'unclassified';
  readonly open: boolean;
  readonly actionable: boolean;
  readonly evidenceSha256: string | null;
  readonly attempts: number;
  readonly resolutionRule: string | null;
  readonly createdAt: string;
  readonly dispositionAt: string | null;
  readonly resolvedAt: string | null;
  readonly reopenCount: number;
  readonly lastReopenedAt: string | null;
}

/** One deterministic keyset page.  `nextCursor` is opaque and bound to the actor scope in SQL. */
export interface OperationalDlqPage {
  readonly schemaVersion: 1;
  readonly items: OperationalDlqItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface OperationalDlqResolutionRequest {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly evidenceSha256: string;
  readonly reason: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

export interface OperationalDlqResolutionResult {
  readonly schemaVersion: 1;
  readonly suite: 'cauce-v3-dlq-no-replay-resolution';
  readonly phase: 'resolved';
  readonly appliedCount: number;
  readonly alreadyApplied: boolean;
  readonly evidenceSha256: string;
  readonly reasonSha256: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

/** Umbrales y límites de tiempo configurados para el barrido de cadenas de delegación inactivas. */
const chainSilenceIdleMs = 6 * 60 * 60 * 1_000;

const chainSilenceSettledGraceMs = 15 * 60 * 1_000;

const chainSilenceMaxAgeMs = 48 * 60 * 60 * 1_000;

const chainSilenceSweepLimit = 5;

const chainSilenceNoticeMaxBytes = 1_024;

const chainSilenceCauseMaxBytes = 240;

export interface ChainPolicy {
  progressRelayEnabled: boolean;
  progressRelayMaxEvents: number;
  cycleCutEnabled: boolean;
  /** False until migration 008 lands, which keeps ACKs working during a partial deploy. */
  visitedPathAvailable: boolean;
  failureCoalesceEnabled: boolean;
  failureCoalesceWindowSeconds: number;
  /** False until migration 014 lands; same partial-deploy contract as visitedPathAvailable. */
  failureCoalesceAvailable: boolean;
  /** Topes de disciplina de delegación (019). `enabled:false` = conducta previa a 019. */
  delegationCaps: DelegationCaps;
  /** False until migration 019 lands; same partial-deploy contract as visitedPathAvailable. */
  delegationCapsAvailable: boolean;
  humanGateEnabled: boolean;
  /** False until migration 019 lands: sin la tabla no hay gates y `@human` vuelve a ser unroutable. */
  humanGateAvailable: boolean;
}

export const disabledChainPolicy: ChainPolicy = {
  progressRelayEnabled: false,
  progressRelayMaxEvents: 0,
  cycleCutEnabled: false,
  visitedPathAvailable: false,
  failureCoalesceEnabled: false,
  failureCoalesceWindowSeconds: 0,
  failureCoalesceAvailable: false,
  delegationCaps: DISABLED_DELEGATION_CAPS,
  delegationCapsAvailable: false,
  humanGateEnabled: false,
  humanGateAvailable: false
};

/**
 * 'coalesced' es un retorno LEGÍTIMO, no un error: el fracaso quedó registrado y el padre ya
 * había sido avisado de esta misma causa dentro de la ventana. Se distingue de 'not_child'
 * porque sigue siendo una rama con padre, y de 'returned' porque no produjo entrega. Los dos
 * consumidores de este tipo sólo preguntan por 'not_child' (para decidir el relay al origen),
 * así que un fracaso plegado nunca se escapa hacia Telegram como si nadie lo estuviera esperando.
 */
export type AgentResponseDisposition = 'not_child' | 'returned' | 'denied' | 'deferred' | 'coalesced';

export interface AgentFaninDisposition {
  hasFanout: boolean;
  scheduled: boolean;
}

/** Migration 016_chain_silence_sweep constrains agent_chain_closures.reason to exactly these values. */
export type ChainSilenceClosureReason = 'settled_without_fanin' | 'idle_timeout';

export interface ChainSilenceSweepOptions {
  /** Sin avance durante este plazo Y con trabajo abierto todavía: se cierra por vencimiento. */
  idleMs?: number;
  /** Cadena ya quieta (nada puede volver a moverla): gracia corta antes de cerrar. */
  settledGraceMs?: number;
  /** Ventana de rastreo. Una raíz más vieja que esto ya no se avisa nunca. */
  maxAgeMs?: number;
  /** Techo duro de raíces tocadas por barrido. */
  limit?: number;
}

export interface ChainSilenceSweepResult {
  /** Raíces candidatas leídas en este barrido. */
  scanned: number;
  /** Raíces destrabadas: el fan-in real quedó agendado y el humano recibirá la síntesis. */
  faninRecovered: number;
  /** Raíces cerradas con un aviso agregado al origen. Nunca más de una por raíz. */
  notified: number;
  /** Raíces salteadas (otro proceso las tenía tomadas, o su cierre falló y se reintentará). */
  skipped: number;
}

interface ChainSilenceCandidate {
  root_message_id: string;
  tenant_id: Tenant;
  request_id: string;
  trace_id: string;
  origin: Origin;
  root_delivery_id: string | null;
  root_status: DeliveryState | null;
  root_attempt: number | null;
  root_max_attempts: number | null;
  branches: number;
  branches_dead: number;
  branches_failed: number;
  branches_open: number;
  open_work: number;
  fanin_present: boolean;
  idle_seconds: number;
}

/** «6 h 12 min», «18 min», «45 s». Sin librerías y sin ambigüedad para el que lo lee. */
function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.trunc(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.trunc(hours / 24)} d ${hours % 24} h`;
}

/**
 * El aviso agregado. UNA línea con el conteo por desenlace y la causa dominante; nunca la
 * enumeración de las ramas. Deliberadamente NO incluye el texto de ninguna rama: pegar salida
 * de agente sin la síntesis del coordinador convierte el aviso en ruido largo y mete texto no
 * confiable en el chat del dueño. El id de la raíz alcanza para pedir el detalle después.
 */
function chainSilenceNoticeText(
  candidate: ChainSilenceCandidate,
  detail: { answered: number; cause?: string; causeCount: number },
  reason: ChainSilenceClosureReason
): string {
  const idle = humanDuration(candidate.idle_seconds);
  const head = candidate.branches === 0
    ? `⚠️ Tu pedido quedó sin respuesta: nadie llegó a trabajarlo`
      + `${candidate.root_status === null ? '' : ` (entrega en «${candidate.root_status}»`
        + `${candidate.root_attempt === null ? '' : `, ${candidate.root_attempt}/${candidate.root_max_attempts ?? '?'} intentos`})`}.`
    : `⚠️ Tu pedido quedó sin respuesta: de ${candidate.branches} `
      + `${candidate.branches === 1 ? 'rama delegada' : 'ramas delegadas'}, ${detail.answered} `
      + `${detail.answered === 1 ? 'devolvió' : 'devolvieron'} resultado, ${candidate.branches_dead} `
      + `${candidate.branches_dead === 1 ? 'murió' : 'murieron'}, ${candidate.branches_failed} `
      + `${candidate.branches_failed === 1 ? 'falló' : 'fallaron'} y ${candidate.branches_open} `
      + `${candidate.branches_open === 1 ? 'sigue' : 'siguen'} sin terminar.`;
  const why = detail.cause === undefined
    ? ''
    : ` Causa dominante: «${detail.cause}» (${detail.causeCount}).`;
  const tail = reason === 'settled_without_fanin'
    ? ` La cadena se apagó hace ${idle} y ya no puede avanzar sola, así que la cierro acá.`
    : ` Sin ningún avance desde hace ${idle}, así que la cierro acá.`;
  return truncateUtf8(
    `${head}${why}${tail} (raíz ${candidate.root_message_id})`,
    chainSilenceNoticeMaxBytes
  ).value;
}

/** Deployment status derived from registry + presence only; no host-side reporter exists yet
 *  (see docs/adr/006-agent-registry-and-deferred-execution.md), so this never claims more than
 *  Postgres actually knows. */
export function agentDeploymentStatus(row: Record<string, unknown>): string {
  if (row.enabled !== true) return 'disabled';
  if (row.online === true) return 'online';
  if (row.online === false) return 'offline';
  return 'unknown';
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const aliasPattern = /^[a-z][a-z0-9_-]{0,63}$/u;

export const tenantPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  const marker = '…[truncated]';
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let used = 0;
  let result = '';
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > contentBudget) break;
    result += character;
    used += bytes;
  }
  return { value: `${result}${marker}`, truncated: true };
}

/**
 * Texto ajeno (el `last_error` que escribió un agente) que va a salir hacia un chat humano.
 * Se le quitan los controles y se lo acota igual que en `agentResponseText`: es un dato, no
 * una instrucción y no un formato.
 */
function sanitizedDiagnostic(value: string): string {
  return value.replace(/[\p{Cf}\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function originBridgeAlias(origin: Origin): string {
  const alias = origin.metadata.bridge_alias;
  return typeof alias === 'string' && aliasPattern.test(alias) ? alias : origin.adapter;
}

export function originRelayTenant(row: Pick<DeliveryRow, 'tenant_id' | 'origin'>): Tenant {
  const trustedTenant = row.origin?.metadata.bridge_tenant;
  return typeof trustedTenant === 'string' && tenantPattern.test(trustedTenant)
    ? trustedTenant
    : row.tenant_id;
}

export abstract class ObservabilityRepository extends BaseRepository {
  protected abstract loadChainPolicy(client: DatabaseClient): Promise<ChainPolicy>;

  protected abstract materializeAgentResponse(
    client: DatabaseClient,
    row: DeliveryRow,
    attempt: number,
    outcome: DeliveryState,
    policy: ChainPolicy,
    result: Record<string, unknown> | undefined,
    error?: string,
    errorCode?: string,
    late?: { previousStatus: DeliveryState }
  ): Promise<AgentResponseDisposition>;

  protected abstract materializeAgentFanin(
    client: DatabaseClient,
    rootMessageId: string | undefined
  ): Promise<AgentFaninDisposition>;

  protected abstract rootMessageId(row: DeliveryRow): string | undefined;

  protected abstract insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: {
      result?: Record<string, unknown> | undefined;
      error?: string | undefined;
      error_code?: string | undefined;
    },
    late?: { previousStatus: DeliveryState; attempt: number }
  ): Promise<LateRelayDisposition>;

  /**
   * Recolecta entregas vencidas o que alcanzaron el techo de vida (leaseCap).
   * Reintenta si no iniciaron ejecución o las transiciona a dead/dead_letters si ya habían iniciado o agotaron intentos.
   */
  async retryStaleDeliveries(
    staleMs: number,
    limit = 100,
    policy: StaleDeliveryPolicy = {}
  ): Promise<{ retried: number; dead: number; parked: number }> {
    const retryStartedDeliveries = policy.retryStartedDeliveries === true;
    const parkWithoutConsumer = policy.parkWithoutConsumer !== false;
    const noConsumerParkMaxAgeMs = positiveMs(
      policy.noConsumerParkMaxAgeMs, DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, 'no-consumer park age'
    );
    // Se valida staleMs como entero no negativo antes de abrir la transacción.
    if (!Number.isSafeInteger(staleMs) || staleMs < 0) {
      throw new StoreError('conflict', 'stale timeout must be a non-negative integer of milliseconds');
    }
    const defaultCapMs = positiveMs(policy.leaseCapMs, DEFAULT_DELIVERY_LEASE_CAP_MS, 'lease cap');
    const graceMs = positiveMs(
      policy.leaseCapGraceMs, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, 'lease cap grace'
    );
    return withTransaction(this.pool, async (client) => {
      // Proyección escalar sin window functions para compatibilidad con FOR UPDATE OF d.
      // El techo se evalúa DOS veces (en la proyección y en el WHERE) con la misma expresión
      // literal a propósito: son escalares sobre la fila que el SELECT ya trae bajo lock, no
      // subconsultas y mucho menos funciones de ventana, así que conviven con `FOR UPDATE OF d`.
      const leaseCapExceeded = `${leaseCapInstantSql(`(${leaseCapMsSql('$3', '$4')})`)} <= now()`;
      const rows = await client.query<DeliveryRow & {
        execution_started: boolean;
        lease_cap_exceeded: boolean;
        lease_cap_ms: string;
        age_ms: string;
      }>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel,
                 (d.execution_started_at IS NOT NULL) AS execution_started,
                 (${leaseCapMsSql('$3', '$4')}) AS lease_cap_ms,
                 (EXTRACT(EPOCH FROM (now()-d.created_at))*1000)::bigint AS age_ms,
                 COALESCE(${leaseCapExceeded},false) AS lease_cap_exceeded
          FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('leased','accepted','started')
            AND (($1=0 OR COALESCE(d.ack_deadline_at,d.claim_expires_at,
                                   d.claimed_at+$1*interval '1 millisecond') <= now())
                 OR ${leaseCapExceeded})
         ORDER BY d.claimed_at FOR UPDATE OF d SKIP LOCKED LIMIT $2`,
        [staleMs, limit, defaultCapMs, graceMs]
      );
      const chainPolicy = await this.loadChainPolicy(client);
      // Quién tiene adaptador conectado AHORA. Va en una consulta aparte y no como subconsulta
      // del SELECT de arriba a propósito: ese SELECT lleva `FOR UPDATE OF d` y es el camino
      // caliente del reaper; la tabla de presencia tiene una fila por alias de la flota, así
      // que traerla entera cuesta menos que correlacionarla por fila.
      const consumidorVivo = new Set<string>();
      if (rows.rows.length > 0) {
        const presentes = await client.query<{ tenant_id: string; alias: string }>(
          'SELECT tenant_id,alias FROM connection_leases WHERE lease_until>now()'
        );
        for (const fila of presentes.rows) consumidorVivo.add(`${fila.tenant_id}\u0000${fila.alias}`);
      }
      let retried = 0;
      let dead = 0;
      let parked = 0;
      for (const row of rows.rows) {
        // El adaptador confirmó que el harness ARRANCÓ: obtuvo la reserva de sesión y estaba a
        // punto de invocarlo. Sólo con esa marca se retiene; "admitida y esperando el candado"
        // no cuenta y se reintenta como siempre.
        const heldForReview = row.execution_started && !retryStartedDeliveries;
        const attemptsExhausted = row.attempt >= row.max_attempts;
        const sinConsumidor = !consumidorVivo.has(
          `${row.recipient_tenant}\u0000${row.recipient_alias}`
        );
        // El techo manda sobre las otras dos condiciones y sobre la palanca de emergencia: una
        // entrega que estuvo horas renovando no se reintenta nunca, tenga o no la marca de
        // ejecución y esté o no prendido `retryStartedDeliveries`.
        const leaseCapExhausted = row.lease_cap_exceeded === true;
        // R3. Gastar los tres intentos contra un alias sin adaptador conectado no es reintentar:
        // no hubo ejecución. Se aparca y se le devuelve el intento. Las tres guardas son necesarias:
        //  - `!heldForReview`: si consta que arrancó, manda la retención; no se toca.
        //  - `!leaseCapExhausted`: el techo manda sobre todo lo demás.
        //  - `sinConsumidor`: con un adaptador vivo del otro lado el fallo SÍ es del destino y
        //    los intentos cuentan como siempre.
        // El horizonte de edad evita la entrega inmortal: pasado ese tiempo muere, y ahora deja
        // rastro en `audit_events`.
        const sinConsumidorAparcable = parkWithoutConsumer
          && attemptsExhausted
          && !heldForReview
          && !leaseCapExhausted
          && sinConsumidor
          && Number(row.age_ms) < noConsumerParkMaxAgeMs;
        if (sinConsumidorAparcable) {
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='pending',attempt=GREATEST(0,attempt-1),last_ack_rank=0,
              claimed_at=NULL,claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
              consumer_instance_id=NULL,consumer_epoch=NULL,execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',
              last_error='ACK timeout: no adapter connected; parked without spending an attempt',
              updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,'delivery.parked_no_consumer','allow',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: 'no_adapter_connected',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempt_refunded: true,
                age_ms: Number(row.age_ms),
                park_max_age_ms: noConsumerParkMaxAgeMs
              })]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-parked:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          parked += 1;
          continue;
        }
        if (attemptsExhausted || heldForReview || leaseCapExhausted) {
          // Cuando arrancó, ese es el motivo que le sirve al operador: le dice que la corrida
          // pudo haber terminado y que reencolar cuesta plata. El de intentos agotados es
          // secundario. El del techo va PRIMERO y con texto propio: "dejó de responder" y "no
          // deja de responder" son diagnósticos opuestos y confundirlos manda al operador a
          // buscar un adaptador caído que está perfectamente vivo.
          const reason = leaseCapExhausted
            ? `Lease cap exhausted: delivery renewed its claim past the ${row.lease_cap_ms} ms`
              + ' total execution ceiling; held for manual replay'
            : heldForReview
              ? 'ACK timeout: execution already started; held for manual replay'
              : 'ACK timeout: max attempts exhausted';
          await client.query(
            `UPDATE deliveries SET status='dead',terminal_at=now(),last_error=$2,updated_at=now()
             WHERE id=$1`, [row.id, reason]
          );
          await client.query(
            `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,$5,$3::jsonb,$4)
             ON CONFLICT(delivery_id) DO NOTHING`,
            [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, reason]
          );
          let responseDisposition: AgentResponseDisposition = 'not_child';
          try {
            responseDisposition = await this.materializeAgentResponse(
              client,
              row,
              row.attempt,
              'dead',
              chainPolicy,
              undefined,
              reason
            );
          } catch (error) {
            // Delivery already transitioned to dead above.
            // If materialization fails (e.g., recipient membership issue in cross-tenant case),
            // log and continue. This prevents a single bad delivery from crashing the entire
            // reaper tick, which would block cleanup of all other alias deliveries.
            console.error(JSON.stringify({
              event: 'materialization_failed_in_reaper',
              delivery_id: row.id,
              recipient_alias: row.recipient_alias,
              recipient_tenant: row.recipient_tenant,
              error: error instanceof Error ? error.message : String(error)
            }));
          }
          const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
          if (responseDisposition === 'not_child'
            && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
            await this.insertOriginRelay(client, row, 'dead', { error: reason });
          }
          // R6. Auditoría para las TRES ramas, no sólo para las dos nuevas.
          //
          // La condición era `if (heldForReview || leaseCapExhausted)`, así que el caso normal
          // —intentos agotados— moría sin escribir nada. 881 entregas se murieron así, sin un
          // solo `audit_events`: no aparecían en ningún informe, no se podían contar por causa y
          // no había forma de saber que el problema existía. Eso es lo que hizo invisible la
          // fuga durante semanas. Un final de entrega SIEMPRE deja rastro.
          //
          // Acciones distintas por rama a propósito: contar cuántas mueren por techo es lo que
          // dice si el default es demasiado agresivo, y mezclarlas con los plazos vencidos hace
          // esa cuenta imposible.
          const action = leaseCapExhausted ? 'delivery.lease_cap' : 'delivery.ack_timeout';
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,$8,'deny',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: leaseCapExhausted
                  ? 'lease_cap_exhausted'
                  : heldForReview ? 'execution_already_started' : 'max_attempts_exhausted',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempts_exhausted: attemptsExhausted,
                held_for_manual_replay: heldForReview || leaseCapExhausted,
                // Iba sólo en la rama del techo y sirve en las tres: la única pregunta que
                // importa al revisar una entrega muerta es si el harness llegó a correr.
                execution_started: row.execution_started,
                // Sin adaptador conectado y aun así muerta = superó el horizonte de aparcado.
                // Es la señal de que el destino lleva demasiado tiempo ausente.
                no_consumer: sinConsumidor,
                ...(leaseCapExhausted ? { lease_cap_ms: Number(row.lease_cap_ms) } : {})
              }), action]
          );
          // Morir también libera un cupo de agents.max_concurrent_deliveries: la entrega sale de
          // ('leased','accepted','started') igual que si hubiera terminado bien. La rama de retry
          // de acá abajo ya despertaba al destinatario; ésta no, y sin techo daba lo mismo porque
          // el reclamo previo se había llevado la cola entera de todas formas.
          //
          // Con techo sí importa: si las entregas en vuelo de un alias mueren todas por timeout,
          // el cupo queda libre, no va a llegar ningún ACK (por eso vencieron) y la cola pendiente
          // se quedaría quieta hasta que alguien publique un mensaje nuevo. El wake cuesta una fila
          // de outbox por entrega MUERTA — un evento raro, no uno por tick — y deja el invariante
          // parejo: toda salida del conjunto en vuelo despierta al destinatario.
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-dead:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' })]
          );
          dead += 1;
        } else {
          // Reintento legítimo: nunca arrancó. Aun así se espacia, igual que la rama de fallo
          // declarado por el agente, porque `available_at=now()` devolvía la entrega al mismo
          // agente en el tick siguiente y realimentaba el mismo bucle que la mató: el harness
          // anterior podía seguir vivo, así que el agente terminaba con dos corridas del mismo
          // trabajo compitiendo por la misma CPU — lo que hace más probable el siguiente latido
          // perdido. Un plazo vencido es señal de que el destino está saturado o mudo, así que la
          // respuesta correcta es esperar, no insistir de inmediato.
          //
          // `execution_started_at=NULL` va acá y no arriba: el intento que sigue arranca sin la
          // marca de ejecución del que venció, que es la que decide si se retiene o se reintenta.
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='retry',last_ack_rank=0,claimed_at=NULL,claim_expires_at=NULL,
              ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
              execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',last_error='ACK timeout',updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-timeout:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          retried += 1;
        }
      }
      return { retried, dead, parked };
    });
  }

  /**
   * Poda las dos tablas de observabilidad. Ver `packages/store/migrations/014_*.sql` para el
   * porqué de cada ventana; acá va el porqué de la FORMA del barrido.
   *
   * Cuatro DELETE independientes y no uno con OR: cada uno tiene su propia ventana y su propio
   * predicado, y separarlos es lo que permite que el barrido de renovaciones —que es el que
   * recupera el 90% del espacio— corra cada pocos minutos y sea barato, sin arrastrar detrás el
   * escaneo de la ventana larga.
   *
   * Cada uno es su propio statement fuera de una transacción explícita, a propósito: si fueran
   * una sola transacción, los locks de fila de los cuatro lotes se sostendrían hasta el COMMIT
   * final y el barrido pasaría de "cuatro pausas de milisegundos" a "una pausa larga". Un lote
   * que falla no deja los otros a medias porque no hay nada que dejar consistente entre ellos:
   * son cuatro podas independientes, y la del tick siguiente reintenta lo que quedó.
   *
   * `id IN (SELECT id ... LIMIT n)` es lo que garantiza que NUNCA hay un DELETE ilimitado sobre
   * una base viva. El primer barrido sobre un backlog acumulado no se come la base: se lleva n
   * filas y vuelve en el tick siguiente.
   */
  async pruneObservability(
    policy: ObservabilityRetentionPolicy = {}
  ): Promise<ObservabilityRetentionResult> {
    const ackRenewalMs = positiveMs(
      policy.ackRenewalMs, DEFAULT_RETENTION_ACK_RENEWAL_MS, 'ack renewal retention'
    );
    const ackMs = positiveMs(policy.ackMs, DEFAULT_RETENTION_ACK_MS, 'ack retention');
    const auditRenewalMs = positiveMs(
      policy.auditRenewalMs, DEFAULT_RETENTION_AUDIT_RENEWAL_MS, 'audit renewal retention'
    );
    const auditMs = positiveMs(policy.auditMs, DEFAULT_RETENTION_AUDIT_MS, 'audit retention');
    const batch = positiveMs(policy.batch, DEFAULT_RETENTION_BATCH, 'retention batch');
    const disposable = [...(policy.disposableAuditActions ?? DISPOSABLE_AUDIT_ACTIONS)];
    // Una ventana de renovaciones MÁS LARGA que la general no borraría nada de más, pero sí
    // volvería el barrido incomprensible al leer los números: la regla general ya se habría
    // llevado las renovaciones antes. Falla acá, que es donde se configura.
    if (ackRenewalMs > ackMs || auditRenewalMs > auditMs) {
      throw new StoreError(
        'conflict', 'renewal retention window cannot exceed the general retention window'
      );
    }
    const prune = async (sql: string, parameters: unknown[]): Promise<number> =>
      (await this.pool.query(sql, parameters)).rowCount ?? 0;
    return {
      ack_renewals: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE renewal AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackRenewalMs, batch]
      ),
      acks: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackMs, batch]
      ),
      // `lease_renewed` lo escribe SÓLO la rama de renovación de `ackDelivery`, y lo viene
      // escribiendo desde antes de este parche: por eso el backlog histórico de audit_events sí
      // se puede podar desde el primer barrido, sin columna nueva y sin backfill. Va acotado
      // igual por la lista blanca, para que un `lease_renewed` que apareciera algún día en otra
      // acción no arrastre una fila de la que dependa un guarda.
      audit_renewals: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[]) AND metadata->>'lease_renewed'='true'
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditRenewalMs, batch, disposable]
      ),
      // Lista BLANCA de acciones. Ver `DISPOSABLE_AUDIT_ACTIONS`: borrar `audit_events` por edad
      // a secas rompe el candado de idempotencia del replay y la marca de confianza de la
      // cadena agente-a-agente, en silencio y con semanas de retraso.
      audit_events: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[])
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditMs, batch, disposable]
      )
    };
  }

  /**
   * Barrido periódico de cadenas inactivas o mudas para asegurar que toda tarea
   * complete su fan-in o emita una respuesta consolidada de cierre hacia el origen.
   */
  async sweepSilentChains(options: ChainSilenceSweepOptions = {}): Promise<ChainSilenceSweepResult> {
    const idleMs = Math.max(1_000, Math.trunc(options.idleMs ?? chainSilenceIdleMs));
    const settledGraceMs = Math.max(1_000, Math.trunc(options.settledGraceMs ?? chainSilenceSettledGraceMs));
    const maxAgeMs = Math.max(idleMs, Math.trunc(options.maxAgeMs ?? chainSilenceMaxAgeMs));
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? chainSilenceSweepLimit)));
    const result: ChainSilenceSweepResult = { scanned: 0, faninRecovered: 0, notified: 0, skipped: 0 };
    const candidates = await this.pool.query<ChainSilenceCandidate>(
      `WITH candidate AS (
         SELECT root.id AS root_message_id,root.tenant_id,root.request_id,root.trace_id,root.origin,
                root.created_at,
                first_delivery.id AS root_delivery_id,first_delivery.status AS root_status,
                first_delivery.attempt AS root_attempt,first_delivery.max_attempts AS root_max_attempts,
                COALESCE(chain.branches,0)::int AS branches,
                COALESCE(chain.branches_dead,0)::int AS branches_dead,
                COALESCE(chain.branches_failed,0)::int AS branches_failed,
                COALESCE(chain.branches_open,0)::int AS branches_open,
                (COALESCE(chain.branches_open,0)
                 + COALESCE(own.open_deliveries,0)
                 + COALESCE(continuation.open_deliveries,0))::int AS open_work,
                COALESCE(continuation.fanin_present,false) AS fanin_present,
                GREATEST(
                  root.created_at,
                  COALESCE(own.last_event,root.created_at),
                  COALESCE(chain.last_event,root.created_at),
                  COALESCE(continuation.last_event,root.created_at)
                ) AS last_event
         FROM messages root
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE own_delivery.status NOT IN ('done','failed','dead')) AS open_deliveries,
                  max(GREATEST(own_delivery.updated_at,own_delivery.created_at)) AS last_event
           FROM deliveries own_delivery WHERE own_delivery.message_id=root.id
         ) own ON true
         LEFT JOIN LATERAL (
           SELECT own_delivery.id,own_delivery.status,own_delivery.attempt,own_delivery.max_attempts
           FROM deliveries own_delivery WHERE own_delivery.message_id=root.id
           ORDER BY own_delivery.created_at,own_delivery.id LIMIT 1
         ) first_delivery ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS branches,
                  count(*) FILTER (WHERE child.status='dead') AS branches_dead,
                  count(*) FILTER (WHERE child.status='failed') AS branches_failed,
                  count(*) FILTER (WHERE child.status NOT IN ('done','failed','dead')) AS branches_open,
                  max(GREATEST(child.updated_at,child.created_at,materialization.created_at)) AS last_event
           FROM agent_output_materializations materialization
           JOIN deliveries child ON child.id=materialization.produced_delivery_id
           WHERE materialization.status='materialized'
             AND materialization.correlation->>'root_message_id'=root.id::text
         ) chain ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (
                    WHERE continuation_delivery.status NOT IN ('done','failed','dead')
                  ) AS open_deliveries,
                  (count(*) FILTER (WHERE continuation.body->>'type'='agent.fanin') > 0) AS fanin_present,
                  max(GREATEST(
                    continuation_delivery.updated_at,continuation_delivery.created_at,continuation.created_at
                  )) AS last_event
           FROM messages continuation
           JOIN deliveries continuation_delivery ON continuation_delivery.message_id=continuation.id
           WHERE continuation.body->'correlation'->>'root_message_id'=root.id::text
             AND continuation.body->>'type' IN ('agent.response','agent.fanin')
         ) continuation ON true
         WHERE root.origin IS NOT NULL
           AND root.origin->>'adapter' IS NOT NULL
           AND root.created_at > now()-($3::bigint*interval '1 millisecond')
           AND root.created_at <= now()-(LEAST($1::bigint,$2::bigint)*interval '1 millisecond')
           AND COALESCE(root.body->>'type','') NOT IN ('agent.message','agent.response','agent.fanin','agent.notify')
           AND NOT EXISTS (
             SELECT 1 FROM agent_output_materializations produced
             WHERE produced.produced_message_id=root.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_chain_closures closure WHERE closure.root_message_id=root.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM adapter_outbox relay
             WHERE relay.kind='origin_relay'
               AND relay.payload->>'relay_kind' IS DISTINCT FROM 'ack'
               AND COALESCE(
                 relay.payload#>>'{correlation,root_message_id}',
                 relay.payload#>>'{correlation,message_id}'
               )=root.id::text
           )
       )
       SELECT root_message_id,tenant_id,request_id,trace_id,origin,
              root_delivery_id,root_status,root_attempt,root_max_attempts,
              branches,branches_dead,branches_failed,branches_open,
              open_work,fanin_present,
              GREATEST(0,extract(epoch FROM now()-last_event))::int AS idle_seconds
       FROM candidate
       WHERE (open_work=0 AND last_event <= now()-($2::bigint*interval '1 millisecond'))
          OR (open_work>0 AND last_event <= now()-($1::bigint*interval '1 millisecond'))
       ORDER BY last_event
       LIMIT $4`,
      [idleMs, settledGraceMs, maxAgeMs, limit]
    );
    result.scanned = candidates.rows.length;
    for (const candidate of candidates.rows) {
      try {
        // Una transacción por raíz. Una raíz envenenada (el caso histórico de la entrega
        // cross-tenant que violaba el FK de memberships) no puede llevarse puesto el barrido
        // entero ni, mucho menos, el tick del dispatcher.
        const outcome = await withTransaction(this.pool, (client) => this.closeSilentChain(client, candidate));
        if (outcome === 'fanin') result.faninRecovered += 1;
        else if (outcome === 'notified') result.notified += 1;
        else result.skipped += 1;
      } catch (error) {
        result.skipped += 1;
        console.error(JSON.stringify({
          event: 'chain_silence_sweep_failed',
          root_message_id: candidate.root_message_id,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return result;
  }

  /** Un candidato del vigía, bajo candado y en su propia transacción. */
  private async closeSilentChain(
    client: DatabaseClient,
    candidate: ChainSilenceCandidate
  ): Promise<'fanin' | 'notified' | 'skipped'> {
    // El mismo candado que toma `materializeAgentFanin`, así que un ACK en vuelo de esta
    // cadena y el vigía nunca se pisan. Es `try` y no bloqueante: si otro proceso la tiene,
    // la raíz se salta y vuelve en el barrido siguiente en vez de retener una conexión.
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired`,
      [`agent-fanin:${candidate.root_message_id}`]
    );
    if (lock.rows[0]?.acquired !== true) return 'skipped';

    // Relectura bajo candado: entre la consulta de candidatos y esta transacción la cadena
    // pudo cerrarse sola, y ese cierre real siempre gana sobre el aviso del vigía.
    const state = await client.query<{ closed: boolean; relayed: boolean }>(
      `SELECT EXISTS(
                SELECT 1 FROM agent_chain_closures closure WHERE closure.root_message_id=$1::uuid
              ) AS closed,
              EXISTS(
                SELECT 1 FROM adapter_outbox relay
                WHERE relay.kind='origin_relay'
                  AND relay.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                  AND COALESCE(
                    relay.payload#>>'{correlation,root_message_id}',
                    relay.payload#>>'{correlation,message_id}'
                  )=$1::text
              ) AS relayed`,
      [candidate.root_message_id]
    );
    if (state.rows[0]?.closed === true || state.rows[0]?.relayed === true) return 'skipped';

    // 1. Destrabe real. Un fan-in que ahora sí puede agendarse le devuelve al humano la
    //    síntesis del coordinador en vez de un diagnóstico de fallo.
    if (candidate.branches > 0 && !candidate.fanin_present) {
      await client.query('SAVEPOINT chain_silence_fanin');
      try {
        // Una rama que llegó a estado terminal SIN pasar por el ACK no tiene su fila de
        // `agent_output.response` y por eso es INCONTABLE para el fan-in: ver
        // `recordTerminalBranchesWithoutResponse`. Rellenarla sólo acá y sólo con la cadena
        // ya declarada muda y sin trabajo abierto.
        if (candidate.open_work === 0) {
          await this.recordTerminalBranchesWithoutResponse(client, candidate.root_message_id);
        }
        const fanin = await this.materializeAgentFanin(client, candidate.root_message_id);
        if (fanin.scheduled) {
          await client.query('RELEASE SAVEPOINT chain_silence_fanin');
          await this.recordChainSweepAudit(client, candidate, 'fanin_recovered', undefined, undefined);
          return 'fanin';
        }
        // No se destrabó: se descartan las filas sintéticas. Si quedaran, `chainSilenceDetail`
        // las contaría como ramas que devolvieron resultado y el aviso al humano diría que N
        // ramas contestaron cuando ninguna contestó. O destraba, o no deja rastro.
        await client.query('ROLLBACK TO SAVEPOINT chain_silence_fanin');
      } catch (error) {
        // Un fallo SQL acá envenena la transacción; el punto de guardado la devuelve intacta
        // para que la raíz igual termine avisada en vez de quedar muda una vez más.
        await client.query('ROLLBACK TO SAVEPOINT chain_silence_fanin');
        console.error(JSON.stringify({
          event: 'chain_silence_fanin_failed',
          root_message_id: candidate.root_message_id,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }

    // 2. Cierre con aviso agregado.
    const detail = await this.chainSilenceDetail(client, candidate.root_message_id);
    const reason: ChainSilenceClosureReason = candidate.open_work === 0
      ? 'settled_without_fanin'
      : 'idle_timeout';
    const text = chainSilenceNoticeText(candidate, detail, reason);
    const relay = await client.query<{ id: string }>(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
       ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING
       RETURNING id`,
      [
        originRelayTenant({ tenant_id: candidate.tenant_id, origin: candidate.origin }),
        candidate.origin.adapter,
        `relay-chain-closure:${candidate.root_message_id}`,
        candidate.request_id,
        candidate.root_message_id,
        candidate.root_delivery_id,
        candidate.trace_id,
        JSON.stringify(candidate.origin),
        JSON.stringify({
          outcome: 'failed',
          error: text,
          error_code: 'CHAIN_CLOSED_WITHOUT_ANSWER',
          result: {
            output: { reply: text, messages: [], status: 'failed', retryable: false, artifacts: [] }
          },
          chain_closure: {
            schema: 'cauce.chain_closure.v1',
            reason,
            branches: candidate.branches,
            branches_answered: detail.answered,
            branches_dead: candidate.branches_dead,
            branches_failed: candidate.branches_failed,
            branches_open: candidate.branches_open,
            open_work: candidate.open_work,
            idle_seconds: candidate.idle_seconds,
            ...(detail.cause === undefined
              ? {}
              : { dominant_cause: detail.cause, dominant_cause_count: detail.causeCount })
          },
          correlation: {
            request_id: candidate.request_id,
            message_id: candidate.root_message_id,
            root_message_id: candidate.root_message_id,
            trace_id: candidate.trace_id,
            ...(candidate.root_delivery_id === null ? {} : { delivery_id: candidate.root_delivery_id })
          }
        })
      ]
    );
    // El ancla durable de «un aviso por raíz, para siempre». Sobrevive a la purga del outbox
    // y es lo que saca a la raíz del conjunto de candidatos en el barrido siguiente.
    const closure = await client.query(
      `INSERT INTO agent_chain_closures(
         root_message_id,tenant_id,adapter,reason,branches,branches_answered,branches_dead,
         branches_open,dominant_cause,dominant_cause_count,idle_seconds,outbox_id
       ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(root_message_id) DO NOTHING`,
      [
        candidate.root_message_id,
        originRelayTenant({ tenant_id: candidate.tenant_id, origin: candidate.origin }),
        candidate.origin.adapter,
        reason,
        candidate.branches,
        detail.answered,
        candidate.branches_dead,
        candidate.branches_open,
        detail.cause ?? null,
        detail.causeCount,
        candidate.idle_seconds,
        relay.rows[0]?.id ?? null
      ]
    );
    if (!closure.rowCount) return 'skipped';
    await this.recordChainSweepAudit(client, candidate, 'closed', reason, detail);
    // Sin `pg_notify`: el canal `cauce_delivery_wake` despierta consumidores de entregas por
    // alias de agente, y esto no crea ninguna entrega. El puente toma el relay por
    // `claimOutbox`, que es el camino durable de siempre.
    return 'notified';
  }

  /**
   * Registra eventos de auditoría para ramas en estado terminal que carecen de respuesta grabada,
   * permitiendo desbloquear el conteo de fan-in en cadenas inactivas.
   */
  private async recordTerminalBranchesWithoutResponse(
    client: DatabaseClient,
    rootMessageId: string
  ): Promise<number> {
    const answered = await client.query<{ answered: boolean }>(
      `SELECT EXISTS(
                SELECT 1
                FROM agent_output_materializations materialization
                JOIN deliveries child ON child.id=materialization.produced_delivery_id
                WHERE materialization.status='materialized'
                  AND materialization.correlation->>'root_message_id'=$1
                  AND EXISTS (
                    SELECT 1 FROM audit_events response_audit
                    WHERE response_audit.action='agent_output.response'
                      AND response_audit.decision IN ('allow','deny')
                      AND response_audit.metadata->>'child_delivery_id'=child.id::text
                  )
              ) AS answered`,
      [rootMessageId]
    );
    const chainAnswered = answered.rows[0]?.answered === true;
    const filled = await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       )
       SELECT child.recipient_tenant,child.recipient_alias,
              'agent_output.response','deny',
              child_message.request_id,child.message_id,child.id,child_message.trace_id,
              jsonb_build_object(
                'reason','terminal_without_response',
                'child_delivery_id',child.id::text,
                'source_delivery_id',materialization.source_delivery_id::text,
                'target_tenant',materialization.source_tenant,
                'target_alias',materialization.source_alias,
                'outcome',child.status,
                'root_message_id',$1::text,
                'synthesized_by','chain_silence_sweep'
              )
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       JOIN messages child_message ON child_message.id=child.message_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
         AND child.status IN ('done','failed','dead')
         AND (child.status='done' OR $2::boolean)
         AND NOT EXISTS (
           SELECT 1 FROM agent_output_materializations descendant
           WHERE descendant.source_delivery_id=child.id
             AND descendant.status='materialized'
         )
         AND NOT EXISTS (
           SELECT 1 FROM audit_events response_audit
           WHERE response_audit.action='agent_output.response'
             AND response_audit.decision IN ('allow','deny')
             AND response_audit.metadata->>'child_delivery_id'=child.id::text
         )`,
      [rootMessageId, chainAnswered]
    );
    return filled.rowCount ?? 0;
  }

  /**
   * Detalle que sólo se calcula para una raíz que efectivamente se va a avisar (raro), nunca
   * en la consulta de candidatos: la causa dominante y el recuento de ramas que sí
   * devolvieron. La búsqueda por `metadata->>'child_delivery_id'` no tiene índice y es la
   * misma que ya paga el fan-in, así que no puede correr por cada candidato de cada barrido.
   */
  private async chainSilenceDetail(
    client: DatabaseClient,
    rootMessageId: string
  ): Promise<{ answered: number; cause?: string; causeCount: number }> {
    const answered = await client.query<{ answered: number }>(
      `SELECT count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM audit_events answer
                  WHERE answer.action='agent_output.response'
                    AND answer.decision IN ('allow','deny')
                    AND answer.metadata->>'child_delivery_id'=child.id::text
                )
              )::int AS answered
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1`,
      [rootMessageId]
    );
    const cause = await client.query<{ cause: string; total: number }>(
      `SELECT COALESCE(NULLIF(btrim(child.last_error),''),child.status) AS cause,count(*)::int AS total
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
         AND child.status IN ('dead','failed')
       GROUP BY 1
       ORDER BY total DESC,cause
       LIMIT 1`,
      [rootMessageId]
    );
    const dominant = cause.rows[0];
    return {
      answered: Number(answered.rows[0]?.answered ?? 0),
      ...(dominant === undefined
        ? {}
        : { cause: truncateUtf8(sanitizedDiagnostic(dominant.cause), chainSilenceCauseMaxBytes).value }),
      causeCount: Number(dominant?.total ?? 0)
    };
  }

  private async recordChainSweepAudit(
    client: DatabaseClient,
    candidate: ChainSilenceCandidate,
    action: 'fanin_recovered' | 'closed',
    reason: ChainSilenceClosureReason | undefined,
    detail?: { answered: number; cause?: string; causeCount: number }
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_chain.silence_sweep','info',$3,$4,$5,$6,$7::jsonb)`,
      [
        candidate.tenant_id,
        originBridgeAlias(candidate.origin),
        candidate.request_id,
        candidate.root_message_id,
        candidate.root_delivery_id,
        candidate.trace_id,
        JSON.stringify({
          outcome: action,
          ...(reason === undefined ? {} : { reason }),
          root_message_id: candidate.root_message_id,
          branches: candidate.branches,
          branches_dead: candidate.branches_dead,
          branches_failed: candidate.branches_failed,
          branches_open: candidate.branches_open,
          open_work: candidate.open_work,
          idle_seconds: candidate.idle_seconds,
          ...(detail === undefined
            ? {}
            : {
              branches_answered: detail.answered,
              ...(detail.cause === undefined
                ? {}
                : { dominant_cause: detail.cause, dominant_cause_count: detail.causeCount })
            })
        })
      ]
    );
  }

  async listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options: { limit?: number; before?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
    }
    const before = options.before ?? null;
    if (before !== null && (
      !/^[1-9][0-9]{0,18}$/u.test(before)
      || BigInt(before) > 9_223_372_036_854_775_807n
    )) {
      throw new StoreError('invalid_input', 'audit cursor is invalid');
    }
    const result = await this.pool.query<{
      event_id: string;
      at: Date | string;
      tenant_id: string | null;
      actor_alias: string | null;
      action: string;
      decision: string;
      request_id: string | null;
      trace_id: string | null;
      metadata: unknown;
    }>(
      `SELECT audit.id AS event_id,audit.created_at AS at,audit.tenant_id,audit.actor_alias,
              audit.action,audit.decision,audit.request_id,audit.trace_id,audit.metadata
       FROM audit_events audit
       LEFT JOIN messages message ON message.id=audit.message_id
       WHERE (
         (audit.tenant_id=$1 AND audit.actor_alias=$2)
         OR (message.id IS NOT NULL AND EXISTS (
           SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
             AND source_member.room_id=message.room_id AND source_member.alias=$2
             AND source_member.enabled AND message.tenant_id=$1
         ))
         OR (audit.delivery_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM deliveries participant WHERE participant.id=audit.delivery_id
             AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2
         ))
       )
         AND ($3::bigint IS NULL OR audit.id < $3::bigint)
       ORDER BY audit.id DESC LIMIT $4`, [actorTenant, actorAlias, before, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const visible = result.rows.slice(0, limit);
    return {
      items: visible.map((row) => ({
        event_id: String(row.event_id),
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        tenant_id: row.tenant_id,
        actor_alias: row.actor_alias,
        action: row.action,
        decision: row.decision,
        request_id: row.request_id,
        trace_id: row.trace_id,
        summary: safeAuditSummary(row.action, row.metadata),
      })),
      next_cursor: hasMore && visible.length > 0
        ? String(visible[visible.length - 1]!.event_id)
        : null,
    };
  }

  /**
   * Actividad en vuelo de toda la flota visible para el actor, agregada por alias. Es la mitad
   * "qué está trabajando cada agente ahora" del panel pedido; la otra mitad (consumo de cuota)
   * vive en quotaSnapshot() con su propio observed_at porque las dos frescuras son
   * incomparables -- ésta es de hace milisegundos, la de cuota es una muestra fuera de banda de
   * hace minutos.
   *
   * Self-contained como topology()/listAgents(): valida el permiso acá mismo, así que la ruta
   * sólo necesita el chequeo de rol+permiso sobre el Principal (requireOperatorPermission).
   *
   * FLEET_ACTIVITY_QUERY es sólo lectura, sin locks y sin funciones de ventana a propósito
   * (ver el comentario en fleet-activity.ts): un panel quiere una foto, no una que congele el
   * despacho mientras la saca, y Postgres rechaza al parsear cualquier combinación de
   * FOR SHARE/FOR UPDATE con funciones de ventana.
   */
  async fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const thresholds = DEFAULT_FLEET_ACTIVITY_THRESHOLDS;
    const result = await this.pool.query<Record<string, unknown>>(FLEET_ACTIVITY_QUERY, [
      actorTenant, thresholds.ack_recent_seconds, thresholds.ack_lookback_seconds, thresholds.items_per_agent
    ]);

    const agents = result.rows.map((row) => {
      // lease_online sale de `(lease.lease_until > now())`: NULL cuando el LEFT JOIN no
      // encontró ninguna fila de lease (nunca se conectó), no cuando el lease está vencido.
      const leaseOnline = row.lease_online === null || row.lease_online === undefined
        ? null : row.lease_online === true;
      // NULL acá es "ningún ACK aplicado dentro de la ventana de búsqueda", la señal MÁS grave;
      // Number(null) daría 0 y lo pintaría como recién ackeado, exactamente al revés.
      const secondsSinceLastAck = row.seconds_since_last_ack === null || row.seconds_since_last_ack === undefined
        ? null : Number(row.seconds_since_last_ack);
      const inFlight = Number(row.in_flight ?? 0);
      const queued = Number(row.queued ?? 0);
      const overdueInFlight = Number(row.overdue_in_flight ?? 0);
      const registered = row.registered === true;

      const { work_state, flags } = agentWorkState(
        { registered, in_flight: inFlight, queued, overdue_in_flight: overdueInFlight, seconds_since_last_ack: secondsSinceLastAck, lease_online: leaseOnline },
        thresholds
      );

      return {
        tenant_id: row.tenant_id,
        alias: row.alias,
        display_name: row.display_name ?? null,
        harness_id: row.harness_id ?? null,
        registered,
        agent_enabled: row.agent_enabled === true,
        presence: {
          online: leaseOnline,
          instance_id: row.instance_id ?? null,
          // bigint: el driver de pg lo devuelve como string; el resto de este archivo ya
          // convierte epoch de la misma forma (ver acquireLease/heartbeat más arriba).
          epoch: row.epoch === null || row.epoch === undefined ? null : Number(row.epoch),
          last_heartbeat_at: row.last_heartbeat_at ?? null,
          lease_until: row.lease_until ?? null
        },
        work_state,
        flags,
        in_flight: inFlight,
        started: Number(row.started ?? 0),
        claimed_not_started: Number(row.claimed_not_started ?? 0),
        queued,
        queued_ready: Number(row.queued_ready ?? 0),
        retrying: Number(row.retrying ?? 0),
        overdue_in_flight: overdueInFlight,
        oldest_claimed_at: row.oldest_claimed_at ?? null,
        oldest_in_flight_seconds: row.oldest_in_flight_seconds === null || row.oldest_in_flight_seconds === undefined
          ? null : Number(row.oldest_in_flight_seconds),
        nearest_ack_deadline_at: row.nearest_ack_deadline_at ?? null,
        max_attempt: row.max_attempt === null || row.max_attempt === undefined ? null : Number(row.max_attempt),
        last_ack_at: row.last_ack_at ?? null,
        seconds_since_last_ack: secondsSinceLastAck,
        acks_recent: Number(row.acks_recent ?? 0),
        in_flight_items_truncated: row.in_flight_items_truncated === true,
        in_flight_items: Array.isArray(row.in_flight_items) ? row.in_flight_items : [],
        // Las salas del alias, ya resueltas por el SQL. `[]` es un valor legítimo -- registrado y
        // sin sala -- y la consola lo dibuja igual; no se colapsa a null ni se omite el campo,
        // porque "no tiene sala" y "el servidor no informa salas" se renderizan distinto.
        rooms: Array.isArray(row.rooms) ? (row.rooms as string[]) : []
      };
    });

    const byState = Object.fromEntries(FLEET_WORK_STATES.map((state) => [state, 0])) as Record<FleetWorkState, number>;
    const flagged = Object.fromEntries(FLEET_ACTIVITY_FLAGS.map((flag) => [flag, 0])) as Record<FleetActivityFlag, number>;
    const totals = agents.reduce((acc, agent) => {
      acc.agents += 1;
      byState[agent.work_state] += 1;
      for (const flag of agent.flags) flagged[flag] += 1;
      acc.in_flight += agent.in_flight;
      acc.queued += agent.queued;
      acc.retrying += agent.retrying;
      acc.overdue_in_flight += agent.overdue_in_flight;
      return acc;
    }, { agents: 0, in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0 });

    return {
      observed_at: new Date().toISOString(),
      thresholds,
      totals: { ...totals, by_state: byState, flagged },
      agents
    };
  }

  /**
   * Inventario DLQ operativo sin payloads ni ids externos. La base aplica control multi-tenant y
   * liga el cursor opaco a la identidad del operador; cambiar actor o reutilizar un cursor de otro
   * scope falla cerrado. No es una firma: un actor autorizado sólo puede alterar navegación dentro
   * de su scope. El orden keyset es estable ante reaperturas porque usa el
   * `created_at` inmutable de la carta, más target e id como desempates.
   */
  async listOperationalDlq(
    actorTenant: Tenant,
    actorAlias: string,
    limit = 200,
    cursor: string | null = null
  ): Promise<OperationalDlqPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'DLQ list limit must be between 1 and 500');
    }
    if (cursor !== null && (cursor.length < 2 || cursor.length > 1024
      || cursor.length % 2 !== 0 || !/^[a-f0-9]+$/.test(cursor))) {
      throw new StoreError('invalid_input', 'DLQ list cursor is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqPage }>(
      `SELECT cauce_list_dlq_030($1,$2,$3,$4) AS value`,
      [actorTenant, actorAlias, limit, cursor]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ list did not return a page');
    return value;
  }

  /** Exact, operator-audited closure of one classified incident without replay or side effects. */
  async resolveOperationalDlqWithoutReplay(
    actorTenant: Tenant,
    actorAlias: string,
    request: OperationalDlqResolutionRequest
  ): Promise<OperationalDlqResolutionResult> {
    const reason = request.reason.trim();
    if ((request.target !== 'delivery' && request.target !== 'outbox')
      || !UUID_PATTERN.test(request.id)
      || !/^[a-f0-9]{64}$/.test(request.evidenceSha256)
      || reason.length < 1 || reason.length > 1_000
      || [...reason].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
      || typeof request.possibleDuplicateAcknowledged !== 'boolean'
      || typeof request.possibleNoDeliveryAcknowledged !== 'boolean') {
      throw new StoreError('invalid_input', 'DLQ no-replay resolution request is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqResolutionResult }>(
      `SELECT cauce_resolve_dlq_without_replay_030(
         $1,$2::uuid,$3,$4,$5,$6,$7,$8
       ) AS value`,
      [
        request.target, request.id, request.evidenceSha256, reason, actorTenant, actorAlias,
        request.possibleDuplicateAcknowledged, request.possibleNoDeliveryAcknowledged,
      ]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ no-replay resolution returned no receipt');
    return value;
  }

  async queueSnapshot(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT d.id AS delivery_id,d.message_id,d.recipient_tenant AS tenant_id,d.recipient_alias,
              m.tenant_id AS message_tenant_id,m.actor_alias,m.lane,d.status AS state,
              d.attempt AS attempts,d.max_attempts,d.available_at,d.last_error
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))
       ORDER BY d.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    // 'failed' cuenta como dead letter porque desde este parche LO ES: `ackDelivery` le escribe
    // su fila y `replayDelivery` la acepta. Dejarla fuera del contador mantendría al operador
    // creyendo que no hay nada que revisar mientras el botón de replay ya está disponible: el
    // mismo desfase que hizo invisibles las 197 entregas de producción.
    const counts = result.rows.reduce<{ pending: number; retrying: number; dead: number }>((value, row) => {
      if (row.state === 'retry') value.retrying += 1;
      if (row.state === 'dead' || row.state === 'failed') value.dead += 1;
      if (['pending', 'leased', 'accepted', 'started'].includes(String(row.state))) value.pending += 1;
      return value;
    }, { pending: 0, retrying: 0, dead: 0 });

    // Conteo total agregado con los mismos filtros de visibilidad que el listado.
    const totales = await this.pool.query<{ pending: string; retrying: string; dead: string; total: string }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started')) AS pending,
              count(*) FILTER (WHERE d.status = 'retry') AS retrying,
              count(*) FILTER (WHERE d.status IN ('dead','failed')) AS dead,
              count(*) AS total
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))`, [actorTenant, actorAlias]
    );
    const fila = totales.rows[0];
    const totals = {
      pending: Number(fila?.pending ?? 0),
      retrying: Number(fila?.retrying ?? 0),
      dead: Number(fila?.dead ?? 0),
    };
    // «Recortada» se decide comparando con el total, no con `items.length === limit`: si hubiera
    // exactamente `limit` entregas, esa comprobación diría que falta algo cuando no falta nada.
    const muestra_recortada = Number(fila?.total ?? 0) > result.rows.length;

    return {
      observed_at: new Date().toISOString(),
      ...counts,
      totals,
      muestra_recortada,
      items: result.rows,
    };
  }
}
