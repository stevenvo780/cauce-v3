import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { AuthError, AuthorizationError } from '../../auth.js';
import { validateContextRepositoryBinding } from './binding.js';
import { assertContextCommit } from './git-reader.js';
import { ContextRepositoryError } from './model.js';
import { inspectNativeContextRepository } from './native-inspect.js';
import type { ContextRepositoryRouteDeps } from './routes.js';

export type NativeContextRepositoryRouteDeps = Pick<ContextRepositoryRouteDeps, 'binding' | 'authorize' | 'authorizeTarget'>;
interface Params { tenantId: string; alias: string }
type Request = FastifyRequest<{ Params: Params; Querystring: Record<string, unknown> }>;

export function registerNativeContextRepositoryRoutes(app: FastifyInstance, deps: NativeContextRepositoryRouteDeps): void {
  const binding = deps.binding === undefined ? undefined : validateContextRepositoryBinding(deps.binding);
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
  app.get<{ Params: Params; Querystring: Record<string, unknown> }>(
    '/v3/console/tenants/:tenantId/agents/:alias/context/repository/native-inspect', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const target = await authorizeTarget(request, reply);
        if (target === undefined) return undefined;
        const { commit, previous_commit } = request.query;
        if (Object.keys(request.query).some((key) => key !== 'commit' && key !== 'previous_commit')
          || typeof commit !== 'string' || (previous_commit !== undefined && typeof previous_commit !== 'string')) {
          return await reply.code(400).send({ error: 'invalid_input' });
        }
        assertContextCommit(commit);
        if (previous_commit !== undefined) assertContextCommit(previous_commit);
        if (binding === undefined) return await reply.code(409).send({ error: 'context_repository_not_configured' });
        const inspection = await inspectNativeContextRepository({ repositoryPath: binding.repositoryPath,
          scope: { instance_id: binding.instance_id, tenant_id: target.tenant_id, alias: target.alias },
          commit, ...(previous_commit === undefined ? {} : { previousCommit: previous_commit }) });
        if (await authorizeTarget(request, reply) === undefined) return undefined;
        return { tenant_id: target.tenant_id, alias: target.alias, ...inspection };
      } catch (error) {
        if (error instanceof AuthError) {
          return await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
        }
        if (error instanceof AuthorizationError) {
          return await reply.code(403).send({ error: 'forbidden', message: 'Agent context access denied' });
        }
        if (error instanceof ContextRepositoryError) {
          return await reply.code(422).send({ error: 'context_snapshot_unavailable', reason: error.code });
        }
        return await reply.code(503).send({ error: 'context_repository_unavailable', message: 'Context inspection unavailable' });
      }
    },
  );
}
