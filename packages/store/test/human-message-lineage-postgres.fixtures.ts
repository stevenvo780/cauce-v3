import { CauceRepository } from '../src/index.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../src/db.js';
import { withTransaction } from '../src/db.js';
import { insertDelivery, insertMessage } from '../src/repository/messages/_insert.js';
import { putHumanMessageInitiator } from '../src/repository/messages/human-initiators.js';
import { seedIdentity } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';

export { seedIdentity };

export async function lineageMessage(client: DatabaseClient, tenant = 'Steven') {
  const message = await insertMessage(client, {
    requestId: randomUUID(), traceId: `lineage-${randomUUID()}`, tenantId: tenant,
    roomId: tenant === 'Steven' ? 'grp.steven' : 'grp.jhon',
    actorAlias: tenant === 'Steven' ? 'argos' : 'hegel', body: { text: 'lineage fixture' },
    origin: null, lane: 'batch', priority: 3, authSessionId: null, authChannel: null,
  });
  const id = message.rows[0]?.id;
  if (!id) throw new Error('missing fixture message');
  return id;
}

export async function lineageRoot(pool: DatabasePool, humanId: string, messageId?: string) {
  return withTransaction(pool, async (client) => {
    const id = messageId ?? await lineageMessage(client);
    const row = { messageId: id, messageTenantId: 'Steven', humanId, tenantId: 'Steven',
      rootMessageId: id, conversationId: `conversation-${randomUUID()}` };
    await putHumanMessageInitiator(client, row);
    return row;
  });
}

export async function lineageBranch(client: DatabaseClient, root: string, child: string) {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM deliveries WHERE message_id=$1 AND recipient_tenant='Steven' AND recipient_alias='argos'",
    [root],
  );
  const source = existing.rows.length > 0 ? existing : await insertDelivery(client, {
    messageId: root, recipientTenant: 'Steven', recipientAlias: 'argos',
  });
  const target = await insertDelivery(client, {
    messageId: child, recipientTenant: 'Steven', recipientAlias: 'kant',
  });
  const sourceId = source.rows[0]?.id;
  const targetId = target.rows[0]?.id;
  if (!sourceId || !targetId) throw new Error('missing fixture delivery');
  await client.query(`INSERT INTO agent_output_materializations(
    source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,source_alias,
    target_tenant,target_alias,target_ref_hash,body_hash,status,produced_message_id,
    produced_delivery_id,request_id,trace_id,hop_count,hop_budget,correlation)
    VALUES($1,1,(SELECT count(*)::integer FROM agent_output_materializations WHERE source_delivery_id=$1),$2,'Steven','argos','Steven','kant',$3,$3,'materialized',$4,$5,$6,$7,1,8,$8::jsonb)`,
  [sourceId, root, 'a'.repeat(64), child, targetId, randomUUID(), `lineage-${randomUUID()}`,
    JSON.stringify({ root_message_id: root })]);
  return { id: targetId, message_id: child, recipient_tenant: 'Steven', recipient_alias: 'kant' };
}

export class HumanLineageRepository extends CauceRepository {
  materializeExistingFanin(client: DatabaseClient, root: string) {
    return this.materializeAgentFanin(client, root);
  }
}
