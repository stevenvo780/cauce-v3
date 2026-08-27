import { randomUUID } from 'node:crypto';
import type {
  ConsolePublishIntentCommand,
  ConsolePublishIntentConfirm,
  ConsolePublishIntentConfirmResult,
  ConsolePublishIntentPrepareResult,
  PublishResult as ProtocolPublishResult,
  Tenant,
} from '@cauce/protocol';
import {
  CanonicalUuidV4Schema,
  ConsolePublishIntentConfirmSchema,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE,
  consolePublishIntentRequestedHash,
  consolePublishIntentSemanticHash,
} from '@cauce/protocol';
import { withTransaction } from '../db.js';
import {
  CONSOLE_PUBLISH_CONFIRM_ACTION,
  CONSOLE_PUBLISH_PREPARE_ACTION,
  MAX_OPEN_CONSOLE_PUBLISH_INTENTS,
  appendConsolePublishHead,
  assertConsolePublishIntentWriteRate,
  assertPublishRoute,
  consolePublishConversationHash,
  consolePublishIntentNonceHash,
  expireStaleConsolePublishIntent,
  loadConsolePublishHead,
  loadConsolePublishIntentByKey,
  loadConsolePublishIntentByNonce,
  lockConsolePublishIntents,
  positiveAuditId,
  reservedInternalMessageTypes,
  validConsoleOperatorScope,
  type ConsolePublishConfirmMetadata,
  type ConsolePublishHeadState,
  type ConsolePublishIntentKeyState,
  type ConsolePublishPrepareMetadata,
} from './config.js';
import { StoreError } from './errors.js';
import { PublishIntentReconciliationRequired } from './messages/contracts.js';
import { MessagePublishingRepository } from './messages/publishing.js';
import { reconstructCommittedConsoleIntentReceipt } from './messages/receipts.js';

export {
  PublishIntentExpiredError,
  PublishIntentReconciliationRequired,
  terminal,
} from './messages/contracts.js';
export type { PublishOptions, PublishResult } from './messages/contracts.js';

export abstract class MessagesRepository extends MessagePublishingRepository {
  // Reserve one server-generated key for an authenticated console publish meaning.
  // Prepare and confirm audit rows are durable state, never disposable observability.
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
