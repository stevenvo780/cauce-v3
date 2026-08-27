import { createHash, randomUUID } from 'node:crypto';
import {
  clampAgentPriority, DelegationMaterializationSchema, DelegationRejectionSchema,
  MAX_DELEGATION_FEEDBACK_ITEMS, type Ack, type Origin, type Tenant
} from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import {
  boundedRejectionTarget, describeDelegationRejection, DISABLED_DELEGATION_CAPS, fanoutCapForTurn,
  HUMAN_GATE_TARGET, rejectionText, sanitizedDelegationCaps,
  type DelegationRejectionCode, type RejectionNotice
} from '../../delegation-guard.js';
import { AgentFaninRepository, chainNode, uuidPattern } from './fanin.js';
import { reservedInternalMessageTypes, sha256 } from '../config.js';
import {
  maxAgentOutputMessages, postgresTextSafe,
  type AckResult, type AgentOutputEntry, type AgentOutputOutcome,
  type DelegationMaterialization, type DelegationRejection, type OpenChainGate
} from '../deliveries.js';
import { StoreError } from '../errors.js';
import {
  aliasPattern, disabledChainPolicy, originRelayTenant, tenantPattern, truncateUtf8,
  type ChainPolicy, type DeliveryRow
} from '../observability.js';
import { objectRecord, visibleText } from '../outbox.js';















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

export abstract class AgentChainControlRepository extends AgentFaninRepository {

















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
}
