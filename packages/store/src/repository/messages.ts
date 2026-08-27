import { randomUUID } from 'node:crypto';
import type {
  ConsolePublishIntentCommand, ConsolePublishIntentConfirm, ConsolePublishIntentConfirmResult,
  ConsolePublishIntentExpired, ConsolePublishIntentPrepareResult, ConsolePublishIntentReconciliation,
  PublishMessage, PublishResult as ProtocolPublishResult, Tenant
} from '@cauce/protocol';
import {
  CanonicalUuidV4Schema, ConsolePublishIntentConfirmSchema, SYSTEM_GATE_PROBE_MESSAGE_TYPE,
  buildPublishReceipt,
  consolePublishIntentRequestedHash, consolePublishIntentSemanticHash, isSystemGateProbeBody,
  OriginSchema, PublishMessageSchema, PublishResultSchema, publishReceiptCausalHash,
  publishRequestHash
} from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { withTransaction } from '../db.js';
import {
  CONSOLE_PUBLISH_CONFIRM_ACTION, CONSOLE_PUBLISH_PREPARE_ACTION,
  MAX_OPEN_CONSOLE_PUBLISH_INTENTS, ConfigRepository, appendConsolePublishHead,
  assertConsolePublishIntentWriteRate, assertPublishRoute, canonicallyEqual,
  consolePublishConversationHash, consolePublishIntentNonceHash, expireStaleConsolePublishIntent,
  loadConsolePublishHead, loadConsolePublishIntentByKey, loadConsolePublishIntentByNonce,
  lockConsolePublishIntents, positiveAuditId, reservedInternalMessageTypes, sha256,
  validConsoleOperatorScope, type ConsolePublishConfirmMetadata, type ConsolePublishHeadState,
  type ConsolePublishIntentKeyState, type ConsolePublishPrepareMetadata
} from './config.js';
import { StoreError } from './quotas.js';

export class PublishIntentReconciliationRequired extends StoreError {
  constructor(readonly reconciliation: ConsolePublishIntentReconciliation) {
    super('conflict', 'a committed console publish intent requires explicit reconciliation');
    this.name = 'PublishIntentReconciliationRequired';
  }
}

export class PublishIntentExpiredError extends StoreError {
  readonly expiration: ConsolePublishIntentExpired;

  constructor(idempotencyKey: string) {
    super('conflict', 'console publish intent expired before it produced an effect');
    this.name = 'PublishIntentExpiredError';
    this.expiration = {
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: idempotencyKey,
      safe_to_resubmit: true,
    };
  }
}

/** One protocol-owned publish receipt type; the store re-exports it for existing consumers. */
export type PublishResult = ProtocolPublishResult;

export interface PublishOptions {
  /** Console-only gate. Machine endpoints deliberately leave it disabled. */
  readonly requirePreparedConsoleIntent?: boolean;
  readonly consoleIntentOperatorScope?: string;
}

interface DurablePublishedMessage {
  id: string;
  version: string;
  request_id: string;
  trace_id: string;
  tenant_id: string;
  room_id: string;
  actor_alias: string;
  body: unknown;
  origin: unknown;
  lane: string;
  priority: number;
  auth_session_id: string | null;
  auth_channel: string | null;
}

interface DurablePublishedDelivery {
  id: string;
  recipient_tenant: string;
  recipient_alias: string;
}

const legacyPublishReceiptKeys = new Set([
  'message_id', 'delivery_ids', 'duplicate', 'request_id', 'trace_id',
  'idempotency_key', 'tenant_id', 'actor_alias', 'request_hash', 'causal_hash',
]);

const legacyPublishReceiptRequiredKeys = [
  'message_id', 'delivery_ids', 'duplicate', 'request_id', 'trace_id',
] as const;

/**
 * A stored JSON receipt is only an optimization. The message/delivery rows are the durable
 * effect, so every replay reconstructs their exact identity and treats the historical JSON as a
 * consistency witness. This is what lets an old receipt gain new fields after a process restart
 * without ever inserting a second message.
 */
