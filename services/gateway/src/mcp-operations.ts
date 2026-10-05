import { createHash } from 'node:crypto';
import { CanonicalUuidV4Schema, PROTOCOL_VERSION, PublishResultSchema, publishReceiptCausalHash } from '@cauce/protocol';
import { PublishIntentExpiredError, PublishIntentRateLimitedError, PublishIntentReconciliationRequired, StoreError } from '@cauce/store';
import {
  McpSubmitCommandSchema, HumanMcpReceiptSchema, InboxInputSchema,
  GatewayOperationError,
  projectGatewayAgents, projectGatewayStatus,
  type GatewayOperationsFactory, type HumanMcpInboxQuery, type HumanMcpReceipt, type McpSubmitCommand, type VerifiedOAuthIdentity,
} from '@cauce/mcp-fleet-monitor/gateway-http';
import type { GatewayRepository } from './app.js';
import { AuthError, AuthorizationError, requirePermission, type Principal } from './auth.js';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import { prepareConsolePublishOperation, confirmConsolePublishOperation } from './console-publish-operation.js';
import { createHumanPublishAuthority, createHumanReadAuthority, resolveHumanMcpAuthority,
  type HumanMcpAuthorityOptions } from './human-mcp-authority.js';
import { humanInboxQuery, projectHumanInbox } from './mcp-inbox-projection.js';
import { publishOperation, type PublishOperationInput } from './publish-operation.js';

export type HumanMcpRepository = Pick<GatewayRepository,
  'publish' | 'verifyPublishReceipt' | 'prepareConsolePublishIntent' | 'confirmConsolePublishIntent'
  | 'listPresence' | 'listAgents' | 'getHumanMessage' | 'listHumanInbox'
>;

export interface HumanMcpOperationsOptions extends HumanMcpAuthorityOptions, Pick<PublishOperationInput, 'priorityLog' | 'logRedaction'> {
  readonly repository: HumanMcpRepository;
  readonly telemetry?: ConsolePublishTelemetry;
}

function intentScope(userId: string, actor: Principal): string {
  return createHash('sha256')
    .update(JSON.stringify(['cauce-v3:human-mcp-intent:v1', userId, actor.tenant_id, actor.alias]))
    .digest('hex');
}

function publicationActor(actor: Principal, operatorScope: string): Principal {
  return Object.freeze({ ...actor, session_id: `human-mcp:${operatorScope}` });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function guardedOperation<T>(operation: () => Promise<T>, mutating = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GatewayOperationError) throw error;
    if (error instanceof AuthError) throw new GatewayOperationError({ status_code: 401, error: 'unauthorized' });
    if (error instanceof AuthorizationError) throw new GatewayOperationError({ status_code: 403, error: 'forbidden' });
    if (error instanceof PublishIntentReconciliationRequired) {
      throw new GatewayOperationError({ ...error.reconciliation, status_code: 409 });
    }
    if (error instanceof PublishIntentExpiredError) {
      throw new GatewayOperationError({ ...error.expiration, status_code: 410 });
    }
    if (error instanceof PublishIntentRateLimitedError) {
      throw new GatewayOperationError({ ...error.rateLimit, status_code: 429 });
    }
    if (error instanceof StoreError) {
      if (error.code === 'not_found') throw new GatewayOperationError({ status_code: 404, error: 'not_found' });
      if (error.code === 'forbidden' || error.code === 'fenced') throw new GatewayOperationError({ status_code: 403, error: 'forbidden' });
      if (['invalid_input', 'invalid_actor', 'no_route'].includes(error.code)) {
        throw new GatewayOperationError({ status_code: 400, error: 'invalid_request' });
      }
      if (error.code === 'conflict') {
        const retrySameKey = mutating && error.recoveryReason !== 'idempotency_durable_conflict'
          && error.message === 'idempotency request is still in progress';
        throw new GatewayOperationError({ status_code: 409, error: 'operation_conflict',
          ...(retrySameKey ? { safe_to_retry_same_request_key: true } : {}) });
      }
    }
    throw new GatewayOperationError({ status_code: 503, error: 'operation_unavailable',
      ...(mutating ? { safe_to_retry_same_request_key: true } : {}) });
  }
}

