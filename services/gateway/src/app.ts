import { randomUUID } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type ClaimedAck, type ConfigMutation, type ConsolePublishIntentPrepareResult,
  type DeliveryEnvelope, type OutboxAckWithConnection, type Tenant,
} from '@cauce/protocol';
import {
  CauceRepository, type subscribeDeliveryWakes,
  type ConnectionSessionFence, type DatabasePool, type DeliveryLeaseCap,
  type FencedWakeOutboxRecipient, type LeaseResult, type OutboxEvent,
  type PublishOptions, type PublishResult,
} from '@cauce/store';
import type { AuthProvider } from './auth.js';
import { createConsoleSecurityHook } from './console-security.js';
import { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import {
  configuredLeaseTtlMs,
  DEFAULT_ACK_DEADLINE_MS, DEFAULT_HUMAN_RESERVED_DELIVERIES, DEFAULT_MAX_INFLIGHT_DELIVERIES,
  validateAckDeadlineMs, validateDeliveryAdmission, type DeliveryAdmissionConfig
} from './config.js';
import { OidcBffAuthProvider, registerOidcBff } from './oidc-bff.js';
import { PasswordAuthProvider, registerPasswordAuth } from './password-auth.js';
import { WakePumpTelemetry } from './wake-pump-telemetry.js';
import {
  type TrustedPublishCommand, type TrustedPublishIntentCommand,
} from './routes/shared.js';
import { createConsoleRoutes, registerConsoleRoutes } from './routes/console.js';
import type { OperatorResolution } from './terminal/authority.js';
import { createCoreRoutePhases } from './routes/core.js';
import { registerConsolePublishIntentRoutes } from './routes/console-publish.js';
import { registerGatewayHealthRoutes } from './routes/health.js';
import { registerChainGateRoutes } from './routes/chain-gates.js';
import { prepareBlobDirectory, registerBlobRoutes, type BlobStoreOptions } from './routes/blobs.js';

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

/** Members the gateway consumes with the store's own signature. */
type StoreDerivedRepository = Pick<CauceRepository,
  'ackDelivery' | 'agentChain' | 'answerChainGate' | 'registerBlob' | 'findBlob'
  | 'assertPermission' | 'assertPrincipal' | 'authorizeAgentTarget' | 'cancelChainGate'
  | 'cancelDelivery' | 'confirmConsolePublishIntent' | 'enqueueJob' | 'enqueueNotification'
  | 'fleetActivity' | 'getAgent' | 'getAgentByIdentity' | 'getConfiguration' | 'getMessage'
  | 'listAdapters' | 'listAgents' | 'listAudit' | 'listChainGates' | 'listJobs' | 'listMessages'
  | 'listNotifications' | 'listOperationalDlq' | 'listOriginRelays' | 'liveDeliveryClaims'
  | 'principalAccess' | 'queueSnapshot' | 'quotaSnapshot' | 'readProfileRuntimeAdoption'
  | 'recordProfileRuntimeExpectation' | 'recordQuotaSample' | 'renewWakeOutbox' | 'replayDelivery'
  | 'resolveOperationalDlqWithoutReplay' | 'selectAccount' | 'topology'
>;

/** Narrowed on purpose: deriving these widens an authenticated, actor-scoped or fenced signature. */
interface GatewayNarrowedRepository {
  publish(input: TrustedPublishCommand, options?: PublishOptions): Promise<PublishResult>;
  prepareConsolePublishIntent(
    input: TrustedPublishIntentCommand,
    operatorScopeHash: string,
  ): Promise<ConsolePublishIntentPrepareResult>;
  /** Independent durable reconciliation; receipt-contained hashes are not an authority for IDs. */
  verifyPublishReceipt(input: TrustedPublishCommand, receipt: PublishResult): Promise<boolean>;
  /** The actor is mandatory: the store skips its permission check when both arguments are absent. */
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
  listPresence(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>[]>;
  /** No `takeover`: a console or adapter call must never fence a live consumer of the same alias. */
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
  claimOutbox(kind: 'wake', worker: string, limit?: number, leaseMs?: number): Promise<OutboxLeaseEvent[]>;
  claimWakeOutbox(
    worker: string,
    recipients: readonly FencedWakeOutboxRecipient[],
    limit?: number,
    leaseMs?: number,
    signal?: AbortSignal,
  ): Promise<OutboxLeaseEvent[]>;
  ackOutbox(ack: OutboxLeaseAck, signal?: AbortSignal): Promise<OutboxLeaseAckResult>;
  /** The receipt stays `unknown`: the route re-validates it field by field before answering. */
  applyConfigurationChange(
    actorTenant: Tenant, actorAlias: string, mutation: ConfigMutation, dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
  rollbackConfiguration(
    actorTenant: Tenant, actorAlias: string, revisionId: number, dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
}

/** Contract implemented by the hardened store; current method names remain stable. */
export type GatewayRepository = StoreDerivedRepository & GatewayNarrowedRepository;

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
  operatorResolution?: OperatorResolution;
  https?: HttpsServerOptions;
  exposeHealthRoutes?: boolean;
  logger?: boolean;
  blobs?: BlobStoreOptions;
}

// Matches the historical QueryDeliveriesSchema default while keeping the claim limit local.
const DEFAULT_DELIVERY_CLAIM_LIMIT = 20;
const DEFAULT_WAKE_PUMP_CONCURRENCY = 4;
const DEFAULT_OUTBOX_SHUTDOWN_TIMEOUT_MS = 1_000;
const GATEWAY_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Fail-closed reads a JavaScript caller can still omit; without them the delivery cap multiplies. */
const REQUIRED_REPOSITORY_METHODS = ['liveDeliveryClaims'] as const;


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
  if (options.authProvider.mode === 'production') {
    const members = repository as unknown as Record<string, unknown>;
    for (const name of REQUIRED_REPOSITORY_METHODS) {
      if (typeof members[name] !== 'function') {
        throw new Error('production gateway requires durable live-delivery claim recovery');
      }
    }
  }
  const leaseTtlMs = options.leaseTtlMs ?? configuredLeaseTtlMs();
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

  await app.register(websocket, { options: { maxPayload: GATEWAY_WS_MAX_PAYLOAD_BYTES } });
  app.addHook('onRequest', createConsoleSecurityHook({
    ...(options.consoleOrigins === undefined ? {} : { allowedOrigins: options.consoleOrigins })
  }));
  if (options.authProvider instanceof OidcBffAuthProvider) registerOidcBff(app, options.authProvider);
  if (options.authProvider instanceof PasswordAuthProvider) registerPasswordAuth(app, options.authProvider);
  registerGatewayHealthRoutes(app, options, repository);

  const publishHandler = coreRoutes.registerPublishRoutes();

  const agentProfiles = registerConsoleRoutes(app, consoleRoutes, publishHandler);

  registerConsolePublishIntentRoutes(
    app, options, repository, consolePublishTelemetry,
  );

  registerChainGateRoutes(app, options, repository);
  if (options.blobs !== undefined) {
    await prepareBlobDirectory(options.blobs);
    registerBlobRoutes(app, options, repository, options.blobs);
  }

  await coreRoutes.registerRuntimeRoutes(agentProfiles);

  return app;
}
