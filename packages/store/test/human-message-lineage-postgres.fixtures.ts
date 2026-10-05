import { CauceRepository } from '../src/index.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../src/db.js';
import { withTransaction } from '../src/db.js';
import { insertDelivery, insertMessage } from '../src/repository/messages/_insert.js';
import { putHumanMessageInitiator } from '../src/repository/messages/human-initiators.js';
import { seedIdentity } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';
import { putHumanClientProvenance } from '../src/human-client-provenance.js';
import { projectHumanClientProvenance } from '../src/repository/deliveries/client-provenance.js';
import { HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY } from '@cauce/protocol';

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

export async function attachLineageClient(pool: DatabasePool, root: Awaited<ReturnType<typeof lineageRoot>>) {
  const grantId = randomUUID(); const bindingId = randomUUID(); const issuer = 'https://issuer.example.test';
  const clientId = 'https://chatgpt.com/oauth/client.json'; const label = 'Dots';
  await withTransaction(pool, async (client) => {
    await client.query(`INSERT INTO cauce_oauth_grants(id,human_id,issuer,resource,client_id,redirect_uri,
      scopes,binding_id,binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp,expires_at)
      SELECT $1,e.human_id,$2,$2||'/mcp',$3,'https://client.example/callback',ARRAY['cauce.read','cauce.publish'],
        e.id,e.revision,m.revision,m.tenant_id,m.actor_alias,repeat('a',43),clock_timestamp()+interval '1 hour'
      FROM human_external_identities e JOIN human_tenant_memberships m ON m.human_id=e.human_id
      WHERE e.human_id=$4 AND e.provider='oauth' AND e.namespace=$2 AND m.tenant_id='Steven'`,
    [grantId, issuer, clientId, root.humanId]);
    await client.query(`INSERT INTO human_oauth_client_delegations(id,local_oauth_grant_id,human_id,
      tenant_id,declared_by_human_id,label) VALUES($1,$2,$3,'Steven',$3,$4)`, [bindingId, grantId, root.humanId, label]);
    await client.query(`INSERT INTO human_client_delegation_operations(human_id,tenant_id,request_id,
      request_hash,operation,response) VALUES($1,'Steven',$2,repeat('a',64),'create','{}')`, [root.humanId, randomUUID()]);
    await putHumanClientProvenance(client, root, { kind: 'oauth_client', verification: 'local_grant',
      issuer, clientId, grantId, instance: 'unknown', delegationBindingId: bindingId });
  });
  return {
    human_client_provenance: { root_message_id: root.rootMessageId,
      client: { kind: 'oauth_client', verification: 'local_grant', issuer, client_id: clientId, instance: 'unknown' } },
    human_client_delegation: { root_message_id: root.rootMessageId, owner_human_id: root.humanId,
      owner_tenant_id: root.tenantId, label, basis: 'owner_declared_grant', instance: 'unknown' },
  };
}

export async function lineageClientProjection(client: DatabaseClient, messageId: string) {
  const projections = await projectHumanClientProvenance(client, [{ id: messageId, message_id: messageId }],
    [HUMAN_CLIENT_PROVENANCE_CAPABILITY, HUMAN_CLIENT_DELEGATION_CAPABILITY]);
  return projections.get(messageId);
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
