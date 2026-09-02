import {
  clampAgentPriority, isAlias, isRfcUuid, MAX_DELEGATION_FEEDBACK_ITEMS, persistedString,
  SYSTEM_PRINCIPAL_ALIASES, type Ack, type Tenant
} from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { DatabaseClient } from '../../../db.js';
import {
  boundedRejectionTarget, describeDelegationRejection, fanoutCapForTurn, HUMAN_GATE_TARGET
} from '../../../delegation-guard.js';
import { chainNode } from '../fanin.js';
import { reservedInternalMessageTypes, sha256 } from '../../config.js';
import {
  maxAgentOutputMessages, type AgentOutputEntry, type AgentOutputOutcome,
  type DelegationMaterialization, type DelegationRejection
} from '../../deliveries.js';
import { StoreError } from '../../errors.js';
import { insertDelivery, insertMessage } from '../../messages/_insert.js';
import type { ChainPolicy, DeliveryRow } from '../../observability.js';
import { objectRecord, visibleText } from '../../outbox.js';
import {
  AgentChainPolicyRepository, agentOutputRequestId, maxAgentOutputExpandedBytes,
  maxVisitedPathEntries, safeHopBudget, safeHopCount, sanitizedVisitedPath,
  type AgentOutputLineage, type AgentOutputRejectionCode, type ResolvedAgentOutputEntry
} from './policy.js';
import {
  continuationBranchMaterialization, insertAgentOutputRejection, openChainGateFor, openHumanGate,
  releaseRootDelegation, reserveChainEdge, reserveRootDelegation
} from './outputs.js';

export abstract class AgentChainMaterializationRepository extends AgentChainPolicyRepository {
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
      ? await continuationBranchMaterialization(client, row, policy.visitedPathAvailable)
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
    const rootRequestId = isRfcUuid(parentCorrelation?.root_request_id)
      ? parentCorrelation.root_request_id
      : row.request_id;
    const rootMessageId = persistedString(
      isRfcUuid(parentCorrelation?.root_message_id)
        ? parentCorrelation.root_message_id
        : row.message_id
    );
    const rootDeliveryId = isRfcUuid(parentCorrelation?.root_delivery_id)
      ? parentCorrelation.root_delivery_id
      : row.id;
    // visited_path mirrors hop_count: fall back to trusted body correlation only when the
    // parent row is absent or its path is empty. Both states mean missing information:
    // root agent.response continuations have no producing materialization, while pre-008 or
    // partial-deploy rows carry the '{}' default.
    //
    // Empty is a safe sentinel because every new materialization stores at least its emitter;
    // therefore a non-empty parent path always wins. bodyCorrelation is available only for
    // reserved internal message types that clients cannot publish, and sanitizedVisitedPath
    // revalidates every tenant/alias entry.
    //
    // This is the same trust surface as hop_count, so client input cannot seed a path or
    // suppress a legitimate delegation.
    // Reserve one slot before inheriting so the current consumer always enters its path;
    // otherwise a saturated ancestor path could omit it and miss a later cycle.
    const inheritedVisitedPath = sanitizedVisitedPath(parentMaterialization?.visited_path);
    const visitedPath = sanitizedVisitedPath([
      ...(inheritedVisitedPath.length > 0
        ? inheritedVisitedPath
        : sanitizedVisitedPath(bodyCorrelation?.visited_path)
      ).slice(0, maxVisitedPathEntries - 1),
      chainNode(row.recipient_tenant, row.recipient_alias)
    ]);

    // An open human gate suspends the root. FOR SHARE interlocks with answering it, so no
    // output materializes and the question is not amplified while it remains open.
    //
    // Check table availability, not the enable flag: disabling prevents new gates but must not
    // silently resume an existing chain awaiting its answer. Only the explicit, audited
    // cancelChainGate operation releases it without an answer.
    const openGate = policy.humanGateAvailable
      ? await openChainGateFor(client, rootMessageId)
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

    // A human question cancels sibling delegations and is processed first, so subsequent
    // siblings observe the open gate and are rejected with chain_gated.
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
        // Child correlation carries the ancestor path plus the current emitter. agent.response
        // inherits it through relationship.correlation.
        // The stored path is the recipient's ancestor path: it already contains its parent, and
        // the recipient adds itself when it ACKs.
        //
        // Pre-deploy branches without the field degrade to a one-node path and therefore do not
        // cut until their next new hop; this preserves prior behavior for in-flight chains.
        // No child-provided lineage is trusted.
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
       * Durable rejections return through delegation_rejections and remain in audit/correlation;
       * they never generate a delivery.
       */
      const reject = async (
        code: AgentOutputRejectionCode,
        extra: { target?: string; cap?: number; question?: string; gateId?: string } = {}
      ): Promise<void> => {
        // Trimmed ONCE, and the same value goes both to the text and the field: `reason` embeds
        // the destination, so leaving the raw value in the text and trimming only the field would
        // move the length problem from one side of the same frame to the other.
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
        await insertAgentOutputRejection(
          client, row, ack, output.index, requestId, targetRefHash, bodyHash,
          hopCount, hopBudget, correlation, code, notice, boundedTarget
        );
      };

