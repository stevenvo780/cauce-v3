import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import {
  AuthenticatedPublishSchema, ClaimedAckSchema, ConfigChangeRequestSchema, ConfigRollbackRequestSchema,
  CreateJobSchema, DeliveryIdSchema, HeartbeatSchema, HelloSchema,
  NotifyRequestSchema, PROTOCOL_VERSION,
  QueryDeliveriesSchema, TenantSchema,
  type ClaimedAck, type ConfigMutation, type DeliveryEnvelope, type Hello, type NotifyRequest, type Tenant
} from '@cauce/protocol';
import {
  CauceRepository, StoreError, subscribeDeliveryWakes,
  type AckResult, type DatabasePool, type LeaseResult, type NotificationVerdict, type OutboxEvent,
  type PublishResult
} from '@cauce/store';
import {
  AuthError, AuthorizationError, MtlsAuthProvider, requireOperatorPermission, requirePermission, validatePrincipal,
  type AuthProvider, type Principal
} from './auth.js';
import { createConsoleSecurityHook } from './console-security.js';
import { DEFAULT_ACK_DEADLINE_MS, validateAckDeadlineMs } from './config.js';
import { registerHealthRoutes } from './health.js';
import { OidcBffAuthProvider, registerOidcBff } from './oidc-bff.js';
import {
  sameTenantRows, visibleMessage, visibleMessageList, visibleOriginRelays, visibleQueue
} from './facades.js';

interface TrustedPublishCommand {
  version: typeof PROTOCOL_VERSION;
  request_id: string;
  trace_id: string;
  tenant_id: Tenant;
  room_id: string;
  actor_alias: string;
  recipients: Array<{ tenant_id: Tenant; alias: string }>;
  body: Record<string, unknown>;
  idempotency_key: string;
  lane: 'interactive' | 'batch';
  priority: number;
  authenticated_context: {
    session_id: string;
    channel: string;
    origin?: Principal['origin'];
  };
}

export type GatewayAck = ClaimedAck;

export type DeliveryClaimRecord = DeliveryEnvelope;

export type OutboxLeaseEvent = OutboxEvent & {
  event_id?: string;
  attempt?: number;
};

export interface OutboxLeaseAck {
  event_id: string;
  attempt: number;
  claim_token: string;
  status: 'sent' | 'retry' | 'dead';
  error?: string;
  retry_after_ms?: number;
}

