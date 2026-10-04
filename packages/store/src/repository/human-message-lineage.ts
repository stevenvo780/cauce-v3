import type { DatabaseClient } from '../db.js';
import { StoreError } from './errors.js';
import {
  loadHumanMessageInitiator, putHumanMessageInitiator, type HumanMessageInitiator,
} from './messages/human-initiators.js';

export function humanLineageConsensus(
  rows: readonly (HumanMessageInitiator | undefined)[],
): HumanMessageInitiator | undefined {
  const known = rows.filter((row): row is HumanMessageInitiator => row !== undefined);
  const first = known[0];
  if (first && known.some((row) => row.humanId !== first.humanId
    || row.tenantId !== first.tenantId || row.rootMessageId !== first.rootMessageId
    || row.conversationId !== first.conversationId)) {
    throw new StoreError('conflict', 'human message lineage disagrees');
  }
  return known.length === rows.length ? first : undefined;
}

export async function loadHumanMessageLineage(
  client: DatabaseClient, messageId: string,
): Promise<HumanMessageInitiator | undefined> {
  const row = await loadHumanMessageInitiator(client, messageId);
  if (!row) return undefined;
  const message = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM messages WHERE id=$1 FOR SHARE', [messageId],
  );
  const root = row.rootMessageId === messageId
    ? row : await loadHumanMessageInitiator(client, row.rootMessageId);
  if (row.messageId !== messageId || row.messageTenantId !== message.rows[0]?.tenant_id
    || !root || root.messageId !== root.rootMessageId || root.messageTenantId !== root.tenantId) {
    throw new StoreError('conflict', 'human message lineage anchor is unavailable');
  }
  humanLineageConsensus([row, root]);
  return row;
}

export async function loadDeliveryHumanLineage(
  client: DatabaseClient,
  delivery: { id: string; message_id: string; recipient_tenant: string; recipient_alias: string },
): Promise<HumanMessageInitiator | undefined> {
  const durable = await client.query<{ message_id: string }>(
    `SELECT delivery.message_id FROM deliveries delivery
     JOIN messages message ON message.id=delivery.message_id
     WHERE delivery.id=$1 AND delivery.message_id=$2
       AND delivery.recipient_tenant=$3 AND delivery.recipient_alias=$4
     FOR SHARE OF delivery,message`,
    [delivery.id, delivery.message_id, delivery.recipient_tenant, delivery.recipient_alias],
  );
  if (durable.rows.length !== 1) throw new StoreError('conflict', 'human lineage delivery disagrees');
  return loadHumanMessageLineage(client, delivery.message_id);
}

export async function preserveHumanMessageLineage(
  client: DatabaseClient, targetMessageId: string,
  source: HumanMessageInitiator | undefined, existing = false,
): Promise<void> {
  const target = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM messages WHERE id=$1 FOR SHARE', [targetMessageId],
  );
  const tenantId = target.rows[0]?.tenant_id;
  if (tenantId === undefined) throw new StoreError('conflict', 'human lineage target is unavailable');
  const previous = await loadHumanMessageLineage(client, targetMessageId);
  if (previous || existing) {
    if ((previous === undefined) !== (source === undefined)) {
      throw new StoreError('conflict', 'human lineage target cannot be reassigned');
    }
    humanLineageConsensus([previous, source]);
    return;
  }
  if (source) await putHumanMessageInitiator(client, {
    ...source, messageId: targetMessageId, messageTenantId: tenantId,
  });
}

export async function loadFaninHumanLineage(
  client: DatabaseClient, rootMessageId: string,
): Promise<HumanMessageInitiator | undefined> {
  const branches = await client.query<{
    source_delivery_id: string; source_message_id: string; source_tenant: string; source_alias: string;
    produced_delivery_id: string; produced_message_id: string; target_tenant: string; target_alias: string;
  }>(
    `SELECT source_delivery_id,source_message_id,source_tenant,source_alias,
            produced_delivery_id,produced_message_id,target_tenant,target_alias
     FROM agent_output_materializations
     WHERE status='materialized' AND correlation->>'root_message_id'=$1
     ORDER BY source_delivery_id,produced_delivery_id FOR SHARE`, [rootMessageId],
  );
  if (branches.rows.length === 0) return undefined;
  const edges = branches.rows.map((branch) => ({
    source: branch.source_message_id, target: branch.produced_message_id,
  }));
  const rows = [await loadHumanMessageLineage(client, rootMessageId)];
  for (const branch of branches.rows) {
    rows.push(await loadDeliveryHumanLineage(client, {
      id: branch.source_delivery_id, message_id: branch.source_message_id,
      recipient_tenant: branch.source_tenant, recipient_alias: branch.source_alias,
    }), await loadDeliveryHumanLineage(client, {
      id: branch.produced_delivery_id, message_id: branch.produced_message_id,
      recipient_tenant: branch.target_tenant, recipient_alias: branch.target_alias,
    }));
    const responses = await client.query<{ message_id: string }>(
      `SELECT audit.message_id FROM audit_events audit
       JOIN deliveries delivery ON delivery.id=audit.delivery_id
         AND delivery.message_id=audit.message_id
       WHERE audit.action='agent_output.response' AND audit.decision='allow'
         AND audit.metadata->>'child_delivery_id'=$1
         AND audit.metadata->>'source_delivery_id'=$2
         AND delivery.recipient_tenant=$3 AND delivery.recipient_alias=$4
       FOR SHARE OF audit,delivery`,
      [branch.produced_delivery_id, branch.source_delivery_id, branch.source_tenant, branch.source_alias],
    );
    for (const response of responses.rows) {
      rows.push(await loadHumanMessageLineage(client, response.message_id));
      edges.push({ source: branch.produced_message_id, target: response.message_id });
    }
  }
  const connected = new Set([rootMessageId]);
  let added = true;
  while (added) {
    added = false;
    for (const edge of edges) {
      if (connected.has(edge.source) && !connected.has(edge.target)) {
        connected.add(edge.target);
        added = true;
      }
    }
  }
  const consensus = humanLineageConsensus(rows);
  return branches.rows.every((branch) => connected.has(branch.source_message_id))
    ? consensus : undefined;
}
