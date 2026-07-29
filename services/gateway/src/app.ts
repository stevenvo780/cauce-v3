import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import {
  AliasSchema, AuthenticatedPublishSchema, ClaimedAckSchema, ConfigChangeRequestSchema, ConfigRollbackRequestSchema,
  CreateJobSchema, DeliveryIdSchema, HeartbeatSchema, HelloSchema, isAgentToAgentBody,
  NotifyRequestSchema, PROTOCOL_VERSION,
  QueryDeliveriesSchema, QuotaSampleRequestSchema, TenantSchema,
  type ClaimedAck, type ConfigMutation, type DeliveryEnvelope, type Hello, type NotifyRequest,
  type QuotaSampleRequest, type Tenant
} from '@cauce/protocol';
import {
  CauceRepository, StoreError, subscribeDeliveryWakes,
  type AccountSelection, type AckResult, type DatabasePool, type DeliveryLeaseCap,
  type LeaseResult, type NotificationVerdict, type OutboxEvent, type PublishResult,
  type QuotaSampleIngestResult
} from '@cauce/store';
import {
  AuthError, AuthorizationError, MtlsAuthProvider, requireOperatorPermission, requirePermission, validatePrincipal,
  type AuthProvider, type Principal
} from './auth.js';
import { createConsoleSecurityHook } from './console-security.js';
import {
  DEFAULT_ACK_DEADLINE_MS, DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES,
  validateAckDeadlineMs, validateDeliveryAdmission, type DeliveryAdmissionConfig
} from './config.js';
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
  listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getAgent(alias: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown> | undefined>;
  listOriginRelays(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueNotification(actorTenant: Tenant, actorAlias: string, input: NotifyRequest): Promise<NotificationVerdict>;
  listNotifications(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAudit(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  agentChain(traceId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  recordQuotaSample(actorTenant: Tenant, actorAlias: string, sample: QuotaSampleRequest): Promise<QuotaSampleIngestResult>;
  selectAccount(actorTenant: Tenant, actorAlias: string, provider: string): Promise<AccountSelection>;
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
    interactiveBurst?: number,
    admission?: { humanReservedLimit?: number; humanBurst?: number },
  ): Promise<DeliveryClaimRecord[]>;
  /**
   * Opcional a propósito: los dobles de test que sólo ejercitan el camino de ACK no la
   * implementan, y sin ella el gateway simplemente arranca la sesión con el cupo vacío, que es
   * el comportamiento anterior. Ver `rehydrateClaims`.
   */
  liveDeliveryClaims?(tenantId: Tenant, alias: string, limit?: number): Promise<readonly {
    delivery_id: string;
    attempt: number;
    claim_token: string;
    ack_deadline_at: string;
    agent_to_agent: boolean;
  }[]>;
  ackDelivery(
    deliveryId: string,
    tenantId: Tenant,
    alias: string,
    ack: GatewayAck,
    ackDeadlineMs?: number,
    leaseCap?: DeliveryLeaseCap,
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
  /**
   * Techo de vida total de un intento. El gateway lo necesita porque es quien ESCRIBE el plazo
   * en cada renovacion: sin el, `ackDelivery` seguiria empujando `ack_deadline_at` 30 min hacia
   * adelante indefinidamente y el techo solo existiria en el reaper, o sea un tick tarde y con
   * dos filas de observabilidad escritas por cada latido de un harness ya colgado.
   */
  deliveryLeaseCap?: DeliveryLeaseCap;
  /** Control de admisión por sesión. Ver `DeliveryAdmissionConfig` y `drain()`. */
  admission?: DeliveryAdmissionConfig;
  outboxPollMs?: number;
  outboxLeaseMs?: number;
  deliveryClaimLimit?: number;
  requireAckClaims?: boolean;
  consoleOrigins?: readonly string[];
  allowedJobKinds?: readonly string[];
  terminalCapability?: Readonly<Record<string, unknown>>;
  https?: HttpsServerOptions;
  exposeHealthRoutes?: boolean;
  logger?: boolean;
}

/**
 * Una garra viva de la sesión. Además del par (attempt, claim_token) que ya fenceaba los ACKs,
 * lleva las dos cosas que necesita el control de admisión: de qué clase es la entrega (para
 * saber qué cupo ocupa) y hasta cuándo cuenta como en vuelo.
 */
interface SessionClaim {
  readonly attempt: GatewayAck['attempt'];
  readonly claim_token: GatewayAck['claim_token'];
  /** False para agente-a-agente. Determina si ocupa el cupo reservado o el general. */
  readonly humanOriginated: boolean;
  /**
   * Instante en que la garra deja de ocupar cupo. Arranca en el `ack_deadline_at` que puso la
   * base y se corre con cada ACK 'started' aplicado, que es exactamente lo que hace el store.
   */
  admissionExpiresAtMs: number;
  /**
   * La garra se reconstruyó desde la base al conectar, no la entregó esta sesión.
   *
   * Cambia UNA cosa y es importante: no se usa para fencear ACKs. Una garra rehidratada puede
   * ser de otra época o de otro intento —justamente lo que hace falta contar para el cupo— y si
   * se la tratara como expectativa de ACK, un ACK viejo del adaptador dejaría de correlacionar
   * y se llevaría un 'fenced' con cierre de socket, donde hoy recibe `ownership_lost` y sigue
   * vivo. Para eso la base ya es la autoridad.
   */
  readonly rehydrated?: true;
}

interface Session {
  socket: WebSocket;
  tenantId: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
  draining: boolean;
  /** Un wake que llegó mientras drenábamos. Se atiende al terminar, nunca se pierde. */
  drainAgain: boolean;
  renewableDeliveryClaims: boolean;
  claims: Map<string, SessionClaim>;
  recentClaims: Map<string, SessionClaim>;
  /** Re-drenaje programado al primer vencimiento de garra. Ver `scheduleExpiryDrain`. */
  expiryTimer: NodeJS.Timeout | undefined;
}

const MAX_RECENT_SESSION_CLAIMS = 1_024;
/**
 * Techo de garras que se rehidratan al conectar. Muy por encima de cualquier cupo razonable:
 * sólo está para que una cola patológica no se traiga miles de filas al socket. Si el alias
 * tuviera más garras vivas que esto, el presupuesto ya da cero de todas formas.
 */
const MAX_REHYDRATED_CLAIMS = 256;
/** Vueltas máximas de un mismo `drain()`. Ver el comentario del bucle. */
const MAX_DRAIN_ROUNDS = 16;

// Lote máximo por drain. Deliberadamente igual al default histórico de QueryDeliveriesSchema para
// que este cambio no altere por sí solo cuánto se reclama: lo que cambia es que ahora el número
// está escrito donde se usa en vez de heredarse en silencio del esquema de un endpoint HTTP.
const DEFAULT_DELIVERY_CLAIM_LIMIT = 20;

// Estados de ACK que devuelven la entrega al mundo terminal o reintentable y por lo tanto la sacan
// de agents.max_concurrent_deliveries. Es el conjunto complementario de ('leased','accepted',
// 'started'), que es exactamente lo que cuenta claimDeliveries.
const RELEASES_CAPACITY: ReadonlySet<string> = new Set(['done', 'failed', 'dead', 'retry']);

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
  if (error.code === 'no_route' || error.code === 'invalid_actor' || error.code === 'invalid_input') return 422;
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

function claimFromDelivery(delivery: DeliveryClaimRecord, fallbackDeadlineMs: number): SessionClaim {
  if (typeof delivery.event_id !== 'string' || delivery.event_id.length === 0 ||
      typeof delivery.claim_token !== 'string' || delivery.claim_token.length === 0 ||
      !Number.isInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new Error('repository returned an incomplete delivery claim');
  }
  // `ack_deadline_at` lo generó PostgreSQL; es la única fuente de verdad sobre cuándo el reaper
  // puede llevarse la garra. Si viniera ilegible se usa el plazo configurado, que es lo mismo
  // que acaba de aplicar el store.
  const deadlineMs = Date.parse(delivery.ack_deadline_at);
  return {
    attempt: delivery.attempt,
    claim_token: delivery.claim_token,
    humanOriginated: !isAgentToAgentBody(delivery.body),
    admissionExpiresAtMs: Number.isFinite(deadlineMs) ? deadlineMs : Date.now() + fallbackDeadlineMs
  };
}

function normalizeDeliveryClaim(delivery: DeliveryClaimRecord, fallbackDeadlineMs: number): DeliveryClaimRecord {
  claimFromDelivery(delivery, fallbackDeadlineMs);
  return delivery;
}

function parseAck(value: unknown): GatewayAck {
  return ClaimedAckSchema.parse(value);
}

function assertAckClaim(ack: GatewayAck, expected?: Pick<SessionClaim, 'attempt' | 'claim_token'>): void {
  if (expected && (ack.attempt !== expected.attempt || ack.claim_token !== expected.claim_token)) {
    throw new StoreError('fenced', 'ACK claim does not match the delivered event');
  }
}

function rememberRecentClaim(session: Session, deliveryId: string, claim: SessionClaim): void {
  session.recentClaims.delete(deliveryId);
  session.recentClaims.set(deliveryId, claim);
  while (session.recentClaims.size > MAX_RECENT_SESSION_CLAIMS) {
    const oldest = session.recentClaims.keys().next().value;
    if (oldest === undefined) break;
    session.recentClaims.delete(oldest);
  }
}

/**
 * Cuánto cupo hay libre AHORA, por clase.
 *
 * De paso saca de `claims` las garras cuyo plazo ya venció. No es una optimización: una garra
 * vencida no se puede renovar nunca más (`ackDelivery` exige `ack_deadline_at > now()`, misma
 * condición), así que si se quedara en el mapa ocuparía un cupo para siempre y el agente se
 * quedaría sin trabajo hasta reconectar. Se mueve a `recentClaims` en vez de borrarse, porque
 * borrarla haría que un ACK tardío no correlacione y un cliente legacy se comiera un 'fenced'
 * con cierre de socket, cuando hoy recibe un `ownership_lost` y sigue vivo.
 *
 * El error de reloj entre gateway y PostgreSQL sólo puede sobre-admitir de a una garra, y el
 * store igual la va a reclamar en el mismo instante: es el lado seguro del error.
 */
function admissionBudget(
  session: Session,
  admission: DeliveryAdmissionConfig,
  nowMs: number
): { limit: number; humanReservedLimit: number } {
  let human = 0;
  let agent = 0;
  for (const [deliveryId, claim] of [...session.claims]) {
    if (claim.admissionExpiresAtMs <= nowMs) {
      session.claims.delete(deliveryId);
      rememberRecentClaim(session, deliveryId, claim);
      continue;
    }
    if (claim.humanOriginated) human += 1;
    else agent += 1;
  }
  // El tráfico humano gasta primero su cupo reservado; sólo cuando lo agota empieza a comerse
  // el general. Por eso el general se descuenta con el excedente humano, no con todo el humano.
  const humanOverflow = Math.max(0, human - admission.humanReservedDeliveries);
  return {
    limit: Math.max(0, admission.maxInflightDeliveries - agent - humanOverflow),
    humanReservedLimit: Math.max(0, admission.humanReservedDeliveries - human)
  };
}

export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  if (!options.authProvider) throw new Error('AuthProvider is mandatory');
  if (process.env.NODE_ENV === 'production' && options.authProvider.mode !== 'production') {
    throw new Error('development/test AuthProvider is forbidden in production');
  }
  const ackDeadlineMs = validateAckDeadlineMs(options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS);
  const deliveryLeaseCap = options.deliveryLeaseCap ?? {};
  const admission = validateDeliveryAdmission(options.admission ?? {
    maxInflightDeliveries: DEFAULT_MAX_INFLIGHT_DELIVERIES,
    humanReservedDeliveries: DEFAULT_HUMAN_RESERVED_DELIVERIES
  });
  const maxQueryLimit = admission.maxInflightDeliveries + admission.humanReservedDeliveries;
  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.https === undefined ? {} : { https: options.https })
  });
  const repository: GatewayRepository = options.repository ?? new CauceRepository(options.pool);
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const outboxPollMs = options.outboxPollMs ?? 100;
  const outboxLeaseMs = options.outboxLeaseMs ?? 30_000;
  // Cota superior de un drain. Antes iba `undefined` y caía en el default 20 de
  // QueryDeliveriesSchema — un 20 que nadie eligió para este camino y que nadie podía ver leyendo
  // el gateway. El techo real por agente vive en agents.max_concurrent_deliveries y lo aplica
  // claimDeliveries; esto es sólo el tamaño máximo de lote para un agente sin techo declarado.
  const deliveryClaimLimit = options.deliveryClaimLimit ?? DEFAULT_DELIVERY_CLAIM_LIMIT;
  if (!Number.isInteger(deliveryClaimLimit) || deliveryClaimLimit < 1 || deliveryClaimLimit > 100) {
    throw new Error('deliveryClaimLimit must be an integer between 1 and 100');
  }
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

  // Ingesta de muestras de cuota del recolector fuera de banda (get_ai_quotas, corre en kratos y
  // en los contenedores de agente). Va A PROPÓSITO fuera de /v3/console/: createConsoleSecurityHook
  // devuelve 403 a todo método inseguro bajo ese prefijo que no traiga un Origin same-origin, y un
  // demonio con certificado de cliente jamás manda Origin. Por eso vive acá, junto a /v3/messages
  // y /v3/egress/notifications, que son la misma clase de superficie máquina-a-máquina.
  //
  // Permiso: mismo par que POST /v3/console/jobs -- requireOperatorPermission sobre el Principal
  // (rol derivado del certificado) MÁS assertPermission contra role_policies (la fuente de verdad
  // en la base). recordQuotaSample() en sí no se autochequea, así que sin este segundo chequeo acá
  // un agente con permiso 'control' mal otorgado podría pausar suscripciones de toda la flota.
  app.post('/v3/quotas/samples', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const sample = QuotaSampleRequestSchema.parse(request.body);
      const result = await repository.recordQuotaSample(actor.tenant_id, actor.alias, sample);
      return reply.code(202).send(result);
    } catch (error) { replyError(reply, error); }
  });

  // Selección de cuenta del PROPIO alias (el sistema rotativo de cuentas). Vive fuera de
  // /v3/console/ por la misma razón que /v3/quotas/samples: la llama un adaptador con certificado
  // de cliente, y createConsoleSecurityHook rechaza todo lo que no traiga un Origin same-origin,
  // que un demonio jamás manda.
  //
  // El sujeto NO es un parámetro: sale del certificado. Un alias resuelve su propia cuenta y
  // ninguna otra, así que el permiso que hace falta es 'route' (el que ya tiene todo adaptador
  // que despacha) y no 'control'. Pedir 'control' acá habría obligado a darle a cada agente el
  // mismo permiso que pausa suscripciones de toda la flota, que es justo lo contrario de lo que
  // esta ruta necesita.
  app.get('/v3/accounts/selection', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'route');
      const provider = (request.query as { provider?: unknown } | undefined)?.provider;
      if (typeof provider !== 'string') {
        return reply.code(400).send({ error: 'invalid_input', message: 'provider query parameter is required' });
      }
      return await repository.selectAccount(actor.tenant_id, actor.alias, provider);
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

  // "Qué está trabajando cada agente ahora mismo", agregado por alias. Igual que topology()/
  // listAgents(), el alcance cross-tenant sale de acl_edges allow_read dentro del propio store
  // (fleetActivity() se autochequea el permiso, no hace falta un facade acá) -- este endpoint no
  // tiene un "modo flota" especial, es la misma regla default-deny de siempre. No lleva
  // sameTenantRows: aplastarlo por tenant sería esconder exactamente el caso que este panel
  // existe para mostrar (un alias sin registrar con entregas en vuelo en otro tenant visible).
  app.get('/v3/console/activity', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return await repository.fleetActivity(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // Consumo de cuotas de las suscripciones de IA, con su propio observed_at: es una muestra
  // fuera de banda de hace minutos, no de hace milisegundos como fleetActivity(), así que
  // fusionar los dos payloads mentiría sobre una de las dos frescuras.
  app.get('/v3/console/quotas', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return await repository.quotaSnapshot(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // The registry is intrinsically cross-tenant (an agent may borrow a pooled account paid by
  // another tenant), so no sameTenantRows facade runs here: the store already applied the
  // visibility rule and redacted the payer's account identity.
  app.get('/v3/console/agents', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return await repository.listAgents(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Params: { alias: string } }>('/v3/console/agents/:alias', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      const alias = AliasSchema.parse(request.params.alias);
      const agent = await repository.getAgent(alias, actor.tenant_id, actor.alias);
      if (!agent) throw new StoreError('not_found', 'agent not found or not visible');
      return agent;
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

  // Follow one delegation chain live, by trace id. The response is a graph, not a row list:
  // the store already applied per-node default-deny visibility, so no facade runs here.
  // sameTenantRows would both empty this payload (it has no `items`) and erase the
  // cross-tenant edges the endpoint exists to show.
  app.get<{ Params: { traceId: string } }>('/v3/console/chains/:traceId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'read');
      return await repository.agentChain(request.params.traceId, actor.tenant_id, actor.alias);
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

  /**
   * Reclamo por HTTP. Es el otro punto por donde se puede vaciar la cola de un agente, y hasta
   * ahora el `limit` lo elegía el cliente sin techo.
   *
   * Decisión: se topea al mismo presupuesto total configurado, y además —si hay una sesión
   * WebSocket viva del mismo (tenant, alias)— se le descuentan las garras que esa sesión ya
   * tiene en vuelo, para que las dos superficies compartan un solo presupuesto en vez de
   * duplicarlo. No se puede hacer un control de admisión completo acá porque el POST es sin
   * estado: no hay nada que sobreviva entre dos polls de un cliente que no tenga socket, así
   * que cualquier acumulado sería una invención. Topear el lote sí acota el daño de UN poll a
   * exactamente lo que puede tomar un drain, que es lo que rompía hoy: el SDK cayendo al
   * camino HTTP heredaba el default 20 del store.
   */
  const queryHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const query = QueryDeliveriesSchema.parse(request.body);
      const live = sessions.get(sessionKey(actor.tenant_id, actor.alias));
      const budget = live !== undefined && live.instanceId === query.instance_id
        && live.epoch === query.epoch
        ? admissionBudget(live, admission, Date.now())
        : { limit: admission.maxInflightDeliveries, humanReservedLimit: admission.humanReservedDeliveries };
      // `query.limit` es un techo total pedido por el cliente (el schema le pone default 20).
      // Se reparte primero contra el cupo general y el resto contra el reservado, para que un
      // cliente que pide 1 no se lleve 1 general + 1 reservado.
      const requested = Math.min(query.limit, maxQueryLimit);
      const generalLimit = Math.min(requested, budget.limit);
      const humanReservedLimit = Math.min(requested - generalLimit, budget.humanReservedLimit);
      if (generalLimit + humanReservedLimit < 1) return { deliveries: [] };
      const deliveries = (await repository.claimDeliveries(
        actor.tenant_id, actor.alias, query.instance_id, query.epoch,
        generalLimit, ackDeadlineMs, undefined, { humanReservedLimit }
      )).map((delivery) => normalizeDeliveryClaim(delivery, ackDeadlineMs));
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
        request.params.deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs,
        deliveryLeaseCap
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
        deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs, deliveryLeaseCap
      );
      // Un ACK por HTTP libera capacidad igual que uno por WebSocket. Si el mismo alias tiene un
      // socket vivo, hay que despertarlo: si no, la capacidad que este ACK liberó queda sin usar
      // hasta el próximo mensaje publicado. No se espera el drenaje para no atar la respuesta HTTP
      // a una ronda de reclamo.
      if (RELEASES_CAPACITY.has(result.status)) {
        const active = sessions.get(sessionKey(actor.tenant_id, actor.alias));
        if (active) void drain(active).catch((error: unknown) => app.log.error(error));
      }
      return { ...result, event_id: ack.event_id, attempt: ack.attempt, claim_token: ack.claim_token };
    } catch (error) {
      replyError(reply, error);
    }
  });

  /**
   * Reconstruye el cupo ocupado de un alias desde la base, al conectar.
   *
   * Sin esto el control de admisión vivía sólo en la RAM del socket y una reconexión lo
   * multiplicaba: `hello` creaba `claims: new Map()` y el adaptador volvía a tener el
   * presupuesto entero. Con `renewable_delivery_claims_v1` es peor todavía, porque esa
   * capacidad existe justamente para CONSERVAR el lease y la época entre reconexiones: las
   * garras viejas siguen vivas en la base y el gateway las olvidaba.
   *
   * Falla abierta a propósito. Si la consulta revienta, se arranca con el cupo vacío —el
   * comportamiento anterior— en vez de dejar al adaptador sin poder reclamar nada: un agente
   * que no recibe trabajo es peor que el bug que estamos arreglando. El techo de la base
   * (`ack_deadline_at`) sigue acotando el daño en el peor caso.
   */
  async function rehydrateClaims(tenantId: Tenant, alias: string): Promise<Map<string, SessionClaim>> {
    const claims = new Map<string, SessionClaim>();
    if (repository.liveDeliveryClaims === undefined) return claims;
    try {
      const live = await repository.liveDeliveryClaims(tenantId, alias, MAX_REHYDRATED_CLAIMS);
      for (const claim of live) {
        const deadlineMs = Date.parse(claim.ack_deadline_at);
        if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) continue;
        claims.set(claim.delivery_id, {
          attempt: claim.attempt,
          claim_token: claim.claim_token,
          humanOriginated: claim.agent_to_agent !== true,
          admissionExpiresAtMs: deadlineMs,
          rehydrated: true
        });
      }
    } catch (error) {
      app.log.error(error);
    }
    return claims;
  }

  /**
   * Entrega a un adaptador SÓLO lo que le entra.
   *
   * Antes esto llamaba a claimDeliveries con `undefined` en la posición de `limit`, o sea que
   * se comía el default 20 del store: veinte entregas reclamadas en el mismo instante,
   * arrancando el mismo plazo de ACK de 30 minutos a la vez. La cola del lote se moría sin
   * haber empezado, se reintentaba, y el reintento volvía a ejecutar trabajo ya hecho.
   *
   * Dos cuidados que son la parte peligrosa del cambio:
   *
   *  1. Si el cupo se libera y nadie vuelve a drenar, el agente se queda sin trabajo PARA
   *     SIEMPRE, con la cola llena. Antes daba lo mismo (se pedían 20 y no había límite que
   *     liberar); ahora no. Por eso todo ACK que saca una garra de `session.claims` vuelve a
   *     llamar a drain, no sólo el 'retry' como antes.
   *  2. Un wake que llega mientras estamos drenando se descartaba silenciosamente por el
   *     `if (session.draining) return`. Con cupo eso puede significar perder el único aviso de
   *     que había trabajo. Ahora se anota en `drainAgain` y se vuelve a drenar al terminar.
   *  3. Hay una forma de liberar cupo que NO produce ni ACK ni wake: que a una garra se le
   *     venza el plazo. Pasa con las garras rehidratadas de un adaptador que murió, y con las
   *     que el reaper manda a `dead` (ese camino no encola wake). Sin nada que dispare, el
   *     agente quedaría con cupo libre y la cola llena. Por eso al terminar se arma un timer al
   *     primer vencimiento conocido: la liveness queda acotada por el plazo de ACK, no por la
   *     suerte.
   */
  async function drain(session: Session): Promise<void> {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    if (session.draining) {
      session.drainAgain = true;
      return;
    }
    session.draining = true;
    try {
      // El tope existe sólo contra las vueltas IMPRODUCTIVAS: las productivas ya están
      // acotadas por el cupo, que baja con cada garra tomada. Sin tope, dos gateways contra la
      // misma cola podrían pasarse wakes de entregas que el otro ya se llevó y girar en vacío.
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        session.drainAgain = false;
        const budget = admissionBudget(session, admission, Date.now());
        if (budget.limit + budget.humanReservedLimit < 1) return;
        // INTEGRACIÓN 2026-07-29: quien manda es el cupo de admisión (`budget.limit`), que sale
        // de las garras vivas de ESTA sesión. `deliveryClaimLimit` queda como techo de lote
        // explícito por encima: con los defaults (cupo 2, lote 20) nunca ata, y existe para
        // poder bajarle el lote a un gateway sin tocar el cupo. Lo que ya no puede pasar —que era
        // el punto del parche de concurrencia— es que este argumento viaje `undefined` y caiga en
        // silencio en el default 20 del esquema de un endpoint HTTP.
        const generalLimit = Math.min(budget.limit, deliveryClaimLimit);
        if (generalLimit + budget.humanReservedLimit < 1) return;
        const deliveries = (await repository.claimDeliveries(
          session.tenantId, session.alias, session.instanceId, session.epoch,
          generalLimit, ackDeadlineMs, undefined,
          { humanReservedLimit: budget.humanReservedLimit }
        )).map((delivery) => normalizeDeliveryClaim(delivery, ackDeadlineMs));
        for (const delivery of deliveries) {
          const claim = claimFromDelivery(delivery, ackDeadlineMs);
          session.recentClaims.delete(delivery.delivery_id);
          session.claims.set(delivery.delivery_id, claim);
          send(session.socket, delivery);
        }
        if (!session.drainAgain) return;
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
      scheduleExpiryDrain(session);
    }
  }

  /**
   * Vuelve a drenar cuando venza la primera garra viva. Es la red de seguridad del punto 3 de
   * `drain()`: sin esto, una garra que se libera por vencimiento —y no por ACK ni por wake—
   * deja al adaptador conectado, con cupo y sin trabajo, que es indistinguible de un adaptador
   * roto. Uno solo por sesión, se reprograma en cada drenaje y se cancela al cerrar el socket.
   */
  function scheduleExpiryDrain(session: Session): void {
    if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
    if (session.socket.readyState !== WebSocket.OPEN || session.claims.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const claim of session.claims.values()) {
      earliest = Math.min(earliest, claim.admissionExpiresAtMs);
    }
    if (!Number.isFinite(earliest)) return;
    // El piso de 1 s evita que un reloj corrido convierta esto en un bucle de drenajes.
    const delayMs = Math.max(1_000, earliest - Date.now() + 1_000);
    const timer = setTimeout(() => {
      session.expiryTimer = undefined;
      void drain(session);
    }, delayMs);
    timer.unref();
    session.expiryTimer = timer;
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
              drainAgain: false,
              renewableDeliveryClaims,
              // El cupo NO arranca vacío: se reconstruye desde la base. Ver `rehydrateClaims`.
              claims: await rehydrateClaims(hello.tenant_id, hello.alias),
              recentClaims: new Map(),
              expiryTimer: undefined
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
          // Una garra rehidratada cuenta para el cupo pero NO fencea: la reconstruimos de la
          // base sin saber si el adaptador la conoce con ese mismo intento, así que exigirle
          // que coincida convertiría un ACK viejo en un cierre de socket 4401 donde antes había
          // un `ownership_lost` recuperable.
          if (sessionClaim !== undefined && sessionClaim.rehydrated !== true) {
            assertAckClaim(incoming, sessionClaim);
          } else if (sessionClaim === undefined && !current.renewableDeliveryClaims) {
            throw new StoreError('fenced', 'ACK has no claim in the live socket session');
          }
          // A renewable client can resume the same fenced DB lease after a
          // socket or gateway restart. In that case the in-memory claim map is
          // intentionally empty; repository.ackDelivery remains authoritative
          // for delivery id, attempt, token, instance, epoch and deadline.
          const result = await repository.ackDelivery(
            deliveryId, current.tenantId, current.alias, incoming, ackDeadlineMs,
            deliveryLeaseCap
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
          // Todo 'started' aplicado corre el plazo en la base a now()+plazo, incluido el
          // primero: el cupo tiene que seguirlo o el gateway daría por vencida una garra que
          // sigue viva. Antes la base NO lo movía en el primero y las dos vistas de la misma
          // garra se separaban por lo que hubiera tardado el arranque; ahora las dos parten del
          // mismo hecho. El máximo evita que un ACK tardío acorte el plazo.
          if (result.applied && incoming.status === 'started') {
            const renewed = current.claims.get(deliveryId);
            if (renewed !== undefined) {
              renewed.admissionExpiresAtMs = Math.max(
                renewed.admissionExpiresAtMs, Date.now() + ackDeadlineMs
              );
            }
          }
          // 'retry' TIENE que liberar el cupo, y no lo hacía. Cuando el harness ACKea un fallo
          // reintentable (un rate limit, digamos) la base pone la entrega en 'retry' y le borra
          // claim_token, consumer y plazo: ya no es de nadie. El gateway, en cambio, se quedaba
          // con ella en `claims` hasta que venciera su `admissionExpiresAtMs`. Con el cupo en 2,
          // dos fallos reintentables dejaban al agente en CUPO CERO durante media hora — el
          // mismo modo de falla que este parche existe para evitar, y bajo saturación 'retry' es
          // el desenlace MÁS frecuente.
          //
          // Estos cuatro son exactamente los estados en los que la base no tiene ninguna garra
          // viva para la entrega. Los otros ('leased', 'accepted', 'started') significan que
          // alguien la tiene; si ese alguien ya no somos nosotros, el vencimiento del plazo la
          // saca del mapa igual. Soltar de más admitiría trabajo que sigue corriendo.
          let releasedSlot = false;
          if (['done', 'failed', 'dead', 'retry'].includes(result.status)) {
            const completedClaim = current.claims.get(deliveryId);
            releasedSlot = current.claims.delete(deliveryId);
            // No se borra: se mueve a `recentClaims`. Un ACK tardío de esta misma entrega tiene
            // que seguir correlacionando, o un cliente viejo se come un 'fenced' con cierre de
            // socket donde hoy recibe un `ownership_lost` y sigue vivo.
            if (completedClaim !== undefined) rememberRecentClaim(current, deliveryId, completedClaim);
          }
          // ESTE es el punto que hace viable el control de admisión: si una garra se liberó,
          // hay que volver a drenar acá mismo. Si sólo se drenara con el 'retry' de antes, un
          // agente que termina su tarea se quedaría con el cupo libre y la cola llena hasta
          // que llegara un wake externo — y una entrega que ya estaba encolada y se salteó no
          // genera ningún wake nuevo. Sería un agente colgado con trabajo esperando.
          if (releasedSlot || result.status === 'retry') await drain(current);
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
      if (closing.expiryTimer !== undefined) clearTimeout(closing.expiryTimer);
      closing.expiryTimer = undefined;
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
