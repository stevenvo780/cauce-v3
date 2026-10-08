import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AliasSchema, NativeOperationIdSchema, NativePieceIdSchema, NativePieceKindSchema, NativePieceMutationSchema, NativeRuntimeIdentitySchema, TenantSchema } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { AuthError, AuthorizationError, requireOperatorPermission, requirePermission, type AuthProvider } from '../../auth.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { NativeAdminError, type NativeAdminActor, type NativeAdminService } from './service.js';

const bodySchema = z.object({ mutation: NativePieceMutationSchema, reason: z.string().trim().min(12).max(500), identity: NativeRuntimeIdentitySchema, operation_id: NativeOperationIdSchema.optional() }).strict();
const paramsSchema = z.object({ tenantId: TenantSchema, alias: AliasSchema, kind: NativePieceKindSchema, id: NativePieceIdSchema.optional() });
async function actor<T>(provider: AuthProvider, request: FastifyRequest, reply: FastifyReply, action: (value: NativeAdminActor) => Promise<T>) {
  if (!(provider instanceof PasswordAuthProvider) || !request.headers.cookie || request.headers.authorization !== undefined) throw new AuthorizationError();
  const who = await provider.authenticateConsoleFresh(request);
  if (request.method === 'GET') requirePermission(who, 'read'); else { requireOperatorPermission(who, 'control'); await provider.requireCsrf(request); }
  if (!who.operator_profile?.id) throw new AuthorizationError();
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (!access) throw new AuthorizationError();
  try { return await action({ tenant_id: who.tenant_id, alias: who.alias, subject: who.operator_profile.id,
    humanAuthority: access.options.humanAuthority, signal: access.options.signal }); }
  finally { access.close(); }
}
function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof NativeAdminError ? error.code : error instanceof AuthError ? 'unauthorized'
    : error instanceof AuthorizationError ? 'forbidden' : error instanceof z.ZodError ? 'invalid_input'
      : error instanceof StoreError && ['forbidden', 'conflict'].includes(error.code) ? error.code : 'unavailable';
  const status = code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : code === 'conflict' ? 409
    : code === 'invalid_input' ? 400 : code === 'not_found' ? 404 : code === 'unsupported' ? 501 : 503;
  return reply.code(status).send({ error: code,
    ...(error instanceof NativeAdminError && error.operationId ? { operation_id: error.operationId, state: 'effect_unknown' } : {}),
    message: code === 'unsupported' ? 'Este arnés no publica edición nativa para este tipo o esta cuenta.'
      : code === 'conflict' ? 'La huella o el runtime cambió. Relee la pieza; el borrador se conserva.'
        : 'No se confirmó la operación nativa. El borrador se conserva.' });
}
export function registerNativeAdminRoutes(app: FastifyInstance, provider: AuthProvider, service: NativeAdminService): void {
  const path = '/v3/console/tenants/:tenantId/agents/:alias/native/:kind';
  app.post(path + '/:id/discover', { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { const params = paramsSchema.parse(request.params);
      const body = z.object({ mutation: NativePieceMutationSchema, identity: NativeRuntimeIdentitySchema, operation_id: NativeOperationIdSchema.optional() }).strict().parse(request.body);
      if (body.mutation.kind !== params.kind || body.mutation.id !== params.id) throw new NativeAdminError('invalid_input');
      return await actor(provider, request, reply, value => service.discover(value, params.tenantId, params.alias, body.mutation, body.identity, body.operation_id));
    } catch (error) { return failure(reply, error); }
  });
  for (const suffix of ['', '/:id']) app.get(path + suffix, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { const params = paramsSchema.parse(request.params); return await actor(provider, request, reply,
      value => service.read(value, params.tenantId, params.alias, params.kind, params.id)); }
    catch (error) { return failure(reply, error); }
  });
  app.post(path + '/:id/recover', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { const params = paramsSchema.parse(request.params); const body = z.object({ operation_id: NativeOperationIdSchema, mutation: NativePieceMutationSchema }).strict().parse(request.body);
      if (body.mutation.kind !== params.kind || body.mutation.id !== params.id) throw new NativeAdminError('invalid_input');
      return await actor(provider, request, reply, value => service.recover(value, params.tenantId, params.alias, body.operation_id, body.mutation));
    } catch (error) { return failure(reply, error); }
  });
  app.post(path + '/:id/recognize', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { const params = paramsSchema.parse(request.params); const body = z.object({ expected_sha: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), identity: NativeRuntimeIdentitySchema }).strict().parse(request.body);
      if (params.id === undefined) throw new NativeAdminError('invalid_input');
      const id = params.id;
      return await actor(provider, request, reply, value => service.recognize(value, params.tenantId, params.alias, params.kind, id, body.expected_sha, body.identity));
    } catch (error) { return failure(reply, error); }
  });
  app.put(path + '/:id', { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const params = paramsSchema.parse(request.params); const body = bodySchema.parse(request.body);
      if (body.mutation.kind !== params.kind || body.mutation.id !== params.id) throw new NativeAdminError('invalid_input');
      return await reply.code(202).send(await actor(provider, request, reply,
        value => service.write(value, params.tenantId, params.alias, body.mutation, body.reason, body.identity, body.operation_id)));
    } catch (error) { return failure(reply, error); }
  });
}
