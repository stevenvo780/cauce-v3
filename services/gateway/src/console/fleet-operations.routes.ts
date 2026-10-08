import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  FleetCapabilitySchema, FleetTargetSchema, FleetOperationControlSchema, FleetOperationPreviewSchema,
  FleetOperationRequestSchema, FleetOperationSchema, sha256Hex,
  type FleetCapability, type FleetOperation, type FleetOperationRequest, type FleetTarget, type Tenant,
} from '@cauce/protocol';
import { FleetOperationError, StoreError } from '@cauce/store';
import { FleetHostUnavailableError } from '../fleet/gateway-config.js';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider, type Principal } from '../auth.js';
import { principal, replyError } from '../routes/shared.js';

export interface FleetOperationsRepositoryBinding {
  list?(actorTenant: Tenant, actorAlias: string, target: FleetTarget, actorSubject?: string): Promise<unknown>;
  preview(actorTenant: Tenant, actorAlias: string, input: FleetOperationRequest, actorSubject?: string): Promise<unknown>;
  enqueue(actorTenant: Tenant, actorAlias: string, input: FleetOperationRequest, actorSubject?: string): Promise<unknown>;
  get(actorTenant: Tenant, actorAlias: string, id: string, actorSubject?: string): Promise<unknown>;
  cancel(actorTenant: Tenant, actorAlias: string, id: string, expectedVersion: number, actorSubject?: string): Promise<unknown>;
  resume(actorTenant: Tenant, actorAlias: string, id: string, expectedVersion: number, actorSubject?: string): Promise<unknown>;
}

const OperationIdSchema = z.uuid();
const ERROR_STATUS = { forbidden: 403, conflict: 409, not_found: 404, invalid_input: 422 } as const;

function sameTarget(left: FleetTarget, right: FleetTarget): boolean {
  if (left.resource !== right.resource || left.tenant_id !== right.tenant_id) return false;
  if (left.resource === 'agent') return right.resource === 'agent' && left.alias === right.alias;
  if (left.resource === 'room') return right.resource === 'room' && left.room_id === right.room_id;
  return true;
}

function invalidReceipt(): never {
  throw new StoreError('conflict', 'fleet operation did not return an exact durable receipt');
}

function operationReceipt(value: unknown, id?: string, expectedVersion?: number): FleetOperation {
  const receipt = FleetOperationSchema.safeParse(value);
  if (!receipt.success || (id !== undefined && receipt.data.id !== id)
      || (expectedVersion !== undefined && receipt.data.version < expectedVersion)) invalidReceipt();
  return receipt.data;
}

function enqueueReceipt(value: unknown, actor: Principal, input: FleetOperationRequest): FleetOperation {
  const receipt = operationReceipt(value);
  if (!sameTarget(receipt.target, input.target) || receipt.kind !== input.kind
      || receipt.expected_revision !== input.expected_revision
      || receipt.request_sha256 !== sha256Hex(input)
      || receipt.actor.tenant_id !== actor.tenant_id || receipt.actor.alias !== actor.alias
      || receipt.actor.actor_subject !== actor.operator_profile?.id) invalidReceipt();
  return receipt;
}

function fleetError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) {
    replyError(reply, error);
    return;
  }
  if (error instanceof FleetOperationError) {
    void reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof FleetHostUnavailableError) {
    void reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: 'invalid_request', message: 'invalid fleet operation request' });
    return;
  }
  void reply.code(500).send({ error: 'operation_unverified', message: 'fleet operation could not be verified' });
}

export function registerFleetCapabilityRoute(app: FastifyInstance, authProvider: AuthProvider, capability: FleetCapability): void {
  app.get('/v3/console/fleet/capability', async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      return FleetCapabilitySchema.parse(capability);
    } catch (error) { fleetError(reply, error); }
  });
}

export function registerFleetOperationRoutes(
  app: FastifyInstance, authProvider: AuthProvider, repository: FleetOperationsRepositoryBinding,
  capability: FleetCapability = { available: false, actions: [], placements: [], reason: 'executor_unconfigured' },
): void {
  const path = '/v3/console/fleet/operations';
  registerFleetCapabilityRoute(app, authProvider, capability);
  app.get(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const target = FleetTargetSchema.parse(request.query);
      if (!repository.list) throw new StoreError('conflict', 'fleet history is unavailable');
      const rows = z.array(FleetOperationSchema).max(100).parse(await repository.list(actor.tenant_id, actor.alias, target, actor.operator_profile?.id));
      if (rows.some((row) => !sameTarget(row.target, target))) invalidReceipt();
      return { operations: rows };
    } catch (error) { fleetError(reply, error); }
  });
  app.post(`${path}/preview`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const input = FleetOperationRequestSchema.parse(request.body);
      const preview = FleetOperationPreviewSchema.safeParse(await repository.preview(actor.tenant_id, actor.alias, input, actor.operator_profile?.id));
      if (!preview.success || !sameTarget(preview.data.target, input.target)
          || preview.data.kind !== input.kind || preview.data.expected_revision !== input.expected_revision
          || preview.data.request_sha256 !== sha256Hex(input)) invalidReceipt();
      return await reply.send(preview.data);
    } catch (error) { fleetError(reply, error); }
  });

  app.post(path, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const input = FleetOperationRequestSchema.parse(request.body);
      const operation = enqueueReceipt(await repository.enqueue(actor.tenant_id, actor.alias, input, actor.operator_profile?.id), actor, input);
      return await reply.code(202).send({ operation_id: operation.id, status: operation.status, operation });
    } catch (error) { fleetError(reply, error); }
  });

  app.get<{ Params: { id: string } }>(`${path}/:id`, async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      const id = OperationIdSchema.parse(request.params.id);
      return operationReceipt(await repository.get(actor.tenant_id, actor.alias, id, actor.operator_profile?.id), id);
    } catch (error) { fleetError(reply, error); }
  });

  for (const action of ['cancel', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(`${path}/:id/${action}`, async (request, reply) => {
      try {
        const actor = await principal(request, authProvider);
        requireOperatorPermission(actor, 'control');
        const id = OperationIdSchema.parse(request.params.id);
        const input = FleetOperationControlSchema.parse(request.body);
        return operationReceipt(
          await repository[action](actor.tenant_id, actor.alias, id, input.expected_version, actor.operator_profile?.id), id, input.expected_version,
        );
      } catch (error) { fleetError(reply, error); }
    });
  }
}
