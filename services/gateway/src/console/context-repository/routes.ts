import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { AuthError, AuthorizationError } from '../../auth.js';
import type { AgentContextHistoryDeps } from '../agent-context-history.routes.js';
import { validateContextRepositoryBinding, type ContextRepositoryBinding } from './binding.js';

export interface ContextRepositoryRouteDeps {
  readonly binding?: ContextRepositoryBinding;
  readonly authorize: AgentContextHistoryDeps['authorize'];
  readonly authorizeTarget: AgentContextHistoryDeps['authorizeTarget'];
}

interface Params { tenantId: string; alias: string }
type Request = FastifyRequest<{ Params: Params; Querystring: Record<string, unknown> }>;

function replyFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
  } else if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: 'forbidden', message: 'Agent context access denied' });
  } else {
    void reply.code(503).send({ error: 'context_repository_unavailable', message: 'Context inspection unavailable' });
  }
}

export function registerContextRepositoryRoutes(app: FastifyInstance, deps: ContextRepositoryRouteDeps): void {
  const binding = deps.binding === undefined ? undefined : validateContextRepositoryBinding(deps.binding);
  const route = '/v3/console/tenants/:tenantId/agents/:alias/context/repository';

  async function authorizeTarget(request: Request, reply: FastifyReply) {
    const actor = await deps.authorize(request, 'read');
    const tenant = TenantSchema.safeParse(request.params.tenantId);
    const alias = AliasSchema.safeParse(request.params.alias);
    if (!tenant.success || !alias.success) {
      await reply.code(400).send({ error: 'invalid_input' });
      return undefined;
    }
    const target = await deps.authorizeTarget(actor, tenant.data, alias.data, 'read', false);
    if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
      await reply.code(404).send({ error: 'not_found', message: 'Agent not found or not visible' });
      return undefined;
    }
    return target;
  }

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(route, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const target = await authorizeTarget(request, reply);
      if (target === undefined) return undefined;
      if (Object.keys(request.query).length > 0) return await reply.code(400).send({ error: 'invalid_input' });
      return {
        tenant_id: target.tenant_id, alias: target.alias,
        state: binding === undefined ? 'not_configured' : 'configured',
        instance_id: binding?.instance_id ?? null,
        storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated',
      };
    } catch (error) { replyFailure(reply, error); return undefined; }
  });
}
