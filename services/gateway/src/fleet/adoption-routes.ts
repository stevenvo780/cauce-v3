import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FleetOperationError, StoreError } from '@cauce/store';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../auth.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { LegacyAdoptionError, LegacyAdoptionPreviewSchema, LegacyAdoptionTargetsSchema,
  type LegacyAdoptionActor } from '@cauce/store';
import type { LegacyFleetAdoptionService } from './adoption.js';

async function humanActor<T>(provider: AuthProvider, request: FastifyRequest, reply: FastifyReply,
  work: (actor: LegacyAdoptionActor) => Promise<T>): Promise<T> {
  if (!(provider instanceof PasswordAuthProvider) || !request.headers.cookie || request.headers.authorization !== undefined) throw new AuthorizationError();
  const who = await provider.authenticateConsoleFresh(request);
  requireOperatorPermission(who, 'control'); await provider.requireCsrf(request);
  if (!who.operator_profile?.id) throw new AuthorizationError();
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (!access) throw new AuthorizationError();
  const subject = who.operator_profile.id;
  try {
    return await work({ tenant_id: who.tenant_id, alias: who.alias, subject,
      authorize: async client => {
        const current = await access.options.humanAuthority(client);
        if (`console:${current.humanId}` !== subject || current.tenantId !== who.tenant_id || current.actorAlias !== who.alias) throw new AuthorizationError();
        access.options.signal.throwIfAborted();
      } });
  } finally { access.close(); }
}
function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof LegacyAdoptionError ? error.code : error instanceof AuthError ? 'unauthorized'
    : error instanceof AuthorizationError ? 'forbidden' : error instanceof z.ZodError ? 'invalid_input'
      : (error instanceof StoreError || error instanceof FleetOperationError) && error.code === 'forbidden' ? 'forbidden' : 'conflict';
  const status = code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : code === 'invalid_input' ? 400 : code === 'unavailable' ? 503 : 409;
  return reply.code(status).send({ error: code, blockers: error instanceof LegacyAdoptionError ? error.blockers : [] });
}
export function registerLegacyFleetAdoptionRoutes(app: FastifyInstance, provider: AuthProvider, service: LegacyFleetAdoptionService): void {
  const path = '/v3/console/fleet/legacy-adoption';
  app.post(path + '/preview', { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const body = z.object({ targets: LegacyAdoptionTargetsSchema }).strict().parse(request.body);
      return await humanActor(provider, request, reply, actor => service.preview(actor, body.targets));
    } catch (error) { return failure(reply, error); }
  });
  app.post(path + '/apply', { bodyLimit: 1_048_576 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const body = z.object({ preview: LegacyAdoptionPreviewSchema }).strict().parse(request.body);
      return await humanActor(provider, request, reply, actor => service.apply(actor, body.preview));
    } catch (error) { return failure(reply, error); }
  });
}
