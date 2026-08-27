import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type ClaimedAck, type ConfigMutation,
  type ConsolePublishIntentConfirm, type ConsolePublishIntentConfirmResult,
  type ConsolePublishIntentPrepareResult,
  type DeliveryEnvelope, type NotifyRequest,
  type ProfileRuntimeAdoptionEvidence, type ProfileRuntimeContract,
  type QuotaSampleRequest, type Tenant,
} from '@cauce/protocol';
import {
  CauceRepository, type subscribeDeliveryWakes,
  type AccountSelection, type AckResult, type DatabasePool, type DeliveryLeaseCap,
  type ConnectionSessionFence, type FencedWakeOutboxRecipient, type LeaseResult,
  type NotificationVerdict, type OperationalDlqPage, type OperationalDlqResolutionRequest,
  type OperationalDlqResolutionResult, type OutboxEvent, type PublishResult,
  type QuotaSampleIngestResult, type WakeOutboxClaimFence,
} from '@cauce/store';
import type { AuthProvider } from './auth.js';
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
  type TrustedPublishCommand, type TrustedPublishIntentCommand,
} from './routes/shared.js';
import {
  createConsoleRoutes,
  registerConsoleRoutesPhase1,
  registerConsoleRoutesPhase2,
  registerConsoleRoutesPhase3,
  registerConsoleRoutesPhase4,
} from './routes/console.js';
import { createCoreRoutePhases } from './routes/core.js';
import { registerConsolePublishIntentRoutes } from './routes/console-publish.js';
import { registerGatewayHealthRoutes } from './routes/health.js';

import { registerLegacyCandidateChainGateRoutes } from './routes/legado-candidato.js';

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
  enableLegacyCandidateRoutes?: boolean;
  logger?: boolean;
}

// Lote máximo por drain. Deliberadamente igual al default histórico de QueryDeliveriesSchema para
// que este cambio no altere por sí solo cuánto se reclama: lo que cambia es que ahora el número
// está escrito donde se usa en vez de heredarse en silencio del esquema de un endpoint HTTP.
const DEFAULT_DELIVERY_CLAIM_LIMIT = 20;
const DEFAULT_WAKE_PUMP_CONCURRENCY = 4;
const DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS = 1_000;


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
  const enableLegacyCandidateRoutes = options.enableLegacyCandidateRoutes !== false;
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
  const consoleRoutes = createConsoleRoutes(options, repository);

  const coreRoutes = createCoreRoutePhases(app, options, repository, {
    ackDeadlineMs,
    deliveryLeaseCap,
    admission,
    maxQueryLimit,
    leaseTtlMs,
    outboxPollMs,
    outboxLeaseMs,
    outboxWakeConcurrency,
    outboxShutdownTimeoutMs,
    wakePumpTelemetry,
    consolePublishTelemetry,
    deliveryClaimLimit,
    workerId,
  });

  await app.register(websocket);
  app.addHook('onRequest', createConsoleSecurityHook({
    ...(options.consoleOrigins === undefined ? {} : { allowedOrigins: options.consoleOrigins })
  }));
  if (options.authProvider instanceof OidcBffAuthProvider) registerOidcBff(app, options.authProvider);
  if (options.authProvider instanceof PasswordAuthProvider) registerPasswordAuth(app, options.authProvider);
  registerGatewayHealthRoutes(app, options, repository);

  registerConsoleRoutesPhase1(app, consoleRoutes);

  const publishHandler = coreRoutes.registerPublishRoutes();

  registerConsoleRoutesPhase2(app, consoleRoutes);

  registerConsolePublishIntentRoutes(
    app, options, repository, consolePublishTelemetry,
  );

  const agentProfiles = registerConsoleRoutesPhase3(
    app, consoleRoutes, publishHandler,
  );

  if (enableLegacyCandidateRoutes) {
    registerLegacyCandidateChainGateRoutes(app, options, repository);
  }

  registerConsoleRoutesPhase4(app, consoleRoutes);

  await coreRoutes.registerRuntimeRoutes(agentProfiles);

  return app;
}
