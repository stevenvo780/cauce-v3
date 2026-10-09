import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  FleetHostCreateSchema, FleetHostIdSchema, FleetHostSchema, FleetHostUpdateSchema,
  type FleetCapability, type FleetHost, type FleetHostCreate, type FleetHostUpdate,
} from '@cauce/protocol';
import {
  FleetOperationError, LEGACY_COMPANY, StoreError, createFleetHost, deleteFleetHost, listFleetHosts, updateFleetHost, type DatabasePool,
} from '@cauce/store';
import {
  AuthError, AuthorizationError, requireOperatorPermission, requirePermission, type AuthProvider, type Principal,
} from '../auth.js';
import { principal, replyError } from '../routes/shared.js';

export interface FleetHostRepository {
  list(approvedHostIds: readonly string[]): Promise<unknown>;
  create(input: FleetHostCreate, approvedHostIds: readonly string[]): Promise<unknown>;
  update(hostId: string, input: FleetHostUpdate, approvedHostIds: readonly string[]): Promise<unknown>;
  delete(hostId: string, expectedVersion: number): Promise<void>;
}

export function fleetHostRepository(pool: DatabasePool): FleetHostRepository {
  return {
    list: (approvedHostIds) => listFleetHosts(pool, { approvedHostIds }),
    create: (input, approvedHostIds) => createFleetHost(pool, input, approvedHostIds),
    update: (hostId, input, approvedHostIds) => updateFleetHost(pool, hostId, input, approvedHostIds),
    delete: (hostId, expectedVersion) => deleteFleetHost(pool, hostId, expectedVersion),
  };
}

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

/** Mirrors the store's configuration control check: the actor must hold a control role on a hub tenant.
 * Hosts stay one installation-wide catalog, so only the legacy company hub may list or change them. */
export async function requireHubControl(pool: Pick<DatabasePool, 'query'>, actor: Principal): Promise<void> {
  const result = await pool.query<{ is_hub: boolean }>(
    `SELECT tenant.is_hub FROM memberships membership
     JOIN role_policies role ON role.role=membership.role
     JOIN tenants tenant ON tenant.id=membership.tenant_id
     JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
     WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
       AND tenant.enabled AND room.enabled AND role.allow_control AND tenant.company_id=$3
       AND to_jsonb(membership)->>'retired_at' IS NULL
       AND to_jsonb(tenant)->>'retired_at' IS NULL AND to_jsonb(room)->>'retired_at' IS NULL LIMIT 1`,
    [actor.tenant_id, actor.alias, LEGACY_COMPANY],
  );
  if (result.rows[0]?.is_hub !== true) throw new AuthorizationError('hub control is required for fleet hosts');
}

export function registerFleetHostRoutes(
  app: FastifyInstance, authProvider: AuthProvider, pool: DatabasePool,
  capability: FleetCapability = { available: false, actions: [], placements: [], reason: 'executor_unconfigured' },
  repository: FleetHostRepository = fleetHostRepository(pool),
): void {
  const path = '/v3/console/fleet/hosts';
  const approvedHostIds = capability.available ? capability.placements.map((placement) => placement.host_id) : [];
  app.get(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requirePermission(actor, 'read');
      await requireHubControl(pool, actor);
      const hosts = z.array(z.unknown()).parse(await repository.list(approvedHostIds));
      return { hosts: hosts.map(hostReceipt) };
    } catch (error) { hostError(reply, error); }
  });

  app.post(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      await requireHubControl(pool, actor);
      const input = FleetHostCreateSchema.parse(request.body);
      return await reply.code(201).send(hostReceipt(await repository.create(input, approvedHostIds)));
    } catch (error) { hostError(reply, error); }
  });

  app.patch<{ Params: { host_id: string } }>(`${path}/:host_id`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      await requireHubControl(pool, actor);
      const hostId = FleetHostIdSchema.parse(request.params.host_id);
      const input = FleetHostUpdateSchema.parse(request.body);
      return await reply.send(hostReceipt(await repository.update(hostId, input, approvedHostIds)));
    } catch (error) { hostError(reply, error); }
  });

  app.delete<{ Params: { host_id: string }; Querystring: { expected_version?: string } }>(`${path}/:host_id`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      await requireHubControl(pool, actor);
      const hostId = FleetHostIdSchema.parse(request.params.host_id);
      const { expected_version: expectedVersion } = ExpectedVersionQuerySchema.parse(request.query);
      await repository.delete(hostId, expectedVersion);
      return await reply.code(204).send();
    } catch (error) { hostError(reply, error); }
  });
}
