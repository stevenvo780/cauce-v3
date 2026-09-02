import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import type { GatewayRepository } from '../app.js';
import { MtlsAuthProvider, requirePermission, type AuthProvider } from '../auth.js';
import { registerHealthRoutes } from '../health.js';
import { principal, replyError } from './shared.js';

interface GatewayHealthRouteOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly exposeHealthRoutes?: boolean;
}

type GatewayHealthRepository = Pick<GatewayRepository,
  'assertPrincipal' | 'listPresence' | 'status'
>;

export function registerGatewayHealthRoutes(
  app: FastifyInstance,
  options: GatewayHealthRouteOptions,
  repository: GatewayHealthRepository,
): void {
  const exposeHealthRoutes = options.exposeHealthRoutes ?? !(options.authProvider instanceof MtlsAuthProvider);
  if (exposeHealthRoutes) {
    registerHealthRoutes(app, {
      pool: options.pool,
      requirePostgresTls: process.env.NODE_ENV === 'production'
    });
  }

  app.get('/v3/status', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      await repository.assertPrincipal(actor.tenant_id, actor.alias);
      return {
        version: PROTOCOL_VERSION,
        auth_provider: options.authProvider.name,
        ...(await repository.status(actor.tenant_id, actor.alias)),
        presence: await repository.listPresence(actor.tenant_id, actor.alias)
      };
    } catch (error) { replyError(reply, error); }
  });
}