      // The chain is waiting on a human: nothing flows out to any agent.
      if (activeGate !== undefined) {
        await reject('chain_gated', { question: activeGate.question, gateId: activeGate.id });
        continue;
      }
        // `@human` is not an alias: it is a question. It stops being a delivery that cannot
        // complete and becomes a row with state. Only when the primitive exists and is enabled;
        // otherwise it falls back to the old path and ends in 'unroutable_alias', as before.
      if (output === gateDirective && targetAlias === HUMAN_GATE_TARGET && body !== undefined && rootMessageId !== undefined) {
        const gate = await openHumanGate(client, row, ack, output.index, {
          rootMessageId, question: body, correlation
        });
        if (gate !== undefined) {
          activeGate = gate;
          suspended = true;
          await reject('human_gate_opened', { question: gate.question, gateId: gate.id });
          continue;
        }
      }
      if (!rejection && !isAlias(targetAlias)) {
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
        // FAN-OUT cap per node, not only by depth. It counts over what was MATERIALIZED, so a
        // turn whose outputs are rejected for another reason does not spend fan-out.
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
             AND NOT (membership.alias=ANY($2::text[]))
           ORDER BY membership.tenant_id,membership.room_id
           FOR SHARE OF membership,target,room`,
          [targetAlias, SYSTEM_PRINCIPAL_ALIASES]
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
      const targetTenant = allowedTargets.length === 1 ? allowedTargets[0] : undefined;
      if (targetTenant === undefined) {
        await reject(allowedTargets.length > 1 ? 'ambiguous_alias' : 'unroutable_alias');
        continue;
      }
      const targetNode = chainNode(targetTenant, targetAlias);
      // The only point where the destination pair is both resolved and authorized. A cycle
      // is a durable rejection, never an exception: when every output of an ACK is rejected
      // the agent simply relays its own reply upwards, which is an already covered path.
      if (policy.cycleCutEnabled && visitedPath.includes(targetNode)) {
        await reject('cycle_detected', { target: targetNode });
        continue;
      }
      // Quota reservation. It runs AFTER resolving the destination and BEFORE writing anything:
      // a rejection for shape or route must not spend chain fuel.
      //
      // The order matters. The root first (a single row, the lock the progress relay already
      // takes), then the edge. If the edge does not fit, the root fuel is RETURNED in the same
      // transaction: otherwise a saturated destination would drain the whole chain's budget
      // without producing a single delivery.
      if (policy.delegationCaps.enabled && policy.delegationCapsAvailable && rootMessageId !== undefined) {
        const rootReserved = await reserveRootDelegation(
          client, rootMessageId, policy.delegationCaps.maxDelegationsPerRoot
        );
        if (!rootReserved) {
          await reject('root_budget_exhausted', {
            target: targetNode, cap: policy.delegationCaps.maxDelegationsPerRoot
          });
          continue;
        }
        const edgeReserved = await reserveChainEdge(
          client, rootMessageId, chainNode(row.recipient_tenant, row.recipient_alias), targetNode,
          policy.delegationCaps.maxEdgeRepeatsPerRoot
        );
        if (!edgeReserved) {
          await releaseRootDelegation(client, rootMessageId);
          await reject('edge_repeat_exceeded', {
            target: targetNode, cap: policy.delegationCaps.maxEdgeRepeatsPerRoot
          });
          continue;
        }
      }

      const message = await insertMessage(client, {
        requestId,
        traceId: row.trace_id,
        tenantId: row.recipient_tenant,
        roomId: sourceRoomId,
        actorAlias: row.recipient_alias,
        body: {
            type: 'agent.message',
            text: body,
            from_alias: row.recipient_alias,
            correlation
        },
        origin: row.origin ?? null,
          // Agent-to-agent delegation always uses the batch lane. Lane selects the queue, while
          // inherited, clamped priority orders work within it; they are independent controls.
          //
          // Applying both here prevents an interactive root or agent-controlled value from
          // promoting the whole machine-to-machine subtree into the human traffic band.
          // Both values are fixed where the child message is created, and the server-controlled
          // cap cannot be bypassed by the agent.
        lane: 'batch',
        priority: clampAgentPriority(row.priority),
        authSessionId: row.auth_session_id
          ?? `delivery:${row.id}:attempt:${String(ack.attempt)}`,
        authChannel: row.auth_channel ?? row.origin?.channel ?? 'agent-output',
      });
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('agent output message insert returned no id');
      const delivery = await insertDelivery(client, {
        messageId, recipientTenant: targetTenant, recipientAlias: targetAlias,
      });
      const producedDeliveryId = delivery.rows[0]?.id;
      if (!producedDeliveryId) throw new Error('agent output delivery insert returned no id');
      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         ) VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
        [
          targetTenant,
          `agent-output:${row.id}:${String(ack.attempt)}:${String(output.index)}`,
          requestId,
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
        + ` (hop ${String(hopCount)}/${String(hopBudget)}).`
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
}
