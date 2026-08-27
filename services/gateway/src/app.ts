import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import {
  AliasSchema, ClaimedAckSchema,
  ConsolePublishIntentConfirmResultSchema, ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentExpiredSchema,
  ConsolePublishIntentPrepareResultSchema, ConsolePublishIntentPrepareSchema,
  ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentReconciliationSchema,
  ConfigChangeRequestSchema, ConfigMutationSchema, ConfigRollbackRequestSchema,
  CreateJobSchema, DeliveryIdSchema, HeartbeatSchema, HelloSchema,
  NotifyRequestSchema,
  QueryDeliveriesSchema, QuotaSampleRequestSchema, TenantSchema,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE, SystemGateProbeBodySchema,
  type ClaimedAck, type ConfigMutation,
  type ConsolePublishIntentConfirm, type ConsolePublishIntentConfirmResult,
  type ConsolePublishIntentPrepare, type ConsolePublishIntentPrepareResult,
  type DeliveryEnvelope, type Hello, type NotifyRequest,
  type ProfileRuntimeAdoptionEvidence, type ProfileRuntimeContract,
  type QuotaSampleRequest, type Tenant
} from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, PublishIntentExpiredError,
  PublishIntentRateLimitedError, PublishIntentReconciliationRequired,
  StoreError, subscribeDeliveryWakes,
  type AccountSelection, type AckResult, type DatabasePool, type DeliveryLeaseCap,
  type ConnectionSessionFence, type FencedWakeOutboxRecipient, type LeaseResult,
  type NotificationVerdict, type OperationalDlqPage, type OperationalDlqResolutionRequest,
  type OperationalDlqResolutionResult, type OutboxEvent, type PublishResult,
  type QuotaSampleIngestResult, type WakeOutboxClaimFence
} from '@cauce/store';
import {
  AuthorizationError, requireOperatorPermission, requirePermission,
  validatePrincipal,
  type AuthProvider
} from './auth.js';
import { registerAgentDocumentRoutes } from './console/agent-documents.routes.js';
import { prepareAgentProfileRuntime } from './console/agent-profile-runtime.js';
import { SondaCompartida, sondaDiferida } from './console/sonda-compartida.js';
import {
  registerAgentProfileRoutes, type ProfileRuntimeVerification,
} from './console/agent-profile.routes.js';
import { createConsoleSecurityHook } from './console-security.js';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import {
  DEFAULT_ACK_DEADLINE_MS, DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES,
  validateAckDeadlineMs, validateDeliveryAdmission, type DeliveryAdmissionConfig
} from './config.js';
import { OidcBffAuthProvider, registerOidcBff } from './oidc-bff.js';
import { PasswordAuthProvider, registerPasswordAuth } from './password-auth.js';
import { WakePumpTelemetry } from './wake-pump-telemetry.js';
import {
  consolePublishOperatorScope, principal, publicPublish, replyError,
  trustedPublishSemantics, validatedPublishReceipt,
  type TrustedPublishCommand, type TrustedPublishIntentCommand,
} from './routes/shared.js';
import { registerGatewayHealthRoutes } from './routes/health.js';
import {
  safeAuditPage, safeCancelReceipt, safeDlqPage, safeDlqResolution, safeReplayReceipt, sameTenantRows,
  visibleMessage, visibleMessageList, visibleOriginRelays, visibleQueue
} from './facades.js';

export { WakePumpTelemetry } from './wake-pump-telemetry.js';
export type {
  WakePumpOutcome, WakePumpTelemetrySnapshot
} from './wake-pump-telemetry.js';

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
  connection: ConnectionSessionFence;
}

export interface OutboxLeaseAckResult {
  status: 'sent' | 'failed' | 'dead';
  applied: boolean;
}

