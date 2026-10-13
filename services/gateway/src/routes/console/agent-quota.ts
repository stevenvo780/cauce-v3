import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentQuotaQuerySchema, AliasSchema, TenantSchema } from '@cauce/protocol';
import { AgentQuotaHostUnavailableError, AgentQuotaOperationsRepository, FleetOperationError, StoreError, type CompanyAuthoritySource, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { principal, replyError } from '../shared.js';

const Params = z.object({ tenant: TenantSchema, alias: AliasSchema }).strict();
const EmptyQuery = z.object({}).strict();

export function registerAgentQuotaRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  const repository = new AgentQuotaOperationsRepository(pool);
  const handler = (query: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (query) requireOperatorPermission(await principal(request, provider), 'control');
      const access = await consoleHumanAccess(provider, request, reply, 'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        EmptyQuery.parse(request.query);
        const params = Params.parse(request.params);
        const target = { tenant_id: params.tenant, alias: params.alias };
        const source: CompanyAuthoritySource = async client => {
          await access.options.humanAuthority(client);
          return access.companyAuthority(client);
        };
        if (!query) return await repository.snapshot(source, target);
        const operation = await repository.enqueue(source, { ...target, ...AgentQuotaQuerySchema.parse(request.body) });
        if (operation.status === 'unsupported') return await reply.code(409).send({ error: 'quota_reader_unavailable',
          status: 'unsupported', operation_id: null, message: 'agent quota reader is unavailable' });
        return await reply.code(202).send({ operation_id: operation.id, status: operation.status, operation });
      } finally { access.close(); }
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid agent quota request' });
      if (error instanceof AgentQuotaHostUnavailableError) return reply.code(409).send({ error: 'quota_host_unavailable', message: error.message });
      if (error instanceof FleetOperationError) return reply.code({ forbidden: 403, conflict: 409, not_found: 404, invalid_input: 422 }[error.code])
        .send({ error: error.code, message: error.message });
      if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) {
        replyError(reply, error); return;
      }
      return reply.code(503).send({ error: 'agent_quota_unavailable', message: 'agent quota could not be verified' });
    }
  };
  app.get('/v3/console/agents/:tenant/:alias/quota', handler(false));
  app.post('/v3/console/agents/:tenant/:alias/quota', handler(true));
}
