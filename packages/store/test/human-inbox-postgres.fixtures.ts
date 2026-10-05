import { randomUUID } from 'node:crypto';
import type { Tenant } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type HumanInboxPage, type HumanInboxQuery } from '../src/index.js';
import { consolePublishConversationHash } from '../src/repository/config.js';
import { insertDelivery, insertMessage } from '../src/repository/messages/_insert.js';
import { putHumanMessageInitiator } from '../src/repository/messages/human-initiators.js';
import { createHumanReadAuthority } from '../../../services/gateway/src/human-mcp-authority.js';
import {
  databasePool, getRepository, humanOptions, verifiedIdentity, type HumanFixture,
} from './human-owned-receipt-postgres.fixtures.js';

export * from './human-owned-receipt-postgres.fixtures.js';

export interface InboxRoot { readonly messageId: string; readonly deliveryId: string; readonly conversationId: string }
export interface TenantHuman extends HumanFixture { readonly tenant: Tenant; readonly room: string }

const ROOMS: Readonly<Record<string, string>> = { Steven: 'grp.steven', Isa: 'grp.isa' };

export function recent(limit = 20, after?: HumanInboxQuery['after']): HumanInboxQuery {
  return { mode: 'recent', limit, openOnly: false, ...(after === undefined ? {} : { after }) };
}

export async function inbox(
  account: HumanFixture, query: HumanInboxQuery = recent(), signal?: AbortSignal,
): Promise<HumanInboxPage> {
  return getRepository().listHumanInbox(query, humanOptions(account, 'read', signal));
}

export async function inboxAs(account: TenantHuman, query: HumanInboxQuery = recent()): Promise<HumanInboxPage> {
  const signal = new AbortController().signal;
  const authority = createHumanReadAuthority(verifiedIdentity(account, ['cauce.read']),
    { humanId: account.humanId, tenantId: account.tenant, actorAlias: account.alias }, signal);
  return getRepository().listHumanInbox(query, { signal, humanAuthority: authority });
}

export async function seedTenantHuman(tenant: Tenant, alias: string): Promise<TenantHuman> {
  const humanId = randomUUID();
  const key = { provider: 'oauth' as const, namespace: 'https://issuer.example.test', subject: `Subject/${humanId}` };
  await withTransaction(databasePool(), async (client) => {
    await client.query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2) ON CONFLICT DO NOTHING', [tenant, alias]);
    await client.query(`INSERT INTO console_users
      (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
      VALUES($1,$2,$2,$3,'Fixture human','operator',$4,$5,true)`,
    [humanId, `${humanId}@example.invalid`, `$scrypt$${'x'.repeat(40)}`, tenant, alias]);
    await client.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
      VALUES($1,$2,$3,$4)`, [humanId, key.provider, key.namespace, key.subject]);
    await client.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,$3,'operator',ARRAY['read','route'])`, [humanId, tenant, alias]);
  });
  return { humanId, alias, key, tenant, room: ROOMS[tenant] ?? 'grp.steven' };
}

async function rootIn(
  client: DatabaseClient, owner: { humanId: string; alias: string; tenant: Tenant; room: string },
  recipient: string, conversationId?: string,
): Promise<InboxRoot> {
  const message = await insertMessage(client, {
    requestId: randomUUID(), traceId: `inbox-${randomUUID()}`, tenantId: owner.tenant, roomId: owner.room,
    actorAlias: owner.alias, body: { text: `inbox root ${randomUUID()}` }, origin: null, lane: 'interactive', priority: 0,
    authSessionId: `human-mcp-session-${randomUUID()}`, authChannel: 'human-mcp',
  });
  const messageId = message.rows[0]?.id;
  if (!messageId) throw new Error('inbox root insert returned no id');
  const delivery = await insertDelivery(client, { messageId, recipientTenant: owner.tenant, recipientAlias: recipient });
  const deliveryId = delivery.rows[0]?.id;
  if (!deliveryId) throw new Error('inbox root delivery insert returned no id');
  const conversation = conversationId ?? consolePublishConversationHash({ tenant_id: owner.tenant, room_id: owner.room,
    actor_alias: owner.alias, recipients: [{ tenant_id: owner.tenant, alias: recipient }] });
  await putHumanMessageInitiator(client, { messageId, messageTenantId: owner.tenant, humanId: owner.humanId,
    tenantId: owner.tenant, rootMessageId: messageId, conversationId: conversation });
  return { messageId, deliveryId, conversationId: conversation };
}

