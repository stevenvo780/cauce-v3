import { hubStarRouteSql } from '../../../acl-edges.js';
import { isAlias, MAX_DELEGATION_FEEDBACK_ITEMS, type Tenant } from '@cauce/protocol';
import { isClientMailboxAlias, clientMailboxRoutingTargets, resolveClientMailbox } from '../../../../client-mailbox.js';
import type { DatabaseClient } from '../../../../db.js';
import { declaredArtifactBudget } from '../../delegated-attachments.js';
import { AGENT_ROOT_DELEGATIONS, HUMAN_GATE_TARGET } from '../../../../delegation-guard.js';
import {
  maxAgentOutputMessages, type AgentOutputEntry, type OpenChainGate, type RoutingTarget
} from '../../../deliveries.js';
import type { ChainPolicy, DeliveryRow } from '../../../observability.js';
import { visibleText } from '../../../outbox.js';
import {
  maxAgentOutputExpandedBytes, type AgentOutputRejectionCode, type ResolvedAgentOutputEntry
} from '../policy.js';
import {
  releaseRootDelegation, reserveChainEdge, reserveRootDelegation
} from '../outputs.js';

export interface PlannedRejection {
  code: AgentOutputRejectionCode;
  cap?: number;
}

export type PreRoutingPlan =
  | { kind: 'rejected'; rejection: PlannedRejection }
  | { kind: 'routable'; targetAlias: string; body: string };

export async function expandAgentOutputs(
  outputs: AgentOutputEntry[],
  internalAgentDelivery: boolean,
  routingTargets: () => Promise<RoutingTarget[]>
): Promise<ResolvedAgentOutputEntry[]> {
  const hasAllDirective = outputs.some((output) => output.target === '@all');
  if (hasAllDirective && (internalAgentDelivery || outputs.length !== 1
    || outputs[0]?.target !== '@all' || outputs[0].rejection !== undefined)) {
    return outputs.map((output) => ({ ...output, rejection: 'invalid_output' }));
  }
  if (outputs.length !== 1 || outputs[0]?.target !== '@all') return outputs;

  const directive = outputs[0];
  const targets = (await routingTargets()).filter((target) => target.online);
  const textBytes = typeof directive.body === 'string'
    ? Buffer.byteLength(directive.body, 'utf8')
    : 0;
  const declared = declaredArtifactBudget(directive.artifacts);
  const withheld = (textBytes + declared.bytes) * targets.length > maxAgentOutputExpandedBytes
    && textBytes * targets.length <= maxAgentOutputExpandedBytes
    ? declared.deliverable
    : 0;
  const { artifacts: _withheldArtifacts, ...withoutArtifacts } = directive;
  const broadcast: AgentOutputEntry = withheld === 0
    ? directive
    : { ...withoutArtifacts, artifactsWithheld: withheld };
  const perTargetBytes = textBytes + (withheld > 0 ? 0 : declared.bytes);
  const expandedBytes = perTargetBytes * targets.length;
  if (targets.length === 0
    || targets.length > MAX_DELEGATION_FEEDBACK_ITEMS
    || expandedBytes > maxAgentOutputExpandedBytes) {
    return [{
      ...broadcast,
      ...(targets.length > MAX_DELEGATION_FEEDBACK_ITEMS
        || expandedBytes > maxAgentOutputExpandedBytes
        ? { rejection: 'invalid_output' as const }
        : {})
    }];
  }
  return targets.map((target, targetIndex) => ({
    ...broadcast,
    index: maxAgentOutputMessages + (directive.index * 100) + targetIndex,
    target: target.alias,
    targetTenant: target.tenant_id,
    targetRef: {
      directive: '@all',
      tenant_id: target.tenant_id,
      alias: target.alias
    }
  }));
}

export function orderAgentOutputs(
  outputs: ResolvedAgentOutputEntry[],
  policy: ChainPolicy,
  openGate: OpenChainGate | undefined,
  rootMessageId: string | undefined
): { gateDirective: ResolvedAgentOutputEntry | undefined; outputs: ResolvedAgentOutputEntry[] } {
  const gateDirective = policy.humanGateEnabled && openGate === undefined
    && rootMessageId !== undefined
    ? outputs.find((output) => output.target === HUMAN_GATE_TARGET
      && output.rejection === undefined && visibleText(output.body))
    : undefined;
  return {
    gateDirective,
    outputs: gateDirective === undefined
      ? outputs
      : [gateDirective, ...outputs.filter((output) => output !== gateDirective)]
  };
}

