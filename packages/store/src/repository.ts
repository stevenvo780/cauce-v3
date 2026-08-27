import { StoreError } from './repository/quotas.js';
import { terminal } from './repository/messages.js';
import { AgentFaninRepository, chainNode, uuidPattern } from './repository/agents/fanin.js';
import {
  handlePattern, maxAgentOutputMessages, maxNotifyBodyBytes,
  notifyKinds, postgresTextSafe,
  type AckResult, type AgentNotifyEntry, type AgentOutputEntry, type AgentOutputOutcome,
  type DelegationMaterialization, type DelegationRejection, type NotifyDenialCode,
  type OpenChainGate
} from './repository/deliveries.js';
import {
  reservedInternalMessageTypes, sha256
} from './repository/config.js';
import { objectRecord, visibleText } from './repository/outbox.js';
export {
  PublishIntentExpiredError, PublishIntentReconciliationRequired,
  type PublishOptions, type PublishResult
} from './repository/messages.js';
export { type ProfileRuntimeAdoptionAck } from './repository/agents.js';
export { failureSignature, type AgentChainProgressStage } from './repository/agents/fanin.js';
export {
  type AckResult, type ClaimedDeliveryEnvelope, type DelegationMaterialization,
  type DelegationRejection, type DeliveryAdmission, type LeaseAcquireOptions,
  type LeaseResult, type LiveDeliveryClaim, type NotifyDenialCode
} from './repository/deliveries.js';
import {
  aliasPattern, disabledChainPolicy, originRelayTenant, tenantPattern, truncateUtf8
} from './repository/observability.js';
import type { ChainPolicy, DeliveryRow } from './repository/observability.js';
export {
  DEFAULT_QUOTA_THRESHOLDS, StoreError, windowSeverity, worstQuotaSeverity,
  type QuotaSampleIngestResult, type QuotaSamplePausedAccount, type QuotaSampleResumedAccount,
  type QuotaSampleUnboundGroup, type QuotaSeverity, type QuotaThresholds, type StoreErrorCode
} from './repository/quotas.js';
export {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  deliveryLeaseCapMs, timeoutRetryBackoffSeconds, type ChainSilenceClosureReason,
  type ChainSilenceSweepOptions, type ChainSilenceSweepResult, type DeliveryLeaseCap,
  type ObservabilityRetentionPolicy, type ObservabilityRetentionResult, type OperationalDlqItem,
  type OperationalDlqPage, type OperationalDlqResolutionRequest,
  type OperationalDlqResolutionResult, type StaleDeliveryPolicy
} from './repository/observability.js';
export { type JobClaim } from './repository/jobs.js';
export {
  type ClaimedOutboxEvent, type ConnectionSessionFence, type FencedWakeOutboxRecipient,
  type OutboxAck, type OutboxEvent, type OutboxRetryResult, type WakeOutboxClaimFence,
  type WakeOutboxRecipient
} from './repository/outbox.js';
export {
  PublishIntentRateLimitedError, type AgentTargetPermission, type AuthorizedAgentTarget
} from './repository/config.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Ack,
  NotifyRequest, Origin, Tenant
} from '@cauce/protocol';
import {
  clampAgentPriority,
  DelegationMaterializationSchema, DelegationRejectionSchema,
  MAX_DELEGATION_FEEDBACK_ITEMS
} from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { withTransaction } from './db.js';
import { selectAccountForAlias, type AccountSelection } from './accounts.js';
import {
  boundedRejectionTarget,
  describeDelegationRejection, DISABLED_DELEGATION_CAPS, fanoutCapForTurn, HUMAN_GATE_TARGET,
  rejectionText, sanitizedDelegationCaps,
  type DelegationRejectionCode, type RejectionNotice
} from './delegation-guard.js';

/** Carries a dry-run verdict out of a transaction that must be rolled back. */
class NotificationPreview extends Error {
  constructor(readonly verdict: NotificationVerdict) {
    super('proactive egress preview rollback');
    this.name = 'NotificationPreview';
  }
}














const agentOutputHopBudget = 16;
const maxAgentOutputExpandedBytes = 512 * 1024;
const maxVisitedPathEntries = agentOutputHopBudget;
/** Coincide con el CHECK de `agent_chain_gates.question` (8192 caracteres). */
const maxChainGateQuestionBytes = 8 * 1_024;

/**
 * Durable rejection domain; migration 008 widens the CHECK with 'cycle_detected' and migration
 * 019 with los cinco de disciplina de delegación. La lista vive en delegation-guard.ts para que
 * el texto legible de cada código y el código mismo no se puedan desincronizar.
 */
export type AgentOutputRejectionCode = DelegationRejectionCode;

/**
 * A hop budget is only trusted when it is a safe positive integer, and it is always
 * saturated at the durable ceiling. A zero would violate CHECK (hop_budget > 0) and abort
 * the whole ACK transaction, and an inflated one would propagate hop after hop.
 */
function safeHopBudget(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, agentOutputHopBudget)
    : agentOutputHopBudget;
}

/** Hop counts saturate at the budget, so `inherited + 1` can never overflow an integer column. */
function safeHopCount(value: unknown, budget: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, budget)
    : 0;
}

/** Only canonical `tenant/alias` entries survive; the column is store-written, never client input. */
function sanitizedVisitedPath(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const path: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || path.includes(entry)) continue;
    const separator = entry.indexOf('/');
    if (separator < 0) continue;
    const tenant = entry.slice(0, separator);
    const alias = entry.slice(separator + 1);
    if (!tenantPattern.test(tenant) || !aliasPattern.test(alias)) continue;
    path.push(entry);
    if (path.length === maxVisitedPathEntries) break;
  }
  return path;
}


interface ResolvedAgentOutputEntry extends AgentOutputEntry {
  targetTenant?: Tenant;
  targetRef?: unknown;
}


interface AgentOutputLineage {
  hop_count: number | null;
  hop_budget: number | null;
  correlation: Record<string, unknown> | null;
  visited_path: string[] | null;
}


export interface NotificationVerdict {
  notification_id: string;
  decision: 'allowed' | 'denied';
  denial_code?: NotifyDenialCode;
  message_id?: string;
  outbox_id?: string;
  duplicate: boolean;
  dry_run: boolean;
}


interface NotificationRequest extends AgentNotifyEntry {
  idempotencyKey: string;
}

interface NotificationContext {
  tenant: Tenant;
  alias: string;
  source: 'agent_output' | 'http' | 'job';
  requestId: string;
  traceId: string;
  sourceDeliveryId?: string;
  sourceAttempt?: number;
  sourceMessageId?: string;
  sourceRootMessageId?: string;
}

interface EgressDestinationRow {
  adapter: string;
  channel: string;
  conversation_id: string;
  conversation_kind: string;
  allow_kinds: string[];
  require_prior_contact: boolean;
  contact_ttl_days: number;
  min_interval_seconds: number;
  max_per_hour: number;
  max_per_day: number;
  max_per_root: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_tz: string;
  enabled: boolean;
}






/** Prefijo estable del motivo de una cancelación: es lo que permite contarlas sin heurística. */
const cancellationReasonPrefix = 'Cancelled by operator';
const maxCancellationReasonBytes = 500;

/**
 * Motivo con el que queda marcada una entrega cancelada.
 *
 * El prefijo es fijo y la nota del operador va después, recortada. Dos razones: `last_error` y
 * `dead_letters.reason` los lee un humano en la consola, y un texto libre sin techo puede venir
 * de un cliente. El NUL se saca porque PostgreSQL no lo acepta en `text` y el `INSERT`
 * abortaría la transacción entera de la cancelación.
 */
function cancellationReason(actorTenant: Tenant, actorAlias: string, reason?: string): string {
  const header = `${cancellationReasonPrefix} ${actorTenant}:${actorAlias}`;
  const note = visibleText(postgresTextSafe(reason));
  if (!note) return header;
  const trimmed = note.length > maxCancellationReasonBytes
    ? `${note.slice(0, maxCancellationReasonBytes)}…`
    : note;
  return `${header}: ${trimmed}`;
}





/** A stable RFC 4122 UUID derived from the delivery attempt and output index. */
function agentOutputRequestId(deliveryId: string, attempt: number, outputIndex: number): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`agent-output:${deliveryId}:${attempt}:${outputIndex}`).digest('hex').slice(0, 32),
    'hex'
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * messages_request_actor_idx is UNIQUE(tenant_id, actor_alias, request_id), so a
 * derived request_id keeps a re-ACK of the same attempt from ever producing a
 * second notification message even if the first idempotency layer were bypassed.
 */