/** Contract implemented by the hardened store; current method names remain stable. */
export interface GatewayRepository {
  publish(
    input: TrustedPublishCommand,
    options?: {
      readonly requirePreparedConsoleIntent?: boolean;
      readonly consoleIntentOperatorScope?: string;
    },
  ): Promise<PublishResult>;
  prepareConsolePublishIntent?(
    input: TrustedPublishIntentCommand,
    operatorScopeHash: string,
  ): Promise<ConsolePublishIntentPrepareResult>;
  confirmConsolePublishIntent?(
    tenantId: Tenant,
    actorAlias: string,
    operatorScopeHash: string,
    input: ConsolePublishIntentConfirm,
  ): Promise<ConsolePublishIntentConfirmResult>;
  /** Independent durable reconciliation; receipt-contained hashes are not an authority for IDs. */
  verifyPublishReceipt(input: TrustedPublishCommand, receipt: PublishResult): Promise<boolean>;
  assertPrincipal(tenantId: Tenant, alias: string): Promise<void>;
  assertPermission(tenantId: Tenant, alias: string, permission: 'route' | 'read' | 'control' | 'notify'): Promise<void>;
  principalAccess(tenantId: Tenant, alias: string): Promise<{ roles: string[]; permissions: Array<'route' | 'read' | 'control' | 'notify'> }>;
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
  listPresence(actorTenant: Tenant, actorAlias: string): Promise<Array<Record<string, unknown>>>;
  topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listMessages(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  queueSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listOperationalDlq(
    actorTenant: Tenant,
    actorAlias: string,
    limit?: number,
    cursor?: string | null,
  ): Promise<OperationalDlqPage>;
  resolveOperationalDlqWithoutReplay(
    actorTenant: Tenant,
    actorAlias: string,
    request: OperationalDlqResolutionRequest,
  ): Promise<OperationalDlqResolutionResult>;
  replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  cancelDelivery(
    deliveryId: string, actorTenant: Tenant, actorAlias: string, reason?: string
  ): Promise<Record<string, unknown>>;
  listJobs(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueJob(tenantId: Tenant, lane: 'interactive' | 'batch', priority: number, kind: string, payload: Record<string, unknown>): Promise<string>;
  listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getAgent(alias: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown> | undefined>;
  /** Canonical detail. Optional only so narrow pre-existing repository doubles stay usable. */
  getAgentByIdentity?(
    tenantId: Tenant, alias: string, actorTenant: Tenant, actorAlias: string,
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Lookup autorizado por identidad canónica. Opcional sólo para dobles legacy de test: las rutas
   * tenant-qualified fallan cerradas cuando no está implementado.
   */
  authorizeAgentTarget?(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: 'read' | 'control',
  ): Promise<{
    tenant_id: Tenant;
    alias: string;
    harness_id: string | null;
    home_directory: string | null;
    enabled: boolean;
  } | undefined>;
  listOriginRelays(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueNotification(actorTenant: Tenant, actorAlias: string, input: NotifyRequest): Promise<NotificationVerdict>;
  listNotifications(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { limit?: number; before?: string | null },
  ): Promise<Record<string, unknown>>;
  agentChain(traceId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  /**
   * Opcionales por la misma razón que `liveDeliveryClaims`: los dobles de test del gateway no
   * implementan la primitiva de gate, y sin ella la ruta responde 404 en vez de romper el
   * arranque. Las implementa `CauceRepository` desde la migración 019_delegation_discipline.
   */
  listChainGates?(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { status?: 'open' | 'all'; limit?: number },
  ): Promise<Record<string, unknown>>;
  answerChainGate?(
    gateId: string,
    answer: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  cancelChainGate?(
    gateId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  recordQuotaSample(actorTenant: Tenant, actorAlias: string, sample: QuotaSampleRequest): Promise<QuotaSampleIngestResult>;
  selectAccount(actorTenant: Tenant, actorAlias: string, provider: string): Promise<AccountSelection>;
  getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  applyConfigurationChange(actorTenant: Tenant, actorAlias: string, mutation: ConfigMutation, dryRun: boolean, expectedRevision?: number): Promise<unknown>;
  rollbackConfiguration(actorTenant: Tenant, actorAlias: string, revisionId: number, dryRun: boolean, expectedRevision?: number): Promise<unknown>;
  getMessage(messageId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  recordProfileRuntimeExpectation?(
    tenantId: Tenant, alias: string, contract: ProfileRuntimeContract,
  ): Promise<void>;
  readProfileRuntimeAdoption?(
    tenantId: Tenant, alias: string, contract: ProfileRuntimeContract,
  ): Promise<(ProfileRuntimeAdoptionEvidence & { readonly adopted_at: string }) | undefined>;
  acquireLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    capabilities: string[],
    ttlMs: number,
    options?: { resume?: boolean; resumeWindowMs?: number; requireDeclaredCapacity?: boolean },
  ): Promise<LeaseResult>;
  heartbeat(
    tenantId: Tenant, alias: string, instanceId: string, epoch: number, ttlMs: number,
    connectionToken: string, signal?: AbortSignal,
  ): Promise<string>;
  releaseLease(
    tenantId: Tenant, alias: string, instanceId: string, epoch: number,
    connectionToken: string, signal?: AbortSignal,
  ): Promise<boolean>;
  claimDeliveries(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    limit?: number,
    ackDeadlineMs?: number,
    interactiveBurst?: number,
    admission?: {
      generalCapacity?: number;
      humanReservedCapacity?: number;
      maxClaims?: number;
      humanBurst?: number;
      requireDeclaredCapacity?: boolean;
    },
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<DeliveryClaimRecord[]>;
  /**
   * Opcional sólo para dobles en modo test. Producción no arranca sin esta lectura: reconstruir
   * claims es parte del fence de reconexión y fallar abierto multiplicaría el cupo.
   */
  liveDeliveryClaims?(tenantId: Tenant, alias: string, limit?: number): Promise<readonly {
    delivery_id: string;
    attempt: number;
    claim_token: string;
    ack_deadline_at: string;
    human_originated: boolean;
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
  claimWakeOutbox(
    worker: string,
    recipients: readonly FencedWakeOutboxRecipient[],
    limit?: number,
    leaseMs?: number,
    signal?: AbortSignal,
  ): Promise<OutboxLeaseEvent[]>;
  renewWakeOutbox(
    fence: WakeOutboxClaimFence,
    leaseMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  ackOutbox(ack: OutboxLeaseAck, signal?: AbortSignal): Promise<OutboxLeaseAckResult>;
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
  /** Máximo de destinatarios cuyos claims de wake pueden estar en I/O simultáneamente. */
  outboxWakeConcurrency?: number;
  /** Espera máxima del cierre por un pump que no responde; después se continúa abortado. */
  outboxShutdownTimeoutMs?: number;
  /** Acumulador identity-free que el proceso puede conectar luego a su endpoint de métricas. */
  wakePumpTelemetry?: WakePumpTelemetry;
  /** Resultados agregados, sin identidades, del journal durable de publicación de consola. */
  consolePublishTelemetry?: ConsolePublishTelemetry;
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
 * conserva la correlación exacta del ACK y hasta cuándo sigue viva. La capacidad ya no se decide
 * en RAM: PostgreSQL la comparte durablemente entre HTTP, WebSocket, reconexiones y gateways.
 */
interface SessionClaim {
  readonly attempt: GatewayAck['attempt'];
  readonly claim_token: GatewayAck['claim_token'];
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
  /** Rotated by PostgreSQL on every hello, including a same-instance/same-epoch resume. */
  connectionToken: string;
  abort: AbortController;
  /** Un wake que llegó mientras drenábamos. Se atiende al terminar, nunca se pierde. */
  drainAgain: boolean;
  /** Promesa compartida por todos los wakes que se pliegan sobre el mismo drenaje. */
  drainPromise: Promise<boolean> | undefined;
  renewableDeliveryClaims: boolean;
  /**
   * El adaptador declaró entender la disciplina de delegación, así que `ack_result` puede llevar
   * `delegation_rejections` y `chain_gate`. Sin la capability esos campos NO se emiten: el
   * adaptador viejo valida el frame con `.strict()` y, cuando el esquema lo rechaza, no descarta
   * el frame — falla la cola entera de la conexión y se lleva puesto todo lo que tenía en vuelo.
   */
  delegationFeedback: boolean;
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
const DEFAULT_WAKE_PUMP_CONCURRENCY = 4;
const DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS = 1_000;

// Estados de ACK que devuelven la entrega al mundo terminal o reintentable y por lo tanto la sacan
// de agents.max_concurrent_deliveries. Es el conjunto complementario de ('leased','accepted',
// 'started'), que es exactamente lo que cuenta claimDeliveries.
const RELEASES_CAPACITY: ReadonlySet<string> = new Set(['done', 'failed', 'dead', 'retry']);

function sessionKey(tenantId: Tenant, alias: string): string {
  return `${tenantId}:${alias}`;
}

const CONNECTION_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DLQ_ID_PATTERN = CONNECTION_TOKEN_PATTERN;
const DLQ_EVIDENCE_PATTERN = /^[a-f0-9]{64}$/u;
const DLQ_CURSOR_PATTERN = /^(?:[a-f0-9]{2}){1,512}$/u;
const DLQ_RESOLUTION_KEYS = new Set([
  'evidence_sha256',
  'reason',
  'possible_duplicate_acknowledged',
  'possible_no_delivery_acknowledged',
]);
const AUDIT_CURSOR_PATTERN = /^[1-9][0-9]{0,18}$/u;
const AUDIT_QUERY_KEYS = new Set(['limit', 'before']);

function parseDlqLimit(value: unknown): number {
  if (value === undefined) return 200;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 500) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  return limit;
}

function parseDlqCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !DLQ_CURSOR_PATTERN.test(value)) {
    throw new StoreError('invalid_input', 'DLQ cursor is invalid');
  }
  return value;
}

function parseAuditQuery(value: unknown): { limit: number; before: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'audit query must be an object');
  }
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !AUDIT_QUERY_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'audit query contains an unknown field');
  }
  const rawLimit = query.limit;
  if (rawLimit !== undefined && (
    typeof rawLimit !== 'string'
    || !/^[1-9][0-9]{0,2}$/u.test(rawLimit)
    || Number(rawLimit) > 500
  )) {
    throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
  }
  const rawBefore = query.before;
  if (rawBefore !== undefined && (
    typeof rawBefore !== 'string'
    || !AUDIT_CURSOR_PATTERN.test(rawBefore)
    || BigInt(rawBefore) > 9_223_372_036_854_775_807n
  )) {
    throw new StoreError('invalid_input', 'audit cursor is invalid');
  }
  return { limit: rawLimit === undefined ? 100 : Number(rawLimit), before: rawBefore ?? null };
}

function parseDlqResolution(
  target: unknown,
  id: unknown,
  value: unknown,
): OperationalDlqResolutionRequest {
  if (target !== 'delivery' && target !== 'outbox') {
    throw new StoreError('invalid_input', 'DLQ target is invalid');
  }
  if (typeof id !== 'string' || !DLQ_ID_PATTERN.test(id)) {
    throw new StoreError('invalid_input', 'DLQ incident id is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'DLQ resolution body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== DLQ_RESOLUTION_KEYS.size
      || Object.keys(body).some((key) => !DLQ_RESOLUTION_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'DLQ resolution body has unexpected or missing fields');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1_000
      || [...reason].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })) {
    throw new StoreError('invalid_input', 'DLQ resolution reason is invalid');
  }
  if (typeof body.evidence_sha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(body.evidence_sha256)) {
    throw new StoreError('invalid_input', 'DLQ evidence hash is invalid');
  }
  if (typeof body.possible_duplicate_acknowledged !== 'boolean'
      || typeof body.possible_no_delivery_acknowledged !== 'boolean') {
    throw new StoreError('invalid_input', 'DLQ risk acknowledgements must be booleans');
  }
  return {
    target,
    id,
    evidenceSha256: body.evidence_sha256,
    reason,
    possibleDuplicateAcknowledged: body.possible_duplicate_acknowledged,
    possibleNoDeliveryAcknowledged: body.possible_no_delivery_acknowledged,
  };
}

function validatedDlqResolutionReceipt(
  value: unknown,
  request: OperationalDlqResolutionRequest,
): Record<string, unknown> {
  const receipt = safeDlqResolution(value);
  const appliedCount = receipt.appliedCount;
  const alreadyApplied = receipt.alreadyApplied;
  const countMatchesReceipt = (appliedCount === 1 && alreadyApplied === false)
    || (appliedCount === 0 && alreadyApplied === true);
  if (receipt.schemaVersion !== 1
      || receipt.suite !== 'cauce-v3-dlq-no-replay-resolution'
      || receipt.phase !== 'resolved'
      || !countMatchesReceipt
      || receipt.evidenceSha256 !== request.evidenceSha256
      || typeof receipt.reasonSha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(receipt.reasonSha256)
      || receipt.possibleDuplicateAcknowledged !== request.possibleDuplicateAcknowledged
      || receipt.possibleNoDeliveryAcknowledged !== request.possibleNoDeliveryAcknowledged) {
    // The transaction may already have committed. Return no false 2xx: an exact retry is safe and
    // the store will answer with its idempotent alreadyApplied receipt.
    throw new StoreError('conflict', 'DLQ resolution did not return an exact durable receipt');
  }
  return receipt;
}

function validatedReplayReceipt(value: unknown, sourceDeliveryId: string): Record<string, unknown> {
  const receipt = safeReplayReceipt(value);
  if (receipt.delivery_id === null
      || receipt.delivery_id === sourceDeliveryId
      || receipt.replayed_from_delivery_id !== sourceDeliveryId
      || receipt.state !== 'pending'
      || receipt.replayed !== true) {
    throw new StoreError('conflict', 'replay did not return an exact durable receipt');
  }
  return receipt;
}

function validatedCancelReceipt(value: unknown, deliveryId: string): Record<string, unknown> {
  const receipt = safeCancelReceipt(value);
  if (receipt.delivery_id !== deliveryId
      || receipt.state !== 'dead'
      || receipt.cancelled !== true
      || receipt.cancelled_from_state === null
      || receipt.parent_notice === null
      || typeof receipt.origin_relayed !== 'boolean'
      || receipt.replayable !== true) {
    throw new StoreError('conflict', 'cancel did not return an exact durable receipt');
  }
  return receipt;
}

function validatedConfigurationReceipt(
  value: unknown,
  dryRun: boolean,
  expectedRolledBackRevisionId: number | null,
  expectedMutation?: ConfigMutation,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  const result = value as Record<string, unknown>;
  const mutation = ConfigMutationSchema.safeParse(result.mutation);
  const inverse = ConfigMutationSchema.safeParse(result.inverse_mutation);
  const revision = result.revision;
  const rolledBackRevisionId = result.rolled_back_revision_id;
  const summary = result.summary;
  const exact = result.applied === !dryRun
    && result.dry_run === dryRun
    && Number.isSafeInteger(revision)
    && Number(revision) >= (dryRun ? 0 : 1)
    && rolledBackRevisionId === expectedRolledBackRevisionId
    && typeof summary === 'string'
    && summary.length >= 1
    && summary.length <= 2_000
    && mutation.success
    && inverse.success
    && (expectedMutation === undefined || isDeepStrictEqual(mutation.data, expectedMutation));
  if (!exact) {
    // La escritura pudo confirmar antes de que una capa incompatible truncara su recibo. La
    // respuesta no refleja campos crudos del store y obliga al cliente a releer la revisión.
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  return {
    applied: result.applied,
    dry_run: result.dry_run,
    revision,
    rolled_back_revision_id: rolledBackRevisionId,
    summary,
    mutation: mutation.data,
    inverse_mutation: inverse.data,
  };
}

function connectionToken(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTION_TOKEN_PATTERN.test(value)) {
    throw new StoreError('fenced', 'connection token is required');
  }
  return value;
}

function parseConnectionBoundBody<T extends Record<string, unknown>>(
  body: unknown,
  parse: (value: unknown) => T,
): T & { connection_token: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new StoreError('invalid_input', 'connection-bound request must be an object');
  }
  const { connection_token: rawToken, ...withoutToken } = body as Record<string, unknown>;
  return { ...parse(withoutToken), connection_token: connectionToken(rawToken) };
}

function sessionFence(session: Session): ConnectionSessionFence {
  return {
    tenant_id: session.tenantId,
    alias: session.alias,
    instance_id: session.instanceId,
    epoch: session.epoch,
    connection_token: session.connectionToken,
  };
}

function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** `Promise.allSettled`, pero con un número fijo de workers y resultados por entrada. */
async function allSettledBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<Array<PromiseSettledResult<void>>> {
  const results = new Array<PromiseSettledResult<void>>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]!);
        results[index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function publicPublishIntent(value: unknown): ConsolePublishIntentPrepare {
  return ConsolePublishIntentPrepareSchema.parse(value);
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

function runtimeContractFromVerification(
  revision: number,
  verification: ProfileRuntimeVerification,
): ProfileRuntimeContract {
  if (verification.state !== 'current' || verification.generation === null
    || verification.documents.length === 0
    || verification.documents.some((document) => !document.current
      || document.observed_sha !== document.expected_sha)) {
    throw new Error('runtime profile expectation requires an exact current verification');
  }
  return {
    revision,
    generation: verification.generation,
    documents: verification.documents.map((document) => ({
      name: document.name,
      path: document.path,
      sha: document.expected_sha,
    })),
  };
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
 * Saca de RAM las garras cuyo plazo ya venció.
 *
 * De paso saca de `claims` las garras cuyo plazo ya venció. No es una optimización: una garra
 * vencida no se puede renovar nunca más (`ackDelivery` exige `ack_deadline_at > now()`, misma
 * condición), así que si se quedara en el mapa ocuparía un cupo para siempre y el agente se
 * quedaría sin trabajo hasta reconectar. Se mueve a `recentClaims` en vez de borrarse, porque
 * borrarla haría que un ACK tardío no correlacione y un cliente legacy se comiera un 'fenced'
 * con cierre de socket, cuando hoy recibe un `ownership_lost` y sigue vivo.
 *
 * El presupuesto no se calcula aquí: la base lo descuenta bajo el lock durable por alias. Este
 * mapa sólo conserva correlación de ACK y programa el próximo drenaje por expiración.
 */
function pruneExpiredClaims(session: Session, nowMs: number): void {
  for (const [deliveryId, claim] of [...session.claims]) {
    if (claim.admissionExpiresAtMs <= nowMs) {
      session.claims.delete(deliveryId);
      rememberRecentClaim(session, deliveryId, claim);
    }
  }
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
  if (options.authProvider.mode === 'production' && repository.liveDeliveryClaims === undefined) {
    throw new Error('production gateway requires durable live-delivery claim recovery');
  }
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const outboxPollMs = options.outboxPollMs ?? 100;
  const outboxLeaseMs = options.outboxLeaseMs ?? 30_000;
  const outboxWakeConcurrency = options.outboxWakeConcurrency ?? DEFAULT_WAKE_PUMP_CONCURRENCY;
  if (!Number.isInteger(outboxWakeConcurrency) || outboxWakeConcurrency < 1 || outboxWakeConcurrency > 32) {
    throw new Error('outboxWakeConcurrency must be an integer between 1 and 32');
  }
  const outboxShutdownTimeoutMs = options.outboxShutdownTimeoutMs
    ?? DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isInteger(outboxShutdownTimeoutMs)
      || outboxShutdownTimeoutMs < 1 || outboxShutdownTimeoutMs > 30_000) {
    throw new Error('outboxShutdownTimeoutMs must be an integer between 1 and 30000');
  }
  const wakePumpTelemetry = options.wakePumpTelemetry ?? new WakePumpTelemetry();
  const consolePublishTelemetry = options.consolePublishTelemetry ?? new ConsolePublishTelemetry();
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
  // A successful lease acquisition starts one local hello admission. Rehydration contains I/O,
  // so an older hello can finish after a newer resume rotated the durable connection token. The
  // opaque marker lets only the most recently acquired hello install/replace the local session.
  const helloAdmissions = new Map<string, object>();
  let outboxPumpPromise: Promise<void> | undefined;
  const outboxPumpAbort = new AbortController();
  const pendingDrains = new Set<Promise<boolean>>();
  const pendingSessionTasks = new Set<Promise<unknown>>();
  let wakeRecipientCursor = 0;

  await app.register(websocket);
  app.addHook('onRequest', createConsoleSecurityHook({
    ...(options.consoleOrigins === undefined ? {} : { allowedOrigins: options.consoleOrigins })
  }));
  if (options.authProvider instanceof OidcBffAuthProvider) registerOidcBff(app, options.authProvider);
  if (options.authProvider instanceof PasswordAuthProvider) registerPasswordAuth(app, options.authProvider);
  registerGatewayHealthRoutes(app, options, repository);

  app.get('/v3/console/access', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const databaseAccess = await repository.principalAccess(actor.tenant_id, actor.alias);
      const effectiveRoles = actor.roles.filter((role) => databaseAccess.roles.includes(role));
      const effectivePermissions = actor.permissions.filter((permission) => databaseAccess.permissions.includes(permission));
      const permissions = [
        ...(effectivePermissions.includes('route') ? ['message.publish'] : []),
        ...(effectivePermissions.includes('notify') ? ['message.notify'] : []),
        ...(effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'dlq.resolve'] : []),
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
    const consolePublish = request.routeOptions.url === '/v3/console/messages';
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const command = publicPublish(request.body);
      const systemGateProbe = command.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE;
      if (systemGateProbe) {
        const probeBody = SystemGateProbeBodySchema.parse(command.body);
        const exactRole = actor.roles.length === 1 && actor.roles[0] === 'agent';
        const exactPermissions = actor.permissions.length === 2
          && actor.permissions.includes('route') && actor.permissions.includes('read');
        if (options.authProvider.name !== 'mtls' || actor.tenant_id !== 'Steven' ||
            actor.alias !== 'gate-probe' || actor.session_id !== 'gate-probe' ||
            actor.channel !== 'gate' || actor.origin !== undefined || !exactRole || !exactPermissions) {
          throw new AuthorizationError('system gate probe requires the exact dedicated mTLS identity');
        }
        const recipient = command.recipients[0];
        if (command.room_id !== 'grp.steven' || command.recipients.length !== 1 ||
            command.lane !== 'interactive' || command.priority !== -100 ||
            command.idempotency_key !== `gate:${recipient?.tenant_id}:${recipient?.alias}:${probeBody.nonce}`) {
          throw new Error('system gate probe payload is not canonical');
        }
      }
      // `gate-probe` intentionally has no membership/agent/lease and can never become a routing
      // target. Kant is only the durable actor required by the messages FK; the authenticated
      // context still preserves the exact mTLS gate authority.
      const trustedCommand: TrustedPublishCommand = {
        ...trustedPublishSemantics(actor, command, request, systemGateProbe ? 'kant' : actor.alias),
        idempotency_key: command.idempotency_key,
      };
      const receipt = validatedPublishReceipt(
        await repository.publish(trustedCommand, {
          requirePreparedConsoleIntent: consolePublish,
          ...(consolePublish
            ? { consoleIntentOperatorScope: consolePublishOperatorScope(actor) }
            : {}),
        }),
        trustedCommand,
        command.recipients.length,
      );
      if (typeof repository.verifyPublishReceipt !== 'function'
          || !(await repository.verifyPublishReceipt(trustedCommand, receipt))) {
        throw new StoreError('conflict', 'publish receipt does not match its durable effect');
      }
      if (consolePublish) {
        consolePublishTelemetry.record({ operation: 'publish', result: 'committed' });
      }
      return reply.code(202).send(receipt);
    } catch (error) {
      if (error instanceof PublishIntentExpiredError) {
        if (consolePublish) {
          consolePublishTelemetry.record({ operation: 'publish', result: 'expired' });
        }
        return reply.code(410).send(
          ConsolePublishIntentExpiredSchema.parse(error.expiration),
        );
      }
      if (consolePublish) consolePublishTelemetry.record({ operation: 'publish', result: 'error' });
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

  // Ingesta de muestras de cuota del recolector fuera de banda. Va fuera de /v3/console/
  // para permitir llamadas autenticadas de servicios de máquina sin cabecera Origin de navegador.
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

  app.post('/v3/console/publish-intents', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (repository.prepareConsolePublishIntent === undefined) {
        throw new StoreError('not_found', 'durable console publish intents are unavailable');
      }
      const publicCommand = publicPublishIntent(request.body);
      const command: TrustedPublishIntentCommand = {
        ...trustedPublishSemantics(actor, publicCommand, request),
        intent_nonce: publicCommand.intent_nonce,
        requested_priority: publicCommand.priority,
      };
      const result = ConsolePublishIntentPrepareResultSchema.parse(
        await repository.prepareConsolePublishIntent(
          command,
          consolePublishOperatorScope(actor),
        ),
      );
      consolePublishTelemetry.record({ operation: 'prepare', result: result.state });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof PublishIntentReconciliationRequired) {
        consolePublishTelemetry.record({ operation: 'prepare', result: 'reconciliation_required' });
        return reply.code(409).send(
          ConsolePublishIntentReconciliationSchema.parse(error.reconciliation),
        );
      }
      if (error instanceof PublishIntentRateLimitedError) {
        consolePublishTelemetry.record({ operation: 'prepare', result: 'rate_limited' });
        const limited = ConsolePublishIntentRateLimitedSchema.parse(error.rateLimit);
        return reply.header('Retry-After', String(limited.retry_after_seconds))
          .code(429).send(limited);
      }
      consolePublishTelemetry.record({ operation: 'prepare', result: 'error' });
      replyError(reply, error);
    }
  });

  app.post('/v3/console/publish-intents/confirm', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (repository.confirmConsolePublishIntent === undefined) {
        throw new StoreError('not_found', 'durable console publish intents are unavailable');
      }
      const confirmation = ConsolePublishIntentConfirmSchema.parse(request.body);
      const result = ConsolePublishIntentConfirmResultSchema.parse(
        await repository.confirmConsolePublishIntent(
          actor.tenant_id,
          actor.alias,
          consolePublishOperatorScope(actor),
          confirmation,
        ),
      );
      consolePublishTelemetry.record({ operation: 'confirm', result: 'confirmed' });
      return reply.code(200).send(result);
    } catch (error) {
      consolePublishTelemetry.record({ operation: 'confirm', result: 'error' });
      replyError(reply, error);
    }
  });

  app.post('/v3/console/messages', publishHandler);

  /**
   * Obtiene el mensaje completo por la superficie de consola autorizada,
   * preservando el cuerpo íntegro del mensaje según las reglas de visibilidad del actor.
   */
  app.get<{ Params: { messageId: string } }>('/v3/console/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      // `not_found` y NO `forbidden`: responder «prohibido» confirmaría que el mensaje existe a
      // quien no puede verlo, que es el mismo criterio que ya usan replay y cancel.
      if (!row) throw new StoreError('not_found', 'message not found or not visible');
      return row;
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/queues', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleQueue(await repository.queueSnapshot(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  // La reconciliación causal es superficie de operador, no una segunda lista de colas. Tanto la
  // lectura como la decisión exigen `control`: la lista revela que existe un incidente operativo
  // y cada fila puede convertirse inmediatamente en una mutación auditada. El store repite la
  // autorización y aplica visibilidad multi-tenant; la fachada es una segunda allowlist para que
  // una regresión SQL nunca filtre payloads, errores ni ids del proveedor al navegador.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/v3/console/dlq',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requireOperatorPermission(actor, 'control');
        const limit = parseDlqLimit(request.query.limit);
        const cursor = parseDlqCursor(request.query.cursor);
        return safeDlqPage(await repository.listOperationalDlq(
          actor.tenant_id,
          actor.alias,
          limit,
          cursor,
        ));
      } catch (error) { replyError(reply, error); }
    },
  );

  // Esta ruta nunca reinyecta un efecto. Registra una decisión humana contra la huella exacta
  // de la evidencia vigente; si la fila cambió, el CAS del store falla. Target/id vienen de la
  // ruta pero actor/tenant sólo del principal autenticado, y el body es exacto para no aceptar
  // autoridad accidental en campos que un cliente viejo o comprometido pudiera agregar.
  app.post<{
    Params: { target: string; id: string };
  }>(
    '/v3/console/dlq/:target/:id/resolve-without-replay',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requireOperatorPermission(actor, 'control');
        const resolution = parseDlqResolution(request.params.target, request.params.id, request.body);
        return validatedDlqResolutionReceipt(await repository.resolveOperationalDlqWithoutReplay(
          actor.tenant_id,
          actor.alias,
          resolution,
        ), resolution);
      } catch (error) { replyError(reply, error); }
    },
  );

  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/replay', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const deliveryId = DeliveryIdSchema.parse(request.params.deliveryId);
      return validatedReplayReceipt(
        await repository.replayDelivery(deliveryId, actor.tenant_id, actor.alias),
        deliveryId,
      );
    } catch (error) { replyError(reply, error); }
  });

  // Cancelar es la operación gemela de replay y va con exactamente el mismo candado
  // (`requireOperatorPermission(actor,'control')` acá y `assertReplayAuthorization` en el store).
  // Se expone por la misma superficie a propósito: hasta hoy la única forma de cancelar era un
  // UPDATE a mano en la base, sin auditoría, sin aviso al origen y sin liberar al padre.
  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/cancel', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      // El motivo es opcional y sólo se acepta como texto. Cualquier otra forma se ignora en vez
      // de rechazarse: la cancelación no puede fallar por un campo decorativo.
      const body = request.body as { reason?: unknown } | undefined;
      const reason = typeof body?.reason === 'string' ? body.reason : undefined;
      const deliveryId = DeliveryIdSchema.parse(request.params.deliveryId);
      return validatedCancelReceipt(await repository.cancelDelivery(
        deliveryId, actor.tenant_id, actor.alias, reason
      ), deliveryId);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/jobs', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
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
      requirePermission(actor, 'read');
      return await repository.fleetActivity(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // Consumo de cuotas de las suscripciones de IA, con su propio observed_at: es una muestra
  // fuera de banda de hace minutos, no de hace milisegundos como fleetActivity(), así que
  // fusionar los dos payloads mentiría sobre una de las dos frescuras.
  app.get('/v3/console/quotas', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.quotaSnapshot(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // The registry is intrinsically cross-tenant (an agent may borrow a pooled account paid by
  // another tenant), so no sameTenantRows facade runs here: the store already applied the
  // visibility rule and redacted the payer's account identity.
  /*
   * Registro del repositorio de perfiles y documentos de agentes.
   * Se registran en el ámbito de `/v3/console` de forma independiente del plugin de terminal.
   */
  // A ESTE nivel y no dentro del bloque: lo usan las rutas de consola Y el saludo del socket, que
  // manda el perfil una vez por conexión. Dos instancias sobre el mismo pool serían dos cachés y
  // dos sitios donde divergir.
  const agentProfiles = new AgentProfileRepository(options.pool);

  /*
   * El hueco donde el plano de terminal deja su sonda. Se decora sobre ESTA instancia de Fastify y
   * no vive como estado de módulo a propósito: los tests montan varios gateways en el mismo
   * proceso y compartirían la sonda del último en arrancar.
  */
  const sondaDeDocumentos = new SondaCompartida();
  const profileProbe = sondaDiferida(sondaDeDocumentos);
  app.decorate('sondaDeDocumentos', sondaDeDocumentos);
  {
    const perfiles = agentProfiles;
    const autorizarPerfil = async (
      request: unknown, permission: 'read' | 'control'
    ): Promise<{ tenant_id: Tenant; alias: string }> => {
      const actor = await principal(request as FastifyRequest, options.authProvider);
      if (permission === 'read') requirePermission(actor, 'read');
      else requireOperatorPermission(actor, 'control');
      return { tenant_id: actor.tenant_id, alias: actor.alias };
    };
    const autorizarDestino = async (
      actor: { tenant_id: string; alias: string },
      targetTenantId: string,
      targetAlias: string,
      permission: 'read' | 'control',
      legacySameTenant: boolean,
    ) => {
      const actorTenant = actor.tenant_id;
      const targetTenant = targetTenantId;
      if (repository.authorizeAgentTarget !== undefined) {
        try {
          return await repository.authorizeAgentTarget(
            actorTenant, actor.alias, targetTenant, targetAlias, permission,
          );
        } catch (error) {
          // No se distingue «actor sin permiso», «destino oculto» y «destino ausente» en esta
          // superficie: los tres fallan cerrados sin confirmar que la identidad existe.
          if (error instanceof StoreError
            && (error.code === 'forbidden' || error.code === 'invalid_actor')) return undefined;
          throw error;
        }
      }

      /*
       * Compatibilidad exclusiva para repositorios falsos anteriores a esta primitiva: sólo la
       * ruta LEGACY, sólo el tenant del actor y con permiso del store. Las rutas canónicas nunca
       * entran acá; sin método exacto responden 404.
       */
      if (!legacySameTenant || targetTenant !== actorTenant) return undefined;
      await repository.assertPermission(actorTenant, actor.alias, permission);
      return {
        tenant_id: actorTenant,
        alias: targetAlias,
        harness_id: null,
        home_directory: null,
        enabled: true,
      };
    };
    registerAgentProfileRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      readContext: (tenantId, alias) => perfiles.readContextWithPresence(tenantId, alias),
      replaceProfile: (profile, expectedRevision, actor) =>
        perfiles.replace(profile, expectedRevision, actor),
      prepareRuntime: (tenantId, alias, contexto) =>
        prepareAgentProfileRuntime(profileProbe, tenantId, alias, contexto),
      ...(repository.recordProfileRuntimeExpectation === undefined
        ? {}
        : {
            recordRuntimeExpectation: (tenantId, alias, revision, verification) =>
              repository.recordProfileRuntimeExpectation!(
                tenantId,
                alias,
                runtimeContractFromVerification(revision, verification),
              ),
          }),
      ...(repository.readProfileRuntimeAdoption === undefined
        ? {}
        : {
            readRuntimeAdoption: (tenantId, alias, revision, verification) =>
              repository.readProfileRuntimeAdoption!(
                tenantId,
                alias,
                runtimeContractFromVerification(revision, verification),
              ),
          }),
      markProfileApplied: (tenantId, alias, revision, actor) =>
        perfiles.markApplied(tenantId, alias, revision, actor),
    });
    registerAgentDocumentRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      /*
       * La sonda se resuelve en CADA petición a través del hueco, no se captura acá.
       *
       * La que de verdad lee el disco del contenedor la construye el plano de terminal, que en
       * `main.ts` se registra DESPUÉS de `buildGateway`: cuando estas rutas se montan, todavía no
       * existe. Capturarla acá guardaría para siempre la degradada, y el despliegue posterior del
       * plano no cambiaría nada — sin un error, además. Ver `console/sonda-compartida.ts`.
       *
       * Mientras nadie instale una, la degradada contesta «no medido» y «no hay canal» con esas
       * palabras, que es lo que la pantalla ya sabe pintar.
       */
      probe: profileProbe,
    });

    app.get<{ Params: { tenantId: string; alias: string } }>(
      '/v3/console/role-assignments/:tenantId/:alias/history',
      async (request, reply) => {
        try {
          const tenant = TenantSchema.safeParse(request.params.tenantId);
          const alias = AliasSchema.safeParse(request.params.alias);
          if (!tenant.success || !alias.success) {
            return reply.code(400).send({
              error: 'invalid_input', message: 'tenantId or alias is invalid',
            });
          }
          const actor = await autorizarPerfil(request, 'read');
          const target = await autorizarDestino(
            actor, tenant.data, alias.data, 'read', false,
          );
          if (!target || target.tenant_id !== tenant.data || target.alias !== alias.data) {
            return reply.code(404).send({
              error: 'not_found', message: 'agent not found or not visible',
            });
          }
          const history = await options.pool.query<Record<string, unknown>>(
            `SELECT id::text,tenant_id,alias,operation,previous_brief,new_brief,
                    previous_template_slug,new_template_slug,actor_tenant,actor_alias,changed_at
               FROM agent_role_brief_history
              WHERE tenant_id=$1 AND alias=$2
              ORDER BY agent_role_brief_history.id DESC LIMIT 100`,
            [target.tenant_id, target.alias],
          );
          return {
            observed_at: new Date().toISOString(),
            tenant_id: target.tenant_id,
            alias: target.alias,
            entries: history.rows,
          };
        } catch (error) { replyError(reply, error); }
      },
    );
  }

  app.get('/v3/console/agents', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.listAgents(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Params: { tenantId: string; alias: string } }>(
    '/v3/console/tenants/:tenantId/agents/:alias',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        const tenant = TenantSchema.safeParse(request.params.tenantId);
        const alias = AliasSchema.safeParse(request.params.alias);
        if (!tenant.success || !alias.success) {
          return reply.code(400).send({
            error: 'invalid_input', message: 'tenantId or alias is invalid',
          });
        }
        const agent = repository.getAgentByIdentity === undefined
          ? tenant.data === actor.tenant_id
            ? await repository.getAgent(alias.data, actor.tenant_id, actor.alias)
            : undefined
          : await repository.getAgentByIdentity(
              tenant.data, alias.data, actor.tenant_id, actor.alias,
            );
        if (!agent || agent.tenant_id !== tenant.data || agent.alias !== alias.data) {
          throw new StoreError('not_found', 'agent not found or not visible');
        }
        return agent;
      } catch (error) { replyError(reply, error); }
    },
  );

  // Compatibilidad sin tenant: significa estrictamente el tenant autenticado. Un alias visible
  // en otro tenant jamás puede ganar por orden alfabético ni por el orden físico de PostgreSQL.
  app.get<{ Params: { alias: string } }>('/v3/console/agents/:alias', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const alias = AliasSchema.parse(request.params.alias);
      const agent = await repository.getAgent(alias, actor.tenant_id, actor.alias);
      if (!agent || agent.tenant_id !== actor.tenant_id || agent.alias !== alias) {
        throw new StoreError('not_found', 'agent not found or not visible');
      }
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

  app.get<{ Querystring: Record<string, unknown> }>('/v3/console/audit', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const query = parseAuditQuery(request.query);
      return safeAuditPage(await repository.listAudit(actor.tenant_id, actor.alias, query));
    } catch (error) { replyError(reply, error); }
  });

  // Follow one delegation chain live, by trace id. The response is a graph, not a row list:
  // the store already applied per-node default-deny visibility, so no facade runs here.
  // sameTenantRows would both empty this payload (it has no `items`) and erase the
  // cross-tenant edges the endpoint exists to show.
  app.get<{ Params: { traceId: string } }>('/v3/console/chains/:traceId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.agentChain(request.params.traceId, actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // Las preguntas que la flota le dejó a una persona. Es la LISTA VISIBLE que el gate promete:
  // sin ella, sacar la espera humana del bus sólo la escondería en otro lado.
  //
  // Sin fachada sameTenantRows, por el mismo motivo que /v3/console/chains/:traceId: el store ya
  // aplicó la visibilidad fila por fila (tenant propio, o arista ACL con allow_read), y aplastar
  // por tenant acá dejaría a un operador del hub sin poder contestar la pregunta de un agente de
  // otro tenant, que es justo para lo que existe esta lista.
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/v3/console/chain-gates',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        if (repository.listChainGates === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        const limit = Number.parseInt(request.query.limit ?? '', 10);
        return await repository.listChainGates(actor.tenant_id, actor.alias, {
          status: request.query.status === 'all' ? 'all' : 'open',
          ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
        });
      } catch (error) { replyError(reply, error); }
    }
  );

  // Contestar reanuda la rama suspendida con UNA entrega. Pide 'route' y no 'read' porque
  // produce tráfico en el bus, igual que publicar.
  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/answer',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        if (repository.answerChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        const body = request.body === null || typeof request.body !== 'object'
          ? {}
          : request.body as Record<string, unknown>;
        const answer = typeof body.answer === 'string' ? body.answer : '';
        return await repository.answerChainGate(
          request.params.gateId, answer, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );

  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/cancel',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        if (repository.cancelChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        return await repository.cancelChainGate(
          request.params.gateId, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );

  app.get('/v3/console/config', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
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
      return reply.code(change.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, change.dry_run, null, change.mutation,
      ));
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
      return reply.code(rollback.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, rollback.dry_run, revisionId,
      ));
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/observability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
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
        hello.tenant_id, hello.alias, hello.instance_id, hello.capabilities, leaseTtlMs,
        { requireDeclaredCapacity: true },
      );
      if (!lease.acquired) return reply.code(409).send(lease);
      if (!lease.epoch) throw new StoreError('conflict', 'lease acquisition returned no epoch');
      const leaseConnectionToken = connectionToken(lease.connection_token);
      return reply.code(200).send({
        ...lease,
        connection_token: leaseConnectionToken,
      });
    } catch (error) {
      replyError(reply, error);
    }
  });

  /**
   * Reclamo por HTTP. Es el otro punto por donde se puede vaciar la cola de un agente. El cliente
   * sólo elige un máximo de lote: las capacidades general y humana viajan por separado y el store
   * descuenta bajo lock todas las garras vivas del alias. Así dos polls, un socket y otro gateway
   * comparten el mismo presupuesto aunque este endpoint sea sin estado.
   */
  const queryHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const query = parseConnectionBoundBody(
        request.body,
        (value) => QueryDeliveriesSchema.parse(value),
      );
      const requested = Math.min(query.limit, maxQueryLimit);
      const deliveries = (await repository.claimDeliveries(
        actor.tenant_id, actor.alias, query.instance_id, query.epoch,
        requested, ackDeadlineMs, undefined, {
          generalCapacity: admission.maxInflightDeliveries,
          humanReservedCapacity: admission.humanReservedDeliveries,
          maxClaims: requested,
          requireDeclaredCapacity: true,
        }, query.connection_token
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
      const heartbeat = parseConnectionBoundBody(
        request.body,
        (value) => HeartbeatSchema.parse(value),
      );
      const leaseExpiresAt = await repository.heartbeat(
        actor.tenant_id, actor.alias, heartbeat.instance_id, heartbeat.epoch, leaseTtlMs,
        heartbeat.connection_token,
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
   * Falla cerrado. La consulta es parte del fence de reconexión: inventar un mapa vacío ante un
   * error permite multiplicar claims y pierde correlación de ACK. El llamador libera el lease que
   * acaba de adquirir antes de rechazar el hello, para que el siguiente intento no quede bloqueado.
   */
  async function rehydrateClaims(tenantId: Tenant, alias: string): Promise<Map<string, SessionClaim>> {
    const claims = new Map<string, SessionClaim>();
    if (repository.liveDeliveryClaims === undefined) return claims;
    const live = await repository.liveDeliveryClaims(tenantId, alias, MAX_REHYDRATED_CLAIMS);
    for (const claim of live) {
      const deadlineMs = Date.parse(claim.ack_deadline_at);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) continue;
      claims.set(claim.delivery_id, {
        attempt: claim.attempt,
        claim_token: claim.claim_token,
        admissionExpiresAtMs: deadlineMs,
        rehydrated: true
      });
    }
    return claims;
  }

  /**
   * Drena entregas pendientes hacia la sesión respetando los límites de admisión configurados.
   * Gestiona el redrenaje ante nuevos wakes, liberaciones de cuota por ACK y expiración de plazos.
   */
  function drain(session: Session): Promise<boolean> {
    if (session.abort.signal.aborted || session.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    if (session.drainPromise !== undefined) {
      session.drainAgain = true;
      return session.drainPromise;
    }
    // El salto de microtarea garantiza que `drainPromise` quede publicado antes de que una rama
    // sin I/O (por ejemplo cupo cero) llegue al `finally` y permita otro drenaje concurrente.
    const operation = Promise.resolve()
      .then(async () => drainExclusively(session))
      .finally(() => {
        if (session.drainPromise === operation) session.drainPromise = undefined;
      });
    session.drainPromise = operation;
    pendingDrains.add(operation);
    void operation.then(
      () => pendingDrains.delete(operation),
      () => pendingDrains.delete(operation),
    );
    return operation;
  }

  async function drainExclusively(session: Session): Promise<boolean> {
    try {
      // El tope existe sólo contra las vueltas IMPRODUCTIVAS: las productivas ya están
      // acotadas por el cupo, que baja con cada garra tomada. Sin tope, dos gateways contra la
      // misma cola podrían pasarse wakes de entregas que el otro ya se llevó y girar en vacío.
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        if (session.abort.signal.aborted) return false;
        session.drainAgain = false;
        pruneExpiredClaims(session, Date.now());
        // `deliveryClaimLimit` es sólo el techo explícito de lote. Las capacidades durables
        // viajan separadas y PostgreSQL descuenta los claims vivos de todo el alias; la RAM de
        // esta sesión ya no decide cuánto se puede reclamar.
        const requested = Math.min(deliveryClaimLimit, maxQueryLimit);
        const deliveries = (await repository.claimDeliveries(
          session.tenantId, session.alias, session.instanceId, session.epoch,
          requested, ackDeadlineMs, undefined,
          {
            generalCapacity: admission.maxInflightDeliveries,
            humanReservedCapacity: admission.humanReservedDeliveries,
            maxClaims: requested,
            requireDeclaredCapacity: true,
          },
          session.connectionToken,
          session.abort.signal,
        )).map((delivery) => normalizeDeliveryClaim(delivery, ackDeadlineMs));
        if (session.abort.signal.aborted
            || sessions.get(sessionKey(session.tenantId, session.alias)) !== session
            || session.socket.readyState !== WebSocket.OPEN) return false;
        let allFramesQueued = true;
        for (const delivery of deliveries) {
          const claim = claimFromDelivery(delivery, ackDeadlineMs);
          session.recentClaims.delete(delivery.delivery_id);
          session.claims.set(delivery.delivery_id, claim);
          allFramesQueued = send(session.socket, delivery) && allFramesQueued;
        }
        // El store ya otorgó estas garras. Si el socket cayó mientras esperaba el claim, el wake
        // no puede declararse entregado: la reconexión lo volverá a reclamar selectivamente y el
        // lease de la entrega seguirá su recuperación normal.
        if (!allFramesQueued) return false;
        if (!session.drainAgain) return true;
      }
      return true;
    } catch (error) {
      if (session.abort.signal.aborted) return false;
      if (error instanceof StoreError && error.code === 'fenced') {
        send(session.socket, { type: 'error', code: 'fenced', message: error.message });
        session.socket.close(4401, 'fenced');
      } else if (error instanceof StoreError && error.code === 'conflict'
          && error.message === 'delivery consumer is missing its durable agent capacity') {
        send(session.socket, {
          type: 'error', code: 'consumer_not_declared',
          message: 'consumer has no durable delivery capacity declaration',
        });
        session.socket.close(4403, 'consumer not declared');
      } else {
        app.log.error(error);
        send(session.socket, {
          type: 'error', code: 'delivery_unavailable',
          message: 'durable delivery admission is unavailable',
        });
        session.socket.close(1011, 'delivery unavailable');
      }
      return false;
    } finally {
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
    if (session.abort.signal.aborted
        || session.socket.readyState !== WebSocket.OPEN || session.claims.size === 0) return;
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
            const delegationFeedback = hello.capabilities.includes('delegation_feedback_v1');
            let lease: LeaseResult;
            try {
              lease = await repository.acquireLease(
                hello.tenant_id,
                hello.alias,
                hello.instance_id,
                hello.capabilities,
                leaseTtlMs,
                renewableDeliveryClaims
                  ? {
                      resume: true,
                      resumeWindowMs: ackDeadlineMs,
                      requireDeclaredCapacity: true,
                    }
                  : { requireDeclaredCapacity: true }
              );
            } catch (error) {
              if (error instanceof StoreError && error.code === 'conflict'
                  && (error.message === 'delivery consumer is missing its durable agent capacity'
                    || error.message === 'delivery consumer capacity is invalid')) {
                send(socket, {
                  type: 'error', code: 'consumer_not_declared',
                  message: 'consumer has no valid durable delivery capacity declaration',
                });
                socket.close(4403, 'consumer not declared');
                return;
              }
              throw error;
            }
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
            const leaseConnectionToken = connectionToken(lease.connection_token);
            const releaseHelloLease = async (event: string): Promise<void> => {
              if (renewableDeliveryClaims) return;
              try {
                await repository.releaseLease(
                  hello.tenant_id,
                  hello.alias,
                  hello.instance_id,
                  lease.epoch!,
                  leaseConnectionToken,
                );
              } catch {
                app.log.error({ event, tenant_id: hello.tenant_id, alias: hello.alias });
              }
            };
            try {
              await repository.heartbeat(
                hello.tenant_id,
                hello.alias,
                hello.instance_id,
                lease.epoch,
                leaseTtlMs,
                leaseConnectionToken,
              );
            } catch (error) {
              await releaseHelloLease('initial_hello_fence_release_failed');
              if (error instanceof StoreError && error.code === 'fenced') {
                send(socket, {
                  type: 'error', code: 'fenced',
                  message: 'a newer hello owns this consumer connection',
                });
                socket.close(4401, 'superseded during hello');
              } else {
                app.log.error(error);
                send(socket, {
                  type: 'error', code: 'delivery_unavailable',
                  message: 'durable delivery admission is unavailable',
                });
                socket.close(1011, 'delivery unavailable');
              }
              return;
            }
            const key = sessionKey(hello.tenant_id, hello.alias);
            const helloAdmission = {};
            helloAdmissions.set(key, helloAdmission);
            const rejectInactiveHello = async (): Promise<boolean> => {
              const ownsAdmission = helloAdmissions.get(key) === helloAdmission;
              if (!closed && socket.readyState === WebSocket.OPEN && ownsAdmission) return false;
              if (ownsAdmission) helloAdmissions.delete(key);
              await releaseHelloLease(closed || socket.readyState !== WebSocket.OPEN
                ? 'closed_hello_release_failed'
                : 'superseded_hello_release_failed');
              if (!closed && socket.readyState === WebSocket.OPEN) {
                send(socket, {
                  type: 'error', code: 'fenced',
                  message: 'a newer hello owns this consumer connection',
                });
                socket.close(4401, 'superseded during hello');
              }
              return true;
            };
            let recoveredClaims: Map<string, SessionClaim>;
            try {
              recoveredClaims = await rehydrateClaims(hello.tenant_id, hello.alias);
            } catch (error) {
              if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
              await releaseHelloLease('delivery_claim_recovery_release_failed');
              app.log.error(error);
              send(socket, {
                type: 'error', code: 'delivery_unavailable',
                message: 'durable delivery claim recovery is unavailable',
              });
              socket.close(1011, 'delivery unavailable');
              return;
            }
            if (await rejectInactiveHello()) return;
            /*
             * EL PERFIL VIAJA EN EL SALUDO, UNA VEZ.
             *
             * La configuración fija reside en el fichero del arnés. Viaja en el saludo inicial
             * para permitir que el adaptador mantenga su contexto sin sobrecargar cada entrega.
             *
             * Gateado tras la capability `agent_profile_v1` para compatibilidad hacia atrás.
             *
             * Un fallo leyendo el perfil NO tumba el saludo. El alias queda conectado y recibiendo
             * entregas con el sobre completo, que es el comportamiento de siempre; lo que se pierde
             * es el recorte. Al revés —negar la conexión porque no se pudo componer un fichero—
             * dejaría a un alias sordo por un problema de presentación.
             */
            let agentProfile: { perfil: unknown; hechos: unknown } | undefined;
            if (hello.capabilities.includes('agent_profile_v1')) {
              try {
                const contexto = await agentProfiles.readContext(hello.tenant_id, hello.alias);
                agentProfile = { perfil: contexto.perfil, hechos: contexto.hechos };
              } catch {
                agentProfile = undefined;
              }
            }
            if (await rejectInactiveHello()) return;
            let confirmedLeaseExpiresAt: string;
            try {
              confirmedLeaseExpiresAt = await repository.heartbeat(
                hello.tenant_id,
                hello.alias,
                hello.instance_id,
                lease.epoch,
                leaseTtlMs,
                leaseConnectionToken,
              );
            } catch (error) {
              if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
              await releaseHelloLease('hello_fence_release_failed');
              if (error instanceof StoreError && error.code === 'fenced') {
                send(socket, {
                  type: 'error', code: 'fenced',
                  message: 'a newer hello owns this consumer connection',
                });
                socket.close(4401, 'superseded during hello');
              } else {
                app.log.error(error);
                send(socket, {
                  type: 'error', code: 'delivery_unavailable',
                  message: 'durable delivery admission is unavailable',
                });
                socket.close(1011, 'delivery unavailable');
              }
              return;
            }
            if (closed || socket.readyState !== WebSocket.OPEN
                || helloAdmissions.get(key) !== helloAdmission) {
              await rejectInactiveHello();
              return;
            }
            const previous = sessions.get(key);
            current = {
              socket, tenantId: hello.tenant_id, alias: hello.alias,
              instanceId: hello.instance_id,
              epoch: lease.epoch,
              connectionToken: leaseConnectionToken,
              abort: new AbortController(),
              drainAgain: false,
              drainPromise: undefined,
              renewableDeliveryClaims,
              delegationFeedback,
              // El cupo NO arranca vacío: se reconstruye desde la base. Ver `rehydrateClaims`.
              claims: recoveredClaims,
              recentClaims: new Map(),
              expiryTimer: undefined
            };
            sessions.set(key, current);
            if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
            if (previous && previous.socket !== socket) {
              previous.abort.abort(new Error('connection superseded by a newer hello'));
              previous.socket.close(4401, 'superseded by newer connection');
            }
            send(socket, {
              type: 'hello_ack', version: '3.0', epoch: lease.epoch,
              lease_expires_at: confirmedLeaseExpiresAt,
              ...(agentProfile === undefined ? {} : { agent_profile: agentProfile })
            });
            const initialDrainReady = await drain(current);
            if (!initialDrainReady || socket.readyState !== WebSocket.OPEN) return;
            // El hello es también la señal durable de que este destinatario volvió. No hace falta
            // esperar al siguiente tick para recoger los wakes que permanecieron intactos offline.
            void pumpOutbox().catch((error: unknown) => app.log.error(error));
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
              current.tenantId, current.alias, current.instanceId, current.epoch, leaseTtlMs,
              current.connectionToken,
              current.abort.signal,
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
          const staleTerminalReplay = incoming.epoch < current.epoch
            && (incoming.status === 'done' || incoming.status === 'failed');
          if (incoming.epoch < current.epoch && !staleTerminalReplay) {
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
          // El orden importa. `claims` tiene la garra VIVA; `recentClaims`, la anterior. Cuando
          // el reaper reintentó una entrega y el mismo adaptador se la volvió a llevar, la viva
          // es la del intento nuevo — y el ACK terminal del intento viejo, que llega tarde con
          // la respuesta adentro, no coincide con ella. `assertAckClaim` lo convertía en un
          // 'fenced' con cierre de socket 4401: el resultado no llegaba siquiera a la base, que
          // es quien sabe decidir si sirve (ver `lateTerminalSalvage`). Si el ACK correlaciona
          // EXACTO con una garra que este mismo socket recuerda haber entregado, se usa ésa y se
          // deja que decida el store. Cuando no correlaciona con ninguna, no cambia nada.
          const liveClaim = current.claims.get(deliveryId);
          const recentClaim = current.recentClaims.get(deliveryId);
          const matchesRecent = recentClaim !== undefined
            && recentClaim.attempt === incoming.attempt
            && recentClaim.claim_token === incoming.claim_token;
          const sessionClaim = matchesRecent ? recentClaim : (liveClaim ?? recentClaim);
          // Una garra rehidratada cuenta para el cupo pero NO fencea: la reconstruimos de la
          // base sin saber si el adaptador la conoce con ese mismo intento, así que exigirle
          // que coincida convertiría un ACK viejo en un cierre de socket 4401 donde antes había
          // un `ownership_lost` recuperable.
          if (!staleTerminalReplay && sessionClaim !== undefined && sessionClaim.rehydrated !== true) {
            assertAckClaim(incoming, sessionClaim);
          } else if (!staleTerminalReplay && sessionClaim === undefined && !current.renewableDeliveryClaims) {
            throw new StoreError('fenced', 'ACK has no claim in the live socket session');
          }
          // A renewable client can resume the same fenced DB lease after a
          // socket or gateway restart. In that case the in-memory claim map is
          // intentionally empty; repository.ackDelivery remains authoritative
          // for delivery id, attempt, token, instance, epoch and deadline.
          let result: AckResult;
          try {
            result = await repository.ackDelivery(
              deliveryId, current.tenantId, current.alias, incoming, ackDeadlineMs,
              deliveryLeaseCap
            );
          } catch (error) {
            // El evento terminal viejo sí llegó a la autoridad durable. Si no era un duplicado
            // exacto, el store puede fencearlo contra la garra nueva: para este frame eso es una
            // prueba concluyente de ownership_lost, no razón para cerrar el socket de época N+1.
            if (!staleTerminalReplay || !(error instanceof StoreError) || error.code !== 'fenced') throw error;
            result = {
              delivery_id: deliveryId,
              status: incoming.status,
              applied: false,
              receipt: 'ownership_lost',
            };
          }
          // Todo campo que el store agregue a `AckResult` se saca de `legacyResult` A MANO y se
          // vuelve a poner detrás de su capability. `legacyResult` es lo que un adaptador de
          // cualquier versión sabe leer, así que el spread NO puede ser la vía por la que entra
          // un campo nuevo: ahí está el defecto que esto arregla — `delegation_rejections` y
          // `chain_gate` viajaban en el spread, el `.strict()` del adaptador viejo los rechazaba,
          // y un frame rechazado no se descarta: falla la cola entera de la conexión.
          const {
            receipt,
            delegation_rejections: delegationRejections,
            delegation_materializations: delegationMaterializations,
            chain_gate: chainGate,
            ...legacyResult
          } = result;
          const feedback = current.delegationFeedback;
          send(socket, {
            type: 'ack_result',
            ...legacyResult,
            event_id: incoming.event_id,
            attempt: incoming.attempt,
            claim_token: incoming.claim_token,
            ...(current.renewableDeliveryClaims ? { receipt } : {}),
            ...(feedback && delegationRejections !== undefined
              ? { delegation_rejections: delegationRejections }
              : {}),
            ...(feedback && delegationMaterializations !== undefined
              ? { delegation_materializations: delegationMaterializations }
              : {}),
            ...(feedback && chainGate !== undefined ? { chain_gate: chainGate } : {})
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
            const closesCurrentClaim = completedClaim !== undefined
              && completedClaim.attempt === incoming.attempt
              && completedClaim.claim_token === incoming.claim_token;
            releasedSlot = closesCurrentClaim && current.claims.delete(deliveryId);
            // No se borra: se mueve a `recentClaims`. Un ACK tardío de esta misma entrega tiene
            // que seguir correlacionando, o un cliente viejo se come un 'fenced' con cierre de
            // socket donde hoy recibe un `ownership_lost` y sigue vivo.
            if (releasedSlot && completedClaim !== undefined) {
              rememberRecentClaim(current, deliveryId, completedClaim);
            }
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
      closing.abort.abort(new Error('consumer connection closed'));
      if (closing.expiryTimer !== undefined) clearTimeout(closing.expiryTimer);
      closing.expiryTimer = undefined;
      const key = sessionKey(closing.tenantId, closing.alias);
      if (sessions.get(key)?.socket === socket) sessions.delete(key);
      // Keep the DB lease and epoch until heartbeat expiry. The same stable
      // instance can resume it within the delivery claim window, so a transient
      // socket or gateway restart does not abort a multi-hour harness.
      if (!closing.renewableDeliveryClaims) {
        const pendingFrames = frameQueue;
        const releaseTask = pendingFrames.finally(async () => {
          await repository.releaseLease(
            closing.tenantId,
            closing.alias,
            closing.instanceId,
            closing.epoch,
            closing.connectionToken,
          );
        });
        pendingSessionTasks.add(releaseTask);
        void releaseTask.then(
          () => pendingSessionTasks.delete(releaseTask),
          (error: unknown) => {
            pendingSessionTasks.delete(releaseTask);
            app.log.error(error);
          },
        );
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

  function pumpOutbox(): Promise<void> {
    if (outboxPumpAbort.signal.aborted) return Promise.resolve();
    if (outboxPumpPromise !== undefined) return outboxPumpPromise;
    const operation = Promise.resolve()
      .then(async () => pumpOutboxOnce())
      .finally(() => {
        if (outboxPumpPromise === operation) outboxPumpPromise = undefined;
      });
    outboxPumpPromise = operation;
    return operation;
  }

  async function pumpOutboxOnce(): Promise<void> {
    wakePumpTelemetry.beginCycle();
    try {
      await pumpOutboxCycle();
    } catch (error) {
      if (outboxPumpAbort.signal.aborted) {
        wakePumpTelemetry.recordOutcome('cancelled');
        return;
      }
      wakePumpTelemetry.recordOutcome(
        error instanceof StoreError && error.code === 'fenced' ? 'fenced' : 'error'
      );
      throw error;
    } finally {
      wakePumpTelemetry.finishCycle();
    }
  }

  async function pumpOutboxCycle(): Promise<void> {
    if (outboxPumpAbort.signal.aborted) return;
    const sortedRecipients: FencedWakeOutboxRecipient[] = [...sessions.values()]
      .filter((session) => session.socket.readyState === WebSocket.OPEN)
      .map((session) => sessionFence(session))
      .sort((left, right) => sessionKey(left.tenant_id, left.alias)
        .localeCompare(sessionKey(right.tenant_id, right.alias)));
    if (sortedRecipients.length === 0) return;

    // Rota el primero de cada tick para que el primer alias lexicográfico no monopolice siempre
    // el primer worker. El FIFO de eventos dentro de cada identidad lo conserva el store.
    const offset = wakeRecipientCursor % sortedRecipients.length;
    wakeRecipientCursor = (wakeRecipientCursor + 1) % sortedRecipients.length;
    const recipients = [
      ...sortedRecipients.slice(offset),
      ...sortedRecipients.slice(0, offset)
    ];
    // One SQL claim per cycle. PostgreSQL returns at most one row per requested identity in this
    // same rotated order, so an old backlog cannot monopolise all leases.
    const events = await repository.claimWakeOutbox(
      workerId,
      recipients,
      recipients.length,
      outboxLeaseMs,
      outboxPumpAbort.signal,
    );
    wakePumpTelemetry.markProgress();
    for (let claimed = 0; claimed < events.length; claimed += 1) {
      wakePumpTelemetry.markClaimed();
    }
    if (outboxPumpAbort.signal.aborted) {
      if (events.length === 0) wakePumpTelemetry.recordOutcome('cancelled');
      for (let cancelled = 0; cancelled < events.length; cancelled += 1) {
        wakePumpTelemetry.recordOutcome('cancelled');
      }
      return;
    }
    if (events.length > recipients.length) {
      throw new StoreError('fenced', 'wake outbox batch exceeded the requested identity count');
    }
    const recipientsByIdentity = new Map(
      recipients.map((recipient) => [sessionKey(recipient.tenant_id, recipient.alias), recipient]),
    );
    const seen = new Set<string>();
    for (const event of events) {
      const parsedAlias = AliasSchema.safeParse(event.payload.recipient_alias);
      const key = parsedAlias.success ? sessionKey(event.tenant_id, parsedAlias.data) : '';
      if (!parsedAlias.success || !recipientsByIdentity.has(key) || seen.has(key)) {
        throw new StoreError('fenced', 'wake outbox returned an invalid or duplicate batch identity');
      }
      seen.add(key);
    }
    const results = await allSettledBounded(
      events,
      outboxWakeConcurrency,
      async (event) => processWakeEvent(
        event,
        recipientsByIdentity,
        outboxPumpAbort.signal,
      ),
    );
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      wakePumpTelemetry.recordOutcome(
        result.reason instanceof StoreError && result.reason.code === 'fenced'
          ? 'fenced' : 'error'
      );
      app.log.error(result.reason);
    }
  }

  async function processWakeEvent(
    event: OutboxLeaseEvent,
    recipients: ReadonlyMap<string, FencedWakeOutboxRecipient>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      wakePumpTelemetry.recordOutcome('cancelled');
      return;
    }
    const parsedAlias = AliasSchema.safeParse(event.payload.recipient_alias);
    const key = parsedAlias.success ? sessionKey(event.tenant_id, parsedAlias.data) : '';
    const recipient = recipients.get(key);
    if (!parsedAlias.success || recipient === undefined) {
      throw new StoreError('fenced', 'wake outbox returned an event outside the requested recipient');
    }
    assertWakeClaimShape(event);
    const active = sessions.get(key);
    if (!active || active.socket.readyState !== WebSocket.OPEN
        || active.connectionToken !== recipient.connection_token
        || active.instanceId !== recipient.instance_id || active.epoch !== recipient.epoch) {
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'recipient disconnected during wake delivery',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    if (signal.aborted || active.abort.signal.aborted) {
      wakePumpTelemetry.recordOutcome('cancelled');
      return;
    }
    const renewed = await repository.renewWakeOutbox(
      wakeClaimFence(event, recipient),
      outboxLeaseMs,
      signal,
    );
    // No await is allowed between the SQL CAS and the frame. A local resume replaces `active`
    // synchronously; a remote resume rotates the same DB token and fences the later ACK.
    if (!renewed) throw new StoreError('fenced', 'wake outbox pre-send renewal was fenced');
    if (signal.aborted || active.abort.signal.aborted
        || sessions.get(key) !== active || active.socket.readyState !== WebSocket.OPEN
        || !send(active.socket, {
          type: 'wake', alias: active.alias, reason: 'delivery_available'
        })) {
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'recipient disconnected during wake delivery',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    const drained = await drain(active);
    if (!drained) {
      if (signal.aborted || active.abort.signal.aborted) {
        wakePumpTelemetry.recordOutcome('cancelled');
        return;
      }
      const result = await ackWake(
        event,
        recipient,
        'retry',
        'delivery drain did not complete',
        signal,
      );
      wakePumpTelemetry.recordOutcome(result === 'dead' ? 'dead' : 'retry');
      return;
    }
    await ackWake(event, recipient, 'sent', undefined, signal);
    wakePumpTelemetry.recordOutcome('sent');
  }

  function assertWakeClaimShape(event: OutboxLeaseEvent): void {
    const eventId = event.event_id ?? event.id;
    const attempt = event.attempt ?? event.attempts;
    const claimToken = event.claim_token;
    if (typeof eventId !== 'string' || eventId.length === 0
        || !Number.isInteger(attempt) || attempt < 1
        || typeof claimToken !== 'string' || claimToken.length === 0
        || event.claimed_by !== workerId) {
      throw new StoreError('fenced', 'wake outbox claim correlation is invalid');
    }
  }

  function wakeClaimFence(
    event: OutboxLeaseEvent,
    connection: ConnectionSessionFence,
  ): WakeOutboxClaimFence {
    assertWakeClaimShape(event);
    return {
      event_id: event.event_id ?? event.id,
      attempt: event.attempt ?? event.attempts,
      claim_token: event.claim_token,
      worker: workerId,
      connection,
    };
  }

  async function ackWake(
    event: OutboxLeaseEvent,
    connection: ConnectionSessionFence,
    status: 'sent' | 'retry',
    error: string | undefined,
    signal: AbortSignal,
  ): Promise<'sent' | 'failed' | 'dead'> {
    const fence = wakeClaimFence(event, connection);
    const result = await repository.ackOutbox({
      event_id: fence.event_id,
      attempt: fence.attempt,
      claim_token: fence.claim_token,
      connection,
      status,
      ...(error === undefined ? {} : { error }),
      ...(status === 'retry' ? { retry_after_ms: 250 } : {})
    }, signal);
    if (result.applied !== true) {
      throw new StoreError('fenced', 'wake outbox ACK was fenced');
    }
    const validStatus = result.status === 'sent' || result.status === 'failed'
      || result.status === 'dead';
    const expectedStatus = status === 'sent'
      ? result.status === 'sent'
      : result.status === 'failed' || result.status === 'dead';
    if (!validStatus || !expectedStatus) {
      throw new StoreError('fenced', 'wake outbox ACK returned an invalid terminal status');
    }
    return result.status;
  }

  const timer = setInterval(() => {
    void pumpOutbox().catch((error: unknown) => app.log.error(error));
  }, outboxPollMs);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    wakePumpTelemetry.markStopping();
    outboxPumpAbort.abort(new Error('gateway shutdown'));
    await stopDeliveryWakes();
    const closingSessions = [...sessions.values()];
    for (const session of closingSessions) {
      session.abort.abort(new Error('gateway shutdown'));
      if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
      session.socket.close(1001, 'gateway shutdown');
    }
    // This timer is diagnostic only. Shutdown never abandons an await: abortable store operations
    // destroy their dedicated backend, settle, and are then joined below.
    const warning = setTimeout(() => {
      app.log.error(new Error(
        `gateway shutdown is still waiting for cancelled work after ${outboxShutdownTimeoutMs}ms`,
      ));
    }, outboxShutdownTimeoutMs);
    warning.unref();
    try {
      while (true) {
        const pending: Promise<unknown>[] = [
          ...(outboxPumpPromise === undefined ? [] : [outboxPumpPromise]),
          ...pendingDrains,
          ...pendingSessionTasks,
        ];
        if (pending.length === 0) break;
        const settled = await Promise.allSettled(pending);
        for (const outcome of settled) {
          if (outcome.status === 'rejected' && !outboxPumpAbort.signal.aborted) {
            app.log.error(outcome.reason);
          }
        }
      }
    } finally {
      clearTimeout(warning);
    }
    sessions.clear();
  });

  return app;
}
