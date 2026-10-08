import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../auth.js';
import { principal } from '../routes/shared.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { ProviderAuthError, ProviderAuthRequestSchema, ProviderAuthSessionIdSchema } from './provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthService } from './provider-auth.types.js';

export async function providerAuthActor(request: FastifyRequest, provider: AuthProvider, fresh = false): Promise<ProviderAuthActor> {
  const actor = fresh && provider instanceof PasswordAuthProvider
    ? await provider.authenticateConsoleFresh(request) : await principal(request, provider);
  requireOperatorPermission(actor, 'control');
  if (actor.channel !== 'console' || !actor.operator_profile?.id) throw new AuthorizationError();
  return { tenant_id: actor.tenant_id, alias: actor.alias, subject: actor.operator_profile.id };
}

function authError(reply: FastifyReply, error: unknown): void {
  const code = error instanceof ProviderAuthError ? error.code
    : error instanceof AuthError ? 'unauthorized' : error instanceof AuthorizationError ? 'forbidden'
      : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'LOGIN_FAILED';
  const status = error instanceof AuthError ? 401 : error instanceof AuthorizationError || code === 'AUTHORITY_REVOKED' ? 403
    : code === 'INVALID_REQUEST' ? 400 : code === 'SESSION_CONFLICT' ? 409 : code === 'SESSION_EXPIRED' ? 410 : 503;
  void reply.code(status).send({ error: code, message: 'No se pudo verificar la autenticación del proveedor.' });
}

export function registerProviderAuthRoutes(app: FastifyInstance, auth: AuthProvider, manager: ProviderAuthService): void {
  const path = '/v3/console/provider-auth/sessions';
  app.get<{ Params: { id: string } }>('/v3/console/provider-auth/operations/:id/scope', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      if (!manager.resolve) throw new ProviderAuthError('HOST_UNAVAILABLE');
      return ProviderAuthRequestSchema.parse(await manager.resolve(await providerAuthActor(request, auth, true),
        ProviderAuthSessionIdSchema.parse(request.params.id)));
    } catch (error) { authError(reply, error); }
  });
  app.post(path, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await reply.code(202).send(await manager.start(await providerAuthActor(request, auth), request.body)); }
    catch (error) { authError(reply, error); }
  });
  app.get<{ Params: { id: string } }>(`${path}/:id`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await manager.get(await providerAuthActor(request, auth), ProviderAuthSessionIdSchema.parse(request.params.id)); }
    catch (error) { authError(reply, error); }
  });
  app.post<{ Params: { id: string } }>(`${path}/:id/ticket`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      z.object({}).strict().parse(request.body ?? {});
      return await manager.issueSocketTicket(await providerAuthActor(request, auth), ProviderAuthSessionIdSchema.parse(request.params.id));
    } catch (error) { authError(reply, error); }
  });
  for (const action of ['verify', 'cancel'] as const) {
    app.post<{ Params: { id: string } }>(`${path}/:id/${action}`, async (request, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        const actor = await providerAuthActor(request, auth);
        z.object({}).strict().parse(request.body ?? {});
        return await manager[action](actor, ProviderAuthSessionIdSchema.parse(request.params.id));
      } catch (error) { authError(reply, error); }
    });
  }
}
