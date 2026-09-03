import {
  SYSTEM_PRINCIPAL_ALIASES, type Ack
} from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { DatabaseClient } from '../../../db.js';
import {
  boundedRejectionTarget, describeDelegationRejection, fanoutCapForTurn, HUMAN_GATE_TARGET
} from '../../../delegation-guard.js';
import {
  redactedOutputText
} from '../delegated-attachments.js';
import { chainNode } from '../fanin.js';
import { sha256 } from '../../config.js';
import {
  type AgentOutputEntry, type AgentOutputOutcome,
  type DelegationMaterialization, type DelegationRejection
} from '../../deliveries.js';
import { StoreError } from '../../errors.js';
import type { ChainPolicy, DeliveryRow } from '../../observability.js';
import {
  AgentChainPolicyRepository, agentOutputRequestId, type AgentOutputRejectionCode
} from './policy.js';
import {
  insertAgentOutputRejection, openChainGateFor, openHumanGate
} from './outputs.js';
import {
  deriveMaterializationLineage, sourceRoomForAgentOutput
} from './materialization/lineage.js';
import {
  allowedTargetTenants, expandAgentOutputs, orderAgentOutputs, preRoutingPlan,
  reserveDelegationCapacity
} from './materialization/planning.js';
import { persistAgentOutput } from './materialization/persistence.js';

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

    const sourceRoomId = await sourceRoomForAgentOutput(client, row);
    if (!sourceRoomId) {
      throw new StoreError('invalid_actor', 'delivery consumer has no source room for agent output');
    }
    const {
      internalAgentDelivery, hopBudget, hopCount, rootRequestId, rootMessageId,
      rootDeliveryId, visitedPath
    } = await deriveMaterializationLineage(client, row, policy);

    // An open human gate suspends the root. FOR SHARE interlocks with answering it, so no
    // output materializes and the question is not amplified while it remains open.
    //
    // Check table availability, not the enable flag: disabling prevents new gates but must not
    // silently resume an existing chain awaiting its answer. Only the explicit, audited
    // cancelChainGate operation releases it without an answer.
    const openGate = policy.humanGateAvailable
      ? await openChainGateFor(client, rootMessageId)
      : undefined;

    const expandedOutputs = await expandAgentOutputs(
      outputs,
      internalAgentDelivery,
      () => this.routingTargets(
        client,
        row.recipient_tenant,
        row.recipient_alias
      )
    );
    const ordered = orderAgentOutputs(expandedOutputs, policy, openGate, rootMessageId);
    const gateDirective = ordered.gateDirective;

    let materialized = 0;
    let suspended = false;
    const rejections: DelegationRejection[] = [];
    const materializations: DelegationMaterialization[] = [];
    let activeGate = openGate;
    const materializedTargets: string[] = [];
    const fanoutCap = fanoutCapForTurn(policy.delegationCaps, hopCount);
    for (const output of ordered.outputs) {
      const requestId = agentOutputRequestId(row.id, ack.attempt, output.index);
      const targetRefHash = sha256(output.targetRef ?? output.target);
      const outputText = redactedOutputText(output.body);
      const bodyHash = sha256(outputText);
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
      const candidateTargetAlias = typeof output.target === 'string' ? output.target : undefined;
      const candidateBody = typeof outputText === 'string' ? outputText : undefined;
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
        const boundedTarget = boundedRejectionTarget(candidateTargetAlias);
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
      if (output === gateDirective && candidateTargetAlias === HUMAN_GATE_TARGET
        && candidateBody !== undefined && rootMessageId !== undefined) {
        const gate = await openHumanGate(client, row, ack, output.index, {
          rootMessageId, question: candidateBody, correlation
        });
        if (gate !== undefined) {
          activeGate = gate;
          suspended = true;
          await reject('human_gate_opened', { question: gate.question, gateId: gate.id });
          continue;
        }
      }
      const routingPlan = preRoutingPlan({
        rejection,
        targetAlias: candidateTargetAlias,
        body: candidateBody,
        hopCount,
        hopBudget,
        recipientAlias: row.recipient_alias,
        actorAlias: row.actor_alias,
        internalAgentDelivery,
        materialized,
        fanoutCap
      });
      if (routingPlan.kind === 'rejected') {
        await reject(
          routingPlan.rejection.code,
          routingPlan.rejection.cap === undefined ? {} : { cap: routingPlan.rejection.cap }
        );
        continue;
      }
      const { targetAlias, body } = routingPlan;

      const allowedTargets = await allowedTargetTenants(
        client,
        row,
        targetAlias,
        output.targetTenant,
        SYSTEM_PRINCIPAL_ALIASES
      );
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
      const capacityRejection = await reserveDelegationCapacity(
        client,
        policy,
        rootMessageId,
        chainNode(row.recipient_tenant, row.recipient_alias),
        targetNode
      );
      if (capacityRejection !== undefined) {
        await reject(capacityRejection.code, {
          target: targetNode,
          ...(capacityRejection.cap === undefined ? {} : { cap: capacityRejection.cap })
        });
        continue;
      }

      const persisted = await persistAgentOutput(client, {
        row,
        ack,
        output,
        sourceRoomId,
        targetTenant,
        targetAlias,
        body,
        requestId,
        targetRefHash,
        bodyHash,
        correlation,
        hopCount,
        hopBudget,
        visitedPath,
        visitedPathAvailable: policy.visitedPathAvailable
      });
      materialized += 1;
      materializations.push({
        output_index: output.index,
        target_tenant: targetTenant,
        target_alias: targetAlias,
        child_delivery_id: persisted.producedDeliveryId,
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