async function reconstructPublishReceipt(
  client: DatabaseClient,
  input: PublishMessage,
  messageId: string,
  requestHash: string,
  storedResponse: unknown,
): Promise<PublishResult> {
  const messageResult = await client.query<DurablePublishedMessage>(
    `SELECT id,version,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
            auth_session_id,auth_channel
       FROM messages WHERE id=$1 FOR SHARE`,
    [messageId],
  );
  const message = messageResult.rows[0];
  const authenticated = input.authenticated_context;
  const expectedOrigin = authenticated?.origin ?? input.origin ?? null;
  const expectedSession = authenticated?.session_id ?? input.session_id ?? null;
  const expectedChannel = authenticated?.channel ?? input.channel ?? null;
  if (messageResult.rowCount !== 1 || !message
      || message.id !== messageId
      || message.version !== input.version
      || message.tenant_id !== input.tenant_id
      || message.room_id !== input.room_id
      || message.actor_alias !== input.actor_alias
      || message.lane !== input.lane
      || message.priority !== input.priority
      || message.auth_session_id !== expectedSession
      || message.auth_channel !== expectedChannel
      || !canonicallyEqual(message.body, input.body)
      || !canonicallyEqual(message.origin, expectedOrigin)) {
    throw new StoreError('conflict', 'idempotent publish durable message differs from its request');
  }

  const deliveryResult = await client.query<DurablePublishedDelivery>(
    `SELECT id,recipient_tenant,recipient_alias FROM deliveries WHERE message_id=$1 FOR SHARE`,
    [messageId],
  );
  const byRecipient = new Map<string, string>();
  for (const row of deliveryResult.rows) {
    const key = `${row.recipient_tenant}\u0000${row.recipient_alias}`;
    if (byRecipient.has(key)) {
      throw new StoreError('conflict', 'idempotent publish has duplicate durable recipients');
    }
    byRecipient.set(key, row.id);
  }
  const deliveryIds = input.recipients.map((recipient) => (
    byRecipient.get(`${recipient.tenant_id}\u0000${recipient.alias}`)
  ));
  if (deliveryResult.rowCount !== input.recipients.length
      || deliveryIds.some((deliveryId) => deliveryId === undefined)) {
    throw new StoreError('conflict', 'idempotent publish deliveries differ from its request');
  }

  const receipt = buildPublishReceipt(input, {
    message_id: message.id,
    delivery_ids: deliveryIds as string[],
    duplicate: false,
    request_id: message.request_id,
    trace_id: message.trace_id,
  });
  const parsed = PublishResultSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new StoreError('conflict', 'idempotent publish durable effect is not canonical');
  }

  if (storedResponse === null || typeof storedResponse !== 'object' || Array.isArray(storedResponse)) {
    throw new StoreError('conflict', 'idempotent publish has no durable historical receipt');
  }
  const historical = storedResponse as Record<string, unknown>;
  const keys = Object.keys(historical);
  if (keys.some((key) => !legacyPublishReceiptKeys.has(key))
      || legacyPublishReceiptRequiredKeys.some((key) => !Object.hasOwn(historical, key))
      || historical.message_id !== parsed.data.message_id
      || historical.request_id !== parsed.data.request_id
      || historical.trace_id !== parsed.data.trace_id
      || historical.duplicate !== false
      || !Array.isArray(historical.delivery_ids)
      || historical.delivery_ids.length !== parsed.data.delivery_ids.length
      || historical.delivery_ids.some((value, index) => value !== parsed.data.delivery_ids[index])
      || (Object.hasOwn(historical, 'idempotency_key')
        && historical.idempotency_key !== parsed.data.idempotency_key)
      || (Object.hasOwn(historical, 'tenant_id') && historical.tenant_id !== parsed.data.tenant_id)
      || (Object.hasOwn(historical, 'actor_alias') && historical.actor_alias !== parsed.data.actor_alias)
      || (Object.hasOwn(historical, 'request_hash') && historical.request_hash !== requestHash)
      || (Object.hasOwn(historical, 'causal_hash')
        && historical.causal_hash !== parsed.data.causal_hash)) {
    throw new StoreError('conflict', 'historical publish receipt differs from its durable effect');
  }
  return parsed.data;
}

