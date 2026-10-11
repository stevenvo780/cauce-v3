import { normalize } from 'node:path';
import { z } from 'zod';
import type { FleetCapability, FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationError, FleetOperationsRepository, assertFleetAuthority, fleetHostAvailability, withTransaction, type CompanyAuthoritySource, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { assertFleetPlacement, assertFleetProviderAccount } from '../console/fleet-capability.js';
import { readPrivateJson } from './provider-login.js';
import { HostProviderAuthService } from './auth-bridge-client.js';
import { createFleetProviderAuthRouter } from './auth-router.js';
import type { ProviderAuthService } from '../console/provider-auth.types.js';
import { HostLegacyAdoptionProbe } from './adoption-bridge-client.js';
import { createLegacyFleetAdoptionService } from './adoption.js';
import type { HostCapabilityRegistry } from './host-channel.capabilities.js';
import type { FleetOperationsRepositoryBinding } from '../console/fleet-operations.routes.js';

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

async function fleetApiConfiguration(environment: NodeJS.ProcessEnv): Promise<z.infer<typeof ApiConfig> | undefined> {
  const config = environment.CAUCE_FLEET_API_CONFIG_FILE === undefined ? undefined
    : ApiConfig.parse(await readPrivateJson(environment.CAUCE_FLEET_API_CONFIG_FILE));
  if (config !== undefined && config.controller_host !== environment.CAUCE_FLEET_CONTROLLER_HOST) {
    throw new Error('Fleet API and controller host catalogs differ');
  }
  return config;
}
function fleetRepository(pool: DatabasePool, environment: NodeJS.ProcessEnv, config: z.infer<typeof ApiConfig> | undefined): FleetOperationsRepository {
  return new FleetOperationsRepository(pool, {
    ...(environment.CAUCE_FLEET_CONTROLLER_HOST === undefined ? {} : { controllerHost: environment.CAUCE_FLEET_CONTROLLER_HOST }),
    ...(config === undefined ? {} : { coordinatorEnabled: true, coordinatorHosts: config.hosts.map(host => host.host_id) }),
  });
}
export async function configuredFleetRepository(pool: DatabasePool, environment: NodeJS.ProcessEnv = process.env): Promise<FleetOperationsRepository> {
  return fleetRepository(pool, environment, await fleetApiConfiguration(environment));
}
export class FleetHostUnavailableError extends Error {
  readonly code = 'host_unavailable';
  readonly statusCode = 409;

  constructor(readonly hostId: string) {
    super(`La computadora ${hostId} está deshabilitada o sin conexión; sus agentes no se pueden operar hasta que vuelva.`);
    this.name = 'FleetHostUnavailableError';
  }
}

async function assertFleetHostOperable(pool: DatabasePool, request: FleetOperationRequest): Promise<void> {
  if (request.kind !== 'create' && request.kind !== 'update' && request.kind !== 'start') return;
  const hostId = request.kind === 'start' ? await placedHostId(pool, request.target) : request.parameters.placement.host_id;
  if (hostId === null) return;
  if (!(await fleetHostAvailability(pool, hostId)).usable) throw new FleetHostUnavailableError(hostId);
}

async function placedHostId(pool: DatabasePool | DatabaseClient, target: { tenant_id: string; alias: string }): Promise<string | null> {
  const result = await pool.query<{ host_id: string | null }>(
    'SELECT host_id FROM agents WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL FOR SHARE', [target.tenant_id, target.alias]);
  return result.rows[0]?.host_id ?? null;
}

export async function configuredFleetGateway(pool: DatabasePool, capability: FleetCapability, environment: NodeJS.ProcessEnv = process.env,
  options:{hostCapabilityRegistry?:HostCapabilityRegistry}={}) {
  const config = await fleetApiConfiguration(environment);
  if (config && (!capability.available
    || capability.placements.some(host => !config.hosts.some(registered => registered.host_id === host.host_id)))) {
    throw new Error('Fleet API and controller host catalogs differ');
  }
  const providerAuthService: ProviderAuthService | undefined = config === undefined
    ? environment.CAUCE_FLEET_API_SOCKET === undefined ? undefined : new HostProviderAuthService(environment.CAUCE_FLEET_API_SOCKET)
    : createFleetProviderAuthRouter(pool, { hosts: config.hosts.map(host => ({ host_id: host.host_id, socket_path: host.socket_path,
      ...(host.socket_policy === undefined ? {} : { socket_policy: { ownerUid: host.socket_policy.ownerUid,
        ...(host.socket_policy.groupGid === undefined ? {} : { groupGid: host.socket_policy.groupGid }) } }) })) });
  const repository = !capability.available && options.hostCapabilityRegistry===undefined ? undefined : fleetRepository(pool, environment, config);
  const approved=async(client:DatabaseClient,tenant:string,alias:string,input:FleetOperationRequest,subject?:string,source?:CompanyAuthoritySource)=>{
    const registry=options.hostCapabilityRegistry;
    const authority=await assertFleetAuthority(client,tenant,alias,input.target,true,subject,source);
    const current=registry===undefined?capability:await registry.fleet(authority.actingCompany,capability);
    assertFleetPlacement(current,input);await assertFleetProviderAccount(pool,current,input);await assertFleetHostOperable(pool,input);
    if (!repository) throw new Error('fleet repository is unavailable');
    const hostId=registry===undefined||config===undefined?null:input.kind==='create'||input.kind==='update'?input.parameters.placement.host_id
      :input.target.resource==='agent'?await placedHostId(client,input.target):null;
    const selected=registry!==undefined && input.target.resource==='agent'
      && config!==undefined && current.placements.some(host=>host.host_id===hostId)
      && !config.hosts.some(host=>host.host_id===hostId)?new FleetOperationsRepository(pool):repository;
    return (source===undefined?selected:selected.forAuthority(source)).forTransaction(client);
  };
  const bind=(selected:FleetOperationsRepository,source?:CompanyAuthoritySource):FleetOperationsRepositoryBinding=>{
    const scoped=source===undefined?selected:selected.forAuthority(source);
    return {
      forAuthority: authority=>bind(selected,authority),
      list: scoped.list.bind(scoped), listRecent: scoped.listRecent.bind(scoped), get: scoped.get.bind(scoped),
      cancel: scoped.cancel.bind(scoped),
      resume: async (tenant,alias,id,expected,subject)=>withTransaction(pool,async client=>{
        const operation=await scoped.forTransaction(client).get(tenant,alias,id,subject);
        const stored=(await client.query<{request:FleetOperationRequest}>('SELECT request FROM fleet_operations WHERE id=$1',[operation.id])).rows[0];
        if (!stored) throw new FleetOperationError('not_found','fleet operation was not found');
        return (await approved(client,tenant,alias,stored.request,subject,source)).resume(tenant,alias,id,expected,subject);
      }),
      preview: async (tenant,alias,input,subject)=>withTransaction(pool,async client=>
        (await approved(client,tenant,alias,input,subject,source)).preview(tenant,alias,input,subject)),
      enqueue: async (tenant,alias,input,subject)=>withTransaction(pool,async client=>
        (await approved(client,tenant,alias,input,subject,source)).enqueue(tenant,alias,input,subject)),
    };
  };
  const binding=repository===undefined?undefined:bind(repository);
  const legacyFleetAdoptionService = config?.legacy_adoption === undefined ? undefined
    : createLegacyFleetAdoptionService(pool, new HostLegacyAdoptionProbe(config.legacy_adoption.socket_path,
      { ownerUid: config.legacy_adoption.socket_policy.ownerUid,
        ...(config.legacy_adoption.socket_policy.groupGid === undefined ? {} : { groupGid: config.legacy_adoption.socket_policy.groupGid }) }));
  return { ...(providerAuthService === undefined ? {} : { providerAuthService }),
    ...(legacyFleetAdoptionService === undefined ? {} : { legacyFleetAdoptionService }),
    ...(binding === undefined ? {} : { fleetOperationsRepository: binding, fleetCapability: capability }) };
}