/** Contract implemented by the hardened store; current method names remain stable. */
export interface GatewayRepository {
  publish(input: TrustedPublishCommand): Promise<PublishResult>;
  assertPrincipal(tenantId: Tenant, alias: string): Promise<void>;
  assertPermission(tenantId: Tenant, alias: string, permission: 'route' | 'read' | 'control' | 'notify'): Promise<void>;
  principalAccess(tenantId: Tenant, alias: string): Promise<{ roles: string[]; permissions: Array<'route' | 'read' | 'control' | 'notify'> }>;
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
  listPresence(actorTenant: Tenant, actorAlias: string): Promise<Array<Record<string, unknown>>>;
  topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listMessages(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  queueSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listJobs(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueJob(tenantId: Tenant, lane: 'interactive' | 'batch', priority: number, kind: string, payload: Record<string, unknown>): Promise<string>;
  listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listOriginRelays(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueNotification(actorTenant: Tenant, actorAlias: string, input: NotifyRequest): Promise<NotificationVerdict>;
  listNotifications(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAudit(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  applyConfigurationChange(actorTenant: Tenant, actorAlias: string, mutation: ConfigMutation, dryRun: boolean, expectedRevision?: number): Promise<unknown>;
  rollbackConfiguration(actorTenant: Tenant, actorAlias: string, revisionId: number, dryRun: boolean, expectedRevision?: number): Promise<unknown>;
  getMessage(messageId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  acquireLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    capabilities: string[],
    ttlMs: number,
    options?: { resume?: boolean; resumeWindowMs?: number },
  ): Promise<LeaseResult>;
  heartbeat(tenantId: Tenant, alias: string, instanceId: string, epoch: number, ttlMs: number): Promise<string>;
  releaseLease(tenantId: Tenant, alias: string, instanceId: string, epoch: number): Promise<void>;
  claimDeliveries(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    limit?: number,
    ackDeadlineMs?: number,
  ): Promise<DeliveryClaimRecord[]>;
  ackDelivery(
    deliveryId: string,
    tenantId: Tenant,
    alias: string,
    ack: GatewayAck,
    ackDeadlineMs?: number,
  ): Promise<AckResult>;
  claimOutbox(kind: 'wake', worker: string, limit?: number, leaseMs?: number): Promise<OutboxLeaseEvent[]>;
  ackOutbox?(ack: OutboxLeaseAck): Promise<unknown>;
  completeOutbox?(id: string, worker: string, claimToken: string): Promise<boolean>;
  retryOutbox?(id: string, worker: string, claimToken: string, delayMs?: number, error?: string): Promise<'retry' | 'dead' | 'fenced'>;
}

export interface GatewayOptions {
  pool: DatabasePool;
  authProvider: AuthProvider;
  repository?: GatewayRepository;
  deliveryWakeSubscriber?: typeof subscribeDeliveryWakes;
  leaseTtlMs?: number;
  ackDeadlineMs?: number;
  outboxPollMs?: number;
  outboxLeaseMs?: number;
  requireAckClaims?: boolean;
  consoleOrigins?: readonly string[];
  allowedJobKinds?: readonly string[];
  terminalCapability?: Readonly<Record<string, unknown>>;
  https?: HttpsServerOptions;
  exposeHealthRoutes?: boolean;
  logger?: boolean;
}

interface Session {
  socket: WebSocket;
  tenantId: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
  draining: boolean;
  renewableDeliveryClaims: boolean;
  claims: Map<string, Pick<GatewayAck, 'attempt' | 'claim_token'>>;
  recentClaims: Map<string, Pick<GatewayAck, 'attempt' | 'claim_token'>>;
}

const MAX_RECENT_SESSION_CLAIMS = 1_024;

function sessionKey(tenantId: Tenant, alias: string): string {
  return `${tenantId}:${alias}`;
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function statusFor(error: StoreError): number {
  if (error.code === 'forbidden' || error.code === 'fenced') return 403;
  if (error.code === 'not_found') return 404;
  if (error.code === 'conflict') return 409;
  if (error.code === 'no_route' || error.code === 'invalid_actor') return 422;
  return 500;
}

function replyError(reply: FastifyReply, error: unknown): void {
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

async function principal(request: FastifyRequest, authProvider: AuthProvider): Promise<Principal> {
  return validatePrincipal(await authProvider.authenticateHttp(request));
}

function publicPublish(value: unknown): ReturnType<typeof AuthenticatedPublishSchema.parse> {
  return AuthenticatedPublishSchema.parse(value);
}

function claimFromDelivery(delivery: DeliveryClaimRecord): Pick<GatewayAck, 'attempt' | 'claim_token'> {
  if (typeof delivery.event_id !== 'string' || delivery.event_id.length === 0 ||
      typeof delivery.claim_token !== 'string' || delivery.claim_token.length === 0 ||
      !Number.isInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new Error('repository returned an incomplete delivery claim');
  }
  return { attempt: delivery.attempt, claim_token: delivery.claim_token };
}

function normalizeDeliveryClaim(delivery: DeliveryClaimRecord): DeliveryClaimRecord {
  claimFromDelivery(delivery);
  return delivery;
}

function parseAck(value: unknown): GatewayAck {
  return ClaimedAckSchema.parse(value);
}

function assertAckClaim(ack: GatewayAck, expected?: ReturnType<typeof claimFromDelivery>): void {
  if (expected && (ack.attempt !== expected.attempt || ack.claim_token !== expected.claim_token)) {
    throw new StoreError('fenced', 'ACK claim does not match the delivered event');
  }
}

export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  if (!options.authProvider) throw new Error('AuthProvider is mandatory');
  if (process.env.NODE_ENV === 'production' && options.authProvider.mode !== 'production') {
    throw new Error('development/test AuthProvider is forbidden in production');
  }
  const ackDeadlineMs = validateAckDeadlineMs(options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS);
  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.https === undefined ? {} : { https: options.https })
  });
  const repository: GatewayRepository = options.repository ?? new CauceRepository(options.pool);
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const outboxPollMs = options.outboxPollMs ?? 100;
  const outboxLeaseMs = options.outboxLeaseMs ?? 30_000;
  // Kept as an explicit startup invariant for migration diagnostics; ACK claims are mandatory below.
  if (options.requireAckClaims === false && process.env.NODE_ENV === 'production') {
    throw new Error('delivery ACK claims cannot be disabled in production');
  }
  const workerId = `gateway:${randomUUID()}`;
  const allowedJobKinds = new Set(options.allowedJobKinds ?? [
    'system.database.probe', ...(process.env.NODE_ENV === 'test' ? ['qa.fairness'] : [])
  ]);
  const sessions = new Map<string, Session>();

  await app.register(websocket);
  app.addHook('onRequest', createConsoleSecurityHook({
    ...(options.consoleOrigins === undefined ? {} : { allowedOrigins: options.consoleOrigins })
  }));
  if (options.authProvider instanceof OidcBffAuthProvider) registerOidcBff(app, options.authProvider);
  const exposeHealthRoutes = options.exposeHealthRoutes ?? !(options.authProvider instanceof MtlsAuthProvider);
  if (exposeHealthRoutes) {
    registerHealthRoutes(app, {
      pool: options.pool,
      requirePostgresTls: process.env.NODE_ENV === 'production'
    });
  }

  app.get('/v3/status', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      await repository.assertPrincipal(actor.tenant_id, actor.alias);
      return {
        version: PROTOCOL_VERSION,
        auth_provider: options.authProvider.name,
        ...(await repository.status(actor.tenant_id, actor.alias)),
        presence: await repository.listPresence(actor.tenant_id, actor.alias)
      };
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.get('/v3/console/access', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      const databaseAccess = await repository.principalAccess(actor.tenant_id, actor.alias);
      const effectiveRoles = actor.roles.filter((role) => databaseAccess.roles.includes(role));
      const effectivePermissions = actor.permissions.filter((permission) => databaseAccess.permissions.includes(permission));
      const permissions = [
        ...(effectivePermissions.includes('route') ? ['message.publish'] : []),
        ...(effectivePermissions.includes('notify') ? ['message.notify'] : []),
        ...(effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['delivery.replay', 'job.create', 'config.write', 'config.rollback'] : []),
        ...(options.terminalCapability?.available === true && effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['ultimate-terminal.connect'] : [])
      ];
      return {
        subject: `${actor.tenant_id}:${actor.alias}`,
        roles: effectiveRoles,
        permissions,
        observed_at: new Date().toISOString()
      };
    } catch (error) { replyError(reply, error); }
  });

  const publishHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const command = publicPublish(request.body);
      const trustedCommand: TrustedPublishCommand = {
        version: PROTOCOL_VERSION,
        request_id: randomUUID(),
        trace_id: `trace-${randomUUID()}`,
        tenant_id: actor.tenant_id,
        actor_alias: actor.alias,
        authenticated_context: {
          session_id: actor.session_id,
          channel: actor.channel,
          ...(actor.origin === undefined ? {} : { origin: actor.origin })
        },
        ...command
      };
      return reply.code(202).send(await repository.publish(trustedCommand));
    } catch (error) {
      replyError(reply, error);
    }
  };
  app.post('/v3/messages', publishHandler);
  app.post('/v3/publish', publishHandler);