/** Rebuild and authenticate a console receipt exclusively from durable effect rows. */
async function reconstructCommittedConsoleIntentReceipt(
  client: DatabaseClient,
  expected: {
    tenant_id: Tenant;
    actor_alias: string;
    idempotency_key: string;
    semantic_hash: string;
    conversation_hash: string;
  },
  durable: { request_hash: string; response: unknown; message_id: string },
): Promise<PublishResult> {
  const storedReceipt = PublishResultSchema.safeParse(durable.response);
  if (!storedReceipt.success
      || storedReceipt.data.duplicate
      || storedReceipt.data.tenant_id !== expected.tenant_id
      || storedReceipt.data.actor_alias !== expected.actor_alias
      || storedReceipt.data.idempotency_key !== expected.idempotency_key
      || storedReceipt.data.message_id !== durable.message_id
      || storedReceipt.data.request_hash !== durable.request_hash
      || publishReceiptCausalHash(storedReceipt.data) !== storedReceipt.data.causal_hash) {
    throw new StoreError('conflict', 'committed console publish receipt is invalid');
  }
  const messageResult = await client.query<DurablePublishedMessage>(
    `SELECT id,version,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
            auth_session_id,auth_channel
       FROM messages WHERE id=$1 FOR SHARE`,
    [durable.message_id],
  );
  const message = messageResult.rows[0];
  if (messageResult.rowCount !== 1 || message === undefined
      || message.auth_session_id === null || message.auth_channel === null) {
    throw new StoreError('conflict', 'committed console publish auth context is unavailable');
  }
  const origin = message.origin === null ? undefined : OriginSchema.safeParse(message.origin);
  if (origin !== undefined && !origin.success) {
    throw new StoreError('conflict', 'committed console publish origin is invalid');
  }
  const deliveryResult = await client.query<DurablePublishedDelivery>(
    `SELECT id,recipient_tenant,recipient_alias
       FROM deliveries WHERE message_id=$1 FOR SHARE`,
    [durable.message_id],
  );
  const deliveriesById = new Map(deliveryResult.rows.map((delivery) => [delivery.id, delivery]));
  if (deliveryResult.rowCount !== storedReceipt.data.delivery_ids.length
      || deliveriesById.size !== deliveryResult.rowCount) {
    throw new StoreError('conflict', 'committed console publish deliveries are inconsistent');
  }
  const recipients = storedReceipt.data.delivery_ids.map((deliveryId) => {
    const delivery = deliveriesById.get(deliveryId);
    if (delivery === undefined) {
      throw new StoreError('conflict', 'committed console publish receipt names an alien delivery');
    }
    return { tenant_id: delivery.recipient_tenant, alias: delivery.recipient_alias };
  });
  const originalCommand = PublishMessageSchema.safeParse({
    version: message.version,
    request_id: message.request_id,
    trace_id: message.trace_id,
    tenant_id: message.tenant_id,
    room_id: message.room_id,
    actor_alias: message.actor_alias,
    recipients,
    body: message.body,
    idempotency_key: expected.idempotency_key,
    lane: message.lane,
    priority: message.priority,
    authenticated_context: {
      session_id: message.auth_session_id,
      channel: message.auth_channel,
      ...(origin === undefined ? {} : { origin: origin.data }),
    },
  });
  if (!originalCommand.success
      || consolePublishIntentSemanticHash(originalCommand.data) !== expected.semantic_hash
      || consolePublishConversationHash(originalCommand.data) !== expected.conversation_hash) {
    throw new StoreError('conflict', 'committed console publish semantic effect is inconsistent');
  }
  const requestHash = publishRequestHash(originalCommand.data);
  if (durable.request_hash !== requestHash) {
    throw new StoreError('conflict', 'committed console publish request hash is inconsistent');
  }
  const reconstructed = await reconstructPublishReceipt(
    client,
    originalCommand.data,
    durable.message_id,
    requestHash,
    durable.response,
  );
  if (!canonicallyEqual(reconstructed, storedReceipt.data)) {
    throw new StoreError('conflict', 'committed console publish receipt differs from durable rows');
  }
  return reconstructed;
}

export function terminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'dead';
}

const telegramRelayAcknowledgement = 'Recibido; estoy trabajando en ello.';
const ackVentanaSilencioMs = 10 * 60 * 1000;

