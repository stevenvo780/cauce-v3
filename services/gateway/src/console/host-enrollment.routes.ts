import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, HostId, StoreError, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { rateLimitKey } from '../client-ip.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { replyError } from '../routes/shared.js';
import type { HostSetupPackager } from '../fleet/host-setup.js';

const EnrollmentParams = z.object({ enrollment_id: z.uuid() }).strict();
const HostParams = z.object({ host_id: HostId }).strict();
/** One-minute windows per client network; once 10 000 clients are tracked, a new one waits for a window to close. */
function clientLimiter(limit: number): (address: string) => number | undefined {
  const windows = new Map<string, { count: number; until: number }>();
  return address => {
    const now = Date.now(); const key = rateLimitKey(address);
    for (const [stored, entry] of windows) if (entry.until <= now) windows.delete(stored);
    const rate = windows.get(key) ?? { count: 0, until: now + 60_000 };
    if (rate.count >= limit || (windows.size >= 10_000 && !windows.has(key))) return Math.max(1, Math.ceil((rate.until - now) / 1000));
    rate.count += 1; windows.set(key, rate); return undefined;
  };
}
async function tooManyRequests(reply: FastifyReply, retryAfter: number, message: string): Promise<FastifyReply> {
  return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'too_many_requests', message });
}
function errorResponse(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid host enrollment request' });
  if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) { replyError(reply,error); return; }
  return reply.code(503).send({ error: 'host_enrollment_unavailable', message: 'host enrollment could not be verified' });
}
/** With `setup`, invitations anchor its signer so the computer never trusts the first setup package it sees. */
export function registerHostEnrollmentRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  readyHostIds: readonly string[] = [], setup?: HostSetupPackager): void {
  const repository = new HostEnrollmentRepository(pool,readyHostIds);
  const anchor = setup === undefined ? {} : { setup_signer_fingerprint: setup.signerFingerprint };
  const claims = clientLimiter(20);
  // Unauthenticated until their proof is verified; 120 a minute still fits dozens of computers behind one NAT.
  const hostRequests = clientLimiter(120);
  const path = '/v3/console/fleet/hosts/enrollments';
  for (const method of ['GET','POST'] as const) app.route({ method,url:path,bodyLimit:8192,handler:async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      const access = await consoleHumanAccess(provider,request,reply,'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        const source = (client: import('@cauce/store').DatabaseClient) => access.companyAuthority(client);
        return method === 'GET' ? { enrollments: await repository.list(source), ...anchor }
          : await reply.code(201).send({ ...await repository.invite(source,request.body), ...anchor });
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
      const retryAfter = claims(request.ip);
      if (retryAfter !== undefined) return await tooManyRequests(reply,retryAfter,'host enrollment rate exceeded');
      const { enrollment_id } = EnrollmentParams.parse(request.params);
      return await repository.claim(enrollment_id,request.body);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/heartbeat', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      const retryAfter = hostRequests(request.ip);
      if (retryAfter !== undefined) return await tooManyRequests(reply,retryAfter,'host request rate exceeded');
      const { host_id } = HostParams.parse(request.params);
      return await repository.heartbeat(host_id,request.body);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/setup', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      const retryAfter = hostRequests(request.ip);
      if (retryAfter !== undefined) return await tooManyRequests(reply,retryAfter,'host request rate exceeded');
      const { host_id } = HostParams.parse(request.params);
      return await repository.setupPackage(host_id,request.body,scope => {
        if (!setup) throw new StoreError('not_found', 'this gateway does not serve host setup packages');
        return setup.build(scope);
      });
    } catch (error) { return errorResponse(error,reply); }
  });
}
