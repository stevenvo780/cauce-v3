import type { PublishMessage, Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import {
  PublishResultSchema,
  HUMAN_MESSAGE_INITIATOR_CAPABILITY,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE,
  buildPublishReceipt,
  consolePublishIntentSemanticHash,
  isSystemGateProbeBody,
  publishRequestHash,
  isAnyUuid,
  TenantSchema,
} from '@cauce/protocol';
import { withAbortableTransaction, withTransaction, type DatabaseClient } from '../../db.js';
import {
  ConfigRepository,
  assertPublishRoute,
  canonicallyEqual,
  consolePublishConversationHash,
  expireStaleConsolePublishIntent,
  loadConsolePublishHead,
  loadConsolePublishIntentByKey,
  lockConsolePublishIntents,
  reservedInternalMessageTypes,
  sha256,
  validConsoleOperatorScope,
} from '../config.js';
import { StoreError } from '../errors.js';
import { grantCarriedBlobs } from '../blob-carry.js';
import { insertDelivery, insertMessage } from './_insert.js';
import {
  PublishIntentExpiredError,
  type PublishOptions,
  type PublishResult,
  type HumanPublishProvenance,
  type HumanMessageOptions,
} from './contracts.js';
import { putHumanMessageInitiator } from './human-initiators.js';
import { putHumanClientProvenance } from '../../human-client-provenance.js';
import { assertHumanMessageRoot, humanMessageAuthority, lockHumanMessageRead } from './human-authority.js';
import { reconstructPublishReceipt } from './receipts.js';
import { requireConsoleAuthor } from './author.js';
import {
  assertAgentRootSlot, humanSenderView, lockAgentRootActor, senderView, type MessageReader,
} from './agent-roots.js';
import { loadMessageDetail, messageDetailWithReplies } from './message-detail.js';
import { loadHumanInboxPage, type HumanInboxPage, type HumanInboxQuery } from './human-inbox.js';

// The BUS writes this, not the agent: first person made it a lie through an 8 h outage.
const telegramRelayAcknowledgement = 'Recibido por el bus; en cola para el agente.';
const ackVentanaSilencioMs = 10 * 60 * 1000;

function conversationKind(chatType: unknown): 'dm' | 'group' | 'unknown' {
  if (chatType === 'private') return 'dm';
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') return 'group';
  return 'unknown';
}

async function humanPublicationAuthority(
  client: DatabaseClient, input: PublishMessage, options: PublishOptions,
): Promise<HumanPublishProvenance | undefined> {
  if (options.humanAuthority === undefined) {
    if (input.authenticated_context?.channel === 'human-mcp') {
      throw new StoreError('forbidden', 'human MCP publication requires durable authority');
    }
    return undefined;
  }
  if (options.signal === undefined || options.requirePreparedConsoleIntent !== true
      || options.consoleAuthor === undefined) {
    throw new StoreError('forbidden', 'human publication requires a cancellable authenticated intent');
  }
  options.signal.throwIfAborted();
  const authority = await options.humanAuthority(client);
  options.signal.throwIfAborted();
  if (!isAnyUuid(authority.humanId) || authority.tenantId !== input.tenant_id
      || authority.actorAlias !== input.actor_alias
      || options.consoleAuthor.subject_id !== `human:${sha256([
        'cauce-v3:human-author:v1', input.tenant_id, `console:${authority.humanId}`,
      ])}`) {
    throw new StoreError('forbidden', 'human publication identity is inconsistent');
  }
  return Object.freeze({ ...authority });
}


export abstract class MessagePublishingRepository extends ConfigRepository {
  // Verify receipt IDs against locked durable rows, never that receipt's own digest.
  async verifyPublishReceipt(input: PublishMessage, candidate: PublishResult, options: PublishOptions = {}): Promise<boolean> {
    const parsed = PublishResultSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const hash = publishRequestHash(input);
    const work = async (client: DatabaseClient): Promise<boolean> => {
      const human = await humanPublicationAuthority(client, input, options);
      if (human !== undefined) await assertPublishRoute(client, input, true);
      const result = await client.query<{
        request_hash: string;
        response: unknown;
        message_id: string | null;
      }>(
        `SELECT request_hash,response,message_id FROM idempotency_keys
         WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR SHARE`,
        [input.tenant_id, input.actor_alias, input.idempotency_key],
      );
      const durableKey = result.rows[0];
      if (result.rowCount !== 1 || durableKey === undefined) return false;
      if (durableKey.request_hash !== hash || durableKey.message_id === null
          || durableKey.response === null) {
        return false;
      }
      if (human !== undefined) await assertHumanMessageRoot(
        client, durableKey.message_id, human, consolePublishConversationHash(input),
      );
      try {
        const durable = await reconstructPublishReceipt(
          client,
          input,
          durableKey.message_id,
          hash,
          durableKey.response,
        );
        // The stored form is always duplicate:false. A retry may only change that response flag;
        // every identity and causal field still has to be byte-for-byte the durable projection.
        return canonicallyEqual(durable, { ...parsed.data, duplicate: false });
      } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') return false;
        throw error;
      }
    };
    return options.signal === undefined ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, options.signal, work);
  }

  async publish(input: PublishMessage, options: PublishOptions = {}): Promise<PublishResult> {
    const author = requireConsoleAuthor(options.consoleAuthor, options.requirePreparedConsoleIntent === true);
    if (options.requirePreparedConsoleIntent === true) {
      if (options.consoleIntentOperatorScope === undefined
          || !validConsoleOperatorScope(options.consoleIntentOperatorScope)) {
        throw new StoreError('forbidden', 'console publish operator scope is invalid');
      }
      input = {
        ...input,
        recipients: [...input.recipients].sort((left, right) => (
          `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
        )),
      };
    }
    if (input.recipients.length === 0) throw new StoreError('no_route', 'message has zero recipients');
    if (input.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE) {
      const recipient = input.recipients[0];
      const gateAuthorized = isSystemGateProbeBody(input.body)
        && input.tenant_id === 'Steven'
        && input.room_id === 'grp.steven'
        && input.actor_alias === 'kant'
        && input.authenticated_context?.session_id === 'gate-probe'
        && input.authenticated_context.channel === 'gate'
        && input.authenticated_context.origin === undefined
        && input.origin === undefined
        && input.recipients.length === 1
        && input.lane === 'interactive'
        && input.priority === -100
        && input.idempotency_key === `gate:${String(recipient?.tenant_id)}:${String(recipient?.alias)}:${input.body.nonce}`;
      if (!gateAuthorized) {
        throw new StoreError('forbidden', 'system gate probe authority or payload is invalid');
      }
    }
    if (typeof input.body.type === 'string' && reservedInternalMessageTypes.has(input.body.type)) {
      throw new StoreError('forbidden', 'reserved internal message types cannot be published by clients');
    }
    const uniqueRecipients = [...new Map(input.recipients.map((item) => [`${item.tenant_id}:${item.alias}`, item])).values()];
    if (uniqueRecipients.length !== input.recipients.length) {
      throw new StoreError('conflict', 'recipient list contains duplicates');
    }
    const work = async (client: DatabaseClient): Promise<PublishResult> => {
      const human = await humanPublicationAuthority(client, input, options);
      await assertPublishRoute(client, input, human !== undefined);

      if (options.requirePreparedConsoleIntent === true) {
        await lockConsolePublishIntents(client, input.tenant_id, input.actor_alias);
        const semanticHash = consolePublishIntentSemanticHash(input);
        const conversationHash = consolePublishConversationHash(input);
        const state = await expireStaleConsolePublishIntent(
          client,
          input.tenant_id,
          input.actor_alias,
          await loadConsolePublishIntentByKey(
            client, input.tenant_id, input.actor_alias, input.idempotency_key,
          ),
        );
        const prepared = state.prepared;
        if (prepared === undefined
            || prepared.operator_scope_hash !== options.consoleIntentOperatorScope
            || prepared.semantic_hash !== semanticHash
            || prepared.conversation_hash !== conversationHash) {
          throw new StoreError(
            'conflict',
            'console publish key was not prepared for this authenticated request',
          );
        }
        if (state.expired) {
          throw new PublishIntentExpiredError(prepared.idempotency_key);
        }
        if (state.confirmed === undefined) {
          const head = await loadConsolePublishHead(
            client,
            input.tenant_id,
            input.actor_alias,
            prepared.operator_scope_hash,
            prepared.conversation_hash,
          );
          if (!head.intents.some((intent) => (
            intent.idempotency_key === prepared.idempotency_key
              && intent.prepare_audit_id === prepared.prepare_audit_id
          ))) {
            throw new StoreError('conflict', 'console publish key is absent from its durable head');
          }
        }
      }

      const agentRoot = options.agentRoot === true;
      if (agentRoot) await lockAgentRootActor(client, input.tenant_id, input.actor_alias);
      const hash = publishRequestHash(input);
      const insertedKey = await client.query(
        `INSERT INTO idempotency_keys(
           tenant_id,actor_alias,idempotency_key,request_hash,expires_at
         ) VALUES(
           $1,$2,$3,$4,
           CASE WHEN $5::boolean THEN 'infinity'::timestamptz ELSE now()+interval '7 days' END
         ) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [
          input.tenant_id,
          input.actor_alias,
          input.idempotency_key,
          hash,
          options.requirePreparedConsoleIntent === true,
        ]
      );
      if (insertedKey.rowCount === 0) {
        const prior = await client.query<{
          request_hash: string;
          response: unknown;
          message_id: string | null;
        }>(
          `SELECT request_hash,response,message_id FROM idempotency_keys
           WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR UPDATE`,
          [input.tenant_id, input.actor_alias, input.idempotency_key]
        );
        const existing = prior.rows[0];
        if (existing === undefined) {
          throw new StoreError('conflict', 'idempotency key reused with a different request');
        }
        if (existing.request_hash !== hash) {
          throw new StoreError(
            'conflict', 'idempotency key reused with a different request',
            existing.message_id && existing.response !== null ? 'idempotency_durable_conflict' : undefined,
          );
        }
        if (!existing.message_id || existing.response === null) {
          throw new StoreError('conflict', 'idempotency request is still in progress');
        }
        if (human !== undefined) await assertHumanMessageRoot(client, existing.message_id, human, consolePublishConversationHash(input));
        const repaired = await reconstructPublishReceipt(
          client,
          input,
          existing.message_id,
          hash,
          existing.response,
        );
        // Upgrade old JSON in place while the idempotency row is locked. The stored form remains
        // duplicate:false; only this retry response is marked duplicate.
        await client.query(
          `UPDATE idempotency_keys SET response=$4::jsonb
           WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
          [input.tenant_id, input.actor_alias, input.idempotency_key, JSON.stringify(repaired)],
        );
        return { ...repaired, duplicate: true };
      }
      if (agentRoot) await assertAgentRootSlot(client, input.tenant_id, input.actor_alias);

      const authenticated = input.authenticated_context;
      if ((authenticated?.channel ?? input.channel) === 'human-mcp') {
        const recipients = [...uniqueRecipients].sort((left, right) => (
          `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
        ));
        for (const recipient of recipients) {
          await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
            `connection-lease:${recipient.tenant_id}:${recipient.alias}`,
          ]);
          const result = await client.query<{ capabilities: unknown }>(
            `SELECT capabilities FROM connection_leases
             WHERE tenant_id=$1 AND alias=$2 AND lease_until>now() FOR SHARE`,
            [recipient.tenant_id, recipient.alias],
          );
          const lease = result.rows[0];
          if (lease !== undefined && (!Array.isArray(lease.capabilities)
              || !lease.capabilities.includes(HUMAN_MESSAGE_INITIATOR_CAPABILITY))) {
            throw new StoreError('no_route',
              `recipient ${recipient.tenant_id}/${recipient.alias} has an active consumer without ${HUMAN_MESSAGE_INITIATOR_CAPABILITY}; human-mcp delivery cannot be consumed`);
          }
        }
      }
      const persistedOrigin = authenticated?.origin ?? input.origin;
      const message = await insertMessage(client, {
        requestId: input.request_id,
        traceId: input.trace_id,
        tenantId: input.tenant_id,
        roomId: input.room_id,
        actorAlias: input.actor_alias,
        body: input.body,
        origin: persistedOrigin ?? null,
        lane: input.lane,
        priority: input.priority,
        authSessionId: authenticated?.session_id ?? input.session_id ?? null,
        authChannel: authenticated?.channel ?? input.channel ?? null,
      });
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('message insert returned no id');
      if (human !== undefined) {
        await putHumanMessageInitiator(client, {
        messageId, messageTenantId: input.tenant_id, humanId: human.humanId,
        tenantId: human.tenantId, rootMessageId: messageId,
        conversationId: consolePublishConversationHash(input),
        });
        if (authenticated?.channel === 'human-mcp') {
          await putHumanClientProvenance(client, { messageId, humanId: human.humanId,
            tenantId: human.tenantId, conversationId: consolePublishConversationHash(input) }, human.clientProvenance);
        }
      }
      const deliveryIds: string[] = [];
      for (const recipient of uniqueRecipients) {
        const delivery = await insertDelivery(client, {
          messageId, recipientTenant: recipient.tenant_id, recipientAlias: recipient.alias,
        });
        const deliveryId = delivery.rows[0]?.id;
        if (!deliveryId) throw new Error('delivery insert returned no id');
        await grantCarriedBlobs(client, {
          body: input.body,
          sourceTenant: input.tenant_id,
          sourceAlias: input.actor_alias,
          targetTenant: recipient.tenant_id,
          targetAlias: recipient.alias,
          deliveryId,
        });
        deliveryIds.push(deliveryId);
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
           [recipient.tenant_id, `wake:${deliveryId}`, input.request_id, messageId, deliveryId, input.trace_id,
             persistedOrigin ? JSON.stringify(persistedOrigin) : null,
            JSON.stringify({ recipient_alias: recipient.alias, reason: 'delivery_available' })]
        );
        await client.query('SELECT pg_notify($1,$2)', [
          'cauce_delivery_wake',
          JSON.stringify({ tenant_id: recipient.tenant_id, alias: recipient.alias })
        ]);
      }
      // Emit one transactional acceptance ACK; later adapter fan-out is unknowable here.
      const authenticatedOrigin = authenticated?.origin;
      const authenticatedTelegramIngress = authenticated?.channel === 'telegram'
        && authenticatedOrigin?.adapter === 'telegram'
        && authenticatedOrigin.channel === 'telegram';
      if (authenticatedTelegramIngress) {
        const contactoPrevio = await client.query<{ last_inbound_at: Date }>(
          `SELECT last_inbound_at FROM egress_contacts
           WHERE tenant_id=$1 AND alias=$2 AND adapter='telegram' AND conversation_id=$3`,
          [
            input.tenant_id,
            input.actor_alias,
            authenticatedOrigin.conversation_id
          ]
        );
        const ultimoEntrante = contactoPrevio.rows[0]
          ? contactoPrevio.rows[0].last_inbound_at
          : null;
        const acusarAhora = !ultimoEntrante
          || (Date.now() - new Date(ultimoEntrante).getTime()) > ackVentanaSilencioMs;
        // The only authenticated point where the system learns that a human
        // spoke to this alias. It shares the ingress transaction, so "prior
        // contact" is exactly "a durable inbound message exists". The session is
        // stored hashed, never the raw Telegram user id.
        await client.query(
          `INSERT INTO egress_contacts(
             tenant_id,alias,adapter,conversation_id,conversation_kind,last_session_hash
           ) VALUES($1,$2,'telegram',$3,$4,$5)
           ON CONFLICT(tenant_id,alias,adapter,conversation_id) DO UPDATE SET
             last_inbound_at=now(),
             inbound_count=egress_contacts.inbound_count+1,
             conversation_kind=EXCLUDED.conversation_kind,
             last_session_hash=EXCLUDED.last_session_hash`,
          [
            input.tenant_id,
            input.actor_alias,
            authenticatedOrigin.conversation_id,
            conversationKind(authenticatedOrigin.metadata.chat_type),
            authenticated?.session_id === undefined ? null : sha256(authenticated.session_id) // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- A runtime caller can omit the authenticated session.
          ]
        );
        if (acusarAhora) await client.query(
          `INSERT INTO adapter_outbox(
             tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
           ) VALUES($1,'telegram','origin_relay',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
           ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
          [
            input.tenant_id,
            `relay-ack:${messageId}`,
            input.request_id,
            messageId,
            deliveryIds[0],
            input.trace_id,
            JSON.stringify(authenticatedOrigin),
            JSON.stringify({
              relay_kind: 'ack',
              terminal: false,
              outcome: 'ack',
              result: {
                output: {
                  reply: telegramRelayAcknowledgement,
                  messages: [],
                  status: 'done',
                  retryable: false,
                  artifacts: []
                }
              },
              correlation: {
                request_id: input.request_id,
                message_id: messageId,
                trace_id: input.trace_id,
                root_message_id: messageId
              }
            })
          ]
        );
      }
      const response = buildPublishReceipt(input, {
        message_id: messageId,
        delivery_ids: deliveryIds,
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id,
      });
      if (!PublishResultSchema.safeParse(response).success) {
        throw new StoreError('conflict', 'publish durable effect did not produce a canonical receipt');
      }
      await client.query(
        `UPDATE idempotency_keys SET message_id=$4,response=$5::jsonb
         WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
        [input.tenant_id, input.actor_alias, input.idempotency_key, messageId, JSON.stringify(response)]
      );
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata)
         VALUES($1,$2,'message.publish','allow',$3,$4,$5,$6::jsonb)`,
        [input.tenant_id, input.actor_alias, input.request_id, messageId, input.trace_id,
           JSON.stringify({
             recipients: uniqueRecipients,
             authenticated_session_id: authenticated?.session_id ?? input.session_id,
             authenticated_channel: authenticated?.channel ?? input.channel,
             ...(author === undefined ? {} : { console_author: author }),
             ...(agentRoot ? { agent_root: true } : {})
           })]
      );
      return response;
    };
    return options.signal === undefined ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, options.signal, work);
  }

  async getHumanMessage(messageId: string, options: HumanMessageOptions): Promise<Record<string, unknown>> {
    return withAbortableTransaction(this.pool, options.signal, async (client) => {
      const human = await humanMessageAuthority(client, options);
      await assertHumanMessageRoot(client, messageId, human);
      await lockHumanMessageRead(client, messageId, human);
      const row = await loadMessageDetail(client, messageId, human.tenantId, human.actorAlias);
      await assertHumanMessageRoot(client, messageId, human, consolePublishConversationHash({
        tenant_id: human.tenantId, room_id: row.room_id, actor_alias: row.actor_alias,
        recipients: row.deliveries.map((delivery) => ({
          tenant_id: TenantSchema.parse(delivery.tenant_id), alias: delivery.alias,
        })),
      }));
      const view = await humanSenderView(client, messageId, human);
      if (view === undefined) throw new StoreError('not_found', 'message not found or not owned');
      return messageDetailWithReplies(row, view);
    });
  }

  async listHumanInbox(query: HumanInboxQuery, options: HumanMessageOptions): Promise<HumanInboxPage> {
    return withAbortableTransaction(this.pool, options.signal, async (client) => {
      const human = await humanMessageAuthority(client, options);
      return loadHumanInboxPage(client, human, query);
    });
  }

  async getMessage(
    messageId: string, actorTenant: Tenant, actorAlias: string, reader?: MessageReader,
  ): Promise<Record<string, unknown>> {
    const row = await loadMessageDetail(this.pool, messageId, actorTenant, actorAlias);
    const view = reader === undefined || row.tenant_id !== actorTenant || row.actor_alias !== actorAlias
      ? undefined : await senderView(this.pool, messageId, reader);
    return messageDetailWithReplies(row, view);
  }

}
