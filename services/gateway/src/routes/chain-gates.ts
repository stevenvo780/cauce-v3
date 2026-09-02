import type { FastifyInstance } from 'fastify';
import { requirePermission, type AuthProvider } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import { principal, replyError } from './shared.js';

interface ChainGateRouteOptions {
  readonly authProvider: AuthProvider;
}

type ChainGateRepository = Pick<GatewayRepository,
  'listChainGates' | 'answerChainGate' | 'cancelChainGate'
>;

export function registerChainGateRoutes(
  app: FastifyInstance,
  options: ChainGateRouteOptions,
  repository: ChainGateRepository,
): void {
  // The questions the fleet left for a person. This is the VISIBLE LIST the gate promises:
  // without it, pulling the human wait out of the bus would only hide it somewhere else.
  //
  // Without a sameTenantRows facade, for the same reason as /v3/console/chains/:traceId: the store
  // already applied visibility row by row (own tenant, or ACL edge with allow_read), and flattening
  // by tenant here would leave a hub operator unable to answer another tenant's agent question,
  // which is exactly what this list exists for.
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/v3/console/chain-gates',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        const limit = Number.parseInt(request.query.limit ?? '', 10);
        return await repository.listChainGates(actor.tenant_id, actor.alias, {
          status: request.query.status === 'all' ? 'all' : 'open',
          ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
        });
      } catch (error) { replyError(reply, error); }
    }
  );

  // Answering resumes the suspended branch with ONE delivery. It asks for 'route' instead of
  // 'read' because it produces traffic on the bus, just like publishing does.
  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/answer',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        const body = request.body === null || typeof request.body !== 'object'
          ? {}
          : request.body as Record<string, unknown>;
        const answer = typeof body.answer === 'string' ? body.answer : '';
        return await repository.answerChainGate(
          request.params.gateId, answer, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );

  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/cancel',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        return await repository.cancelChainGate(
          request.params.gateId, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );
}
