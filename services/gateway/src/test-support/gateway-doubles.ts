import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import type { RawData, WebSocket } from 'ws';
import type { DatabasePool, OperationalDlqResolutionRequest } from '@cauce/store';
import { buildPublishReceipt, type ConfigMutation, type Tenant } from '@cauce/protocol';
import {
  buildGateway,
  type GatewayOptions, type GatewayRepository, type OutboxLeaseAck,
} from '../app.js';
import { DevOnlyAuthProvider, type AuthProvider, type Principal } from '../auth.js';

export const ids = {
  message: '10000000-0000-4000-8000-000000000001',
  delivery: '20000000-0000-4000-8000-000000000001',
  deliveryTwo: '20000000-0000-4000-8000-000000000002',
  request: '30000000-0000-4000-8000-000000000001',
  claim: '40000000-0000-4000-8000-000000000001',
  claimTwo: '40000000-0000-4000-8000-000000000002',
  event: '50000000-0000-4000-8000-000000000001',
  eventTwo: '50000000-0000-4000-8000-000000000002',
  notification: '60000000-0000-4000-8000-000000000001',
  outbox: '70000000-0000-4000-8000-000000000001'
} as const;

export function testPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Pablo',
    alias: 'midas',
    session_id: 'verified-session',
    channel: 'verified-channel',
    roles: ['agent'],
    permissions: ['route', 'read'],
    origin: {
      adapter: 'verified-adapter',
      channel: 'verified-channel',
      conversation_id: 'verified-conversation',
      relay: [],
      metadata: {}
    },
    ...overrides
  };
}

export class FixedAuthProvider implements AuthProvider {
  readonly name = 'fixed-test';
  readonly mode = 'test' as const;

  constructor(private readonly principal: Principal) {}

  async authenticateHttp(): Promise<Principal> {
    return this.principal;
  }

  async authenticateHello(): Promise<Principal> {
    return this.principal;
  }
}

export function fakePool(row: Record<string, unknown> = { '?column?': 1 }): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) } as unknown as DatabasePool;
}

export const noDeliveryWakes: NonNullable<GatewayOptions['deliveryWakeSubscriber']> = async () => async () => undefined;

/**
 * Property names that value printers, promise unwrapping and matchers probe on any object. They
 * are not repository members, so reading them must not be mistaken for a missing stub.
 */
const NON_MEMBER_PROBES = new Set([
  '$$typeof', 'asymmetricMatch', 'constructor', 'inspect', 'nodeType',
  'tagName', 'then', 'toJSON', 'toString', 'valueOf',
]);