function conversationKind(chatType: unknown): 'dm' | 'group' | 'unknown' {
  if (chatType === 'private') return 'dm';
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') return 'group';
  return 'unknown';
}

export abstract class MessagesRepository extends ConfigRepository {
/**
   * Durably reserve the server-generated key for one authenticated console publish meaning.
   * The append-only audit rows are state: neither prepare nor confirm belongs to the disposable
   * observability allowlist.
   */
  async prepareConsolePublishIntent(
    input: ConsolePublishIntentCommand,
    operatorScopeHash: string,
  ): Promise<ConsolePublishIntentPrepareResult> {
    if (!validConsoleOperatorScope(operatorScopeHash)) {
      throw new StoreError('forbidden', 'console publish operator scope is invalid');
    }
    const intentNonce = CanonicalUuidV4Schema.parse(input.intent_nonce);
    if (input.recipients.length === 0) {
      throw new StoreError('no_route', 'message has zero recipients');
    }
    if (!Number.isInteger(input.requested_priority)
        || input.requested_priority < -100 || input.requested_priority > 100) {
      throw new StoreError('invalid_input', 'console publish requested priority is invalid');
    }
    if (input.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE
        || (typeof input.body.type === 'string' && reservedInternalMessageTypes.has(input.body.type))) {
      throw new StoreError('forbidden', 'reserved internal message types cannot be published by clients');
    }
    const uniqueRecipients = new Map(
      input.recipients.map((item) => [`${item.tenant_id}:${item.alias}`, item]),
    );
    if (uniqueRecipients.size !== input.recipients.length) {
      throw new StoreError('conflict', 'recipient list contains duplicates');
    }
    const normalizedInput: ConsolePublishIntentCommand = {
      ...input,
      intent_nonce: intentNonce,
      recipients: [...uniqueRecipients.values()].sort((left, right) => (
        `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
      )),
    };
    const semanticHash = consolePublishIntentSemanticHash(normalizedInput);
    const requestedHash = consolePublishIntentRequestedHash(normalizedInput);
    const conversationHash = consolePublishConversationHash(normalizedInput);
    const intentNonceHash = consolePublishIntentNonceHash(intentNonce);
    return withTransaction(this.pool, async (client) => {
      await assertPublishRoute(client, normalizedInput);
      await lockConsolePublishIntents(
        client, normalizedInput.tenant_id, normalizedInput.actor_alias,
      );
      const nonceState = await loadConsolePublishIntentByNonce(
        client,
        normalizedInput.tenant_id,
        normalizedInput.actor_alias,
        operatorScopeHash,
        intentNonceHash,
      );
      if (nonceState !== undefined) {
        const state = await expireStaleConsolePublishIntent(
          client,
          normalizedInput.tenant_id,
          normalizedInput.actor_alias,
          nonceState,
        );
        const prepared = state.prepared;
        if (prepared === undefined || state.expired
            || prepared.requested_hash !== requestedHash
            || prepared.conversation_hash !== conversationHash
            || prepared.intent_nonce_hash !== intentNonceHash
            || prepared.operator_scope_hash !== operatorScopeHash) {
          throw new StoreError('conflict', 'console publish intent nonce was reused inconsistently');
        }
        if (state.confirmed === undefined) {
          const head = await loadConsolePublishHead(
            client,
            normalizedInput.tenant_id,
            normalizedInput.actor_alias,
            operatorScopeHash,
            conversationHash,
          );
          if (!head.intents.some((intent) => (
            intent.idempotency_key === prepared.idempotency_key
              && intent.prepare_audit_id === prepared.prepare_audit_id
          ))) {
            throw new StoreError('conflict', 'console publish intent is absent from its durable head');
          }
        }
        const durableResult = await client.query<{
          request_hash: string;
          response: unknown;
          message_id: string | null;
        }>(
          `SELECT request_hash,response,message_id FROM idempotency_keys
            WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR SHARE`,
          [normalizedInput.tenant_id, normalizedInput.actor_alias, prepared.idempotency_key],
        );
        const durable = durableResult.rows[0];
        if (durable !== undefined) {
          if (durable.message_id === null || durable.response === null) {
            throw new StoreError('conflict', 'prepared console publish durable effect is inconsistent');
          }
          const receipt = await reconstructCommittedConsoleIntentReceipt(
            client,
            {
              tenant_id: normalizedInput.tenant_id,
              actor_alias: normalizedInput.actor_alias,
              idempotency_key: prepared.idempotency_key,
              semantic_hash: prepared.semantic_hash,
              conversation_hash: prepared.conversation_hash,
            },
            { ...durable, message_id: durable.message_id },
          );
          return {
            version: 1,
            state: 'committed',
            idempotency_key: prepared.idempotency_key,
            receipt,
          };
        }
        if (state.confirmed !== undefined) {
          throw new StoreError('conflict', 'confirmed console publish intent lost its durable effect');
        }
        if (prepared.semantic_hash !== semanticHash) {
          throw new StoreError(
            'conflict',
            'console publish intent effective policy changed before producing an effect',
          );
        }
        return {
          version: 1,
          state: 'prepared',
          idempotency_key: prepared.idempotency_key,
          receipt: null,
        };
      }

      let head = await loadConsolePublishHead(
        client,
        normalizedInput.tenant_id,
        normalizedInput.actor_alias,
        operatorScopeHash,
        conversationHash,
      );
      for (const candidate of head.states) {
        await expireStaleConsolePublishIntent(
          client,
          normalizedInput.tenant_id,
          normalizedInput.actor_alias,
          candidate,
        );
      }
      head = await loadConsolePublishHead(
        client,
        normalizedInput.tenant_id,
        normalizedInput.actor_alias,
        operatorScopeHash,
        conversationHash,
      );
      let activeStates = [...head.states];
      if (activeStates.length > MAX_OPEN_CONSOLE_PUBLISH_INTENTS) {
        throw new StoreError('conflict', 'console publish intent capacity state exceeds its bound');
      }
      const committedMatches: Array<{
        readonly idempotency_key: string;
        readonly receipt: ProtocolPublishResult;
      }> = [];
      const uneffectedMatches: ConsolePublishIntentKeyState[] = [];
      for (const state of activeStates) {
        const prepared = state.prepared;
        if (prepared === undefined || prepared.requested_hash !== requestedHash) continue;
        const durableResult = await client.query<{
          request_hash: string;
          response: unknown;
          message_id: string | null;
        }>(
          `SELECT request_hash,response,message_id FROM idempotency_keys
            WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR SHARE`,
          [normalizedInput.tenant_id, normalizedInput.actor_alias, prepared.idempotency_key],
        );
        const durable = durableResult.rows[0];
        if (durable === undefined) {
          uneffectedMatches.push(state);
          continue;
        }
        if (durable.message_id === null || durable.response === null) {
          throw new StoreError('conflict', 'prepared console publish durable effect is inconsistent');
        }
        const receipt = await reconstructCommittedConsoleIntentReceipt(
          client,
          {
            tenant_id: normalizedInput.tenant_id,
            actor_alias: normalizedInput.actor_alias,
            idempotency_key: prepared.idempotency_key,
            semantic_hash: prepared.semantic_hash,
            conversation_hash: prepared.conversation_hash,
          },
          { ...durable, message_id: durable.message_id },
        );
        committedMatches.push({ idempotency_key: prepared.idempotency_key, receipt });
      }
      // `activeStates` follows the head's strictly increasing prepare_audit_id order. Reconcile
      // one durable effect at a time in that authenticated order: confirming it removes exactly
      // that binding from the head, making the next lost effect recoverable on the next prepare.
      // All matching effects were reconstructed above before selecting one, so corruption in a
      // later binding still fails closed instead of being hidden by the first valid receipt.
      const committedMatch = committedMatches[0];
      if (committedMatch !== undefined) {
        throw new PublishIntentReconciliationRequired({
          version: 1,
          error: 'publish_intent_reconciliation_required',
          state: 'committed',
          idempotency_key: committedMatch.idempotency_key,
          receipt: committedMatch.receipt,
        });
      }

      const reusableMatches = uneffectedMatches.filter(
        (state) => state.prepared?.semantic_hash === semanticHash,
      );
      const reusable = reusableMatches[0]?.prepared;
      if (reusable !== undefined) {
        // A new browser nonce can be a reload after the prepare response was lost. Reusing the
        // oldest exact reservation closes prepare-B -> late-publish-A -> publish-B duplication.
        // Any additional legacy reservations for that same requested meaning are closed before
        // returning so a late owner gets the explicit 410 instead of producing another effect.
        for (const state of uneffectedMatches) {
          if (state.prepared?.idempotency_key === reusable.idempotency_key) continue;
          await expireStaleConsolePublishIntent(
            client,
            normalizedInput.tenant_id,
            normalizedInput.actor_alias,
            state,
            true,
          );
        }
        return {
          version: 1,
          state: 'prepared',
          idempotency_key: reusable.idempotency_key,
          receipt: null,
        };
      }

      if (uneffectedMatches.length > 0) {
        // The public meaning is stable but the effective policy changed before any effect. Close
        // the obsolete reservation under the actor lock; an already-waiting old publish then
        // receives the typed 410 and only the newly prepared policy can commit.
        for (const state of uneffectedMatches) {
          await expireStaleConsolePublishIntent(
            client,
            normalizedInput.tenant_id,
            normalizedInput.actor_alias,
            state,
            true,
          );
        }
        head = await loadConsolePublishHead(
          client,
          normalizedInput.tenant_id,
          normalizedInput.actor_alias,
          operatorScopeHash,
          conversationHash,
        );
        activeStates = [...head.states];
      }
      await assertConsolePublishIntentWriteRate(
        client,
        normalizedInput.tenant_id,
        normalizedInput.actor_alias,
        operatorScopeHash,
      );
      if (activeStates.length >= MAX_OPEN_CONSOLE_PUBLISH_INTENTS) {
        // A reservation with no idempotency row is not an effect. Lost prepare responses must
        // not deny the conversation for the whole expiry window, so bounded-capacity pressure
        // closes the oldest such reservation append-only. A committed/unconfirmed effect is
        // never evicted: `expireStaleConsolePublishIntent` rechecks idempotency under this lock.
        for (const candidate of activeStates) {
          const expired = await expireStaleConsolePublishIntent(
            client,
            normalizedInput.tenant_id,
            normalizedInput.actor_alias,
            candidate,
            true,
          );
          if (expired.expired) {
            head = await loadConsolePublishHead(
              client,
              normalizedInput.tenant_id,
              normalizedInput.actor_alias,
              operatorScopeHash,
              conversationHash,
            );
            activeStates = [...head.states];
            break;
          }
        }
        if (activeStates.length >= MAX_OPEN_CONSOLE_PUBLISH_INTENTS) {
          throw new StoreError('conflict', 'console publish intent capacity reached');
        }
      }

      const idempotencyKey = `console:${randomUUID()}`;
      const collision = await client.query(
        `SELECT 1
           FROM audit_events
          WHERE tenant_id=$1 AND actor_alias=$2
            AND metadata->>'idempotency_key'=$3
            AND action IN (
              'console.publish.prepare','console.publish.confirm','console.publish.expire'
            )
         UNION ALL
         SELECT 1
           FROM idempotency_keys
          WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3
          LIMIT 1`,
        [normalizedInput.tenant_id, normalizedInput.actor_alias, idempotencyKey],
      );
      if (collision.rowCount !== 0) {
        throw new StoreError('conflict', 'opaque console publish intent key collision');
      }
      const metadata: ConsolePublishPrepareMetadata = {
        version: 1,
        idempotency_key: idempotencyKey,
        semantic_hash: semanticHash,
        requested_hash: requestedHash,
        conversation_hash: conversationHash,
        intent_nonce_hash: intentNonceHash,
        operator_scope_hash: operatorScopeHash,
      };
      const insertedPrepare = await client.query<{ audit_id: string }>(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
         VALUES($1,$2,$3,'allow',$4::jsonb)
         RETURNING id::text AS audit_id`,
        [
          normalizedInput.tenant_id,
          normalizedInput.actor_alias,
          CONSOLE_PUBLISH_PREPARE_ACTION,
          JSON.stringify(metadata),
        ],
      );
      const prepareAuditId = insertedPrepare.rows[0]?.audit_id;
      if (!positiveAuditId(prepareAuditId)) {
        throw new StoreError('conflict', 'durable console publish prepare id is invalid');
      }
      await appendConsolePublishHead(
        client,
        normalizedInput.tenant_id,
        normalizedInput.actor_alias,
        head,
        [...head.intents, {
          idempotency_key: idempotencyKey,
          semantic_hash: semanticHash,
          requested_hash: requestedHash,
          intent_nonce_hash: intentNonceHash,
          prepare_audit_id: prepareAuditId,
        }],
      );
      return {
        version: 1,
        state: 'prepared',
        idempotency_key: idempotencyKey,
        receipt: null,
      };
    });
  }

/** Confirm a committed intent exactly once; an identical retry returns the same receipt. */
  async confirmConsolePublishIntent(
    tenantId: Tenant,
    actorAlias: string,
    operatorScopeHash: string,
    candidate: ConsolePublishIntentConfirm,
  ): Promise<ConsolePublishIntentConfirmResult> {
    if (!validConsoleOperatorScope(operatorScopeHash)) {
      throw new StoreError('forbidden', 'console publish operator scope is invalid');
    }
    const input = ConsolePublishIntentConfirmSchema.parse(candidate);
    return withTransaction(this.pool, async (client) => {
      await lockConsolePublishIntents(client, tenantId, actorAlias);
      const state = await expireStaleConsolePublishIntent(
        client,
        tenantId,
        actorAlias,
        await loadConsolePublishIntentByKey(
          client, tenantId, actorAlias, input.idempotency_key,
        ),
      );
      const prepared = state.prepared;
      if (prepared === undefined || state.expired
          || prepared.operator_scope_hash !== operatorScopeHash) {
        throw new StoreError('conflict', 'console publish intent was not prepared by this actor');
      }

      const confirmed = state.confirmed;
      let head: ConsolePublishHeadState | undefined;
      let headIndex = -1;
      if (confirmed !== undefined) {
        if (confirmed.message_id !== input.message_id
            || confirmed.causal_hash !== input.causal_hash
            || confirmed.semantic_hash !== prepared.semantic_hash
            || confirmed.conversation_hash !== prepared.conversation_hash) {
          throw new StoreError('conflict', 'console publish intent was confirmed with another effect');
        }
      } else {
        head = await loadConsolePublishHead(
          client,
          tenantId,
          actorAlias,
          prepared.operator_scope_hash,
          prepared.conversation_hash,
        );
        headIndex = head.intents.findIndex((intent) => (
          intent.idempotency_key === prepared.idempotency_key
            && intent.prepare_audit_id === prepared.prepare_audit_id
        ));
        if (headIndex < 0) {
          throw new StoreError('conflict', 'console publish confirmation is absent from its durable head');
        }
      }

      const durableResult = await client.query<{
        request_hash: string;
        response: unknown;
        message_id: string | null;
      }>(
        `SELECT request_hash,response,message_id FROM idempotency_keys
          WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR UPDATE`,
        [tenantId, actorAlias, input.idempotency_key],
      );
      const durable = durableResult.rows[0];
      if (durableResult.rowCount !== 1 || durable === undefined
          || durable.message_id !== input.message_id
          || durable.message_id === null || durable.response === null) {
        throw new StoreError('conflict', 'console publish confirmation does not match its durable effect');
      }
      const receipt = await reconstructCommittedConsoleIntentReceipt(
        client,
        {
          tenant_id: tenantId,
          actor_alias: actorAlias,
          idempotency_key: input.idempotency_key,
          semantic_hash: prepared.semantic_hash,
          conversation_hash: prepared.conversation_hash,
        },
        { ...durable, message_id: durable.message_id },
      );
      if (receipt.message_id !== input.message_id || receipt.causal_hash !== input.causal_hash) {
        throw new StoreError('conflict', 'console publish confirmation does not match its durable effect');
      }

      if (confirmed === undefined) {
        const metadata: ConsolePublishConfirmMetadata = {
          version: 1,
          idempotency_key: prepared.idempotency_key,
          semantic_hash: prepared.semantic_hash,
          requested_hash: prepared.requested_hash,
          conversation_hash: prepared.conversation_hash,
          intent_nonce_hash: prepared.intent_nonce_hash,
          operator_scope_hash: prepared.operator_scope_hash,
          causal_hash: input.causal_hash,
        };
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,message_id,metadata
           ) VALUES($1,$2,$3,'allow',$4,$5::jsonb)`,
          [
            tenantId,
            actorAlias,
            CONSOLE_PUBLISH_CONFIRM_ACTION,
            input.message_id,
            JSON.stringify(metadata),
          ],
        );
        if (head === undefined || headIndex < 0) {
          throw new StoreError('conflict', 'console publish confirmation head transition is missing');
        }
        await appendConsolePublishHead(
          client,
          tenantId,
          actorAlias,
          head,
          head.intents.filter((_, index) => index !== headIndex),
        );
      }
      return {
        version: 1,
        confirmed: true,
        idempotency_key: input.idempotency_key,
        message_id: input.message_id,
        causal_hash: input.causal_hash,
      };
    });
  }

/**
   * Independently proves that a publish receipt names the effect committed for this exact
   * idempotency tuple.  The gateway calls this after `publish`: a digest carried by the receipt
   * cannot authenticate IDs that came from that same receipt, while the locked idempotency,
   * message and delivery rows can.
   */
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
      if (result.rowCount !== 1 || !durableKey || durableKey.request_hash !== hash
          || durableKey.message_id === null || durableKey.response === null) {
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
        && input.idempotency_key === `gate:${recipient?.tenant_id}:${recipient?.alias}:${input.body.nonce}`;
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
        if (!existing || existing.request_hash !== hash) {
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
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                              auth_session_id,auth_channel)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11) RETURNING id`,
        [input.request_id, input.trace_id, input.tenant_id, input.room_id, input.actor_alias,
          JSON.stringify(input.body), persistedOrigin ? JSON.stringify(persistedOrigin) : null, input.lane, input.priority,
          authenticated?.session_id ?? input.session_id ?? null,
          authenticated?.channel ?? input.channel ?? null]
      );
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('message insert returned no id');
      const deliveryIds: string[] = [];
      for (const recipient of uniqueRecipients) {
        const delivery = await client.query<{ id: string }>(
          `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
           VALUES($1,$2,$3) RETURNING id`, [messageId, recipient.tenant_id, recipient.alias]
        );
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
      // Whether the adapter will fan out is unknowable until a later ACK. Emit one
      // acceptance ACK for every authenticated Telegram ingress, in this transaction.
      const authenticatedOrigin = authenticated?.origin;
      const authenticatedTelegramIngress = authenticated?.channel === 'telegram'
        && authenticatedOrigin?.adapter === 'telegram'
        && authenticatedOrigin.channel === 'telegram';
      if (authenticatedTelegramIngress && authenticatedOrigin) {
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
            authenticated?.session_id === undefined ? null : sha256(authenticated.session_id)
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
    const result = await this.pool.query<Record<string, unknown>>(
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

async listMessages(actorTenant: Tenant, actorAlias: string, limit = 100): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT m.id AS message_id,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
              left(COALESCE(m.body->>'text',m.body->>'prompt',m.body::text),240) AS body_preview,
              m.lane,m.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'delivery_id',d.id,'recipient_tenant',d.recipient_tenant,'recipient_alias',d.recipient_alias,
                'status',d.status,'attempt',d.attempt,
                'timeline',(SELECT COALESCE(jsonb_agg(event ORDER BY at),'[]'::jsonb) FROM (
                  SELECT jsonb_build_object('status','published','at',m.created_at,'attempt',0) AS event,m.created_at AS at
                  UNION ALL
                  SELECT jsonb_build_object('status',a.status,'at',a.created_at,'attempt',d.attempt,
                    'detail',CASE WHEN a.applied THEN NULL ELSE 'duplicate_or_out_of_order' END),a.created_at
                  FROM delivery_acks a WHERE a.delivery_id=d.id
                ) timeline_events)
              ) ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL),'[]'::jsonb) AS deliveries
       FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                   AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
         OR (d.recipient_tenant=$1 AND d.recipient_alias=$2)
       )
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (EXISTS (SELECT 1 FROM deliveries participant
                      WHERE participant.message_id=m.id AND participant.recipient_tenant=$1
                        AND participant.recipient_alias=$2)
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))
       GROUP BY m.id ORDER BY m.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows, next_cursor: null };
  }
}
