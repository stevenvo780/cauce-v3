import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DeliveryIdSchema } from '@cauce/protocol';
import { parseAgentProgress, StoreError } from '@cauce/store';
import { AuthError, AuthorizationError, requirePermission, type AuthProvider, type Principal } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import { isAuthorizedTlsSocket } from '../runtime-guards.js';
import { principal, replyError } from './shared.js';

export function registerAgentEmissionRoutes(
  app: FastifyInstance, authProvider: AuthProvider,
  repository: Pick<GatewayRepository, 'agentQueue' | 'recordAgentProgress' | 'retryOwnDelivery'>,
): void {
  const agent = async (request: FastifyRequest): Promise<Principal> => {
    if (authProvider.mode === 'production' && !isAuthorizedTlsSocket(request.raw.socket)) {
      throw new AuthError('agent emission requires a verified client certificate');
    }
    const actor = await principal(request, authProvider);
    if (!actor.roles.some((role) => role === 'agent' || role === 'adapter')) {
      throw new AuthorizationError('agent identity is required');
    }
    return actor;
  };

  app.get('/v3/agent/queue', async (request, reply) => {
    try {
      const actor = await agent(request);
      requirePermission(actor, 'read');
      return await repository.agentQueue(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { deliveryId: string } }>('/v3/agent/deliveries/:deliveryId/progress', async (request, reply) => {
    try {
      const actor = await agent(request);
      requirePermission(actor, 'route');
      return await repository.recordAgentProgress(DeliveryIdSchema.parse(request.params.deliveryId),
        actor.tenant_id, actor.alias, parseAgentProgress(request.body));
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { deliveryId: string } }>('/v3/agent/deliveries/:deliveryId/retry', async (request, reply) => {
    try {
      const actor = await agent(request);
      requirePermission(actor, 'route');
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)
          || Object.keys(request.body).length !== 0) {
        throw new StoreError('invalid_input', 'retry body must be an empty object');
      }
      return await repository.retryOwnDelivery(DeliveryIdSchema.parse(request.params.deliveryId), actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });
}