function projectReceipt(row: Record<string, unknown>, messageId: string): HumanMcpReceipt {
  if (row.id !== messageId) {
    throw new StoreError('not_found', 'message not found or not visible');
  }
  if (!Array.isArray(row.deliveries)) throw new StoreError('conflict', 'message receipt is incomplete');
  const deliveries = row.deliveries.map((value: unknown) => {
    const delivery = record(value);
    if (!delivery) throw new StoreError('conflict', 'message receipt is incomplete');
    return {
      delivery_id: delivery.delivery_id, tenant_id: delivery.tenant_id, alias: delivery.alias,
      status: delivery.status, attempt: delivery.attempt, terminal_at: delivery.terminal_at,
      reply: delivery.reply,
    };
  });
  const result = HumanMcpReceiptSchema.safeParse({ message_id: messageId, deliveries, chain_open: row.chain_open });
  if (!result.success) throw new StoreError('conflict', 'message receipt is incomplete');
  return result.data;
}

export function createHumanMcpOperationsFactory(options: HumanMcpOperationsOptions): GatewayOperationsFactory {
  const telemetry = options.telemetry ?? new ConsolePublishTelemetry();
  return Object.freeze({
    async forRequest(candidate: VerifiedOAuthIdentity, requestSignal: AbortSignal) {
      return guardedOperation(async () => {
      const identity = Object.freeze({ ...candidate, scopes: Object.freeze([...candidate.scopes]) });
      const remaining = Math.floor(identity.expiresAt * 1000 - Date.now());
      if (!Number.isFinite(remaining) || remaining <= 0) throw new AuthError();
      const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(Math.min(10_000, remaining))]);
      function active(): void {
        if (identity.expiresAt * 1_000 <= Date.now()) throw new AuthError();
        signal.throwIfAborted();
      }
      active();
      const initial = await resolveHumanMcpAuthority(options, identity, signal);
      active();
      const pinned = Object.freeze({ humanId: initial.userId, tenantId: initial.principal.tenant_id,
        actorAlias: initial.principal.alias });
      function access(mode: 'read' | 'publish') {
        if (options.identityStore === undefined && options.pool === undefined) {
          throw new AuthError('durable human MCP authority is unavailable');
        }
        return { signal, humanAuthority: mode === 'read'
          ? createHumanReadAuthority(identity, pinned, signal, options.identityStore)
          : createHumanPublishAuthority(identity, pinned, signal, options.identityStore) };
      }

      async function authorize(permission: 'read' | 'route', scope: 'cauce.read' | 'cauce.publish') {
        active();
        const current = await resolveHumanMcpAuthority(options, identity, signal);
        active();
        if (current.userId !== initial.userId || current.principal.tenant_id !== initial.principal.tenant_id
            || current.principal.alias !== initial.principal.alias) throw new AuthError();
        requirePermission(current.principal, permission);
        if (!current.scopes.includes(scope)) throw new AuthorizationError();
        return current;
      }

      const operations = {
        async status() {
          const { principal } = await authorize('read', 'cauce.read');
          const presence = options.identityStore === undefined && options.pool === undefined
            ? await options.repository.listPresence(principal.tenant_id, principal.alias)
            : await options.repository.listPresence(principal.tenant_id, principal.alias, access('read'));
          active();
          return projectGatewayStatus({ version: PROTOCOL_VERSION, presence }, principal.tenant_id);
        },
        async agents() {
          const { principal } = await authorize('read', 'cauce.read');
          const agents = options.identityStore === undefined && options.pool === undefined
            ? await options.repository.listAgents(principal.tenant_id, principal.alias)
            : await options.repository.listAgents(principal.tenant_id, principal.alias, access('read'));
          active();
          return projectGatewayAgents(agents, principal.tenant_id);
        },
        async submit(candidate: McpSubmitCommand) {
          const parsed = McpSubmitCommandSchema.safeParse(candidate);
          if (!parsed.success) throw new StoreError('invalid_input', 'invalid submit command');
          const command = parsed.data;
          const authority = await authorize('route', 'cauce.publish');
          const humanAccess = { ...access('publish'), coalesceConsolePublishIntents: false };
          const consoleIntentOperatorScope = intentScope(authority.userId, authority.principal);
          const prepared = await prepareConsolePublishOperation(options.repository, {
            actor: publicationActor(authority.principal, consoleIntentOperatorScope),
            body: { room_id: command.room_id, recipients: command.recipients, body: command.body,
              intent_nonce: command.request_key, lane: 'interactive', priority: 0 },
            interactiveHumanEntry: true, consoleIntentOperatorScope, humanAccess,
            priorityLog: options.priorityLog, logRedaction: options.logRedaction,
          }, telemetry);
          const beforePublish = await authorize('route', 'cauce.publish');
          let receipt;
          if (prepared.state === 'committed') {
            receipt = PublishResultSchema.parse(prepared.receipt);
            if (receipt.idempotency_key !== prepared.idempotency_key
                || receipt.tenant_id !== beforePublish.principal.tenant_id
                || receipt.actor_alias !== beforePublish.principal.alias
                || receipt.delivery_ids.length !== command.recipients.length
                || new Set(receipt.delivery_ids).size !== receipt.delivery_ids.length
                || receipt.causal_hash !== publishReceiptCausalHash(receipt)) {
              throw new StoreError('conflict', 'committed intent receipt is inconsistent');
            }
          } else {
            try {
              receipt = await publishOperation(options.repository, {
                actor: publicationActor(beforePublish.principal, consoleIntentOperatorScope), entry: 'console', authMechanism: 'oauth',
                body: { room_id: command.room_id, recipients: command.recipients, body: command.body,
                  idempotency_key: prepared.idempotency_key, lane: 'interactive', priority: 0 },
                consoleIntentOperatorScope, humanAccess, priorityLog: options.priorityLog, logRedaction: options.logRedaction,
              });
              telemetry.record({ operation: 'publish', result: 'committed' });
            } catch (error) {
              telemetry.record({ operation: 'publish', result: error instanceof PublishIntentExpiredError ? 'expired' : 'error' });
              throw error;
            }
          }
          const beforeConfirm = await authorize('route', 'cauce.publish');
          await confirmConsolePublishOperation(options.repository, {
            actor: publicationActor(beforeConfirm.principal, consoleIntentOperatorScope), consoleIntentOperatorScope, humanAccess,
            body: { idempotency_key: receipt.idempotency_key, message_id: receipt.message_id,
              causal_hash: receipt.causal_hash },
          }, telemetry);
          active();
          return receipt;
        },
        async receipt(candidate: string) {
          const parsed = CanonicalUuidV4Schema.safeParse(candidate);
          if (!parsed.success) throw new StoreError('invalid_input', 'invalid message id');
          const messageId = parsed.data;
          await authorize('read', 'cauce.read');
          const row = await options.repository.getHumanMessage(messageId, access('read'));
          active();
          return projectReceipt(row, messageId);
        },
        async inbox(candidate: HumanMcpInboxQuery) {
          const parsed = InboxInputSchema.safeParse(candidate);
          if (!parsed.success) throw new StoreError('invalid_input', 'invalid inbox query');
          const { userId } = await authorize('read', 'cauce.read');
          const query = humanInboxQuery(parsed.data, userId);
          const page = await options.repository.listHumanInbox(query, access('read'));
          active();
          return projectHumanInbox(page, query, userId);
        },
      };
      return Object.freeze({
        status: () => guardedOperation(() => operations.status()),
        agents: () => guardedOperation(() => operations.agents()),
        submit: (command: McpSubmitCommand) => guardedOperation(() => operations.submit(command), true),
        receipt: (messageId: string) => guardedOperation(() => operations.receipt(messageId)),
        inbox: (query: HumanMcpInboxQuery) => guardedOperation(() => operations.inbox(query)),
      });
      });
    },
  });
}
