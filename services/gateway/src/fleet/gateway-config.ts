import { normalize } from 'node:path';
import { z } from 'zod';
import type { FleetCapability, FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { assertFleetPlacement, assertFleetProviderAccount } from '../console/fleet-capability.js';
import { readPrivateJson } from './provider-login.js';
import { HostProviderAuthService } from './auth-bridge-client.js';
import { createFleetProviderAuthRouter } from './auth-router.js';
import type { ProviderAuthService } from '../console/provider-auth.types.js';
import { HostLegacyAdoptionProbe } from './adoption-bridge-client.js';
import { createLegacyFleetAdoptionService } from './adoption.js';

const Path = z.string().refine(value => value.startsWith('/') && normalize(value) === value && !/[\p{Cc}]/u.test(value));
const Host = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const SocketPolicy = z.object({ ownerUid: z.number().int().nonnegative(), groupGid: z.number().int().nonnegative().optional() }).strict();
const ApiConfig = z.object({ version: z.literal(1), controller_host: Host,
  hosts: z.array(z.object({ host_id: Host, socket_path: Path,
    socket_policy: SocketPolicy.optional(),
  }).strict()).min(1).max(100),
  legacy_adoption: z.object({ socket_path: Path, socket_policy: SocketPolicy }).strict().optional(),
}).strict().refine(value => new Set(value.hosts.map(host => host.host_id)).size === value.hosts.length
  && new Set(value.hosts.map(host => host.socket_path)).size === value.hosts.length
  && value.hosts.some(host => host.host_id === value.controller_host)
  && (value.legacy_adoption === undefined || !value.hosts.some(host => host.socket_path === value.legacy_adoption?.socket_path)));
export async function configuredFleetGateway(pool: DatabasePool, capability: FleetCapability, environment: NodeJS.ProcessEnv = process.env) {
  const config = environment.CAUCE_FLEET_API_CONFIG_FILE === undefined ? undefined
    : ApiConfig.parse(await readPrivateJson(environment.CAUCE_FLEET_API_CONFIG_FILE));
  if (config && (!capability.available || config.controller_host !== environment.CAUCE_FLEET_CONTROLLER_HOST
    || capability.placements.some(host => !config.hosts.some(registered => registered.host_id === host.host_id)))) {
    throw new Error('Fleet API and controller host catalogs differ');
  }
  const providerAuthService: ProviderAuthService | undefined = config === undefined
    ? environment.CAUCE_FLEET_API_SOCKET === undefined ? undefined : new HostProviderAuthService(environment.CAUCE_FLEET_API_SOCKET)
    : createFleetProviderAuthRouter(pool, { hosts: config.hosts.map(host => ({ host_id: host.host_id, socket_path: host.socket_path,
      ...(host.socket_policy === undefined ? {} : { socket_policy: { ownerUid: host.socket_policy.ownerUid,
        ...(host.socket_policy.groupGid === undefined ? {} : { groupGid: host.socket_policy.groupGid }) } }) })) });
  const repository = !capability.available ? undefined : new FleetOperationsRepository(pool, {
    ...(environment.CAUCE_FLEET_CONTROLLER_HOST === undefined ? {} : { controllerHost: environment.CAUCE_FLEET_CONTROLLER_HOST }),
    ...(config === undefined ? {} : { coordinatorEnabled: true, coordinatorHosts: config.hosts.map(host => host.host_id) }),
  });
  const binding = repository === undefined ? undefined : {
    list: repository.list.bind(repository), get: repository.get.bind(repository),
    cancel: repository.cancel.bind(repository), resume: repository.resume.bind(repository),
    preview: async (tenant: string, alias: string, input: FleetOperationRequest, subject?: string) => {
      assertFleetPlacement(capability, input); await assertFleetProviderAccount(pool, capability, input);
      return repository.preview(tenant, alias, input, subject);
    },
    enqueue: async (tenant: string, alias: string, input: FleetOperationRequest, subject?: string) => {
      assertFleetPlacement(capability, input); await assertFleetProviderAccount(pool, capability, input);
      return repository.enqueue(tenant, alias, input, subject);
    },
  };
  const legacyFleetAdoptionService = config?.legacy_adoption === undefined ? undefined
    : createLegacyFleetAdoptionService(pool, new HostLegacyAdoptionProbe(config.legacy_adoption.socket_path,
      { ownerUid: config.legacy_adoption.socket_policy.ownerUid,
        ...(config.legacy_adoption.socket_policy.groupGid === undefined ? {} : { groupGid: config.legacy_adoption.socket_policy.groupGid }) }));
  return { ...(providerAuthService === undefined ? {} : { providerAuthService }),
    ...(legacyFleetAdoptionService === undefined ? {} : { legacyFleetAdoptionService }),
    ...(binding === undefined ? {} : { fleetOperationsRepository: binding, fleetCapability: capability }) };
}