export function preRoutingPlan(input: {
  rejection: 'invalid_output' | undefined;
  targetAlias: string | undefined;
  body: string | undefined;
  hopCount: number;
  hopBudget: number;
  recipientAlias: string;
  actorAlias: string;
  internalAgentDelivery: boolean;
  materialized: number;
  fanoutCap: number | undefined;
}): PreRoutingPlan {
  if (!input.rejection && !isAlias(input.targetAlias)) {
    return { kind: 'rejected', rejection: { code: 'unroutable_alias' } };
  }
  if (!input.rejection && input.hopCount > input.hopBudget) {
    return { kind: 'rejected', rejection: { code: 'hop_budget_exhausted' } };
  }
  if (!input.rejection && (input.targetAlias === input.recipientAlias
    || (input.internalAgentDelivery && input.targetAlias === input.actorAlias))) {
    return { kind: 'rejected', rejection: { code: 'unroutable_alias' } };
  }
  if (!input.rejection && input.fanoutCap !== undefined
    && input.materialized >= input.fanoutCap) {
    return {
      kind: 'rejected',
      rejection: { code: 'fanout_exceeded', cap: input.fanoutCap }
    };
  }
  if (input.rejection || input.targetAlias === undefined || input.body === undefined) {
    return {
      kind: 'rejected',
      rejection: { code: input.rejection ?? 'invalid_output' }
    };
  }
  return { kind: 'routable', targetAlias: input.targetAlias, body: input.body };
}

export async function reserveDelegationCapacity(
  client: DatabaseClient,
  policy: ChainPolicy,
  rootMessageId: string | undefined,
  sourceNode: string,
  targetNode: string,
  agentRoot = false
): Promise<PlannedRejection | undefined> {
  if (!policy.delegationCaps.enabled || !policy.delegationCapsAvailable
    || rootMessageId === undefined) return undefined;
  const rootCap = agentRoot
    ? Math.min(policy.delegationCaps.maxDelegationsPerRoot, AGENT_ROOT_DELEGATIONS)
    : policy.delegationCaps.maxDelegationsPerRoot;
  const rootReserved = await reserveRootDelegation(client, rootMessageId, rootCap);
  if (!rootReserved) return { code: 'root_budget_exhausted', cap: rootCap };
  const edgeReserved = await reserveChainEdge(
    client,
    rootMessageId,
    sourceNode,
    targetNode,
    policy.delegationCaps.maxEdgeRepeatsPerRoot
  );
  if (edgeReserved) return undefined;
  await releaseRootDelegation(client, rootMessageId);
  return {
    code: 'edge_repeat_exceeded',
    cap: policy.delegationCaps.maxEdgeRepeatsPerRoot
  };
}

export async function allowedTargetTenants(
  client: DatabaseClient,
  row: DeliveryRow,
  targetAlias: string,
  targetTenant: Tenant | undefined,
  excludedAliases: readonly string[]
): Promise<Tenant[]> {
  if (isClientMailboxAlias(targetAlias)) {
    const candidates = targetTenant === undefined
      ? await clientMailboxRoutingTargets(client, row.recipient_tenant, targetAlias)
      : [{ tenant_id: targetTenant, alias: targetAlias }];
    const allowed: Tenant[] = [];
    for (const candidate of candidates.filter((target) => target.alias === targetAlias)) {
      if (candidate.tenant_id !== row.recipient_tenant) {
        const edge = await client.query(`SELECT 1 FROM acl_edges edge JOIN tenants source ON source.id=edge.from_tenant
          JOIN tenants target ON target.id=edge.to_tenant WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
          AND source.enabled AND target.enabled AND edge.enabled AND edge.allow_route AND ${hubStarRouteSql('source', 'target', true)}
          FOR SHARE OF edge,source,target`, [row.recipient_tenant, candidate.tenant_id]);
        if (edge.rowCount !== 1) continue;
      }
      if (await resolveClientMailbox(client, candidate.tenant_id, targetAlias)) allowed.push(candidate.tenant_id);
    }
    return allowed;
  }
  if (targetTenant !== undefined) return [targetTenant];
  const candidates = await client.query<{ tenant_id: Tenant }>(
    `SELECT membership.tenant_id
       FROM memberships membership
       JOIN tenants target ON target.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.alias=$1 AND membership.enabled AND target.enabled AND room.enabled
         AND NOT (membership.alias=ANY($2::text[]))
       ORDER BY membership.tenant_id,membership.room_id
       FOR SHARE OF membership,target,room`,
    [targetAlias, excludedAliases]
  );
  const allowed: Tenant[] = [];
  for (const candidate of new Set(candidates.rows.map((entry) => entry.tenant_id))) {
    if (candidate === row.recipient_tenant) {
      allowed.push(candidate);
      continue;
    }
    const edge = await client.query(
      `SELECT 1 FROM acl_edges edge
       JOIN tenants source ON source.id=edge.from_tenant
       JOIN tenants target ON target.id=edge.to_tenant
       WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
         AND edge.enabled AND edge.allow_route AND ${hubStarRouteSql('source', 'target', true)}
       FOR SHARE OF edge,source,target`,
      [row.recipient_tenant, candidate]
    );
    if (edge.rowCount === 1) allowed.push(candidate);
  }
  return allowed;
}
