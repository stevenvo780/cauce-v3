import type { FastifyInstance } from 'fastify';
import type { Tenant } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { requirePermission, type AuthProvider } from '../auth.js';
import { principal, replyError } from './shared.js';

interface LegacyCandidateRouteOptions {
  readonly authProvider: AuthProvider;
}

interface LegacyCandidateRepository {
  listChainGates?(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { status?: 'open' | 'all'; limit?: number },
  ): Promise<Record<string, unknown>>;
  answerChainGate?(
    gateId: string,
    answer: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  cancelChainGate?(
    gateId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
}

export function registerLegacyCandidateChainGateRoutes(
  app: FastifyInstance,
  options: LegacyCandidateRouteOptions,
  repository: LegacyCandidateRepository,
): void {
  // Las preguntas que la flota le dejó a una persona. Es la LISTA VISIBLE que el gate promete:
  // sin ella, sacar la espera humana del bus sólo la escondería en otro lado.
  //
  // Sin fachada sameTenantRows, por el mismo motivo que /v3/console/chains/:traceId: el store ya
  // aplicó la visibilidad fila por fila (tenant propio, o arista ACL con allow_read), y aplastar
  // por tenant acá dejaría a un operador del hub sin poder contestar la pregunta de un agente de
  // otro tenant, que es justo para lo que existe esta lista.
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/v3/console/chain-gates',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        if (repository.listChainGates === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        const limit = Number.parseInt(request.query.limit ?? '', 10);
        return await repository.listChainGates(actor.tenant_id, actor.alias, {
          status: request.query.status === 'all' ? 'all' : 'open',
          ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
        });
      } catch (error) { replyError(reply, error); }
    }
  );

  // Contestar reanuda la rama suspendida con UNA entrega. Pide 'route' y no 'read' porque
  // produce tráfico en el bus, igual que publicar.
  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/answer',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        if (repository.answerChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
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
        if (repository.cancelChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        return await repository.cancelChainGate(
          request.params.gateId, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );
}
