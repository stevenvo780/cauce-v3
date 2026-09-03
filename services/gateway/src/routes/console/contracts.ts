import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import type { GatewayRepository } from '../../app.js';
import type { AuthProvider } from '../../auth.js';
import type { OperatorResolution } from '../../terminal/authority.js';

export interface ConsoleRouteOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly allowedJobKinds?: readonly string[];
  readonly terminalCapability?: Readonly<Record<string, unknown>>;
  /** Enrolment the PTY plane resolves people with; absent, only a server-verified operator_id attributes. */
  readonly operatorResolution?: OperatorResolution;
}

export type ConsoleRouteRepository = Pick<GatewayRepository,
  'agentChain' | 'applyConfigurationChange' | 'assertPermission' | 'authorizeAgentTarget'
  | 'cancelDelivery' | 'enqueueJob' | 'fleetActivity' | 'getAgent' | 'getAgentByIdentity'
  | 'getConfiguration' | 'getMessage' | 'listAdapters' | 'listAgents' | 'listAudit' | 'listJobs'
  | 'listMessages' | 'listNotifications' | 'listOperationalDlq' | 'listOriginRelays'
  | 'principalAccess' | 'queueSnapshot' | 'quotaSnapshot' | 'readProfileRuntimeAdoption'
  | 'recordProfileRuntimeExpectation' | 'replayDelivery' | 'resolveOperationalDlqWithoutReplay'
  | 'rollbackConfiguration' | 'status' | 'topology'
>;

export interface ConsoleRoutes {
  readonly options: ConsoleRouteOptions;
  readonly repository: ConsoleRouteRepository;
  readonly allowedJobKinds: ReadonlySet<string>;
}

export type PublishHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;
