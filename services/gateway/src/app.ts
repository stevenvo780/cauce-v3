import { randomUUID } from 'node:crypto';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type ClaimedAck, type ConfigMutation,
  type ConsolePublishIntentConfirm, type ConsolePublishIntentConfirmResult,
  type ConsolePublishIntentPrepareResult,
  type DeliveryEnvelope, type NotifyRequest,
  type OutboxAckWithConnection,
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

import { registerLegacyCandidateChainGateRoutes } from './routes/chain-gates-legado.js';

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

export type OutboxLeaseAck = OutboxAckWithConnection<ConnectionSessionFence>;

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
  principalAccess(tenantId: Tenant, alias: string): Promise<{ roles: string[]; permissions: ('route' | 'read' | 'control' | 'notify')[] }>;
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
  listPresence(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>[]>;
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
   * Lookup authorized by canonical identity. Optional only for legacy test doubles: tenant-qualified
   * routes fail closed when it is not implemented.
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
   * Optional for the same reason as `liveDeliveryClaims`: the gateway test doubles do not
   * implement the gate primitive, and without it the route returns 404 instead of breaking
   * startup. Implemented by `CauceRepository` since migration 019_delegation_discipline.
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
    options?: {
      resume?: boolean; resumeWindowMs?: number;
      requireDeclaredCapacity?: boolean; requireEnabledAgent?: boolean;
    },
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
   * Optional only for doubles in test mode. Production does not start without this read:
   * reconstructing claims is part of the reconnection fence and failing open would multiply the cap.
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
   * Total lifetime cap of an attempt. The gateway needs it because it is who WRITES the deadline
   * on each renewal: without it, `ackDelivery` would keep pushing `ack_deadline_at` 30 min forward
   * indefinitely and the cap would only exist in the reaper — i.e. a tick late, and with two rows
   * of observability written for each heartbeat of an already-hung harness.
   */
  deliveryLeaseCap?: DeliveryLeaseCap;
  /** Per-session admission control. See `DeliveryAdmissionConfig` and `drain()`. */
  admission?: DeliveryAdmissionConfig;
  outboxPollMs?: number;
  outboxLeaseMs?: number;
  /** Maximum recipients whose wake claims may be in I/O simultaneously. */
  outboxWakeConcurrency?: number;
  /** Maximum wait for shutdown by an unresponsive pump; afterwards it continues aborted. */
  outboxShutdownTimeoutMs?: number;
  /** Identity-free accumulator that the process can later connect to its metrics endpoint. */
  wakePumpTelemetry?: WakePumpTelemetry;
  /** Aggregated results, identity-free, from the durable console-publish journal. */
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

// Matches the historical QueryDeliveriesSchema default while keeping the claim limit local.
const DEFAULT_DELIVERY_CLAIM_LIMIT = 20;
const DEFAULT_WAKE_PUMP_CONCURRENCY = 4;
const DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS = 1_000;


export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JavaScript callers can omit a required TypeScript option.
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
  // Upper bound of a drain. It used to be `undefined` and fall back to the default 20 from
  // QueryDeliveriesSchema — a 20 nobody chose for this path and nobody could see by reading the
  // gateway. The real per-agent cap lives in agents.max_concurrent_deliveries and is enforced by
  // claimDeliveries; this is only the maximum batch size for an agent without a declared cap.
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