function failOnMissingMember(stubs: GatewayRepository): GatewayRepository {
  return new Proxy(stubs, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target) && !NON_MEMBER_PROBES.has(property)) {
        throw new Error(`gateway test double has no ${property}`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Every member the contract declares, so a route that reaches an unstubbed one fails loudly
 * instead of reading `undefined` and taking a degraded branch nobody wrote a test for. Suite
 * specifics go through `overrides`: spreading the result instead would copy own properties onto a
 * plain object and drop the trap that makes the gap loud.
 */
export function fakeRepository(overrides: Partial<GatewayRepository> = {}): GatewayRepository {
  return failOnMissingMember({
    publish: vi.fn(async (input: Parameters<GatewayRepository['publish']>[0]) => buildPublishReceipt(
      input,
      {
        message_id: ids.message,
        delivery_ids: [ids.delivery],
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id,
      },
    )),
    prepareConsolePublishIntent: vi.fn(async () => ({
      version: 1 as const,
      state: 'prepared' as const,
      idempotency_key: 'console:test-intent',
      receipt: null,
    })),
    confirmConsolePublishIntent: vi.fn(async (
      _tenantId: Tenant,
      _actorAlias: string,
      _operatorScopeHash: string,
      input: Parameters<NonNullable<GatewayRepository['confirmConsolePublishIntent']>>[3],
    ) => ({
      version: 1 as const,
      confirmed: true as const,
      idempotency_key: input.idempotency_key,
      message_id: input.message_id,
      causal_hash: input.causal_hash,
    })),
    verifyPublishReceipt: vi.fn(async (
      _input: Parameters<GatewayRepository['verifyPublishReceipt']>[0],
      receipt: Parameters<GatewayRepository['verifyPublishReceipt']>[1],
    ) => (
      receipt.message_id === ids.message
      && receipt.delivery_ids.length === 1
      && receipt.delivery_ids[0] === ids.delivery
    )),
    assertPrincipal: vi.fn(async () => undefined),
    assertPermission: vi.fn(async () => undefined),
    principalAccess: vi.fn(async () => ({
      roles: ['operator'], permissions: ['route', 'read', 'control'] as ('route' | 'read' | 'control')[]
    })),
    status: vi.fn(async () => ({ online: 0, queued: 0, dead_letters: 0, outbox_pending: 0 })),
    listPresence: vi.fn(async () => []),
    topology: vi.fn(async () => ({ tenants: [], acl_edges: [] })),
    listMessages: vi.fn(async () => ({ items: [], next_cursor: null })),
    queueSnapshot: vi.fn(async () => ({ pending: 0, retrying: 0, dead: 0, items: [] })),
    listOperationalDlq: vi.fn(async () => ({
      schemaVersion: 1 as const,
      items: [],
      total: 0,
      truncated: false,
      nextCursor: null,
    })),
    resolveOperationalDlqWithoutReplay: vi.fn(async (
      _actorTenant: Tenant,
      _actorAlias: string,
      request: OperationalDlqResolutionRequest,
    ) => ({
      schemaVersion: 1 as const,
      suite: 'cauce-v3-dlq-no-replay-resolution' as const,
      phase: 'resolved' as const,
      appliedCount: 1,
      alreadyApplied: false,
      evidenceSha256: request.evidenceSha256,
      reasonSha256: '0'.repeat(64),
      possibleDuplicateAcknowledged: request.possibleDuplicateAcknowledged,
      possibleNoDeliveryAcknowledged: request.possibleNoDeliveryAcknowledged,
    })),
    replayDelivery: vi.fn(async (deliveryId: string) => ({
      delivery_id: ids.deliveryTwo,
      replayed_from_delivery_id: deliveryId,
      state: 'pending',
      replayed: true
    })),
    cancelDelivery: vi.fn(async (deliveryId: string) => ({
      delivery_id: deliveryId,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: true,
      replayable: true
    })),
    listJobs: vi.fn(async () => ({ items: [] })),
    enqueueJob: vi.fn(async () => 'job-1'),
    listAdapters: vi.fn(async () => ({ items: [] })),
    listAgents: vi.fn(async () => ({ items: [] })),
    getAgent: vi.fn(async () => undefined),
    getAgentByIdentity: vi.fn(async () => undefined),
    /** Mirrors the same-tenant reach the routes grant; a foreign tenant stays invisible. */
    authorizeAgentTarget: vi.fn(async (
      actorTenant: Tenant,
      _actorAlias: string,
      targetTenant: Tenant,
      targetAlias: string,
    ) => (targetTenant === actorTenant
      ? {
          tenant_id: targetTenant,
          alias: targetAlias,
          harness_id: null,
          home_directory: null,
          enabled: true,
        }
      : undefined)),
    listOriginRelays: vi.fn(async () => ({ items: [] })),
    enqueueNotification: vi.fn(async () => ({
      notification_id: ids.notification,
      decision: 'allowed' as const,
      message_id: ids.message,
      outbox_id: ids.outbox,
      duplicate: false,
      dry_run: false
    })),
    listNotifications: vi.fn(async () => ({ items: [] })),
    listAudit: vi.fn(async () => ({ items: [] })),
    agentChain: vi.fn(async (traceId: string) => ({
      trace_id: traceId, nodes: [], edges: [], origin_relays: []
    })),
    listChainGates: vi.fn(async () => ({ items: [] })),
    answerChainGate: vi.fn(async (gateId: string) => ({ gate_id: gateId, answered: true })),
    cancelChainGate: vi.fn(async (gateId: string) => ({ gate_id: gateId, cancelled: true })),
    fleetActivity: vi.fn(async () => ({
      observed_at: new Date().toISOString(),
      thresholds: {
        saturation_in_flight: 8, stall_after_seconds: 300, ack_recent_seconds: 300,
        ack_lookback_seconds: 3600, items_per_agent: 10
      },
      totals: {
        agents: 0, in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0,
        by_state: { idle: 0, queued: 0, working: 0, saturated: 0, stalled: 0 },
        flagged: {
          saturated: 0, ack_stalled: 0, overdue_acks: 0, lease_expired: 0,
          never_connected: 0, unregistered: 0, queued_without_consumer: 0
        }
      },
      agents: []
    })),
    quotaSnapshot: vi.fn(async () => ({
      observed_at: new Date().toISOString(),
      thresholds: {
        stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10,
        history_window_seconds: 86400, history_bucket_seconds: 1800, history_max_points: 48
      },
      collectors: [], providers: [], unbound_groups: [], paused_accounts: []
    })),
    recordQuotaSample: vi.fn(async () => ({
      collection_id: '80000000-0000-4000-8000-000000000001',
      host: 'kratos', captured_at: new Date().toISOString(), duplicate: false,
      accepted_providers: 0, accepted_windows: 0,
      unbound_groups: [], paused_accounts: [], resumed_accounts: [], pruned_collections: 0
    })),
    selectAccount: vi.fn(async (tenant: Tenant, alias: string, provider: string) => ({
      tenant_id: tenant, alias, provider, observed_at: new Date().toISOString(),
      selected: null, candidates: [], failover: false, auto_paused: []
    })),
    getConfiguration: vi.fn(async () => ({ revision: 0, tenants: [], rooms: [], memberships: [], acl_edges: [] })),
    applyConfigurationChange: vi.fn(async (
      _tenant: Tenant, _alias: string, mutation: ConfigMutation, dryRun: boolean
    ) => ({
      applied: !dryRun, dry_run: dryRun, revision: dryRun ? 0 : 1,
      rolled_back_revision_id: null,
      summary: 'test configuration change', mutation, inverse_mutation: mutation,
    })),
    rollbackConfiguration: vi.fn(async (
      _tenant: Tenant, _alias: string, revisionId: number, dryRun: boolean
    ) => {
      const mutation: ConfigMutation = {
        resource: 'tenant', action: 'update', id: 'Pablo', value: { enabled: true },
      };
      return {
        applied: !dryRun, dry_run: dryRun, revision: revisionId,
        rolled_back_revision_id: revisionId,
        summary: `rollback ${String(revisionId)}`, mutation, inverse_mutation: mutation,
      };
    }),
    getMessage: vi.fn(async () => ({
      id: ids.message,
      tenant_id: 'Pablo',
      actor_alias: 'midas',
      deliveries: []
    })),
    recordProfileRuntimeExpectation: vi.fn(async () => undefined),
    readProfileRuntimeAdoption: vi.fn(async () => undefined),
    acquireLease: vi.fn(async () => ({
      acquired: true,
      epoch: 1,
      connection_token: randomUUID(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString()
    })),
    heartbeat: vi.fn(async () => new Date(Date.now() + 60_000).toISOString()),
    releaseLease: vi.fn(async () => true),
    claimDeliveries: vi.fn(async () => []),
    liveDeliveryClaims: vi.fn(async () => []),
    ackDelivery: vi.fn(async (deliveryId: string) => ({
      delivery_id: deliveryId,
      status: 'done' as const,
      applied: true,
      receipt: 'applied' as const,
    })),
    claimOutbox: vi.fn(async () => []),
    claimWakeOutbox: vi.fn(async () => []),
    renewWakeOutbox: vi.fn(async () => true),
    ackOutbox: vi.fn(async (ack: OutboxLeaseAck) => ({
      status: ack.status === 'sent' ? 'sent' as const : 'failed' as const,
      applied: true,
    })),
    ...overrides,
  });
}

/** The option block every colocated gateway suite repeats; overrides win over each default. */
export async function buildTestGateway(
  overrides: Partial<GatewayOptions> = {},
): Promise<FastifyInstance> {
  return buildGateway({
    pool: fakePool(),
    authProvider: DevOnlyAuthProvider.forTests(),
    repository: fakeRepository(),
    deliveryWakeSubscriber: noDeliveryWakes,
    exposeHealthRoutes: false,
    consoleOrigins: ['http://localhost'],
    logger: false,
    ...overrides,
  });
}

export function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Reads decoded frames in order; `sink` collects every frame for suites that assert on history. */
export function frameReader(
  socket: WebSocket,
  sink?: Record<string, unknown>[],
): () => Promise<Record<string, unknown>> {
  const queued: Record<string, unknown>[] = [];
  const waiting: ((value: Record<string, unknown>) => void)[] = [];
  socket.on('message', (data: RawData) => {
    const decoded = JSON.parse(text(data)) as Record<string, unknown>;
    sink?.push(decoded);
    const resolve = waiting.shift();
    if (resolve) resolve(decoded);
    else queued.push(decoded);
  });
  return async () => {
    const existing = queued.shift();
    if (existing) return existing;
    return new Promise((resolve) => waiting.push(resolve));
  };
}
