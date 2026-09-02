import type { PublishMessage, Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import {
  PublishResultSchema,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE,
  buildPublishReceipt,
  consolePublishIntentSemanticHash,
  isSystemGateProbeBody,
  publishRequestHash,
} from '@cauce/protocol';
import { withTransaction } from '../../db.js';
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
import { insertDelivery, insertMessage } from './_insert.js';
import {
  PublishIntentExpiredError,
  type PublishOptions,
  type PublishResult,
} from './contracts.js';
import { reconstructPublishReceipt } from './receipts.js';
import type { MessageDetailRow } from '../visibility-rows.js';

// The BUS writes this, not the agent: first person made it a lie through an 8 h outage.
const telegramRelayAcknowledgement = 'Recibido por el bus; en cola para el agente.';
const ackVentanaSilencioMs = 10 * 60 * 1000;

function conversationKind(chatType: unknown): 'dm' | 'group' | 'unknown' {
  if (chatType === 'private') return 'dm';
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') return 'group';
  return 'unknown';
}

export abstract class MessagePublishingRepository extends ConfigRepository {
  // Verify receipt IDs against locked durable rows, never that receipt's own digest.
  async verifyPublishReceipt(input: PublishMessage, candidate: PublishResult): Promise<boolean> {
    const parsed = PublishResultSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const hash = publishRequestHash(input);
    return withTransaction(this.pool, async (client) => {
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
    });
  }

  async publish(input: PublishMessage, options: PublishOptions = {}): Promise<PublishResult> {
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
    return withTransaction(this.pool, async (client) => {
      await assertPublishRoute(client, input);

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
          throw new StoreError('conflict', 'idempotency key reused with a different request');
        }
        if (!existing.message_id || existing.response === null) {
          throw new StoreError('conflict', 'idempotency request is still in progress');
        }
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

      const authenticated = input.authenticated_context;
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
      const deliveryIds: string[] = [];
      for (const recipient of uniqueRecipients) {
        const delivery = await insertDelivery(client, {
          messageId, recipientTenant: recipient.tenant_id, recipientAlias: recipient.alias,
        });
        const deliveryId = delivery.rows[0]?.id;
        if (!deliveryId) throw new Error('delivery insert returned no id');
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
             authenticated_channel: authenticated?.channel ?? input.channel
           })]
      );
      return response;
    });
  }

  async getMessage(messageId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<MessageDetailRow>(
      `SELECT m.id,m.version,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
              m.body,m.origin,m.lane,m.priority,m.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
         'delivery_id',d.id,'tenant_id',d.recipient_tenant,'alias',d.recipient_alias,
         'status',d.status,'attempt',d.attempt,'terminal_at',d.terminal_at
       ) ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS deliveries
       FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                   AND source_member.alias=$3 AND source_member.enabled)
         OR (d.recipient_tenant=$2 AND d.recipient_alias=$3)
       )
       WHERE m.id=$1 AND EXISTS (
         SELECT 1 FROM memberships own JOIN role_policies role ON role.role=own.role
         WHERE own.tenant_id=$2 AND own.alias=$3 AND own.enabled AND role.allow_read
       ) AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                   AND source_member.alias=$3 AND source_member.enabled AND m.tenant_id=$2)
         OR (EXISTS (SELECT 1 FROM deliveries participant
                     WHERE participant.message_id=m.id AND participant.recipient_tenant=$2
                       AND participant.recipient_alias=$3)
             AND (m.tenant_id=$2 OR EXISTS (SELECT 1 FROM acl_edges edge
                         WHERE edge.from_tenant=$2 AND edge.to_tenant=m.tenant_id
                           AND edge.enabled AND edge.allow_read)))
       ) GROUP BY m.id`, [messageId, actorTenant, actorAlias]
    );
    const row = result.rows[0];
    if (!row) throw new StoreError('not_found', 'message not found or not visible');
    return row;
  }

}
