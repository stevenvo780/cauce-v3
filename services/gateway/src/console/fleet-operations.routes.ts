import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ConsoleFleetOperationSchema, FleetCapabilitySchema, FleetTargetSchema, FleetOperationControlSchema, FleetOperationPreviewSchema,
  FleetOperationRecentQuerySchema, FleetOperationRequestSchema, FleetOperationSubmissionSchema, FleetOperationSchema, RESERVED_ALIAS_MESSAGE, sha256Hex,
  type ConsoleFleetOperation, type FleetCapability, type FleetOperation, type FleetOperationRequest, type FleetTarget, type Tenant,
} from '@cauce/protocol';
import { FleetOperationError, StoreError, type CompanyAuthoritySource, type DatabasePool } from '@cauce/store';
import { FleetHostUnavailableError } from '../fleet/gateway-config.js';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider, type Principal } from '../auth.js';
import { principal, replyError } from '../routes/shared.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { admittingAuthority, assertActorAgentAllowance, createdFleetAgents, PlanLimitError, type AgentTarget } from '../billing/agent-allowance.js';

export interface FleetOperationsRepositoryBinding {
  forAuthority?(source: CompanyAuthoritySource): FleetOperationsRepositoryBinding;
  display?(operation: FleetOperation): Promise<ConsoleFleetOperation>;
  list?(actorTenant: Tenant, actorAlias: string, target: FleetTarget, actorSubject?: string): Promise<unknown>;
  listRecent?(actorTenant: Tenant, actorAlias: string, limit: number, actorSubject?: string): Promise<unknown>;
  preview(actorTenant: Tenant, actorAlias: string, input: FleetOperationRequest, actorSubject?: string): Promise<unknown>;
  enqueue(actorTenant: Tenant, actorAlias: string, input: FleetOperationRequest, actorSubject?: string): Promise<unknown>;
  get(actorTenant: Tenant, actorAlias: string, id: string, actorSubject?: string): Promise<unknown>;
  cancel(actorTenant: Tenant, actorAlias: string, id: string, expectedVersion: number, actorSubject?: string): Promise<unknown>;
  resume(actorTenant: Tenant, actorAlias: string, id: string, expectedVersion: number, actorSubject?: string): Promise<unknown>;
}
export type FleetCapabilitySource=(request:FastifyRequest,reply:FastifyReply)=>Promise<FleetCapability>;

const OperationIdSchema = z.uuid();
const ERROR_STATUS = { forbidden: 403, conflict: 409, not_found: 404, invalid_input: 400 } as const;

function sameTarget(left: FleetTarget, right: FleetTarget): boolean {
  if (left.resource !== right.resource || left.tenant_id !== right.tenant_id) return false;
  if (left.resource === 'agent') return right.resource === 'agent' && left.alias === right.alias;
  if (left.resource === 'room') return right.resource === 'room' && left.room_id === right.room_id;
  return true;
}

