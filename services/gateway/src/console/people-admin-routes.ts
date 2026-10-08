import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { principal } from '../routes/shared.js';
import {
  PeopleAdminControlSchema, PeopleAdminCreateSchema, PeopleAdminError, PeopleAdminIdSchema, PeopleAdminListSchema,
  PeopleAdminPersonSchema, PeopleAdminPurgeSchema, PeopleAdminUpdateSchema, type PeopleAdminActor,
  type PeopleAdminControl, type PeopleAdminCreate, type PeopleAdminPerson, type PeopleAdminUpdate,
} from './people-admin-schema.js';

export interface PeopleAdminRepositoryBinding {
  list(actor: PeopleAdminActor): Promise<unknown>;
  create(actor: PeopleAdminActor, input: PeopleAdminCreate): Promise<unknown>;
  update(actor: PeopleAdminActor, id: string, input: PeopleAdminUpdate): Promise<unknown>;
  retire(actor: PeopleAdminActor, id: string, input: PeopleAdminControl): Promise<unknown>;
  restore(actor: PeopleAdminActor, id: string, input: PeopleAdminControl): Promise<unknown>;
  purge(actor: PeopleAdminActor, id: string, input: PeopleAdminControl): Promise<unknown>;
}
const STATUS = { invalid_request: 400, forbidden: 403, conflict: 409, not_found: 404, unverified: 503 } as const;
function fail(reply: FastifyReply, error: unknown): void {
  const code = error instanceof PeopleAdminError ? error.code : error instanceof AuthError ? 'unauthorized'
    : error instanceof AuthorizationError ? 'forbidden' : error instanceof z.ZodError ? 'invalid_request' : 'unverified';
  const status = code === 'unauthorized' ? 401 : STATUS[code];
  void reply.code(status).send({ error: code, message: code === 'conflict'
    ? 'La revisión cambió, existen dependencias o se perdería el último administrador efectivo. Relee el estado.'
    : 'No se pudo verificar la administración de esta persona.' });
}
function receipt<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new PeopleAdminError('unverified'); return result.data;
}
function personReceipt(value: unknown, fields: { [K in keyof PeopleAdminPerson]?: PeopleAdminPerson[K] | undefined }, id?: string, revision?: string): PeopleAdminPerson {
  const result = receipt(PeopleAdminPersonSchema, value);
  const keys = ['email', 'display_name', 'role', 'tenant_id', 'alias', 'active'] as const;
  if ((id !== undefined && result.id !== id) || (revision !== undefined && BigInt(result.revision) <= BigInt(revision))
    || keys.some(key => fields[key] !== undefined && result[key] !== fields[key])) throw new PeopleAdminError('unverified');
  return result;
}
async function run<T>(request: FastifyRequest, reply: FastifyReply, provider: AuthProvider, action: (actor: PeopleAdminActor) => Promise<T>): Promise<T> {
  const who = await principal(request, provider); requireOperatorPermission(who, 'control');
  if (who.channel !== 'console' || !who.operator_profile?.id || !request.headers.cookie || request.headers.authorization !== undefined) throw new AuthorizationError();
  if (!(provider instanceof PasswordAuthProvider)) throw new AuthorizationError();
  if (request.method !== 'GET') await provider.requireCsrf(request);
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (!access) throw new AuthorizationError();
  try {
    return await action({ tenant_id: who.tenant_id, alias: who.alias, subject: who.operator_profile.id,
      ...(access.options.signal === undefined ? {} : { signal: access.options.signal }), humanAuthority: access.options.humanAuthority });
  } finally { access.close(); }
}
export function registerPeopleAdminRoutes(app: FastifyInstance, provider: AuthProvider, repository: PeopleAdminRepositoryBinding): void {
  const path = '/v3/console/people';
  app.get(path, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await run(request, reply, provider, async actor => receipt(PeopleAdminListSchema, await repository.list(actor))); }
    catch (error) { fail(reply, error); }
  });
  app.post(path, { bodyLimit: 16_384 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await reply.code(201).send(await run(request, reply, provider, async actor => {
      const input = PeopleAdminCreateSchema.parse(request.body); return personReceipt(await repository.create(actor, input), input);
    })); }
    catch (error) { fail(reply, error); }
  });
  app.patch<{ Params: { id: string } }>(`${path}/:id`, { bodyLimit: 16_384 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await run(request, reply, provider, async actor => {
      const id = PeopleAdminIdSchema.parse(request.params.id); const input = PeopleAdminUpdateSchema.parse(request.body);
      return personReceipt(await repository.update(actor, id, input), input, id, input.expected_revision);
    }); }
    catch (error) { fail(reply, error); }
  });
  const control = async (action: 'retire' | 'restore' | 'purge', request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    try { return await run(request, reply, provider, async actor => {
      const id = PeopleAdminIdSchema.parse(request.params.id); const input = PeopleAdminControlSchema.parse(request.body);
      const value = await repository[action](actor, id, input);
      if (action !== 'purge') return personReceipt(value, { active: action === 'restore' }, id, input.expected_revision);
      const result = receipt(PeopleAdminPurgeSchema, value);
      if (result.id !== id || result.revision !== input.expected_revision) throw new PeopleAdminError('unverified'); return result;
    }); } catch (error) { fail(reply, error); }
  };
  app.delete<{ Params: { id: string } }>(`${path}/:id`, async (request, reply) => control('retire', request, reply));
  app.post<{ Params: { id: string } }>(`${path}/:id/restore`, async (request, reply) => control('restore', request, reply));
  app.delete<{ Params: { id: string } }>(`${path}/:id/purge`, async (request, reply) => control('purge', request, reply));
}