  // Proactive egress. POST /v3/messages deliberately cannot express a channel
  // destination and must stay that way; this is the only surface that can, and
  // the only destination it accepts is a handle already on the allowlist.
  app.post('/v3/egress/notifications', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'notify');
      const command = NotifyRequestSchema.parse(request.body);
      const verdict = await repository.enqueueNotification(actor.tenant_id, actor.alias, command);
      if (verdict.decision === 'denied') {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'proactive egress was denied by policy',
          notification_id: verdict.notification_id,
          denial_code: verdict.denial_code,
          dry_run: verdict.dry_run,
          duplicate: verdict.duplicate
        });
      }
      return reply.code(202).send(verdict);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/topology', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.topology(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/messages', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleMessageList(await repository.listMessages(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });
  app.post('/v3/console/messages', publishHandler);

  app.get('/v3/console/queues', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleQueue(await repository.queueSnapshot(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/replay', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      return await repository.replayDelivery(request.params.deliveryId, actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/jobs', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return sameTenantRows(await repository.listJobs(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });
  app.post('/v3/console/jobs', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const job = CreateJobSchema.parse(request.body);
      if (!allowedJobKinds.has(job.kind)) {
        throw new StoreError('no_route', `job kind has no executable handler: ${job.kind}`);
      }
      return reply.code(202).send({
        job_id: await repository.enqueueJob(actor.tenant_id, job.lane, job.priority, job.kind, job.payload)
      });
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/adapters', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.listAdapters(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/origin-relays', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleOriginRelays(await repository.listOriginRelays(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/egress/notifications', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return sameTenantRows(await repository.listNotifications(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/audit', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return sameTenantRows(await repository.listAudit(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/config', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      return await repository.getConfiguration(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.post('/v3/console/config/changes', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const change = ConfigChangeRequestSchema.parse(request.body);
      const result = await repository.applyConfigurationChange(
        actor.tenant_id, actor.alias, change.mutation, change.dry_run, change.expected_revision
      );
      return reply.code(change.dry_run ? 200 : 201).send(result);
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { revisionId: string } }>('/v3/console/config/revisions/:revisionId/rollback', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const revisionId = Number(request.params.revisionId);
      if (!Number.isSafeInteger(revisionId) || revisionId < 1) throw new Error('revision id must be positive');
      const rollback = ConfigRollbackRequestSchema.parse(request.body);
      const result = await repository.rollbackConfiguration(
        actor.tenant_id, actor.alias, revisionId, rollback.dry_run, rollback.expected_revision
      );
      return reply.code(rollback.dry_run ? 200 : 201).send(result);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/observability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      const [status, queues, jobs, relays] = await Promise.all([
        repository.status(actor.tenant_id, actor.alias),
        repository.queueSnapshot(actor.tenant_id, actor.alias),
        repository.listJobs(actor.tenant_id, actor.alias),
        repository.listOriginRelays(actor.tenant_id, actor.alias)
      ]);
      return { observed_at: new Date().toISOString(), status, queues, jobs, origin_relays: relays };
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/terminal/capability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      if (options.terminalCapability?.available === true) return options.terminalCapability;
      return reply.code(501).send({ available: false, reason: 'PTY backend capability is not configured' });
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Params: { messageId: string } }>('/v3/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      if (!row) throw new StoreError('not_found', 'message not found or not visible');
      return row;
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post('/v3/connections/hello', async (request, reply) => {
    try {
      const hello = HelloSchema.parse(request.body);
      const actor = validatePrincipal(await options.authProvider.authenticateHello(request, hello));
      requirePermission(actor, 'route');
      if (actor.tenant_id !== hello.tenant_id || actor.alias !== hello.alias) {
        throw new StoreError('forbidden', 'authenticated identity does not match hello');
      }
      const lease = await repository.acquireLease(
        hello.tenant_id, hello.alias, hello.instance_id, hello.capabilities, leaseTtlMs
      );
      return reply.code(lease.acquired ? 200 : 409).send(lease);
    } catch (error) {
      replyError(reply, error);
    }
  });

  const queryHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const query = QueryDeliveriesSchema.parse(request.body);
      const deliveries = (await repository.claimDeliveries(
        actor.tenant_id, actor.alias, query.instance_id, query.epoch, query.limit, ackDeadlineMs
      )).map(normalizeDeliveryClaim);
      return {
        deliveries
      };
    } catch (error) {
      replyError(reply, error);
    }
  };
  app.post('/v3/deliveries/query', queryHandler);
  app.post('/v3/query', queryHandler);

  app.post('/v3/heartbeat', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const heartbeat = HeartbeatSchema.parse(request.body);
      const leaseExpiresAt = await repository.heartbeat(
        actor.tenant_id, actor.alias, heartbeat.instance_id, heartbeat.epoch, leaseTtlMs
      );
      return { lease_expires_at: leaseExpiresAt };
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post<{ Params: { deliveryId: string } }>('/v3/deliveries/:deliveryId/ack', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const ack = parseAck(request.body);
      const result = await repository.ackDelivery(
        request.params.deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs
      );
      return { ...result, event_id: ack.event_id, attempt: ack.attempt, claim_token: ack.claim_token };
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post('/v3/ack', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
        throw new Error('ACK must be an object');
      }
      const { delivery_id: deliveryValue, ...ackValue } = request.body as Record<string, unknown>;
      const deliveryId = DeliveryIdSchema.parse(deliveryValue);
      const ack = parseAck(ackValue);
      const result = await repository.ackDelivery(
        deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs
      );
      return { ...result, event_id: ack.event_id, attempt: ack.attempt, claim_token: ack.claim_token };
    } catch (error) {
      replyError(reply, error);
    }
  });

  async function drain(session: Session): Promise<void> {
    if (session.draining || session.socket.readyState !== WebSocket.OPEN) return;
    session.draining = true;
    try {
      const deliveries = (await repository.claimDeliveries(
        session.tenantId, session.alias, session.instanceId, session.epoch, undefined, ackDeadlineMs
      )).map(normalizeDeliveryClaim);
      for (const delivery of deliveries) {
        const claim = claimFromDelivery(delivery);
        session.recentClaims.delete(delivery.delivery_id);
        session.claims.set(delivery.delivery_id, claim);
        send(session.socket, delivery);
      }
    } catch (error) {
      if (error instanceof StoreError && error.code === 'fenced') {
        send(session.socket, { type: 'error', code: 'fenced', message: error.message });
        session.socket.close(4401, 'fenced');
      } else {
        app.log.error(error);
      }
    } finally {
      session.draining = false;
    }
  }

  app.get('/v3/ws', { websocket: true }, (socket, request) => {
    let current: Session | undefined;
    let frameQueue = Promise.resolve();
    let closed = false;

    socket.on('message', (data: RawData) => {
      const text = rawDataText(data);
      frameQueue = frameQueue.then(async () => {
        if (closed) return;
        try {
          const decoded: unknown = JSON.parse(text);
          if (!current) {
            const hello: Hello = HelloSchema.parse(decoded);
            const actor = validatePrincipal(await options.authProvider.authenticateHello(request, hello));
            requirePermission(actor, 'route');
            if (actor.tenant_id !== hello.tenant_id || actor.alias !== hello.alias) {
              throw new StoreError('forbidden', 'authenticated identity does not match hello');
            }
            const renewableDeliveryClaims = hello.capabilities.includes('renewable_delivery_claims_v1');
            const lease = await repository.acquireLease(
              hello.tenant_id,
              hello.alias,
              hello.instance_id,
              hello.capabilities,
              leaseTtlMs,
              renewableDeliveryClaims
                ? { resume: true, resumeWindowMs: ackDeadlineMs }
                : {}
            );
            if (!lease.acquired || !lease.epoch) {
              send(socket, {
                type: 'takeover_rejected',
                reason: 'another live instance owns this consumer',
                active_instance_id: lease.active_instance_id ?? 'unknown',
                lease_expires_at: lease.lease_expires_at
              });
              socket.close(4409, 'live consumer exists');
              return;
            }
            const key = sessionKey(hello.tenant_id, hello.alias);
            const previous = sessions.get(key);
            current = {
              socket, tenantId: hello.tenant_id, alias: hello.alias,
              instanceId: hello.instance_id,
              epoch: lease.epoch,
              draining: false,
              renewableDeliveryClaims,
              claims: new Map(),
              recentClaims: new Map()
            };
            sessions.set(key, current);
            if (previous && previous.socket !== socket) previous.socket.close(4401, 'superseded by newer epoch');
            send(socket, {
              type: 'hello_ack', version: '3.0', epoch: lease.epoch,
              lease_expires_at: lease.lease_expires_at
            });
            await drain(current);
            return;
          }

          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new Error('frame must be an object');
          }
          const frame = decoded as Record<string, unknown>;
          if (frame.type === 'hello') throw new Error('hello already completed');
          if (frame.type === 'heartbeat') {
            const heartbeat = HeartbeatSchema.parse(decoded);
            if (heartbeat.instance_id !== current.instanceId || heartbeat.epoch !== current.epoch) {
              throw new StoreError('fenced', 'heartbeat identity does not match socket lease');
            }
            const leaseExpiresAt = await repository.heartbeat(
              current.tenantId, current.alias, current.instanceId, current.epoch, leaseTtlMs
            );
            send(socket, { type: 'heartbeat_ack', lease_expires_at: leaseExpiresAt });
            return;
          }
          if (frame.type !== 'ack') throw new Error('unsupported frame type');
          const deliveryId = DeliveryIdSchema.parse(frame.delivery_id);
          const ackValue = Object.fromEntries(
            Object.entries(frame).filter(([key]) => key !== 'type' && key !== 'delivery_id')
          );
          const incoming = parseAck(ackValue);
          if (incoming.instance_id !== current.instanceId) {
            throw new StoreError('fenced', 'ACK identity does not match socket lease');
          }
          if (incoming.epoch < current.epoch) {
            send(socket, {
              type: 'ack_result',
              event_id: incoming.event_id,
              delivery_id: deliveryId,
              attempt: incoming.attempt,
              claim_token: incoming.claim_token,
              status: incoming.status,
              applied: false
            });
            return;
          }
          if (incoming.epoch > current.epoch) {
            throw new StoreError('fenced', 'ACK identity does not match socket lease');
          }
          const sessionClaim = current.claims.get(deliveryId)
            ?? current.recentClaims.get(deliveryId);
          if (sessionClaim !== undefined) {
            assertAckClaim(incoming, sessionClaim);
          } else if (!current.renewableDeliveryClaims) {
            throw new StoreError('fenced', 'ACK has no claim in the live socket session');
          }
          // A renewable client can resume the same fenced DB lease after a
          // socket or gateway restart. In that case the in-memory claim map is
          // intentionally empty; repository.ackDelivery remains authoritative
          // for delivery id, attempt, token, instance, epoch and deadline.
          const result = await repository.ackDelivery(
            deliveryId, current.tenantId, current.alias, incoming, ackDeadlineMs
          );
          const { receipt, ...legacyResult } = result;
          send(socket, {
            type: 'ack_result',
            ...legacyResult,
            event_id: incoming.event_id,
            attempt: incoming.attempt,
            claim_token: incoming.claim_token,
            ...(current.renewableDeliveryClaims ? { receipt } : {})
          });
          if (['done', 'failed', 'dead'].includes(result.status)) {
            const completedClaim = current.claims.get(deliveryId);
            current.claims.delete(deliveryId);
            if (completedClaim !== undefined) {
              current.recentClaims.delete(deliveryId);
              current.recentClaims.set(deliveryId, completedClaim);
              while (current.recentClaims.size > MAX_RECENT_SESSION_CLAIMS) {
                const oldest = current.recentClaims.keys().next().value;
                if (oldest === undefined) break;
                current.recentClaims.delete(oldest);
              }
            }
          }
          if (result.status === 'retry') await drain(current);
        } catch (error) {
          const code = error instanceof StoreError ? error.code : 'invalid_frame';
          send(socket, { type: 'error', code, message: error instanceof Error ? error.message : 'unknown frame error' });
          if (code === 'fenced') socket.close(4401, 'fenced');
        }
      }).catch((error: unknown) => app.log.error(error));
    });

    socket.on('close', () => {
      closed = true;
      const closing = current;
      if (!closing) return;
      const key = sessionKey(closing.tenantId, closing.alias);
      if (sessions.get(key)?.socket === socket) sessions.delete(key);
      // Keep the DB lease and epoch until heartbeat expiry. The same stable
      // instance can resume it within the delivery claim window, so a transient
      // socket or gateway restart does not abort a multi-hour harness.
      if (!closing.renewableDeliveryClaims) {
        const pendingFrames = frameQueue;
        void pendingFrames.finally(async () => {
          await repository.releaseLease(
            closing.tenantId,
            closing.alias,
            closing.instanceId,
            closing.epoch
          );
        }).catch((error: unknown) => app.log.error(error));
      }
    });
  });

  const wakeSubscriber = options.deliveryWakeSubscriber ?? subscribeDeliveryWakes;
  const stopDeliveryWakes = await wakeSubscriber(options.pool, (notice) => {
    const tenant = TenantSchema.safeParse(notice.tenant_id);
    if (!tenant.success) return;
    const active = sessions.get(sessionKey(tenant.data, notice.alias));
    if (!active || active.socket.readyState !== WebSocket.OPEN) return;
    send(active.socket, { type: 'wake', alias: active.alias, reason: 'delivery_available' });
    void drain(active);
  });

  async function pumpOutbox(): Promise<void> {
    if (sessions.size === 0) return;
    const events = await repository.claimOutbox('wake', workerId, 50, outboxLeaseMs);
    for (const event of events) {
      const alias = typeof event.payload.recipient_alias === 'string' ? event.payload.recipient_alias : undefined;
      const active = alias ? sessions.get(sessionKey(event.tenant_id, alias)) : undefined;
      if (!active || active.socket.readyState !== WebSocket.OPEN) {
        await ackWake(event, 'retry', 'recipient is offline');
        continue;
      }
      send(active.socket, { type: 'wake', alias: active.alias, reason: 'delivery_available' });
      await drain(active);
      await ackWake(event, 'sent');
    }
  }

  async function ackWake(event: OutboxLeaseEvent, status: 'sent' | 'retry', error?: string): Promise<void> {
    const eventId = event.event_id ?? event.id;
    const attempt = event.attempt ?? event.attempts;
    const claimToken = event.claim_token;
    if (typeof claimToken !== 'string' || claimToken.length === 0) throw new Error('wake outbox claim token is missing');
    if (repository.ackOutbox) {
      await repository.ackOutbox({
        event_id: eventId,
        attempt,
        claim_token: claimToken,
        status,
        ...(error === undefined ? {} : { error }),
        ...(status === 'retry' ? { retry_after_ms: 250 } : {})
      });
      return;
    }
    if (status === 'sent' && repository.completeOutbox) {
      const applied = await repository.completeOutbox(event.id, workerId, claimToken);
      if (!applied) throw new StoreError('fenced', 'wake outbox ACK was fenced');
    } else if (status === 'retry' && repository.retryOutbox) {
      const result = await repository.retryOutbox(event.id, workerId, claimToken, 250, error);
      if (result === 'fenced') throw new StoreError('fenced', 'wake outbox retry was fenced');
    } else {
      throw new Error('repository does not implement fenced outbox ACK');
    }
  }

  const timer = setInterval(() => {
    void pumpOutbox().catch((error: unknown) => app.log.error(error));
  }, outboxPollMs);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    await stopDeliveryWakes();
    for (const session of sessions.values()) session.socket.close(1001, 'gateway shutdown');
    sessions.clear();
  });

  return app;
}
