import { isRfcUuid, persistedString } from '@cauce/protocol';
import type { DatabaseClient } from '../../../../db.js';
import { chainNode } from '../../fanin.js';
import { reservedInternalMessageTypes } from '../../../config.js';
import { StoreError } from '../../../errors.js';
import type { ChainPolicy, DeliveryRow } from '../../../observability.js';
import { objectRecord } from '../../../outbox.js';
import {
  maxVisitedPathEntries, safeHopBudget, safeHopCount, sanitizedVisitedPath,
  type AgentOutputLineage
} from '../policy.js';
import { continuationBranchMaterialization } from '../outputs.js';

export interface MaterializationLineage {
  internalAgentDelivery: boolean;
  hopBudget: number;
  hopCount: number;
  rootRequestId: string;
  rootMessageId: string | undefined;
  rootDeliveryId: string;
  visitedPath: string[];
}

export async function sourceRoomForAgentOutput(
  client: DatabaseClient,
  row: DeliveryRow
): Promise<string | undefined> {
  const membership = await client.query<{ room_id: string }>(
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
  return membership.rows[0]?.room_id;
}

async function storedParentLineage(
  client: DatabaseClient,
  row: DeliveryRow,
  policy: ChainPolicy
): Promise<AgentOutputLineage | undefined> {
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
  const stored = parent.rows[0];
  return stored?.hop_count === undefined || stored.hop_count === null ? undefined : stored;
}

export async function deriveMaterializationLineage(
  client: DatabaseClient,
  row: DeliveryRow,
  policy: ChainPolicy
): Promise<MaterializationLineage> {
  const storedParent = await storedParentLineage(client, row, policy);
  const parent = storedParent
    ?? await continuationBranchMaterialization(client, row, policy.visitedPathAvailable);
  return materializationLineageFrom(row, parent);
}

export function materializationLineageFrom(
  row: DeliveryRow,
  parent: AgentOutputLineage | undefined
): MaterializationLineage {
  const internalAgentDelivery = typeof row.body.type === 'string'
    && reservedInternalMessageTypes.has(row.body.type);
  // Client-publishable body types cannot supply lineage or chain budgets.
  const bodyCorrelation = internalAgentDelivery ? objectRecord(row.body.correlation) : undefined;
  const hopBudget = safeHopBudget(parent?.hop_budget ?? bodyCorrelation?.hop_budget);
  const hopCount = safeHopCount(parent?.hop_count ?? bodyCorrelation?.hop_count, hopBudget) + 1;
  const parentCorrelation = objectRecord(parent?.correlation) ?? bodyCorrelation;
  const inheritedVisitedPath = sanitizedVisitedPath(parent?.visited_path);
  return {
    internalAgentDelivery,
    hopBudget,
    hopCount,
    rootRequestId: isRfcUuid(parentCorrelation?.root_request_id)
      ? parentCorrelation.root_request_id
      : row.request_id,
    rootMessageId: persistedString(
      isRfcUuid(parentCorrelation?.root_message_id)
        ? parentCorrelation.root_message_id
        : row.message_id
    ),
    rootDeliveryId: isRfcUuid(parentCorrelation?.root_delivery_id)
      ? parentCorrelation.root_delivery_id
      : row.id,
    visitedPath: sanitizedVisitedPath([
      ...(inheritedVisitedPath.length > 0
        ? inheritedVisitedPath
        : sanitizedVisitedPath(bodyCorrelation?.visited_path)
      ).slice(0, maxVisitedPathEntries - 1),
      chainNode(row.recipient_tenant, row.recipient_alias)
    ])
  };
}