/** Roots written in ONE transaction share now(): every created_at ties, the worst case for a keyset. */
export async function tiedRoots(
  account: HumanFixture | TenantHuman, count: number, options: { recipient?: string; conversationId?: string } = {},
): Promise<InboxRoot[]> {
  const owner = 'tenant' in account ? account : { ...account, tenant: 'Steven' as const, room: 'grp.steven' };
  return withTransaction(databasePool(), async (client) => {
    const roots: InboxRoot[] = [];
    for (let index = 0; index < count; index += 1) {
      roots.push(await rootIn(client, owner, options.recipient ?? (owner.tenant === 'Steven' ? 'argos' : 'salva'),
        options.conversationId));
    }
    return roots;
  });
}

/** A chain message back to the root's alias, carrying the root's human lineage like persistAgentOutput does. */
export async function chainMessageBack(
  account: HumanFixture, root: InboxRoot, text: string, lineage = true,
): Promise<string> {
  return withTransaction(databasePool(), async (client) => {
    const message = await insertMessage(client, {
      requestId: randomUUID(), traceId: `inbox-chain-${randomUUID()}`, tenantId: 'Steven', roomId: 'grp.steven',
      actorAlias: 'argos', body: { type: 'agent.message', text, from_alias: 'argos',
        correlation: { root_message_id: root.messageId } }, origin: null, lane: 'batch', priority: 3,
      authSessionId: null, authChannel: 'human-mcp',
    });
    const messageId = message.rows[0]?.id;
    if (!messageId) throw new Error('chain message insert returned no id');
    await insertDelivery(client, { messageId, recipientTenant: 'Steven', recipientAlias: account.alias });
    if (lineage) await putHumanMessageInitiator(client, { messageId, messageTenantId: 'Steven', humanId: account.humanId,
      tenantId: 'Steven', rootMessageId: root.messageId, conversationId: root.conversationId });
    return messageId;
  });
}

export async function chainGate(
  root: InboxRoot, question: string, answered?: { answer: string; by: string },
): Promise<string> {
  const result = await databasePool().query<{ id: string }>(
    `INSERT INTO agent_chain_gates(root_message_id,tenant_id,asked_by_alias,source_delivery_id,source_attempt,
       output_index,trace_id,question,correlation,status,answer,answered_at,answered_by)
     VALUES($1,'Steven','argos',$2,1,(SELECT count(*)::integer FROM agent_chain_gates WHERE source_delivery_id=$2),
       $3,$4,$5::jsonb,$6,$7,CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,$8) RETURNING id`,
    [root.messageId, root.deliveryId, `inbox-gate-${randomUUID()}`, question,
      JSON.stringify({ root_message_id: root.messageId }), answered === undefined ? 'open' : 'answered',
      answered?.answer ?? null, answered?.by ?? null],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('chain gate insert returned no id');
  return id;
}

/**
 * Opens a gate asked BY `askedByAlias` — which must be the alias that `root`'s delivery was sent
 * to, exactly as `tiedRoots(account, 1, { recipient: askedByAlias })` produces — and answers it
 * for real through the repository, like an agent processing that delivery would. Unlike
 * `chainGate`, which only ever writes the `agent_chain_gates` row by hand, this also produces the
 * `agent.message` resume that `answerChainGate` delivers back into the human's own lineage.
 */
export async function askAndAnswerChainGate(
  root: InboxRoot, askedByAlias: string, question: string, answer: string, answeredBy = 'argos',
): Promise<{ gateId: string; resumeMessageId: string }> {
  const gate = await databasePool().query<{ id: string }>(
    `INSERT INTO agent_chain_gates(root_message_id,tenant_id,asked_by_alias,source_delivery_id,source_attempt,
       output_index,trace_id,question,correlation,status)
     VALUES($1,'Steven',$2,$3,1,(SELECT count(*)::integer FROM agent_chain_gates WHERE source_delivery_id=$3),
       $4,$5,$6::jsonb,'open') RETURNING id`,
    [root.messageId, askedByAlias, root.deliveryId, `inbox-gate-${randomUUID()}`, question,
      JSON.stringify({ root_message_id: root.messageId })],
  );
  const gateId = gate.rows[0]?.id;
  if (!gateId) throw new Error('chain gate insert returned no id');
  const result = await getRepository().answerChainGate(gateId, answer, 'Steven', answeredBy) as { resume_message_id?: string };
  const resumeMessageId = result.resume_message_id;
  if (!resumeMessageId) throw new Error('answerChainGate returned no resume message id');
  return { gateId, resumeMessageId };
}
