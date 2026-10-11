import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, HostId, StoreError, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { replyError } from '../routes/shared.js';

const EnrollmentParams = z.object({ enrollment_id: z.uuid() }).strict();
const HostParams = z.object({ host_id: HostId }).strict();
function errorResponse(error: unknown, reply: import('fastify').FastifyReply): unknown {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid host enrollment request' });
  if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) { replyError(reply,error); return; }
  return reply.code(503).send({ error: 'host_enrollment_unavailable', message: 'host enrollment could not be verified' });
}
export function registerHostEnrollmentRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  readyHostIds: readonly string[] = []): void {
  const repository = new HostEnrollmentRepository(pool,readyHostIds);
  const claims = new Map<string, { count: number; until: number }>();
  const path = '/v3/console/fleet/hosts/enrollments';
  for (const method of ['GET','POST'] as const) app.route({ method,url:path,bodyLimit:8192,handler:async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      const access = await consoleHumanAccess(provider,request,reply,'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        const source = (client: import('@cauce/store').DatabaseClient) => access.companyAuthority(client);
        return method === 'GET' ? { enrollments: await repository.list(source) }
          : await reply.code(201).send(await repository.invite(source,request.body));
      } finally { access.close(); }
    } catch (error) { return errorResponse(error,reply); }
  } });
  app.delete(`${path}/:enrollment_id`, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      const { enrollment_id } = EnrollmentParams.parse(request.params);
      const access = await consoleHumanAccess(provider,request,reply,'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try { return await repository.revoke(client => access.companyAuthority(client),enrollment_id); }
      finally { access.close(); }
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/enrollments/:enrollment_id/claim', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      const now = Date.now();
      for (const [ip, entry] of claims) if (entry.until<=now) claims.delete(ip);
      const rate = claims.get(request.ip) ?? {count:0,until:now+60_000};
      if (rate.count>=20 || (claims.size>=10_000 && !claims.has(request.ip))) {
        return await reply.header('Retry-After',String(Math.max(1,Math.ceil((rate.until-now)/1000)))).code(429)
          .send({error:'too_many_requests',message:'host enrollment rate exceeded'});
      }
      rate.count+=1; claims.set(request.ip,rate);
      const { enrollment_id } = EnrollmentParams.parse(request.params);
      return await repository.claim(enrollment_id,request.body);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/heartbeat', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      const { host_id } = HostParams.parse(request.params);
      return await repository.heartbeat(host_id,request.body);
    } catch (error) { return errorResponse(error,reply); }
  });
}
