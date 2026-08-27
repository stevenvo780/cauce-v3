import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthenticatedPublishSchema, PROTOCOL_VERSION,
  publishReceiptCausalHash, publishRequestHash, PublishResultSchema,
  type ConsolePublishIntentCommand, type ConsolePublishIntentPrepare,
  type PublishMessage,
} from '@cauce/protocol';
import { StoreError, type PublishResult } from '@cauce/store';
import {
  AuthError, AuthorizationError, validatePrincipal,
  type AuthProvider, type Principal,
} from '../auth.js';
import { publishPriorityDecision } from '../publish-priority-policy.js';

export const CONNECTION_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TrustedPublishCommand = PublishMessage & {
  authenticated_context: NonNullable<PublishMessage['authenticated_context']>;
};

export type TrustedPublishIntentCommand = ConsolePublishIntentCommand & {
  authenticated_context: NonNullable<PublishMessage['authenticated_context']>;
};

function statusFor(error: StoreError): number {
  if (error.code === 'forbidden' || error.code === 'fenced') return 403;
  if (error.code === 'not_found') return 404;
  if (error.code === 'conflict') return 409;
  if (error.code === 'no_route' || error.code === 'invalid_actor' || error.code === 'invalid_input') return 422;
  return 500;
}

export function replyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof StoreError) {
    void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  void reply.code(400).send({ error: 'invalid_request', message });
}

export async function principal(
  request: FastifyRequest,
  authProvider: AuthProvider,
): Promise<Principal> {
  return validatePrincipal(await authProvider.authenticateHttp(request));
}

export function publicPublish(
  value: unknown,
): ReturnType<typeof AuthenticatedPublishSchema.parse> {
  return AuthenticatedPublishSchema.parse(value);
}

/**
 * The ceiling an agent cannot publish over.
 *
 * This is the only surface where an agent chooses its own `priority`, and the only place in the
 * process that can prove whether a browser action is attributed to a person. `operator` by itself
 * is not enough: password/OIDC authentication must also provide a server-verified `operator_id`.
 * Only that principal, entering through the interactive console compose surface, can reach the
 * human band; that surface also floors its historical priority 10 at HUMAN_CHAT_PRIORITY.
 *
 * Everything else is held at AGENT_PRIORITY_CEILING. Clamping rather than rejecting keeps a
 * misconfigured canary or an old adapter publishing instead of 400-ing; the drop is logged so the
 * misconfiguration is still visible.
 */
function routedPriority(
  actor: Principal,
  requested: number,
  lane: PublishMessage['lane'],
  request: FastifyRequest,
): number {
  const decision = publishPriorityDecision(actor, requested, {
    interactiveHumanEntry: (
      request.routeOptions.url === '/v3/console/messages'
        || request.routeOptions.url === '/v3/console/publish-intents'
    )
      && lane === 'interactive',
  });
  if (decision.reason === 'agent_ceiling') {
    request.log?.warn?.({
      event: 'publish_priority_clamped',
      tenant_id: actor.tenant_id,
      alias: actor.alias,
      channel: actor.channel,
      requested,
      applied: decision.applied
    }, 'agent priority clamped to the agent band');
  } else if (decision.reason === 'human_entry_floor') {
    request.log?.info?.({
      event: 'publish_priority_human_floor',
      tenant_id: actor.tenant_id,
      alias: actor.alias,
      channel: actor.channel,
      requested,
      applied: decision.applied,
    }, 'authenticated interactive publish entered the human band');
  }
  return decision.applied;
}

export function trustedPublishSemantics(
  actor: Principal,
  command: Pick<
    ConsolePublishIntentPrepare,
    'room_id' | 'recipients' | 'body' | 'lane' | 'priority'
  >,
  request: FastifyRequest,
  actorAlias = actor.alias,
): Omit<TrustedPublishCommand, 'idempotency_key'> {
  return {
    version: PROTOCOL_VERSION,
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: actor.tenant_id,
    actor_alias: actorAlias,
    authenticated_context: {
      session_id: actor.session_id,
      channel: actor.channel,
      ...(actor.origin === undefined ? {} : { origin: actor.origin }),
    },
    room_id: command.room_id,
    recipients: [...command.recipients].sort((left, right) => (
      `${left.tenant_id}\u0000${left.alias}`.localeCompare(`${right.tenant_id}\u0000${right.alias}`)
    )),
    body: command.body,
    lane: command.lane,
    priority: routedPriority(actor, command.priority, command.lane, request),
  };
}

export function consolePublishOperatorScope(actor: Principal): string {
  const authority = actor.operator_id === undefined
    ? `principal:${actor.tenant_id}:${actor.alias}:${actor.channel}`
    : `operator:${actor.tenant_id}:${actor.alias}:${actor.operator_id}`;
  return createHash('sha256')
    .update(`cauce-v3:console-publish-operator-scope:v1\n${authority}`)
    .digest('hex');
}

export function validatedPublishReceipt(
  value: unknown,
  command: TrustedPublishCommand,
  expectedDeliveries: number,
): PublishResult {
  const parsed = PublishResultSchema.safeParse(value);
  const expectedRequestHash = publishRequestHash(command);
  if (!parsed.success
      || parsed.data.delivery_ids.length !== expectedDeliveries
      || new Set(parsed.data.delivery_ids).size !== parsed.data.delivery_ids.length
      // A real receipt for another tenant/actor/request must never credit this invocation.
      || parsed.data.tenant_id !== command.tenant_id
      || parsed.data.actor_alias !== command.actor_alias
      || parsed.data.idempotency_key !== command.idempotency_key
      || parsed.data.request_hash !== expectedRequestHash
      // Recompute instead of trusting a self-described hash: this rejects a response assembled
      // from the request half of one publish and the IDs of another.
      || parsed.data.causal_hash !== publishReceiptCausalHash(parsed.data)
      // A fresh insert must carry the exact request/trace generated for this invocation. An
      // idempotent duplicate intentionally carries the original pair; request_hash is stable
      // across those generated transport values and remains the causal proof for that branch.
      || (parsed.data.duplicate === false
        && (parsed.data.request_id !== command.request_id || parsed.data.trace_id !== command.trace_id))) {
    // Igual que DLQ/replay/cancel: el commit pudo ocurrir. Un 409 obliga a conciliar por lectura
    // y nunca acredita con un 2xx una respuesta truncada, duplicada o de otra versión del store.
    throw new StoreError('conflict', 'publish did not return an exact durable receipt');
  }
  return parsed.data;
}