function agentNotifyRequestId(deliveryId: string, attempt: number, notifyIndex: number): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`agent-notify:${deliveryId}:${attempt}:${notifyIndex}`).digest('hex').slice(0, 32),
    'hex'
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class CauceRepository extends AgentFaninRepository {

















  /**
   * Reads the versioned chain policy without ever aborting the caller's transaction.
   * A missing table or column is a legitimate state during a partial deploy, and a
   * `42P01`/`42703` inside the ACK transaction would poison every later statement, so the
   * catalog is probed first with a query that cannot fail.
   */
  protected async loadChainPolicy(client: DatabaseClient): Promise<ChainPolicy> {
    const schema = await client.query<{
      policies_present: boolean;
      visited_path_present: boolean;
      failure_coalesce_present: boolean;
      delegation_caps_present: boolean;
      human_gate_present: boolean;
    }>(
      `SELECT to_regclass('public.agent_chain_policies') IS NOT NULL AS policies_present,
              EXISTS (
                SELECT 1 FROM pg_attribute attribute
                WHERE attribute.attrelid=to_regclass('public.agent_output_materializations')
                  AND attribute.attname='visited_path' AND NOT attribute.attisdropped
              ) AS visited_path_present,
              (
                to_regclass('public.agent_failure_notices') IS NOT NULL
                AND to_regclass('public.agent_failure_notice_events') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='failure_coalesce_enabled' AND NOT attribute.attisdropped
                )
              ) AS failure_coalesce_present,
              (
                to_regclass('public.agent_chain_edge_uses') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='delegation_caps_enabled' AND NOT attribute.attisdropped
                )
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_progress')
                    AND attribute.attname='delegations' AND NOT attribute.attisdropped
                )
              ) AS delegation_caps_present,
              (
                to_regclass('public.agent_chain_gates') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='human_gate_enabled' AND NOT attribute.attisdropped
                )
              ) AS human_gate_present`
    );
    const visitedPathAvailable = schema.rows[0]?.visited_path_present === true;
    // Migration 014 ships the two ledger tables and the two policy columns in one transaction,
    // but the probe still checks all three: a half-applied schema must degrade to "no
    // coalescing" instead of raising 42P01/42703 inside the ACK transaction, which would
    // poison every later statement of the same turn.
    const failureCoalesceAvailable = schema.rows[0]?.failure_coalesce_present === true;
    // Migración 019: mismo contrato de despliegue parcial. Sin la tabla de aristas, sin la
    // columna de combustible o sin las columnas de política, los topes quedan APAGADOS y
    // `materializeAgentOutputs` se comporta exactamente como antes de 019. Nunca 42P01/42703
    // dentro de la transacción del ACK.
    const delegationCapsAvailable = schema.rows[0]?.delegation_caps_present === true;
    const humanGateAvailable = schema.rows[0]?.human_gate_present === true;
    if (schema.rows[0]?.policies_present !== true) {
      return { ...disabledChainPolicy, visitedPathAvailable };
    }
    const policy = await client.query<{
      progress_relay_enabled: boolean;
      progress_relay_max_events: number;
      cycle_cut_enabled: boolean;
      failure_coalesce_enabled: boolean | null;
      failure_coalesce_window_seconds: number | null;
      delegation_caps_enabled: boolean | null;
      max_fanout_per_turn: number | null;
      max_edge_repeats_per_root: number | null;
      max_delegations_per_root: number | null;
      human_gate_enabled: boolean | null;
    }>(
      `SELECT progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
              ${failureCoalesceAvailable
                ? 'failure_coalesce_enabled,failure_coalesce_window_seconds'
                : 'NULL::boolean AS failure_coalesce_enabled,NULL::integer AS failure_coalesce_window_seconds'},
              ${delegationCapsAvailable
                ? 'delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,max_delegations_per_root'
                : `NULL::boolean AS delegation_caps_enabled,NULL::integer AS max_fanout_per_turn,
                   NULL::integer AS max_edge_repeats_per_root,NULL::integer AS max_delegations_per_root`},
              ${humanGateAvailable
                ? 'human_gate_enabled'
                : 'NULL::boolean AS human_gate_enabled'}
       FROM agent_chain_policies WHERE id='default'`
    );
    const row = policy.rows[0];
    if (!row) return { ...disabledChainPolicy, visitedPathAvailable };
    const windowSeconds = Number.isSafeInteger(row.failure_coalesce_window_seconds)
      ? Number(row.failure_coalesce_window_seconds)
      : 0;
    return {
      progressRelayEnabled: row.progress_relay_enabled === true,
      progressRelayMaxEvents: Number.isSafeInteger(row.progress_relay_max_events)
        ? row.progress_relay_max_events
        : 0,
      cycleCutEnabled: row.cycle_cut_enabled === true && visitedPathAvailable,
      visitedPathAvailable,
      failureCoalesceEnabled: failureCoalesceAvailable && row.failure_coalesce_enabled === true,
      // A saturated ceiling, never a raw value: the CHECK on the column is NOT VALID, so a row
      // written before it existed could still carry an absurd window and mute a parent for days.
      failureCoalesceWindowSeconds: Math.min(86_400, Math.max(0, windowSeconds)),
      failureCoalesceAvailable,
      delegationCaps: delegationCapsAvailable
        ? sanitizedDelegationCaps({
          enabled: row.delegation_caps_enabled === true,
          maxFanoutPerTurn: row.max_fanout_per_turn ?? undefined,
          maxEdgeRepeatsPerRoot: row.max_edge_repeats_per_root ?? undefined,
          maxDelegationsPerRoot: row.max_delegations_per_root ?? undefined
        })
        : DISABLED_DELEGATION_CAPS,
      delegationCapsAvailable,
      humanGateEnabled: humanGateAvailable && row.human_gate_enabled === true,
      humanGateAvailable
    };
  }

  /**
   * Resolves the branch that opened this coordinator turn when the delivery being ACKed is
   * an authenticated agent.response continuation. The store proved that correlation with an
   * audit row when it created the response, so the delegation path keeps growing across
   * continuations instead of restarting at every hop.
   */
  private async continuationBranchMaterialization(
    client: DatabaseClient,
    row: DeliveryRow,
    visitedPathAvailable: boolean
  ): Promise<AgentOutputLineage | undefined> {
    if (row.body.type !== 'agent.response') return undefined;
    const correlation = objectRecord(row.body.correlation);
    const claimed = typeof correlation?.response_to_delivery_id === 'string'
      && uuidPattern.test(correlation.response_to_delivery_id)
      ? correlation.response_to_delivery_id
      : undefined;
    if (claimed === undefined) return undefined;
    const trusted = await client.query(
      `SELECT 1 FROM audit_events
       WHERE message_id=$1 AND delivery_id=$2
         AND action='agent_output.response' AND decision='allow'
       LIMIT 1 FOR SHARE`,
      [row.message_id, row.id]
    );
    if (trusted.rowCount !== 1) return undefined;
    const parent = await client.query<AgentOutputLineage>(
      `SELECT materialization.hop_count,materialization.hop_budget,materialization.correlation,
              ${visitedPathAvailable ? 'materialization.visited_path' : `'{}'::text[] AS visited_path`}
       FROM agent_output_materializations materialization
       WHERE materialization.produced_delivery_id=$1 AND materialization.status='materialized'
       LIMIT 1
       FOR SHARE OF materialization`,
      [claimed]
    );
    return parent.rows[0];
  }

  /**
   * Rebuild the capability-gated receipt from durable materialization rows.
   *
   * This is used for an exact repeated event after the DB committed but the adapter died before
   * receiving ack_result. It returns the same ordered identities/notices as the fresh ACK and
   * never selects target_ref_hash, body_hash, messages or bodies.
   */
  protected override async delegationFeedbackForAck(
    client: DatabaseClient,
    deliveryId: string,
    attempt: number,
  ): Promise<Pick<AckResult, "delegation_rejections" | "delegation_materializations">> {
    const rows = await client.query<{
      output_index: number;
      status: 'materialized' | 'rejected';
      target_tenant: Tenant | null;
      target_alias: string | null;
      produced_delivery_id: string | null;
      rejection: unknown;
    }>(
      `SELECT output_index,status,target_tenant,target_alias,produced_delivery_id,
              correlation->'rejection' AS rejection
       FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND source_attempt=$2
       ORDER BY output_index
       LIMIT $3`,
      [deliveryId, attempt, MAX_DELEGATION_FEEDBACK_ITEMS + 1],
    );
    if (rows.rows.length > MAX_DELEGATION_FEEDBACK_ITEMS) {
      throw new StoreError('conflict', 'durable delegation feedback exceeds the wire limit');
    }
    const delegationRejections: DelegationRejection[] = [];
    const delegationMaterializations: DelegationMaterialization[] = [];
    for (const row of rows.rows) {
      if (row.status === 'materialized') {
        delegationMaterializations.push(DelegationMaterializationSchema.parse({
          output_index: row.output_index,
          target_tenant: row.target_tenant,
          target_alias: row.target_alias,
          child_delivery_id: row.produced_delivery_id,
        }));
        continue;
      }
      const rejection = objectRecord(row.rejection);
      const parsed = DelegationRejectionSchema.safeParse({
        output_index: row.output_index,
        ...rejection,
      });
      // Rows written before readable rejection notices existed cannot reconstruct text exactly.
      // Omitting legacy feedback is safer than breaking every reconnect with an invalid frame.
      if (parsed.success) delegationRejections.push(parsed.data);
    }
    return {
      ...(delegationRejections.length === 0
        ? {}
        : { delegation_rejections: delegationRejections }),
      ...(delegationMaterializations.length === 0
        ? {}
        : { delegation_materializations: delegationMaterializations }),
    };
  }

  protected override async materializeAgentOutputs(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    outputs: AgentOutputEntry[],
    policy: ChainPolicy
  ): Promise<AgentOutputOutcome> {
    if (outputs.length === 0) {
      return { materialized: 0, suspended: false, rejections: [], materializations: [] };
    }

    const sourceMembership = await client.query<{ room_id: string }>(
      `SELECT membership.room_id
       FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND policy.allow_route
       ORDER BY membership.room_id LIMIT 1`,
      [row.recipient_tenant, row.recipient_alias]
    );
    const sourceRoomId = sourceMembership.rows[0]?.room_id;
    if (!sourceRoomId) {
      throw new StoreError('invalid_actor', 'delivery consumer has no source room for agent output');
    }

    const parent = await client.query<AgentOutputLineage & { cycle_detected: boolean }>(
      `WITH RECURSIVE message_lineage(message_id,depth,path,cycle_detected) AS (
         SELECT $1::uuid,0,ARRAY[$1::uuid],false
         UNION ALL
         SELECT (replay.metadata->>'replayed_from_message_id')::uuid,lineage.depth+1,
                lineage.path || (replay.metadata->>'replayed_from_message_id')::uuid,
                (replay.metadata->>'replayed_from_message_id')::uuid=ANY(lineage.path)
         FROM message_lineage lineage
         JOIN LATERAL (
           SELECT audit.metadata
           FROM audit_events audit
           WHERE audit.message_id=lineage.message_id
             AND audit.action='delivery.replay' AND audit.decision='allow'
             AND (audit.metadata->>'replayed_from_message_id') ~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
           ORDER BY audit.id DESC LIMIT 1
         ) replay ON true
         WHERE NOT lineage.cycle_detected
       ), parent AS (
         SELECT materialization.hop_count,materialization.hop_budget,materialization.correlation,
                ${policy.visitedPathAvailable
                  ? 'materialization.visited_path'
                  : `'{}'::text[] AS visited_path`}
         FROM message_lineage lineage
         JOIN agent_output_materializations materialization
           ON materialization.produced_message_id=lineage.message_id
         ORDER BY lineage.depth LIMIT 1
       )
       SELECT parent.hop_count,parent.hop_budget,parent.correlation,parent.visited_path,
              EXISTS(SELECT 1 FROM message_lineage WHERE cycle_detected) AS cycle_detected
       FROM (SELECT true) guard LEFT JOIN parent ON true`,
      [row.message_id]
    );
    if (parent.rows[0]?.cycle_detected) {
      throw new StoreError('conflict', 'replay lineage cycle detected');
    }
    const parentMaterialization = parent.rows[0]?.hop_count === null || parent.rows[0] === undefined
      ? await this.continuationBranchMaterialization(client, row, policy.visitedPathAvailable)
      : parent.rows[0];
    // Provenance rule: a correlation carried by the body is authoritative only for the
    // reserved internal types, which no client can publish (see publish() and
    // AuthenticatedPublishBodySchema). Any other body is a client-controlled surface, so a
    // publisher can no longer graft its delegations onto another chain's root, poison the
    // hop budget, or abort the ACK transaction with a non-integer hop count.
    const bodyCorrelation = typeof row.body.type === 'string'
      && reservedInternalMessageTypes.has(row.body.type)
      ? objectRecord(row.body.correlation)
      : undefined;
    const hopBudget = safeHopBudget(parentMaterialization?.hop_budget ?? bodyCorrelation?.hop_budget);
    const inheritedHopCount = safeHopCount(
      parentMaterialization?.hop_count ?? bodyCorrelation?.hop_count,
      hopBudget
    );
    const hopCount = inheritedHopCount + 1;
    const parentCorrelation = objectRecord(parentMaterialization?.correlation) ?? bodyCorrelation;
    const rootRequestId = typeof parentCorrelation?.root_request_id === 'string'
      && uuidPattern.test(parentCorrelation.root_request_id)
      ? parentCorrelation.root_request_id
      : row.request_id;
    const rootMessageId = typeof parentCorrelation?.root_message_id === 'string'
      && uuidPattern.test(parentCorrelation.root_message_id)
      ? parentCorrelation.root_message_id
      : row.message_id;
    const rootDeliveryId = typeof parentCorrelation?.root_delivery_id === 'string'
      && uuidPattern.test(parentCorrelation.root_delivery_id)
      ? parentCorrelation.root_delivery_id
      : row.id;
    // Simetría con hop_count. El camino visitado se reconstruye desde la fila del padre y el
    // consumidor actual se agrega del lado del servidor, pero hasta acá NO tenía el respaldo
    // que hop_count sí tiene (`?? bodyCorrelation.hop_count`, arriba). Esa asimetría dejaba
    // CIEGO al guarda de ciclo: medida en filas reales de prod como
    // `hop_count=16 | vp_len=1 | corr_has_hop=t | corr_has_vp=f`, el hop sobrevivía y el
    // camino se reiniciaba en largo 1, así que `visitedPath.includes(destino)` nunca podía
    // ser verdadero por más que se encendiera `cycle_cut_enabled`.
    //
    // Dos estados producen esa pérdida y el respaldo cubre a los dos:
    //   - la fila del padre no existe (continuación `agent.response` en la RAÍZ de la cadena:
    //     `continuationBranchMaterialization` busca `produced_delivery_id=<entrega raíz>`, que
    //     por definición no nació de ninguna materialización);
    //   - la fila existe pero con el camino vacío (migración 008 declara
    //     `visited_path text[] NOT NULL DEFAULT '{}'`, así que toda fila anterior a 008 —y toda
    //     fila escrita durante un despliegue parcial con `visitedPathAvailable=false`— vale '{}').
    //
    // Un camino vacío es un centinela fiable de "sin información", no un dato legítimo: toda
    // materialización guarda al menos a su propio emisor, así que su camino nunca es
    // legítimamente vacío. Por eso caer a la correlación jamás pisa un dato bueno; sólo
    // rellena uno ausente.
    //
    // Procedencia: se lee exactamente la misma superficie de confianza que ya usa hop_count.
    // `bodyCorrelation` sólo está definido para los tipos internos reservados, que ningún
    // cliente puede publicar (publish() lo rechaza con 'forbidden'), y además
    // `sanitizedVisitedPath` revalida cada entrada contra tenantPattern/aliasPattern. Un
    // publicador sigue sin poder sembrar el camino para censurar una delegación legítima.
    //
    // Cota: se reserva un lugar para el nodo actual antes de heredar, de modo que el
    // consumidor SIEMPRE entre en su propio camino aunque el heredado llegue saturado; si no,
    // un camino de largo tope lo expulsaría y un hijo podría volver a él sin ser detectado.
    const inheritedVisitedPath = sanitizedVisitedPath(parentMaterialization?.visited_path);
    const visitedPath = sanitizedVisitedPath([
      ...(inheritedVisitedPath.length > 0
        ? inheritedVisitedPath
        : sanitizedVisitedPath(bodyCorrelation?.visited_path)
      ).slice(0, maxVisitedPathEntries - 1),
      chainNode(row.recipient_tenant, row.recipient_alias)
    ]);

    // Gate humano abierto = cadena SUSPENDIDA. Se lee antes de expandir nada, con FOR SHARE:
    // ese candado es el que hace que responder el gate y delegar sobre la misma raíz no puedan
    // cruzarse. Mientras esté abierto, NINGUNA salida de esta raíz se convierte en entrega; la
    // pregunta ya salió una vez y repetirla es exactamente la amplificación que se quiere matar.
    //
    // La condición es `humanGateAvailable` (la TABLA existe) y no `humanGateEnabled` (la bandera
    // está prendida) a propósito. Apagar la bandera impide abrir gates NUEVOS, pero no debe
    // desbloquear en silencio una cadena que quedó suspendida esperando a una persona: eso la
    // haría seguir delegando sin la respuesta que estaba esperando. Para liberarla hay una
    // operación explícita y auditada, `cancelChainGate`.
    const openGate = policy.humanGateAvailable
      ? await this.openChainGateFor(client, rootMessageId)
      : undefined;

    const internalAgentDelivery = typeof row.body.type === 'string'
      && reservedInternalMessageTypes.has(row.body.type);
    const hasAllDirective = outputs.some((output) => output.target === '@all');
    let expandedOutputs: ResolvedAgentOutputEntry[];
    // @all on an internal turn was only ever forbidden client-side by the SDK output parser,
    // so an adapter rolled back to an older build could fan a delegated turn out to every
    // online peer. The prohibition now also exists server-side, before any expansion.
    if (hasAllDirective && (internalAgentDelivery || outputs.length !== 1
      || outputs[0]?.target !== '@all' || outputs[0].rejection !== undefined)) {
      expandedOutputs = outputs.map((output) => ({
        ...output,
        rejection: 'invalid_output'
      }));
    } else if (outputs.length === 1 && outputs[0]?.target === '@all') {
      const directive = outputs[0];
      const targets = (await this.routingTargets(
        client,
        row.recipient_tenant,
        row.recipient_alias
      )).filter((target) => target.online);
      const expandedBytes = typeof directive.body === 'string'
        ? Buffer.byteLength(directive.body, 'utf8') * targets.length
        : 0;
      expandedOutputs = targets.length === 0
        || targets.length > MAX_DELEGATION_FEEDBACK_ITEMS
        || expandedBytes > maxAgentOutputExpandedBytes
        ? [{
          ...directive,
          ...(targets.length > MAX_DELEGATION_FEEDBACK_ITEMS
            || expandedBytes > maxAgentOutputExpandedBytes
            ? { rejection: 'invalid_output' as const }
            : {})
        }]
        : targets.map((target, targetIndex) => ({
          ...directive,
          index: maxAgentOutputMessages + (directive.index * 100) + targetIndex,
          target: target.alias,
          targetTenant: target.tenant_id,
          targetRef: {
            directive: '@all',
            tenant_id: target.tenant_id,
            alias: target.alias
          }
        }));
    } else {
      expandedOutputs = outputs;
    }

    // Una pregunta a una persona no compite con las delegaciones del mismo turno: las cancela.
    // Pedir ayuda humana y repartir trabajo en el mismo ACK es la firma de un agente que no sabe
    // cómo seguir, y es justamente ahí donde nace el paseo aleatorio. La directiva se procesa
    // PRIMERO para que las hermanas ya vean el gate abierto y se rechacen con 'chain_gated'.
    const gateDirective = policy.humanGateEnabled && openGate === undefined && rootMessageId !== undefined
      ? expandedOutputs.find((output) => output.target === HUMAN_GATE_TARGET
        && output.rejection === undefined && visibleText(output.body))
      : undefined;
    const orderedOutputs = gateDirective === undefined
      ? expandedOutputs
      : [gateDirective, ...expandedOutputs.filter((output) => output !== gateDirective)];

    let materialized = 0;
    let suspended = false;
    const rejections: DelegationRejection[] = [];
    const materializations: DelegationMaterialization[] = [];
    /** Un gate abierto en ESTE turno pesa igual que uno heredado para las salidas siguientes. */
    let activeGate = openGate;
    const materializedTargets: string[] = [];
    const fanoutCap = fanoutCapForTurn(policy.delegationCaps, hopCount);
    for (const output of orderedOutputs) {
      const requestId = agentOutputRequestId(row.id, ack.attempt, output.index);
      const targetRefHash = sha256(output.targetRef ?? output.target);
      const bodyHash = sha256(output.body);
      const correlation = {
        root_request_id: rootRequestId,
        root_message_id: rootMessageId,
        root_delivery_id: rootDeliveryId,
        parent_request_id: row.request_id,
        parent_message_id: row.message_id,
        parent_delivery_id: row.id,
        parent_attempt: ack.attempt,
        output_index: output.index,
        trace_id: row.trace_id,
        hop_count: hopCount,
        hop_budget: hopBudget,
        // Contraparte del respaldo de arriba: hasta ahora la correlación llevaba hop_count
        // pero NO el camino, así que el respaldo no tenía de dónde leer (`corr_has_vp=f` en
        // prod). Es el camino de ANTEPASADOS del destinatario —incluye al emisor actual, que
        // es su padre— y el destinatario se agrega a sí mismo cuando ACKea.
        //
        // `agent.response` lo hereda solo: su correlación se arma con
        // `...relationship.correlation` (materializeAgentResponse), y `relationship` es
        // justamente esta arista, así que una continuación recupera el camino hasta el
        // coordinador inclusive sin código extra.
        //
        // Cadenas viejas: las que ya estaban en vuelo cuando entra esta imagen no traen el
        // campo. Ahí el respaldo no encuentra nada, el camino queda en largo 1 y el guarda se
        // comporta EXACTAMENTE como hoy: no corta. Es degradación a la conducta actual, nunca
        // un corte nuevo, así que el despliegue no puede inventar falsos positivos sobre
        // cadenas que ya estaban corriendo. Se cura sola en el primer salto nuevo.
        visited_path: visitedPath
      };
      const existing = await client.query(
        `SELECT 1 FROM agent_output_materializations
         WHERE source_delivery_id=$1 AND source_attempt=$2 AND output_index=$3`,
        [row.id, ack.attempt, output.index]
      );
      if (existing.rowCount) continue;

      const rejection = output.rejection;
      const targetAlias = typeof output.target === 'string' ? output.target : undefined;
      const body = typeof output.body === 'string' ? output.body : undefined;
      /**
       * Un rechazo durable QUE ADEMÁS SE LEE. Antes esto era una fila y un audit 'deny' y el
       * emisor no se enteraba de nada, así que lo natural era reintentar; de ahí las 148
       * repeticiones de una misma arista medidas en prod. Ahora el motivo y qué hacer en vez
       * de reintentar viajan en el audit, en la correlación de la fila y en la respuesta del
       * ACK (`delegation_rejections`), sin generar NI UNA entrega nueva.
       */
      const reject = async (
        code: AgentOutputRejectionCode,
        extra: { target?: string; cap?: number; question?: string; gateId?: string } = {}
      ): Promise<void> => {
        // Recortado UNA vez, y el mismo valor va al texto y al campo: `reason` incrusta el
        // destino, así que dejar el crudo en el texto y recortar sólo el campo movería el
        // problema de largo de un lado al otro del mismo frame.
        const boundedTarget = boundedRejectionTarget(targetAlias);
        const notice = describeDelegationRejection(code, {
          hopCount,
          hopBudget,
          ...(boundedTarget === undefined ? {} : { target: boundedTarget }),
          ...extra
        });
        rejections.push({
          output_index: output.index,
          ...(boundedTarget === undefined ? {} : { target: boundedTarget }),
          ...notice
        });
        await this.insertAgentOutputRejection(
          client, row, ack, output.index, requestId, targetRefHash, bodyHash,
          hopCount, hopBudget, correlation, code, notice, boundedTarget
        );
      };

      // La cadena está esperando a una persona: no sale nada hacia ningún agente.
      if (activeGate !== undefined) {
        await reject('chain_gated', { question: activeGate.question, gateId: activeGate.id });
        continue;
      }
      // `@human` no es un alias: es una pregunta. Deja de ser una entrega imposible de completar
      // y pasa a ser una fila con estado. Sólo cuando la primitiva existe y está encendida; si
      // no, cae al camino de siempre y termina en 'unroutable_alias', como hoy.
      if (output === gateDirective && targetAlias === HUMAN_GATE_TARGET && body !== undefined
        && rootMessageId !== undefined) {
        const gate = await this.openHumanGate(client, row, ack, output.index, {
          rootMessageId, question: body, correlation
        });
        if (gate !== undefined) {
          activeGate = gate;
          suspended = true;
          await reject('human_gate_opened', { question: gate.question, gateId: gate.id });
          continue;
        }
      }
      if (!rejection && (!targetAlias || !aliasPattern.test(targetAlias))) {
        await reject('unroutable_alias');
        continue;
      }
      if (!rejection && hopCount > hopBudget) {
        await reject('hop_budget_exhausted');
        continue;
      }
      if (!rejection && (targetAlias === row.recipient_alias
        || (internalAgentDelivery && targetAlias === row.actor_alias))) {
        await reject('unroutable_alias');
        continue;
      }
      // Tope de ABANICO por nodo, no sólo de profundidad. Se cuenta sobre lo MATERIALIZADO, así
      // que un turno cuyas salidas se rechazan por otra causa no gasta abanico.
      if (!rejection && fanoutCap !== undefined && materialized >= fanoutCap) {
        await reject('fanout_exceeded', { cap: fanoutCap });
        continue;
      }
      if (rejection || targetAlias === undefined || body === undefined) {
        await reject(rejection ?? 'invalid_output');
        continue;
      }

      const allowedTargets: Tenant[] = [];
      if (output.targetTenant !== undefined) {
        allowedTargets.push(output.targetTenant);
      } else {
        const candidates = await client.query<{ tenant_id: Tenant }>(
          `SELECT membership.tenant_id
           FROM memberships membership
           JOIN tenants target ON target.id=membership.tenant_id
           JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
           WHERE membership.alias=$1 AND membership.enabled AND target.enabled AND room.enabled
           ORDER BY membership.tenant_id,membership.room_id
           FOR SHARE OF membership,target,room`,
          [targetAlias]
        );
        const targetCandidates = [...new Set(candidates.rows.map((candidate) => candidate.tenant_id))];
        for (const candidate of targetCandidates) {
          if (candidate === row.recipient_tenant) {
            allowedTargets.push(candidate);
            continue;
          }
          const edge = await client.query(
            `SELECT 1 FROM acl_edges edge
             JOIN tenants source ON source.id=edge.from_tenant
             JOIN tenants target ON target.id=edge.to_tenant
             WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
               AND edge.enabled AND edge.allow_route AND (source.is_hub OR target.is_hub)
             FOR SHARE OF edge,source,target`,
            [row.recipient_tenant, candidate]
          );
          if (edge.rowCount === 1) allowedTargets.push(candidate);
        }
      }
      if (allowedTargets.length !== 1) {
        await reject(allowedTargets.length > 1 ? 'ambiguous_alias' : 'unroutable_alias');
        continue;
      }
      const targetTenant = allowedTargets[0]!;
      const targetNode = chainNode(targetTenant, targetAlias);
      // The only point where the destination pair is both resolved and authorized. A cycle
      // is a durable rejection, never an exception: when every output of an ACK is rejected
      // the agent simply relays its own reply upwards, which is an already covered path.
      if (policy.cycleCutEnabled && visitedPath.includes(targetNode)) {
        await reject('cycle_detected', { target: targetNode });
        continue;
      }
      // Reserva de cupo. Va DESPUÉS de resolver el destino y ANTES de escribir nada: un rechazo
      // por forma o por ruta no debe gastar combustible de la cadena.
      //
      // El orden importa. Primero la raíz (una sola fila, el candado que ya toma el relay de
      // progreso), después la arista. Si la arista no entra, el combustible de la raíz se
      // DEVUELVE en la misma transacción: si no, un destino saturado iría drenando el
      // presupuesto de toda la cadena sin producir una sola entrega.
      if (policy.delegationCaps.enabled && policy.delegationCapsAvailable
        && rootMessageId !== undefined) {
        const rootReserved = await this.reserveRootDelegation(
          client, rootMessageId, policy.delegationCaps.maxDelegationsPerRoot
        );
        if (!rootReserved) {
          await reject('root_budget_exhausted', {
            target: targetNode, cap: policy.delegationCaps.maxDelegationsPerRoot
          });
          continue;
        }
        const edgeReserved = await this.reserveChainEdge(
          client, rootMessageId, chainNode(row.recipient_tenant, row.recipient_alias), targetNode,
          policy.delegationCaps.maxEdgeRepeatsPerRoot
        );
        if (!edgeReserved) {
          await this.releaseRootDelegation(client, rootMessageId);
          await reject('edge_repeat_exceeded', {
            target: targetNode, cap: policy.delegationCaps.maxEdgeRepeatsPerRoot
          });
          continue;
        }
      }

      const message = await client.query<{ id: string }>(
        `INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11) RETURNING id`,
        [
          requestId, row.trace_id, row.recipient_tenant, sourceRoomId, row.recipient_alias,
          JSON.stringify({
            type: 'agent.message',
            text: body,
            from_alias: row.recipient_alias,
            correlation
          }),
          row.origin ? JSON.stringify(row.origin) : null,
          // Deja de heredar `row.lane`. Heredarlo era lo que volvía inútil al carril como
          // señal: un pedido de una persona nace 'interactive' y toda su descendencia
          // agente-a-agente lo copiaba, así que la cola del asistente y la cola de trabajo
          // eran la misma cola. Una delegación es trabajo de fondo por definición; el mensaje
          // de la persona que la originó ya se atendió (o se está atendiendo) aparte.
          //
          // La PRIORIDAD se hereda y después se acota. Los dos ejes son independientes y hacen
          // falta los dos: el carril decide qué cola, la prioridad decide el orden DENTRO de la
          // cola (`ORDER BY (m.lane='interactive') DESC, m.priority DESC`). Éste es el punto
          // exacto donde el número de una persona se escaparía al tráfico entre máquinas — el
          // 88% de los mensajes de agente de la semana medida desciende de una raíz de Telegram,
          // así que copiarlo sin techo pondría a la flota entera en la banda humana. Es además
          // el único techo que un agente no puede esquivar, porque nunca elige este número.
          'batch', clampAgentPriority(row.priority),
          row.auth_session_id ?? `delivery:${row.id}:attempt:${ack.attempt}`,
          row.auth_channel ?? row.origin?.channel ?? 'agent-output'
        ]
      );
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('agent output message insert returned no id');
      const delivery = await client.query<{ id: string }>(
        `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
         VALUES($1,$2,$3) RETURNING id`,
        [messageId, targetTenant, targetAlias]
      );
      const producedDeliveryId = delivery.rows[0]?.id;
      if (!producedDeliveryId) throw new Error('agent output delivery insert returned no id');
      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
        [
          targetTenant, `agent-output:${row.id}:${ack.attempt}:${output.index}`, requestId,
          messageId, producedDeliveryId, row.trace_id,
          JSON.stringify({ recipient_alias: targetAlias, reason: 'delivery_available' })
        ]
      );
      await client.query(
        `INSERT INTO agent_output_materializations(
           source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
           target_tenant,target_alias,target_ref_hash,body_hash,status,produced_message_id,
           produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation
           ${policy.visitedPathAvailable ? ',visited_path' : ''}
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'materialized',$11,$12,$13,$14,$15,$16,$17::jsonb
           ${policy.visitedPathAvailable ? ',$18::text[]' : ''})`,
        [
          row.id, ack.attempt, output.index, row.message_id, row.recipient_tenant, row.recipient_alias,
          targetTenant, targetAlias, targetRefHash, bodyHash, messageId, producedDeliveryId,
          requestId, row.trace_id, hopCount, hopBudget, JSON.stringify(correlation),
          ...(policy.visitedPathAvailable ? [visitedPath] : [])
        ]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'agent_output.materialize','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          row.recipient_tenant, row.recipient_alias, requestId, messageId, producedDeliveryId, row.trace_id,
          JSON.stringify({
            source_delivery_id: row.id,
            source_attempt: ack.attempt,
            output_index: output.index,
            target_tenant: targetTenant,
            target_alias: targetAlias,
            hop_count: hopCount,
            hop_budget: hopBudget
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: targetTenant, alias: targetAlias })
      ]);
      materialized += 1;
      materializations.push({
        output_index: output.index,
        target_tenant: targetTenant,
        target_alias: targetAlias,
        child_delivery_id: producedDeliveryId,
      });
      materializedTargets.push(targetNode);
    }
    // Rendered here because hop_count, hop_budget and the accepted destinations only exist
    // as locals of this method; the relay helper never re-derives them.
    if (materialized > 0) {
      await this.insertProgressRelay(
        client, row, ack.attempt, policy, rootMessageId, 'delegated',
        `${row.recipient_alias} delegó en ${materializedTargets.join(', ')}`
        + ` (hop ${hopCount}/${hopBudget}).`
      );
    }
    return {
      materialized,
      suspended,
      rejections,
      materializations,
      ...(activeGate === undefined ? {} : { gate: activeGate })
    };
  }

  /** El gate abierto de una raíz, si lo hay. `FOR SHARE` es el interlock contra `answerChainGate`. */
  private async openChainGateFor(
    client: DatabaseClient,
    rootMessageId: string | undefined
  ): Promise<OpenChainGate | undefined> {
    if (rootMessageId === undefined) return undefined;
    const gate = await client.query<{ id: string; question: string }>(
      `SELECT id,question FROM agent_chain_gates
       WHERE root_message_id=$1 AND status='open' LIMIT 1 FOR SHARE`,
      [rootMessageId]
    );
    return gate.rows[0];
  }

  /**
   * Convierte una pregunta a una persona en una FILA, no en una entrega.
   *
   * Devuelve `undefined` cuando otra rama de la misma raíz ganó la carrera y ya dejó un gate
   * abierto: el índice único parcial `agent_chain_gates_open_root_idx` es lo que garantiza que
   * la pregunta salga UNA sola vez, y el `ON CONFLICT DO NOTHING` lo convierte en un no-op en
   * vez de en una violación que abortaría la transacción del ACK.
   *
   * La pregunta se relaya al canal humano por `adapter_outbox` reusando la forma de acuse no
   * terminal que el bridge ya implementa (misma que insertProgressRelay), así que no hay orden
   * de despliegue entre store y bridge.
   */
  private async openHumanGate(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    outputIndex: number,
    input: { rootMessageId: string; question: string; correlation: Record<string, unknown> }
  ): Promise<OpenChainGate | undefined> {
    const question = truncateUtf8(input.question, maxChainGateQuestionBytes).value;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agent_chain_gates(
         root_message_id,tenant_id,asked_by_alias,source_delivery_id,source_attempt,output_index,
         trace_id,question,correlation,origin
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        input.rootMessageId, row.recipient_tenant, row.recipient_alias, row.id, ack.attempt,
        outputIndex, row.trace_id, question, JSON.stringify(input.correlation),
        row.origin ? JSON.stringify(row.origin) : null
      ]
    );
    const gateId = inserted.rows[0]?.id;
    if (gateId === undefined) {
      // Perdió la carrera (otro gate abierto de la misma raíz) o es un ACK repetido del mismo
      // output. En los dos casos el gate vigente es el que manda.
      const current = await this.openChainGateFor(client, input.rootMessageId);
      return current;
    }
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_chain.gate_opened','allow',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
        row.trace_id,
        JSON.stringify({
          gate_id: gateId,
          root_message_id: input.rootMessageId,
          source_attempt: ack.attempt,
          output_index: outputIndex,
          question_bytes: Buffer.byteLength(question, 'utf8')
        })
      ]
    );
    if (row.origin) {
      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [
          originRelayTenant(row), row.origin.adapter, `chain-gate:${gateId}`, row.request_id,
          row.message_id, row.id, row.trace_id, JSON.stringify(row.origin),
          JSON.stringify({
            relay_kind: 'ack',
            terminal: false,
            outcome: 'ack',
            progress_stage: 'gated',
            gate_id: gateId,
            result: {
              output: {
                reply: `${row.recipient_alias} necesita una respuesta tuya para seguir:\n\n${question}`,
                messages: [],
                status: 'done',
                retryable: false,
                artifacts: []
              }
            },
            correlation: {
              request_id: row.request_id,
              message_id: row.message_id,
              trace_id: row.trace_id,
              root_message_id: input.rootMessageId,
              gate_id: gateId
            }
          })
        ]
      );
    }
    return { id: gateId, question };
  }

  /**
   * Reserva una delegación del combustible de la raíz.
   *
   * La reserva ES el UPDATE condicional: si el `WHERE delegations < cap` no se cumple no vuelve
   * ninguna fila y el contador NO avanza, así que un rechazo no consume presupuesto y dos ACK
   * concurrentes de la misma cadena serializan sobre la fila en vez de pasarse de largo.
   */
  private async reserveRootDelegation(
    client: DatabaseClient,
    rootMessageId: string,
    cap: number
  ): Promise<boolean> {
    await client.query(
      `INSERT INTO agent_chain_progress(root_message_id) VALUES($1)
       ON CONFLICT(root_message_id) DO NOTHING`,
      [rootMessageId]
    );
    const reserved = await client.query(
      `UPDATE agent_chain_progress SET delegations=delegations+1
       WHERE root_message_id=$1 AND delegations<$2 RETURNING delegations`,
      [rootMessageId, cap]
    );
    return reserved.rowCount === 1;
  }

  /** Devuelve el combustible tomado cuando el paso siguiente de la reserva no entró. */
  private async releaseRootDelegation(
    client: DatabaseClient,
    rootMessageId: string
  ): Promise<void> {
    await client.query(
      `UPDATE agent_chain_progress SET delegations=delegations-1
       WHERE root_message_id=$1 AND delegations>0`,
      [rootMessageId]
    );
  }

  /**
   * Reserva un uso de la arista (raíz, emisor, destino).
   *
   * Este es el tope que corta el paseo aleatorio de verdad. El guarda de ciclo por camino de
   * ANTEPASADOS no ve el caso dominante medido en prod (61% de las delegaciones nacen sobre una
   * continuación `agent.response`): cuando C delega en X y X le responde, X nunca fue antepasado
   * de C, así que C -> X -> C -> X ... es invisible para `visited_path`. Contar la arista sí lo ve.
   */
  private async reserveChainEdge(
    client: DatabaseClient,
    rootMessageId: string,
    sourceNode: string,
    targetNode: string,
    cap: number
  ): Promise<boolean> {
    const reserved = await client.query(
      `INSERT INTO agent_chain_edge_uses(root_message_id,source_node,target_node,uses)
       VALUES($1,$2,$3,1)
       ON CONFLICT(root_message_id,source_node,target_node) DO UPDATE
         SET uses=agent_chain_edge_uses.uses+1,last_used_at=now()
         WHERE agent_chain_edge_uses.uses<$4
       RETURNING uses`,
      [rootMessageId, sourceNode, targetNode, cap]
    );
    return reserved.rowCount === 1;
  }

  private async insertAgentOutputRejection(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    outputIndex: number,
    requestId: string,
    targetRefHash: string,
    bodyHash: string,
    hopCount: number,
    hopBudget: number,
    correlation: Record<string, unknown>,
    rejectionCode: AgentOutputRejectionCode,
    notice?: RejectionNotice,
    target?: string,
  ): Promise<void> {
    // El motivo legible entra en la correlación de la fila, no en una columna nueva: así el
    // read-model de la cadena y cualquier lectura forense lo encuentran sin migración extra, y
    // la fila sigue sin guardar el cuerpo (sólo su hash), que es la regla de esta tabla.
    const rejectionCorrelation = notice === undefined
      ? correlation
      : {
          ...correlation,
          rejection: {
            code: notice.code,
            reason: notice.reason,
            guidance: notice.guidance,
            ...(target === undefined ? {} : { target }),
          },
        };
    await client.query(
      `INSERT INTO agent_output_materializations(
         source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
         target_ref_hash,body_hash,status,rejection_code,request_id,trace_id,hop_count,hop_budget,correlation
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rejected',$9,$10,$11,$12,$13,$14::jsonb)
       ON CONFLICT(source_delivery_id,source_attempt,output_index) DO NOTHING`,
      [
        row.id, ack.attempt, outputIndex, row.message_id, row.recipient_tenant, row.recipient_alias,
        targetRefHash, bodyHash, rejectionCode, requestId, row.trace_id,
        hopCount, hopBudget, JSON.stringify(rejectionCorrelation)
      ]
    );
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_output.materialize','deny',$3,$4,$5,$6,$7::jsonb)`,
      [
        row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id, row.trace_id,
        JSON.stringify({
          source_attempt: ack.attempt,
          output_index: outputIndex,
          rejection_code: rejectionCode,
          target_ref_hash: targetRefHash,
          body_hash: bodyHash,
          hop_count: hopCount,
          hop_budget: hopBudget,
          ...(notice === undefined ? {} : { rejection_notice: rejectionText(notice) })
        })
      ]
    );
  }

  /**
   * `renewal` separa el latido de la transición de estado, y esa distinción es la que hace
   * posible la retención por tipo: un ACK que sólo dice "sigo vivo" no tiene valor forense
   * pasadas unas horas, y es ~90% del volumen de la tabla. Uno que dice "pasé de accepted a
   * started" o "terminé" sí lo tiene y se conserva mucho más. Se marca acá, en el único lugar
   * que sabe con certeza cuál es cuál (la rama de renovación de `ackDelivery`), en vez de
   * inferirlo después con una función de ventana sobre la tabla entera.
   *
   * `DO UPDATE ... WHERE` en vez de `DO NOTHING`: el mismo evento puede ser rechazado primero y
   * aceptado después (un ACK terminal reenviado que la segunda vez cae en el rescate tardío, o
   * uno que falló por lease y se reintenta con el lease ya renovado). La fila tiene que quedar
   * diciendo la verdad. La cláusula sólo deja subir de `false` a `true`, nunca al revés, y
   * cuando el ACK se rechaza otra vez el UPDATE no se ejecuta: idéntico al `DO NOTHING` viejo.
   */
  protected override async insertAck(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    applied: boolean,
    persistedResult: Record<string, unknown> | undefined,
    renewal = false
  ): Promise<void> {
    await client.query(
      `INSERT INTO delivery_acks(event_id,delivery_id,status,instance_id,epoch,claim_token,attempt,applied,renewal,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$10,$9::jsonb)
       ON CONFLICT(event_id) DO UPDATE
         SET applied=true,renewal=EXCLUDED.renewal,payload=EXCLUDED.payload
         WHERE delivery_acks.applied=false AND EXCLUDED.applied`,
      [ack.event_id, row.id, ack.status, ack.instance_id, ack.epoch, ack.claim_token, ack.attempt, applied,
        JSON.stringify({
          retryable: ack.retryable,
          ...(postgresTextSafe(ack.error) === undefined
            ? {}
            : { error: postgresTextSafe(ack.error) }),
          ...(postgresTextSafe(ack.error_code) === undefined
            ? {}
            : { error_code: postgresTextSafe(ack.error_code) }),
          ...(persistedResult === undefined ? {} : { result: persistedResult })
        }), renewal]
    );
  }

  /**
   * The single authorization engine for proactive egress. Both surfaces (the
   * in-band `notify[]` of an agent ACK and POST /v3/egress/notifications) go
   * through here, so there is exactly one place where the answer to "may this
   * alias write to this human right now" is decided.
   *
   * Every step is default-deny and every refusal becomes a durable
   * `egress_notifications` row plus an audit event. It never throws for a policy
   * decision: a disabled destination must not be able to abort the ACK of a real
   * delivery.
   */
  private async authorizeAndEmitNotification(
    client: DatabaseClient,
    context: NotificationContext,
    request: NotificationRequest
  ): Promise<NotificationVerdict> {
    const bodyBytes = Buffer.byteLength(request.body, 'utf8');
    const bodyHash = sha256(request.body);
    const deny = async (code: NotifyDenialCode): Promise<NotificationVerdict> => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO egress_notifications(
           tenant_id,alias,handle,adapter,kind,source,idempotency_key,decision,denial_code,
           body_hash,body_bytes,source_delivery_id,source_attempt,notify_index,
           source_message_id,source_root_message_id,request_id,trace_id,correlation
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'denied',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING id`,
        [
          context.tenant, context.alias, request.handle, 'telegram', request.kind, context.source,
          request.idempotencyKey, code, bodyHash, bodyBytes,
          context.sourceDeliveryId ?? null, context.sourceAttempt ?? null,
          context.source === 'agent_output' ? request.index : null,
          context.sourceMessageId ?? null, context.sourceRootMessageId ?? null,
          context.requestId, context.traceId,
          JSON.stringify({ source: context.source, notify_index: request.index })
        ]
      );
      const notificationId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,trace_id,metadata)
         VALUES($1,$2,'egress.notify','deny',$3,$4,$5::jsonb)`,
        [context.tenant, context.alias, context.requestId, context.traceId,
          JSON.stringify({
            notification_id: notificationId, handle: request.handle, kind: request.kind,
            denial_code: code, source: context.source, body_bytes: bodyBytes
          })]
      );
      return { notification_id: notificationId, decision: 'denied', denial_code: code, duplicate: false, dry_run: false };
    };

    // 1. Serialize on the idempotency key first, then on the destination. Both
    //    keys are taken in a fixed order and callers iterate handles sorted, so
    //    concurrent notifications cannot build a lock cycle.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`egress-notify:${context.tenant}:${context.alias}:${request.idempotencyKey}`]);
    const replay = await client.query<{
      id: string; decision: 'allowed' | 'denied'; denial_code: NotifyDenialCode | null;
      produced_message_id: string | null; produced_outbox_id: string | null;
    }>(
      `SELECT id,decision,denial_code,produced_message_id,produced_outbox_id
       FROM egress_notifications WHERE tenant_id=$1 AND alias=$2 AND idempotency_key=$3`,
      [context.tenant, context.alias, request.idempotencyKey]
    );
    const previous = replay.rows[0];
    if (previous) {
      return {
        notification_id: previous.id,
        decision: previous.decision,
        ...(previous.denial_code === null ? {} : { denial_code: previous.denial_code }),
        ...(previous.produced_message_id === null ? {} : { message_id: previous.produced_message_id }),
        ...(previous.produced_outbox_id === null ? {} : { outbox_id: previous.produced_outbox_id }),
        duplicate: true,
        dry_run: false
      };
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`egress-notify-destination:${context.tenant}:${context.alias}:${request.handle}`]);

    if (request.forcedDenial) return deny(request.forcedDenial);

    // 2. Role gate and source room in one query. An alias with no enabled
    //    membership carrying allow_notify has no way to emit anything, and the
    //    room it is a member of is the room the notification message lives in.
    const permitted = await client.query<{ room_id: string }>(
      `SELECT membership.room_id
       FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND policy.allow_notify
       ORDER BY membership.room_id LIMIT 1`,
      [context.tenant, context.alias]
    );
    const sourceRoomId = permitted.rows[0]?.room_id;
    if (!sourceRoomId) return deny('notify_permission_denied');

    // 3. The allowlist. Zero rows means default-deny, which is the state the
    //    migration leaves the system in.
    const destinations = await client.query<EgressDestinationRow>(
      `SELECT adapter,channel,conversation_id,conversation_kind,allow_kinds,require_prior_contact,
              contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,max_per_root,
              quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled
       FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3 FOR SHARE`,
      [context.tenant, context.alias, request.handle]
    );
    const destination = destinations.rows[0];
    if (!destination) return deny('unknown_destination');
    if (!destination.enabled) return deny('destination_disabled');
    if (!destination.allow_kinds.includes(request.kind)) return deny('kind_not_allowed');

    // 4. No cold contact. A destination that requires prior contact needs a real
    //    authenticated inbound message from that conversation to this alias,
    //    inside the configured freshness window.
    if (destination.require_prior_contact) {
      const contact = await client.query(
        `SELECT 1 FROM egress_contacts
         WHERE tenant_id=$1 AND alias=$2 AND adapter=$3 AND conversation_id=$4
           AND inbound_count>=1
           AND last_inbound_at > clock_timestamp() - ($5::int * interval '1 day')`,
        [context.tenant, context.alias, destination.adapter, destination.conversation_id,
          destination.contact_ttl_days]
      );
      if (contact.rowCount !== 1) return deny('cold_contact');
    }

    // 5. Sliding windows, computed with clock_timestamp() so a long transaction
    //    cannot back-date its own notification out of the window.
    const windows = await client.query<{ last_hour: string; last_day: string; last_at: Date | null }>(
      `SELECT count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour') AS last_hour,
              count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 day') AS last_day,
              max(created_at) AS last_at
       FROM egress_notifications
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3 AND decision='allowed'`,
      [context.tenant, context.alias, request.handle]
    );
    const usage = windows.rows[0];
    if (usage) {
      if (Number(usage.last_hour) >= destination.max_per_hour) return deny('rate_limited');
      if (Number(usage.last_day) >= destination.max_per_day) return deny('rate_limited');
      if (usage.last_at !== null && destination.min_interval_seconds > 0) {
        const elapsedMs = Date.now() - usage.last_at.getTime();
        if (elapsedMs < destination.min_interval_seconds * 1_000) return deny('rate_limited');
      }
    }

    // 6. Per-chain quota. The chain is source_root_message_id; root_message_id is
    //    the notification's own message id and is unique per row, so counting on
    //    it would silently disable this limit.
    if (context.sourceRootMessageId !== undefined) {
      const chain = await client.query<{ used: string }>(
        `SELECT count(*) AS used FROM egress_notifications
         WHERE decision='allowed' AND source_root_message_id=$1`,
        [context.sourceRootMessageId]
      );
      if (Number(chain.rows[0]?.used ?? 0) >= destination.max_per_root) return deny('root_quota_exhausted');
    }

    // 7. Quiet hours. An unknown timezone falls back to UTC instead of raising,
    //    because raising here would abort the ACK transaction.
    if (destination.quiet_hours_start !== null && destination.quiet_hours_end !== null
      && destination.quiet_hours_start !== destination.quiet_hours_end) {
      const local = await client.query<{ hour: number }>(
        `SELECT extract(hour FROM clock_timestamp() AT TIME ZONE coalesce(
           (SELECT name FROM pg_timezone_names WHERE name=$1 LIMIT 1),'UTC'
         ))::int AS hour`,
        [destination.quiet_hours_tz]
      );
      const hour = local.rows[0]?.hour ?? 0;
      const start = destination.quiet_hours_start;
      const end = destination.quiet_hours_end;
      const quiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
      if (quiet) return deny('quiet_hours');
    }

    const notificationMessage = await client.query<{ id: string }>(
      `INSERT INTO messages(
         request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
         auth_session_id,auth_channel
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'interactive',0,$8,$9) RETURNING id`,
      [
        context.requestId, context.traceId, context.tenant, sourceRoomId, context.alias,
        JSON.stringify({
          type: 'agent.notify',
          text: request.body,
          notify_kind: request.kind,
          destination_handle: request.handle,
          from_alias: context.alias,
          correlation: {
            source: context.source,
            ...(context.sourceDeliveryId === undefined ? {} : { source_delivery_id: context.sourceDeliveryId }),
            ...(context.sourceMessageId === undefined ? {} : { source_message_id: context.sourceMessageId }),
            ...(context.sourceRootMessageId === undefined
              ? {}
              : { source_root_message_id: context.sourceRootMessageId }),
            trace_id: context.traceId
          }
        }),
        JSON.stringify(this.notificationOrigin(context, destination)),
        `egress-notify:${context.tenant}:${context.alias}:${request.idempotencyKey}`,
        destination.channel
      ]
    );
    const notificationMessageId = notificationMessage.rows[0]!.id;

    // The relay's own correlation root is the notification message itself, never
    // the chain it came from. Reusing the inbound root would make claimOutbox's
    // supersession CTE kill the pending 'Recibido' acknowledgement of that
    // conversation. The originating chain travels in source_correlation.
    const relayPayload = {
      relay_kind: 'notify',
      terminal: true,
      outcome: 'done',
      kind: request.kind,
      result: {
        output: {
          reply: request.body,
          messages: [],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      },
      correlation: {
        request_id: context.requestId,
        message_id: notificationMessageId,
        trace_id: context.traceId,
        root_message_id: notificationMessageId
      },
      source_correlation: {
        source: context.source,
        ...(context.sourceDeliveryId === undefined ? {} : { source_delivery_id: context.sourceDeliveryId }),
        ...(context.sourceMessageId === undefined ? {} : { source_message_id: context.sourceMessageId }),
        ...(context.sourceRootMessageId === undefined
          ? {}
          : { source_root_message_id: context.sourceRootMessageId }),
        ...(context.sourceAttempt === undefined ? {} : { source_attempt: context.sourceAttempt })
      }
    };
    // No ON CONFLICT clause: the idempotency key carries a fresh notification id,
    // so a conflict is impossible, and swallowing one would leave
    // produced_outbox_id NULL and abort the whole transaction on the CHECK.
    const notificationId = randomUUID();
    const outbox = await client.query<{ id: string }>(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,trace_id,origin,payload
       ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
      [
        context.tenant, destination.adapter, `notify:${notificationId}`, context.requestId,
        notificationMessageId, context.traceId,
        JSON.stringify(this.notificationOrigin(context, destination)),
        JSON.stringify(relayPayload)
      ]
    );
    const outboxId = outbox.rows[0]!.id;
    const stored = await client.query<{ id: string }>(
      `INSERT INTO egress_notifications(
         id,tenant_id,alias,handle,adapter,conversation_id,kind,source,idempotency_key,decision,
         body_hash,body_bytes,source_delivery_id,source_attempt,notify_index,
         source_message_id,source_root_message_id,produced_message_id,produced_outbox_id,
         root_message_id,request_id,trace_id,correlation
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'allowed',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)
       RETURNING id`,
      [
        notificationId, context.tenant, context.alias, request.handle, destination.adapter,
        destination.conversation_id, request.kind, context.source, request.idempotencyKey,
        bodyHash, bodyBytes,
        context.sourceDeliveryId ?? null, context.sourceAttempt ?? null,
        context.source === 'agent_output' ? request.index : null,
        context.sourceMessageId ?? null, context.sourceRootMessageId ?? null,
        notificationMessageId, outboxId, notificationMessageId,
        context.requestId, context.traceId,
        JSON.stringify({ source: context.source, notify_index: request.index })
      ]
    );
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata)
       VALUES($1,$2,'egress.notify','allow',$3,$4,$5,$6::jsonb)`,
      [context.tenant, context.alias, context.requestId, notificationMessageId, context.traceId,
        JSON.stringify({
          notification_id: notificationId, handle: request.handle, kind: request.kind,
          source: context.source, adapter: destination.adapter, body_bytes: bodyBytes
        })]
    );
    return {
      notification_id: stored.rows[0]!.id,
      decision: 'allowed',
      message_id: notificationMessageId,
      outbox_id: outboxId,
      duplicate: false,
      dry_run: false
    };
  }

  /**
   * Synthetic return route. It carries no external_message_id on purpose: a
   * proactive relay does not answer an inbound message, so the bridge must not
   * try to place a reaction on some arbitrary message id of that chat.
   */
  private notificationOrigin(
    context: NotificationContext,
    destination: EgressDestinationRow
  ): Origin {
    return {
      adapter: destination.adapter,
      channel: destination.channel,
      conversation_id: destination.conversation_id,
      relay: [],
      metadata: {
        bridge_alias: context.alias,
        bridge_tenant: context.tenant,
        chat_type: destination.conversation_kind,
        proactive: true
      }
    };
  }

  /**
   * In-band proactive egress from an agent ACK. Runs inside the ACK transaction
   * so either the delivery finished and the notification exists, or neither did.
   *
   * Two invariants make this safe to call on the hot path:
   *  - it returns a count that the caller must NOT feed into the delegation
   *    disposition; a notification is a side effect, never a child of the
   *    delegation tree, and counting it would leave the parent waiting forever.
   *  - each entry is fenced by a SAVEPOINT, so no unexpected database error from
   *    the notification path can abort the ACK of a real delivery.
   */
  protected override async materializeAgentNotifications(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    entries: AgentNotifyEntry[],
    ambiguousExecution: boolean
  ): Promise<{ allowed: number; denied: number; errors: number }> {
    const result = { allowed: 0, denied: 0, errors: 0 };
    if (entries.length === 0) return result;
    const ordered = [...entries].sort((left, right) =>
      left.handle === right.handle ? left.index - right.index : left.handle.localeCompare(right.handle));
    for (const entry of ordered) {
      const context: NotificationContext = {
        tenant: row.recipient_tenant,
        alias: row.recipient_alias,
        source: 'agent_output',
        requestId: agentNotifyRequestId(row.id, ack.attempt, entry.index),
        traceId: row.trace_id,
        sourceDeliveryId: row.id,
        sourceAttempt: ack.attempt,
        sourceMessageId: row.message_id,
        ...(this.rootMessageId(row) === undefined ? {} : { sourceRootMessageId: this.rootMessageId(row)! })
      };
      const request: NotificationRequest = {
        ...entry,
        // An ambiguous execution is a state where the system does not know
        // whether the work happened. It must never become a message to a human
        // claiming it did.
        ...(ambiguousExecution ? { forcedDenial: 'ambiguous_execution' as const } : {}),
        idempotencyKey: `agent:${row.id}:${ack.attempt}:${entry.index}`
      };
      await client.query('SAVEPOINT cauce_notify');
      try {
        const verdict = await this.authorizeAndEmitNotification(client, context, request);
        await client.query('RELEASE SAVEPOINT cauce_notify');
        if (verdict.duplicate) continue;
        if (verdict.decision === 'allowed') result.allowed += 1;
        else result.denied += 1;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT cauce_notify');
        await client.query('RELEASE SAVEPOINT cauce_notify');
        result.errors += 1;
      }
    }
    return result;
  }

  /**
   * Out-of-band proactive egress for crons, jobs and the console. It shares the
   * whole authorization engine with the in-band path; only the idempotency key
   * namespace and the correlation differ.
   */
  async enqueueNotification(
    actorTenant: Tenant,
    actorAlias: string,
    input: NotifyRequest,
    source: 'http' | 'job' = 'http'
  ): Promise<NotificationVerdict> {
    if (!handlePattern.test(input.destination)) {
      throw new StoreError('not_found', 'notification destination handle is invalid');
    }
    if (!notifyKinds.has(input.kind)) throw new StoreError('conflict', 'notification kind is invalid');
    const bodyDenial = Buffer.byteLength(input.body, 'utf8') > maxNotifyBodyBytes
      ? 'body_too_large' as const
      : visibleText(input.body).length === 0 ? 'invalid_output' as const : undefined;
    const context: NotificationContext = {
      tenant: actorTenant,
      alias: actorAlias,
      source,
      requestId: randomUUID(),
      traceId: `trace-${randomUUID()}`
    };
    const request: NotificationRequest = {
      index: 0,
      handle: input.destination,
      kind: input.kind,
      body: bodyDenial === undefined ? input.body : '',
      ...(bodyDenial === undefined ? {} : { forcedDenial: bodyDenial }),
      idempotencyKey: `${source}:${input.idempotency_key}`
    };
    try {
      return await withTransaction(this.pool, async (client) => {
        const verdict = await this.authorizeAndEmitNotification(client, context, request);
        // A preview must be able to prove a destination works without writing to
        // a human. Same rollback contract as the configuration dry run.
        if (input.dry_run) throw new NotificationPreview({ ...verdict, dry_run: true });
        return verdict;
      });
    } catch (error) {
      if (error instanceof NotificationPreview) return error.verdict;
      throw error;
    }
  }

  /**
   * Denied notifications have no produced message and no outbox row, so the
   * visibility filter of listOriginRelays (which joins messages through the
   * outbox) would discard exactly the rows an operator needs to see. Visibility
   * is derived from the emitting (tenant, alias) against memberships instead.
   */
  async listNotifications(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT notification.id,notification.tenant_id,notification.alias,notification.handle,
              notification.adapter,notification.conversation_id,notification.kind,notification.source,
              notification.decision,notification.denial_code,notification.body_bytes,
              notification.source_delivery_id,notification.source_root_message_id,
              notification.produced_message_id,notification.produced_outbox_id,
              notification.request_id,notification.trace_id,notification.created_at,
              outbox.status AS relay_status,outbox.attempts AS relay_attempts,outbox.sent_at AS relay_sent_at
       FROM egress_notifications notification
       LEFT JOIN adapter_outbox outbox ON outbox.id=notification.produced_outbox_id
       WHERE notification.tenant_id=$1 AND (
         notification.alias=$2
         OR EXISTS (
           SELECT 1 FROM memberships viewer
           JOIN memberships emitter ON emitter.tenant_id=viewer.tenant_id AND emitter.room_id=viewer.room_id
           WHERE viewer.tenant_id=$1 AND viewer.alias=$2 AND viewer.enabled
             AND emitter.alias=notification.alias AND emitter.enabled
         )
       ) ORDER BY notification.created_at DESC LIMIT $3`,
      [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
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

  /**
   * Autorización compartida por las DOS operaciones de operador sobre una entrega ajena:
   * `replayDelivery` y `cancelDelivery`. Es deliberado que sean la misma: las dos mueven el
   * estado terminal de una entrega que el operador no emitió, y tener dos criterios distintos
   * garantizaría que uno de los dos se quede viejo.
   *
   * Se responde `not_found` (nunca `forbidden`) para no confirmar la existencia de entregas
   * fuera del alcance del actor.
   */
  private async assertReplayAuthorization(
    client: DatabaseClient,
    actorTenant: Tenant,
    actorAlias: string,
    row: {
      recipient_tenant: Tenant; recipient_alias: string;
      tenant_id: Tenant; room_id: string; actor_alias: string;
    }
  ): Promise<void> {
    const denied = (): never => {
      throw new StoreError('not_found', 'delivery not found or not visible');
    };
    const actorControl = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.allow_control
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,role,tenant,room`,
      [actorTenant, actorAlias]
    );
    if (actorControl.rowCount === 0) denied();

    const sourceRoute = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
         AND membership.enabled AND tenant.enabled AND room.enabled AND role.allow_route
       FOR SHARE OF membership,role,tenant,room`,
      [row.tenant_id, row.room_id, row.actor_alias]
    );
    if (sourceRoute.rowCount === 0) denied();

    const recipient = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,tenant,room`,
      [row.recipient_tenant, row.recipient_alias]
    );
    if (recipient.rowCount === 0) denied();

    if (row.tenant_id !== row.recipient_tenant) {
      const route = await client.query(
        `SELECT 1 FROM acl_edges edge
         JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
         JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
           AND edge.enabled AND edge.allow_route
           AND source_tenant.enabled AND target_tenant.enabled
           AND (source_tenant.is_hub OR target_tenant.is_hub)
         FOR SHARE OF edge,source_tenant,target_tenant`,
        [row.tenant_id, row.recipient_tenant]
      );
      if (route.rowCount === 0) denied();
    }

    if (row.recipient_tenant === actorTenant) return;
    if (row.tenant_id === actorTenant) {
      const sourceVisibility = await client.query(
        `SELECT 1 FROM memberships membership
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
           AND membership.enabled AND tenant.enabled AND room.enabled
         FOR SHARE OF membership,tenant,room`,
        [actorTenant, row.room_id, actorAlias]
      );
      if (sourceVisibility.rowCount !== 0) return;
    }

    const controlEdge = await client.query(
      `SELECT 1 FROM acl_edges edge
       JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
       JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
       WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
         AND edge.enabled AND edge.allow_control
         AND source_tenant.enabled AND target_tenant.enabled
         AND (source_tenant.is_hub OR target_tenant.is_hub)
       FOR SHARE OF edge,source_tenant,target_tenant`,
      [actorTenant, row.recipient_tenant]
    );
    if (controlEdge.rowCount === 0) denied();
  }

  /**
   * Reencola a mano una entrega que terminó en error.
   *
   * El filtro es `status IN ('dead','failed')` y no `status='dead'` porque los dos son finales de
   * ERROR y la diferencia entre ellos la elige el agente que falló (`ack.retryable`), no el
   * operador. Con el filtro viejo, 197 entregas de producción quedaron sin botón de rescate por
   * una decisión que tomó el proceso que se rompió. Ver el comentario largo de `ackDelivery`
   * junto al INSERT en `dead_letters`.
   *
   * El JOIN con `dead_letters` se conserva y sigue siendo el candado de idempotencia: es la fila
   * que se marca `resolved_at` acá dentro, en la misma transacción que crea el clon, y sin ella
   * dos operadores simultáneos crearían dos clones. La migración 018_terminal_recovery_backfill hace el backfill de las
   * entregas terminales que quedaron sin esa fila, incluidas las que un humano marcó `dead` a
   * mano en psql.
   */
  async replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; message_id: string; dead_letter_id: string;
        recipient_tenant: Tenant; recipient_alias: string; max_attempts: number;
        request_id: string; trace_id: string; tenant_id: Tenant; room_id: string; actor_alias: string;
        dead_letter_resolved_at: Date | null;
      }>(
        `SELECT d.id,d.message_id,dl.id AS dead_letter_id,d.recipient_tenant,d.recipient_alias,d.max_attempts,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
                dl.resolved_at AS dead_letter_resolved_at
         FROM deliveries d
         JOIN messages m ON m.id=d.message_id
         JOIN dead_letters dl ON dl.delivery_id=d.id
         WHERE d.id=$1 AND d.status IN ('dead','failed')
           AND EXISTS (
             SELECT 1 FROM memberships actor_member
             JOIN role_policies role ON role.role=actor_member.role
             JOIN tenants operator_tenant ON operator_tenant.id=actor_member.tenant_id
             JOIN rooms operator_room
               ON operator_room.id=actor_member.room_id AND operator_room.tenant_id=actor_member.tenant_id
             WHERE actor_member.tenant_id=$2 AND actor_member.alias=$3 AND actor_member.enabled
               AND operator_tenant.enabled AND operator_room.enabled AND role.allow_control
           )
           AND EXISTS (
             SELECT 1 FROM memberships source_actor
             JOIN role_policies source_role ON source_role.role=source_actor.role
             JOIN tenants source_tenant ON source_tenant.id=source_actor.tenant_id
             JOIN rooms source_room
               ON source_room.id=source_actor.room_id AND source_room.tenant_id=source_actor.tenant_id
             WHERE source_actor.tenant_id=m.tenant_id AND source_actor.room_id=m.room_id
               AND source_actor.alias=m.actor_alias AND source_actor.enabled
               AND source_role.allow_route AND source_tenant.enabled AND source_room.enabled
           )
           AND EXISTS (
             SELECT 1 FROM memberships recipient
             JOIN tenants recipient_tenant ON recipient_tenant.id=recipient.tenant_id
             JOIN rooms recipient_room
               ON recipient_room.id=recipient.room_id AND recipient_room.tenant_id=recipient.tenant_id
             WHERE recipient.tenant_id=d.recipient_tenant AND recipient.alias=d.recipient_alias
               AND recipient.enabled AND recipient_tenant.enabled AND recipient_room.enabled
           )
           AND (
             m.tenant_id=d.recipient_tenant
             OR EXISTS (
               SELECT 1 FROM acl_edges route_edge
               JOIN tenants source_tenant ON source_tenant.id=route_edge.from_tenant
               JOIN tenants target_tenant ON target_tenant.id=route_edge.to_tenant
               WHERE route_edge.from_tenant=m.tenant_id AND route_edge.to_tenant=d.recipient_tenant
                 AND route_edge.enabled AND route_edge.allow_route
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
             )
           )
           AND (
            d.recipient_tenant=$2
            OR EXISTS (
              SELECT 1 FROM memberships source_member
              JOIN tenants source_tenant ON source_tenant.id=source_member.tenant_id
              JOIN rooms source_room
                ON source_room.id=source_member.room_id AND source_room.tenant_id=source_member.tenant_id
              WHERE m.tenant_id=$2 AND source_member.tenant_id=$2
                AND source_member.room_id=m.room_id AND source_member.alias=$3 AND source_member.enabled
                AND source_tenant.enabled AND source_room.enabled
            )
            OR EXISTS (
              SELECT 1 FROM acl_edges edge
              JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
              JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
              WHERE edge.from_tenant=$2 AND edge.to_tenant=d.recipient_tenant
                AND edge.enabled AND edge.allow_control
                AND source_tenant.enabled AND target_tenant.enabled
                AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
         FOR UPDATE OF d,m,dl`,
        [deliveryId, actorTenant, actorAlias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'terminal delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);

      const existingReplay = await client.query(
        `SELECT 1
         FROM audit_events replay
         JOIN deliveries replayed_delivery ON replayed_delivery.id=replay.delivery_id
         JOIN messages replayed_message ON replayed_message.id=replay.message_id
         WHERE replay.action='delivery.replay' AND replay.decision='allow'
           AND replay.metadata->>'replayed_from_delivery_id'=$1
           AND replayed_delivery.message_id=replayed_message.id
         LIMIT 1`,
        [row.id]
      );
      if (existingReplay.rowCount) {
        throw new StoreError('conflict', 'delivery already has a durable replay clone');
      }

      const legacyReplay = row.dead_letter_resolved_at === null
        ? false
        : (await client.query(
          `SELECT 1 FROM adapter_outbox legacy
           WHERE legacy.tenant_id=$1 AND legacy.adapter='gateway' AND legacy.kind='wake'
             AND legacy.delivery_id=$2 AND legacy.message_id=$3 AND legacy.request_id=$4
             AND legacy.idempotency_key LIKE $5
             AND legacy.payload->>'recipient_alias'=$6
           LIMIT 1`,
          [
            row.recipient_tenant, row.id, row.message_id, row.request_id,
            `wake-replay:${row.id}:%`, row.recipient_alias
          ]
        )).rowCount === 1;
      if (row.dead_letter_resolved_at !== null && !legacyReplay) {
        throw new StoreError('not_found', 'terminal delivery has no open or legacy-replay dead letter');
      }

      const message = await client.query<{ id: string; request_id: string }>(
        `INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         )
         SELECT gen_random_uuid(),trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                auth_session_id,auth_channel
         FROM messages WHERE id=$1
         RETURNING id,request_id`,
        [row.message_id]
      );
      const replayedMessage = message.rows[0];
      if (!replayedMessage) throw new Error('replay message insert returned no id');

      const delivery = await client.query<{ id: string }>(
        `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,max_attempts)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [replayedMessage.id, row.recipient_tenant, row.recipient_alias, row.max_attempts]
      );
      const replayedDeliveryId = delivery.rows[0]?.id;
      if (!replayedDeliveryId) throw new Error('replay delivery insert returned no id');

      if (row.dead_letter_resolved_at === null) {
        const resolved = await client.query(
          `UPDATE dead_letters SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL`,
          [row.dead_letter_id]
        );
        if (resolved.rowCount !== 1) {
          throw new StoreError('conflict', 'dead letter was already resolved');
        }
      }

      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         )
         SELECT $1,'gateway','wake',$2,replayed.request_id,replayed.id,$3,replayed.trace_id,replayed.origin,
                jsonb_build_object('recipient_alias',$4::text,'reason','delivery_available')
         FROM messages replayed WHERE replayed.id=$5`,
        [
          row.recipient_tenant, `wake-replay:${replayedDeliveryId}`, replayedDeliveryId,
          row.recipient_alias, replayedMessage.id
        ]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.replay','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          actorTenant, actorAlias, replayedMessage.request_id, replayedMessage.id, replayedDeliveryId, row.trace_id,
          JSON.stringify({
            replayed_from_delivery_id: row.id,
            replayed_from_message_id: row.message_id,
            legacy_dead_letter_recovery: legacyReplay,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: row.recipient_tenant, alias: row.recipient_alias })
      ]);
      return {
        delivery_id: replayedDeliveryId,
        replayed_from_delivery_id: row.id,
        state: 'pending',
        replayed: true
      };
    });
  }

  /**
   * CANCELACIÓN de una entrega en vuelo. Operación del operador, hermana de
   * `replayDelivery` y con exactamente su misma autorización.
   *
   * Proporciona una operación consistente y trazable de cancelación de entregas:
   *   1. Registra la entrega en `dead_letters` para trazabilidad y replay.
   *   2. Notifica el resultado a través de `insertOriginRelay`.
   *   3. Materializa la respuesta en el árbol de delegación para actualizar al padre y la agregación de fan-in.
   *
   * NO INVENTA UN ESTADO NUEVO. Termina en 'dead', por el mismo motivo por el que lo hace el
   * reaper (ver su comentario): toda la maquinaria de revisión manual ya apunta ahí, y un
   * 'cancelled' obligaría a ampliar el CHECK de `deliveries.status`, `DeliveryStateSchema`, las
   * series del dispatcher y cinco vistas de consola para terminar reimplementando el mismo botón
   * de replay. Lo que sí es propio es el rastro: motivo con prefijo estable y un `audit_events`
   * con acción `delivery.cancel`, para poder contar cancelaciones sin confundirlas con timeouts.
   *
   * NO MANDA NINGÚN FRAME AL ADAPTADOR, a propósito. El lado servidor queda consistente en una
   * sola transacción; el harness que siga corriendo morirá por su propio camino (techo de vida)
   * y su ACK tardío rebotará como `ownership_lost`, porque `ackDelivery` corta antes con
   * `terminal(row.status)`. Es la degradación correcta: no depende de que el adaptador esté vivo,
   * que es justamente la situación en la que hace falta cancelar.
   */
  async cancelDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
    reason?: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    const cancelReason = cancellationReason(actorTenant, actorAlias, reason);
    return withTransaction(this.pool, async (client) => {
      // Se traen las MISMAS columnas que arma el reaper porque abajo se llaman los mismos tres
      // helpers (`materializeAgentResponse`, `materializeAgentFanin`, `insertOriginRelay`) y
      // todos esperan un `DeliveryRow` completo. `FOR UPDATE OF d` sin función de ventana: ver
      // `sql-locking-clauses.test.ts`, PostgreSQL rechaza esa combinación al parsear.
      const selected = await client.query<DeliveryRow>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,
                d.max_attempts,d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,
                d.claim_token,d.ack_deadline_at,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,
                m.priority,m.origin,m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1
         FOR UPDATE OF d`,
        [deliveryId]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);
      // Una entrega ya terminal no se cancela: se replaya o se deja. Devolver `conflict` en vez
      // de "ok" es lo honesto, porque un segundo cancel que dijera que sí haría creer al operador
      // que interrumpió algo que en realidad ya había terminado (y quizá terminado BIEN).
      if (terminal(row.status)) {
        throw new StoreError('conflict', `delivery is already terminal (${row.status})`);
      }

      // Se limpian los campos de vallado además del estado. No es cosmético: mientras
      // `claim_token`/`consumer_epoch` sigan puestos, un adaptador con la garra en la mano puede
      // seguir renovándola, y el objetivo de cancelar es soltar el cupo del alias ya.
      const cancelled = await client.query(
        `UPDATE deliveries
           SET status='dead',terminal_at=now(),last_error=$2,last_ack_rank=3,
               cancelled_at=now(),
               claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
               consumer_instance_id=NULL,consumer_epoch=NULL,updated_at=now()
         WHERE id=$1 AND status NOT IN ('done','failed','dead')`,
        [row.id, cancelReason]
      );
      if (cancelled.rowCount !== 1) {
        throw new StoreError('conflict', 'delivery became terminal while being cancelled');
      }

      // (1) Rastro replayable. El `ON CONFLICT` cubre la entrega que ya tenía dead letter de una
      // vida anterior; el `resolved_at` lo pone `replayDelivery` cuando alguien la rescate.
      await client.query(
        `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
         VALUES($1,$2,$5,$3::jsonb,$4)
         ON CONFLICT(delivery_id) DO NOTHING`,
        [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, cancelReason]
      );

      // (2) y (3): el padre y el humano, por los mismos dos caminos que usa el reaper. A
      // diferencia del reaper, acá NO se atrapa el error de materialización: el reaper procesa un
      // lote y no puede dejar que una fila mate el tick entero, pero esto es un comando
      // interactivo de una sola entrega. Si el aviso al padre no se puede escribir, la
      // transacción entera se deshace y el operador ve el motivo, en vez de quedarse con una
      // cancelación a medias —que es exactamente el estado que produce el UPDATE manual—.
      const chainPolicy = await this.loadChainPolicy(client);
      const responseDisposition = await this.materializeAgentResponse(
        client, row, row.attempt, 'dead', chainPolicy, undefined, cancelReason, 'DELIVERY_CANCELLED'
      );
      const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
      const relayed = responseDisposition === 'not_child'
        && (row.body.type === 'agent.fanin' || !fanin.hasFanout);
      if (relayed) {
        await this.insertOriginRelay(
          client, row, 'dead', { error: cancelReason, error_code: 'DELIVERY_CANCELLED' }
        );
      }

      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.cancel','allow',$3,$4,$5,$6,$7::jsonb)`,
        [actorTenant, actorAlias, row.request_id, row.message_id, row.id, row.trace_id,
          JSON.stringify({
            cancelled_from_status: row.status,
            attempt: row.attempt,
            reason: cancelReason,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias,
            parent_notice: responseDisposition,
            origin_relayed: relayed
          })]
      );
      return {
        delivery_id: row.id,
        state: 'dead',
        cancelled: true,
        cancelled_from_state: row.status,
        reason: cancelReason,
        parent_notice: responseDisposition,
        origin_relayed: relayed,
        // El operador tiene que saber que esto NO es irreversible: la fila de `dead_letters` que
        // se acaba de escribir es la que habilita el botón de replay.
        replayable: true
      };
    });
  }

  async listJobs(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS job_id,tenant_id,lane,kind,status,priority,attempts,claimed_by,claimed_at,created_at,updated_at
       FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [actorTenant, limit]
    );
    return { items: result.rows };
  }





  async listOriginRelays(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT outbox.id,outbox.tenant_id,outbox.adapter,outbox.request_id,outbox.message_id,
              outbox.delivery_id,outbox.trace_id,outbox.origin,outbox.payload,outbox.status,
              outbox.attempts,outbox.created_at,outbox.sent_at,message.actor_alias,
              message.tenant_id AS message_tenant_id,delivery.recipient_tenant,delivery.recipient_alias
       FROM adapter_outbox outbox JOIN messages message ON message.id=outbox.message_id
       LEFT JOIN deliveries delivery ON delivery.id=outbox.delivery_id
       WHERE outbox.kind='origin_relay' AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$1 AND source_member.room_id=message.room_id
                   AND source_member.alias=$2 AND source_member.enabled AND message.tenant_id=$1)
         OR (EXISTS (SELECT 1 FROM deliveries participant
                     WHERE participant.id=outbox.delivery_id AND participant.recipient_tenant=$1
                       AND participant.recipient_alias=$2)
             AND (message.tenant_id=$1 OR EXISTS (
               SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1
                 AND edge.to_tenant=message.tenant_id AND edge.enabled AND edge.allow_read
             )))
       ) ORDER BY outbox.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
  }

  /**
   * La LISTA VISIBLE de preguntas pendientes a una persona.
   *
   * Es la contrapartida del gate: desacoplar la espera humana del bus para exponer
   * un listado consultable y gestionable por operadores o agentes autorizados.
   *
   * Devuelve los abiertos primero y luego los resueltos recientes, para que la lista sirva
   * también como acuse de "esto ya se contestó".
   */
  async listChainGates(
    actorTenant: Tenant,
    actorAlias: string,
    options: { status?: 'open' | 'all'; limit?: number } = {}
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
      ? Math.min(options.limit!, 500)
      : 200;
    const onlyOpen = options.status !== 'all';
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT gate.id,gate.root_message_id,gate.tenant_id,gate.asked_by_alias,gate.trace_id,
              gate.question,gate.status,gate.answer,gate.answered_at,gate.answered_by,
              gate.resume_delivery_id,gate.origin,gate.created_at,gate.updated_at,
              gate.source_delivery_id,
              (gate.correlation->>'hop_count')::integer AS hop_count,
              (gate.correlation->>'hop_budget')::integer AS hop_budget,
              extract(epoch FROM (now()-gate.created_at))::bigint AS waiting_seconds
       FROM agent_chain_gates gate
       WHERE (NOT $3::boolean OR gate.status='open')
         AND (gate.tenant_id=$1 OR EXISTS (
           SELECT 1 FROM acl_edges edge
           WHERE edge.from_tenant=$1 AND edge.to_tenant=gate.tenant_id
             AND edge.enabled AND edge.allow_read
         ))
         AND EXISTS (
           SELECT 1 FROM memberships membership
           WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         )
       ORDER BY (gate.status='open') DESC,gate.created_at DESC
       LIMIT $4`,
      [actorTenant, actorAlias, onlyOpen, limit]
    );
    return { items: result.rows };
  }

  /**
   * El humano contesta y la cadena se reanuda.
   *
   * Emite EXACTAMENTE UNA entrega, hacia el agente que preguntó, con la correlación de la rama
   * suspendida restaurada: misma raíz, mismo trace, mismo presupuesto de saltos y mismo camino
   * visitado. Por eso reanudar no arranca una cadena nueva ni recupera combustible ya gastado.
   *
   * `FOR UPDATE` sobre la fila del gate es el otro lado del `FOR SHARE` que toma
   * `materializeAgentOutputs`: contestar y delegar sobre la misma raíz no se pueden cruzar.
   */
  async answerChainGate(
    gateId: string,
    answer: string,
    actorTenant: Tenant,
    actorAlias: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'route');
    if (!uuidPattern.test(gateId)) {
      throw new StoreError('invalid_input', 'gate id must be a uuid');
    }
    const text = postgresTextSafe(answer) ?? '';
    if (!visibleText(text)) {
      throw new StoreError('invalid_input', 'gate answer must be non-empty text');
    }
    const bounded = truncateUtf8(text, maxChainGateQuestionBytes).value;
    return withTransaction(this.pool, async (client) => {
      const gate = await client.query<{
        id: string;
        root_message_id: string;
        tenant_id: Tenant;
        asked_by_alias: string;
        trace_id: string;
        question: string;
        status: string;
        correlation: Record<string, unknown> | null;
        origin: Origin | null;
      }>(
        `SELECT id,root_message_id,tenant_id,asked_by_alias,trace_id,question,status,correlation,origin
         FROM agent_chain_gates WHERE id=$1 FOR UPDATE`,
        [gateId]
      );
      const row = gate.rows[0];
      if (!row) throw new StoreError('not_found', 'chain gate not found');
      if (row.status !== 'open') {
        throw new StoreError('conflict', `chain gate is already ${row.status}`);
      }
      const room = await client.query<{ room_id: string }>(
        `SELECT membership.room_id
         FROM memberships membership
         JOIN role_policies policy ON policy.role=membership.role
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
           AND tenant.enabled AND room.enabled AND policy.allow_route
         ORDER BY membership.room_id LIMIT 1`,
        [row.tenant_id, row.asked_by_alias]
      );
      const roomId = room.rows[0]?.room_id;
      if (!roomId) {
        throw new StoreError('invalid_actor', 'the agent that opened the gate has no routable room');
      }
      const gateCorrelation = objectRecord(row.correlation) ?? {};
      // Se resta un salto a propósito. La correlación guardada es la que habría llevado el HIJO
      // de esta rama; la reanudación no baja un nivel, vuelve al MISMO agente. Sin la resta,
      // cada gate le comería un salto al presupuesto de la cadena.
      const storedHop = typeof gateCorrelation.hop_count === 'number'
        && Number.isSafeInteger(gateCorrelation.hop_count)
        ? gateCorrelation.hop_count
        : 1;
      const correlation = {
        ...gateCorrelation,
        hop_count: Math.max(0, storedHop - 1),
        gate_id: row.id,
        gate_question: row.question,
        gate_answered_by: `${actorTenant}/${actorAlias}`
      };
      const requestId = randomUUID();
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'batch',$8,$9,$10) RETURNING id`,
        [
          requestId, row.trace_id, row.tenant_id, roomId, row.asked_by_alias,
          JSON.stringify({
            type: 'agent.message',
            text: `Respuesta humana a tu pregunta pendiente.\n\nPregunta: ${row.question}\n\n`
              + `Respuesta de ${actorAlias}: ${bounded}\n\n`
              + 'Retomá la tarea con esto. No vuelvas a preguntar lo mismo.',
            from_alias: actorAlias,
            correlation
          }),
          row.origin ? JSON.stringify(row.origin) : null,
          7, `chain-gate:${row.id}`, 'chain-gate'
        ]
      );
      const resumeMessageId = message.rows[0]?.id;
      if (!resumeMessageId) throw new Error('gate resume message insert returned no id');
      const delivery = await client.query<{ id: string }>(
        `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
         VALUES($1,$2,$3) RETURNING id`,
        [resumeMessageId, row.tenant_id, row.asked_by_alias]
      );
      const resumeDeliveryId = delivery.rows[0]?.id;
      if (!resumeDeliveryId) throw new Error('gate resume delivery insert returned no id');
      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,NULL,$7::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [
          row.tenant_id, `chain-gate-resume:${row.id}`, requestId, resumeMessageId,
          resumeDeliveryId, row.trace_id,
          JSON.stringify({ recipient_alias: row.asked_by_alias, reason: 'delivery_available' })
        ]
      );
      await client.query(
        `UPDATE agent_chain_gates
         SET status='answered',answer=$2,answered_at=now(),answered_by=$3,
             resume_message_id=$4,resume_delivery_id=$5,updated_at=now()
         WHERE id=$1`,
        [row.id, bounded, `${actorTenant}/${actorAlias}`, resumeMessageId, resumeDeliveryId]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'agent_chain.gate_answered','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          row.tenant_id, actorAlias, requestId, resumeMessageId, resumeDeliveryId, row.trace_id,
          JSON.stringify({
            gate_id: row.id,
            root_message_id: row.root_message_id,
            asked_by_alias: row.asked_by_alias,
            answered_by: `${actorTenant}/${actorAlias}`
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: row.tenant_id, alias: row.asked_by_alias })
      ]);
      return {
        gate_id: row.id,
        status: 'answered',
        resume_message_id: resumeMessageId,
        resume_delivery_id: resumeDeliveryId,
        recipient_tenant: row.tenant_id,
        recipient_alias: row.asked_by_alias
      };
    });
  }

  /**
   * Cierra un gate sin reanudar nada. Es la válvula para una pregunta que ya no tiene sentido:
   * sin esto, un gate mal abierto dejaría su raíz suspendida para siempre.
   */
  async cancelChainGate(
    gateId: string,
    actorTenant: Tenant,
    actorAlias: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'route');
    if (!uuidPattern.test(gateId)) {
      throw new StoreError('invalid_input', 'gate id must be a uuid');
    }
    const updated = await this.pool.query<{ id: string; root_message_id: string }>(
      `UPDATE agent_chain_gates SET status='cancelled',updated_at=now()
       WHERE id=$1 AND status='open' RETURNING id,root_message_id`,
      [gateId]
    );
    if (updated.rowCount !== 1) {
      throw new StoreError('conflict', 'chain gate is not open');
    }
    return { gate_id: gateId, status: 'cancelled' };
  }

  /**
   * Qué suscripción gasta el alias en su próxima ejecución (GET /v3/accounts/selection).
   *
   * `actorTenant`/`actorAlias` son la identidad mTLS AUTENTICADA y son TAMBIÉN el sujeto de la
   * consulta: no hay parámetro para preguntar por otro alias. Es deliberado y es la mitad de la
   * seguridad de esta ruta — la respuesta incluye el `credential_ref` de la cuenta, y aunque sea
   * un locator y no un secreto, decirle a un agente dónde busca su credencial OTRO agente es
   * exactamente el tipo de dato que no tiene por qué cruzar. Un alias sólo resuelve lo suyo.
   *
   * Nótese la diferencia con `getConfiguration()`, que NUNCA devuelve `credential_ref` ni a su
   * pagador (ver configuration.ts): aquello alimenta un navegador, esto alimenta al adaptador que
   * corre en el host que ya tiene el material montado. La migración 010 lo dice al describir el
   * locator: "the borrower receives a reference it can only dereference on a host that already
   * holds the material".
   */
  async selectAccount(actorTenant: Tenant, actorAlias: string, provider: string): Promise<AccountSelection> {
    // Mismo juego de caracteres que el CHECK de `provider_accounts.provider`. Se valida acá y no
    // sólo en la ruta para que ningún llamador futuro pueda meter una cadena arbitraria en el
    // parámetro de la consulta.
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(provider)) {
      throw new StoreError('invalid_input', `invalid provider name: ${provider}`);
    }
    return selectAccountForAlias(this.pool, {
      tenant_id: actorTenant, alias: actorAlias, provider
    });
  }
}
