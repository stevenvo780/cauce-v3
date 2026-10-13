import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FleetHostCreateSchema, FleetHostIdSchema, FleetHostSchema, FleetHostUpdateSchema,
  type FleetCapability, type FleetHost, type FleetHostCreate, type FleetHostUpdate,
} from '@cauce/protocol';
import {
  FleetOperationError, StoreError, createFleetHost, deleteFleetHost, listFleetHosts, updateFleetHost,
  type CompanyAuthoritySource, type DatabasePool,
} from '@cauce/store';
import {
  AuthError, AuthorizationError, requireOperatorPermission, requirePermission, type AuthProvider,
} from '../auth.js';
import { consoleHumanAccess, type ConsoleHumanAccess } from '../console-human-authority.js';
import { principal, replyError } from '../routes/shared.js';
import type { FleetCapabilitySource } from './fleet-operations.routes.js';

/** Every call resolves the company role of the console person in its own transaction. */
export interface FleetHostRepository {
  list(authority: CompanyAuthoritySource, approvedHostIds: readonly string[]): Promise<unknown>;
  create(input: FleetHostCreate, authority: CompanyAuthoritySource, approvedHostIds: readonly string[]): Promise<unknown>;
  update(hostId: string, input: FleetHostUpdate, authority: CompanyAuthoritySource, approvedHostIds: readonly string[]): Promise<unknown>;
  delete(hostId: string, expectedVersion: number, authority: CompanyAuthoritySource): Promise<void>;
}

function fleetHostRepository(pool: DatabasePool): FleetHostRepository {
  return {
    list: (authority, approvedHostIds) => listFleetHosts(pool, { authority, approvedHostIds }),
    create: (input, authority, approvedHostIds) => createFleetHost(pool, input, { authority, approvedHostIds }),
    update: (hostId, input, authority, approvedHostIds) => updateFleetHost(pool, hostId, input, { authority, approvedHostIds }),
    delete: (hostId, expectedVersion, authority) => deleteFleetHost(pool, hostId, expectedVersion, { authority, approvedHostIds: [] }),
  };
}

export type FleetHostHumanAccess = (request: FastifyRequest, reply: FastifyReply) => Promise<ConsoleHumanAccess | undefined>;

const ERROR_STATUS = { forbidden: 403, conflict: 409, not_found: 404, invalid_input: 422 } as const;
const ExpectedVersionQuerySchema = z.object({
  expected_version: z.string().regex(/^[0-9]{1,9}$/u).transform(Number).pipe(FleetHostUpdateSchema.shape.expected_version),
}).strict();

function invalidReceipt(): never {
  throw new StoreError('conflict', 'fleet host did not return an exact durable receipt');
}

function hostReceipt(value: unknown): FleetHost {
  const host = FleetHostSchema.safeParse(value);
  if (!host.success) invalidReceipt();
  return host.data;
}

function hostError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) {
    replyError(reply, error);
    return;
  }
  if (error instanceof FleetOperationError) {
    void reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: 'invalid_request', message: 'invalid fleet host request' });
    return;
  }
  void reply.code(500).send({ error: 'fleet_host_unverified', message: 'fleet host could not be verified' });
}

/** Company authority comes only from the verified console session, never from the hub topology. */
async function withHostAuthority<T>(
  access: FleetHostHumanAccess, request: FastifyRequest, reply: FastifyReply, work: (authority: CompanyAuthoritySource) => Promise<T>,
): Promise<T> {
  const human = await access(request, reply);
  if (human === undefined) throw new AuthorizationError('a console session is required for fleet hosts');
  try { return await work(client=>human.companyAuthority(client)); } finally { human.close(); }
}

export function registerFleetHostRoutes(
  app: FastifyInstance, authProvider: AuthProvider, pool: DatabasePool,
  capability: FleetCapability|FleetCapabilitySource = { available: false, actions: [], placements: [], reason: 'executor_unconfigured' },
  repository: FleetHostRepository = fleetHostRepository(pool),
  access: FleetHostHumanAccess = (request, reply) => consoleHumanAccess(authProvider, request, reply, 'read'),
): void {
  const path = '/v3/console/fleet/hosts';
  const approvedHosts=async(request:FastifyRequest,reply:FastifyReply):Promise<string[]>=>{
    const current=typeof capability==='function'?await capability(request,reply):capability;
    return current.available?current.placements.map(placement=>placement.host_id):[];
  };
  app.get(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requirePermission(actor, 'read');
      const approvedHostIds=await approvedHosts(request,reply);
      const hosts = z.array(z.unknown()).parse(await withHostAuthority(access, request, reply,
        authority => repository.list(authority, approvedHostIds)));
      return { hosts: hosts.map(hostReceipt) };
    } catch (error) { hostError(reply, error); }
  });

  app.post(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const input = FleetHostCreateSchema.parse(request.body);
      const approvedHostIds=await approvedHosts(request,reply);
      const created = await withHostAuthority(access, request, reply, authority => repository.create(input, authority, approvedHostIds));
      return await reply.code(201).send(hostReceipt(created));
    } catch (error) { hostError(reply, error); }
  });

  app.patch<{ Params: { host_id: string } }>(`${path}/:host_id`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const hostId = FleetHostIdSchema.parse(request.params.host_id);
      const input = FleetHostUpdateSchema.parse(request.body);
      const approvedHostIds=await approvedHosts(request,reply);
      const updated = await withHostAuthority(access, request, reply, authority => repository.update(hostId, input, authority, approvedHostIds));
      return await reply.send(hostReceipt(updated));
    } catch (error) { hostError(reply, error); }
  });

  app.delete<{ Params: { host_id: string }; Querystring: { expected_version?: string } }>(`${path}/:host_id`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const hostId = FleetHostIdSchema.parse(request.params.host_id);
      const { expected_version: expectedVersion } = ExpectedVersionQuerySchema.parse(request.query);
      await withHostAuthority(access, request, reply, authority => repository.delete(hostId, expectedVersion, authority));
      return await reply.code(204).send();
    } catch (error) { hostError(reply, error); }
  });
}
