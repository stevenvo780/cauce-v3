import { vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import type { ConfigMutation, Tenant } from '@cauce/protocol';
import type {
  AuthProvider, GatewayOptions, GatewayRepository, Principal, PrincipalPermission, PrincipalRole
} from '../../services/gateway/src/index.js';

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

export function fakePool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })) } as unknown as DatabasePool;
}

export const noDeliveryWakes: NonNullable<GatewayOptions['deliveryWakeSubscriber']> = async () => async () => undefined;

export function fakeRepository(): GatewayRepository {
  return {
    publish: vi.fn(async () => ({
      message_id: ids.message,
      delivery_ids: [ids.delivery],
      duplicate: false,
      request_id: ids.request,
      trace_id: 'trace-test'
    })),
    assertPrincipal: vi.fn(async () => undefined),
    assertPermission: vi.fn(async () => undefined),
    principalAccess: vi.fn(async () => ({
      roles: ['operator'], permissions: ['route', 'read', 'control'] as Array<'route' | 'read' | 'control'>
    })),
    status: vi.fn(async () => ({ online: 0, queued: 0, dead_letters: 0, outbox_pending: 0 })),
    listPresence: vi.fn(async () => []),
    topology: vi.fn(async () => ({ tenants: [], acl_edges: [] })),
    listMessages: vi.fn(async () => ({ items: [], next_cursor: null })),
    queueSnapshot: vi.fn(async () => ({ pending: 0, retrying: 0, dead: 0, items: [] })),
    replayDelivery: vi.fn(async (deliveryId: string) => ({
      delivery_id: ids.deliveryTwo,
      replayed_from_delivery_id: deliveryId,
      state: 'pending',
      replayed: true
    })),
    listJobs: vi.fn(async () => ({ items: [] })),
    enqueueJob: vi.fn(async () => 'job-1'),
    listAdapters: vi.fn(async () => ({ items: [] })),
    listAgents: vi.fn(async () => ({ items: [] })),
    getAgent: vi.fn(async () => undefined),
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
    getConfiguration: vi.fn(async () => ({ revision: 0, tenants: [], rooms: [], memberships: [], acl_edges: [] })),
    applyConfigurationChange: vi.fn(async (
      _tenant: Tenant, _alias: string, mutation: ConfigMutation, dryRun: boolean
    ) => ({
      applied: !dryRun, dry_run: dryRun, revision: dryRun ? 0 : 1, mutation
    })),
    rollbackConfiguration: vi.fn(async (
      _tenant: Tenant, _alias: string, revisionId: number, dryRun: boolean
    ) => ({
      applied: !dryRun, dry_run: dryRun, revision: revisionId
    })),
    getMessage: vi.fn(async () => ({
      id: ids.message,
      tenant_id: 'Pablo',
      actor_alias: 'midas',
      deliveries: []
    })),
    acquireLease: vi.fn(async () => ({
      acquired: true,
      epoch: 1,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString()
    })),
    heartbeat: vi.fn(async () => new Date(Date.now() + 60_000).toISOString()),
    releaseLease: vi.fn(async () => undefined),
    claimDeliveries: vi.fn(async () => []),
    ackDelivery: vi.fn(async (deliveryId: string) => ({
      delivery_id: deliveryId,
      status: 'done' as const,
      applied: true,
      receipt: 'applied' as const,
    })),
    claimOutbox: vi.fn(async () => []),
    completeOutbox: vi.fn(async () => true),
    retryOutbox: vi.fn(async () => 'retry' as const)
  };
}

export function roles(...values: PrincipalRole[]): readonly PrincipalRole[] {
  return values;
}

export function grants(...values: PrincipalPermission[]): readonly PrincipalPermission[] {
  return values;
}
