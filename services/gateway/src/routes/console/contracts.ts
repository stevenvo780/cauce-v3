import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ConfigMutation, Lane, Permission, ProfileRuntimeAdoptionEvidence, ProfileRuntimeContract, Tenant,
} from '@cauce/protocol';
import type {
  AuthorizedAgentTarget, DatabasePool, OperationalDlqPage, OperationalDlqResolutionRequest,
  OperationalDlqResolutionResult,
} from '@cauce/store';
import type { AuthProvider } from '../../auth.js';

export interface ConsoleRouteOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly allowedJobKinds?: readonly string[];
  readonly terminalCapability?: Readonly<Record<string, unknown>>;
}

export interface ConsoleRouteRepository {
  assertPermission(
    tenantId: Tenant,
    alias: string,
    permission: Permission,
  ): Promise<void>;
  principalAccess(
    tenantId: Tenant,
    alias: string,
  ): Promise<{
    roles: string[];
    permissions: Permission[];
  }>;
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
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
  replayDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  cancelDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
    reason?: string,
  ): Promise<Record<string, unknown>>;
  listJobs(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueJob(
    tenantId: Tenant,
    lane: Lane,
    priority: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<string>;
  listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getAgent(
    alias: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown> | undefined>;
  getAgentByIdentity?(
    tenantId: Tenant,
    alias: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown> | undefined>;
  authorizeAgentTarget?(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: 'read' | 'control',
  ): Promise<AuthorizedAgentTarget | undefined>;
  listOriginRelays(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listNotifications(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { limit?: number; before?: string | null },
  ): Promise<Record<string, unknown>>;
  agentChain(
    traceId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  applyConfigurationChange(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
  rollbackConfiguration(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
  getMessage(
    messageId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  recordProfileRuntimeExpectation?(
    tenantId: Tenant,
    alias: string,
    contract: ProfileRuntimeContract,
  ): Promise<void>;
  readProfileRuntimeAdoption?(
    tenantId: Tenant,
    alias: string,
    contract: ProfileRuntimeContract,
  ): Promise<(ProfileRuntimeAdoptionEvidence & { readonly adopted_at: string }) | undefined>;
}

export interface ConsoleRoutes {
  readonly options: ConsoleRouteOptions;
  readonly repository: ConsoleRouteRepository;
  readonly allowedJobKinds: ReadonlySet<string>;
}

export type PublishHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;