/** Only a verified console person is a fleet subject: its company role is resolved, and re-resolved for every step, from it. */
function humanSubject(actor: Principal): string | undefined {
  return actor.human_id === undefined ? undefined : `console:${actor.human_id}`;
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

async function displayReceipt(repository: FleetOperationsRepositoryBinding, operation: FleetOperation): Promise<ConsoleFleetOperation> {
  const expected = sha256Hex(operation);
  const shown = ConsoleFleetOperationSchema.parse(repository.display ? await repository.display(operation) : operation);
  const canonical = { ...shown, actor: { ...shown.actor } };
  delete canonical.actor.display_name;
  if (sha256Hex(canonical) !== expected) invalidReceipt();
  return shown;
}

function enqueueReceipt(value: unknown, actor: Principal, input: FleetOperationRequest): FleetOperation {
  const receipt = operationReceipt(value);
  if (!sameTarget(receipt.target, input.target) || receipt.kind !== input.kind
      || receipt.expected_revision !== input.expected_revision
      || receipt.request_sha256 !== sha256Hex(input)
      || receipt.actor.tenant_id !== actor.tenant_id || receipt.actor.alias !== actor.alias
      || receipt.actor.actor_subject !== humanSubject(actor)) invalidReceipt();
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
  if (error instanceof PlanLimitError) {
    replyError(reply, error);
    return;
  }
  if (error instanceof FleetHostUnavailableError) {
    void reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    const reserved = error.issues.some(issue => issue.message === RESERVED_ALIAS_MESSAGE);
    void reply.code(400).send({ error: 'invalid_request', message: reserved ? RESERVED_ALIAS_MESSAGE : 'invalid fleet operation request' });
    return;
  }
  void reply.code(500).send({ error: 'operation_unverified', message: 'fleet operation could not be verified' });
}

export function registerFleetCapabilityRoute(app: FastifyInstance, authProvider: AuthProvider, capability: FleetCapability|FleetCapabilitySource): void {
  app.get('/v3/console/fleet/capability', async (request, reply) => {
    try {
      const actor = await principal(request, authProvider);
      requireOperatorPermission(actor, 'control');
      return FleetCapabilitySchema.parse(typeof capability==='function'?await capability(request,reply):capability);
    } catch (error) { fleetError(reply, error); }
  });
}

export function registerFleetOperationRoutes(
  app: FastifyInstance, authProvider: AuthProvider, repository: FleetOperationsRepositoryBinding,
  capability: FleetCapability|FleetCapabilitySource = { available: false, actions: [], placements: [], reason: 'executor_unconfigured' },
  /** Charges agent creations against the company plan; omitted, no plan limit applies. */
  billingPool?: DatabasePool,
): void {
  const path = '/v3/console/fleet/operations';
  registerFleetCapabilityRoute(app, authProvider, capability);
  const withAccess = async <T>(request: FastifyRequest, reply: FastifyReply,
    action: (active: FleetOperationsRepositoryBinding, actor: Principal) => Promise<T>, created: readonly AgentTarget[] = []): Promise<T> => {
    const actor = await principal(request, authProvider);
    requireOperatorPermission(actor, 'control');
    const access = await consoleHumanAccess(authProvider, request, reply, 'read');
    try {
      const forAuthority = repository.forAuthority?.bind(repository);
      if (billingPool !== undefined && (access === undefined || forAuthority === undefined)) {
        await assertActorAgentAllowance(billingPool, actor.tenant_id, created);
      }
      const active = access === undefined || forAuthority === undefined ? repository
        : forAuthority(admittingAuthority(access.companyAuthority.bind(access), billingPool === undefined ? [] : created));
      return await action(active, actor);
    } finally { access?.close(); }
  };
  app.get(path, async (request, reply) => {
    try {
      return await withAccess(request, reply, async (active, actor) => {
        const target = FleetTargetSchema.parse(request.query);
        if (!active.list) throw new StoreError('conflict', 'fleet history is unavailable');
        const rows = z.array(FleetOperationSchema).max(100).parse(await active.list(actor.tenant_id, actor.alias, target, humanSubject(actor)));
        if (rows.some((row) => !sameTarget(row.target, target))) invalidReceipt();
        return { operations: await Promise.all(rows.map(row => displayReceipt(active, row))) };
      });
    } catch (error) { fleetError(reply, error); }
  });
  app.get(`${path}/recent`, async (request, reply) => {
    try {
      return await withAccess(request, reply, async (active, actor) => {
        const { limit } = FleetOperationRecentQuerySchema.parse(request.query);
        if (!active.listRecent) throw new StoreError('conflict', 'fleet history is unavailable');
        const rows = z.array(FleetOperationSchema).max(limit).parse(await active.listRecent(actor.tenant_id, actor.alias, limit, humanSubject(actor)));
        return { operations: await Promise.all(rows.map(row => displayReceipt(active, row))) };
      });
    } catch (error) { fleetError(reply, error); }
  });
  app.post(`${path}/preview`, async (request, reply) => {
    try {
      return await withAccess(request, reply, async (active, actor) => {
        const input = FleetOperationRequestSchema.parse(request.body);
        const preview = FleetOperationPreviewSchema.safeParse(await active.preview(actor.tenant_id, actor.alias, input, humanSubject(actor)));
        if (!preview.success || !sameTarget(preview.data.target, input.target)
            || preview.data.kind !== input.kind || preview.data.expected_revision !== input.expected_revision
            || preview.data.request_sha256 !== sha256Hex(input)) invalidReceipt();
        return await reply.send(preview.data);
      });
    } catch (error) { fleetError(reply, error); }
  });

  app.post(path, async (request, reply) => {
    try {
      const submitted = FleetOperationSubmissionSchema.safeParse(request.body);
      return await withAccess(request, reply, async (active, actor) => {
        const input = FleetOperationSubmissionSchema.parse(request.body);
        const canonical = enqueueReceipt(await active.enqueue(actor.tenant_id, actor.alias, input, humanSubject(actor)), actor, input);
        const operation = await displayReceipt(active, canonical);
        return await reply.code(202).send({ operation_id: operation.id, status: operation.status, operation });
      }, submitted.success ? createdFleetAgents(submitted.data) : []);
    } catch (error) { fleetError(reply, error); }
  });

  app.get<{ Params: { id: string } }>(`${path}/:id`, async (request, reply) => {
    try {
      return await withAccess(request, reply, async (active, actor) => {
        const id = OperationIdSchema.parse(request.params.id);
        return displayReceipt(active, operationReceipt(await active.get(actor.tenant_id, actor.alias, id, humanSubject(actor)), id));
      });
    } catch (error) { fleetError(reply, error); }
  });

  for (const action of ['cancel', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(`${path}/:id/${action}`, async (request, reply) => {
      try {
        return await withAccess(request, reply, async (active, actor) => {
          const id = OperationIdSchema.parse(request.params.id);
          const input = FleetOperationControlSchema.parse(request.body);
          const operation = operationReceipt(
            await active[action](actor.tenant_id, actor.alias, id, input.expected_version, humanSubject(actor)), id, input.expected_version,
          );
          return displayReceipt(active, operation);
        });
      } catch (error) { fleetError(reply, error); }
    });
  }
}
