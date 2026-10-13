import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, HostId, StoreError, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { rateLimitKey } from '../client-ip.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { replyError } from '../routes/shared.js';
import { openHostSetupArtifact, type HostSetupArtifact, type HostSetupPackager } from '../fleet/host-setup.js';

const EnrollmentParams = z.object({ enrollment_id: z.uuid() }).strict();
const HostParams = z.object({ host_id: HostId }).strict();
class RateLimited extends Error {
  constructor(message: string, readonly retryAfter: number) { super(message); }
}
/**
 * One-minute windows per key, at most 10 000 of them. A renewed window is reinserted, so the map stays in
 * window order: expired windows leave from the front and, when full, the oldest gives way to a new key.
 */
function windowLimiter(limit: number, message: string): (key: string) => void {
  const windows = new Map<string, { count: number; until: number }>();
  return key => {
    const now = Date.now();
    for (const [stored, entry] of windows) { if (entry.until > now) break; windows.delete(stored); }
    let rate = windows.get(key);
    if (rate === undefined || rate.until <= now) {
      windows.delete(key);
      if (windows.size >= 10_000) { const oldest = windows.keys().next(); if (!oldest.done) windows.delete(oldest.value); }
      rate = { count: 0, until: now + 60_000 }; windows.set(key, rate);
    }
    if (rate.count >= limit) throw new RateLimited(message, Math.max(1, Math.ceil((rate.until - now) / 1000)));
    rate.count += 1;
  };
}
function errorResponse(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof RateLimited) {
    return reply.header('Retry-After', String(error.retryAfter)).code(429).send({ error: 'too_many_requests', message: error.message });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid host enrollment request' });
  if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) { replyError(reply,error); return; }
  return reply.code(503).send({ error: 'host_enrollment_unavailable', message: 'host enrollment could not be verified' });
}
/** With `setup`, invitations anchor its signer so the computer never trusts the first setup package it sees. */
export function registerHostEnrollmentRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  readyHostIds: readonly string[] = [], setup?: HostSetupPackager): void {
  const repository = new HostEnrollmentRepository(pool,readyHostIds);
  const anchor = setup === undefined ? {} : { setup_signer_fingerprint: setup.signerFingerprint };
  const claims = windowLimiter(20, 'host enrollment rate exceeded');
  // Checked before the proof, so it only guards each network; 120 a minute still fits dozens of computers behind one NAT.
  const hostClients = windowLimiter(120, 'host request rate exceeded');
  // Checked once the proof verifies, so only the computer's own key spends its quota; it reports every 30 s.
  const heartbeats = windowLimiter(10, 'host request rate exceeded');
  const setups = windowLimiter(10, 'host request rate exceeded');
  // Release, agent image and small files, plus resumed downloads of the image after a cut connection.
  const downloads = windowLimiter(30, 'host request rate exceeded');
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
      claims(rateLimitKey(request.ip));
      const { enrollment_id } = EnrollmentParams.parse(request.params);
      return await repository.claim(enrollment_id,request.body);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/heartbeat', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      hostClients(rateLimitKey(request.ip));
      const { host_id } = HostParams.parse(request.params);
      return await repository.heartbeat(host_id,request.body,heartbeats);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/setup', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      hostClients(rateLimitKey(request.ip));
      const { host_id } = HostParams.parse(request.params);
      return await repository.setupPackage(host_id,request.body,scope => {
        if (!setup) throw new StoreError('not_found', 'this gateway does not serve host setup packages');
        return setup.build(scope);
      },setups);
    } catch (error) { return errorResponse(error,reply); }
  });
  app.post('/v3/fleet/hosts/:host_id/setup/artifact', { bodyLimit:4096 }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    let artifact: HostSetupArtifact;
    try {
      if (request.headers.cookie !== undefined) throw new AuthorizationError('host identity requests cannot use a browser session');
      hostClients(rateLimitKey(request.ip));
      const { host_id } = HostParams.parse(request.params);
      artifact = await repository.setupArtifact(host_id,request.body,wanted => {
        if (!setup) throw new StoreError('not_found', 'this gateway does not serve host setup packages');
        return setup.artifact(wanted);
      },downloads);
    } catch (error) { return errorResponse(error,reply); }
    let opened: Awaited<ReturnType<typeof openHostSetupArtifact>>;
    try { opened = await openHostSetupArtifact(artifact); }
    catch { return reply.code(503).send({ error: 'host_setup_artifact_unavailable', message: 'setup artifact is unavailable; retry is safe' }); }
    reply.code(artifact.offset === 0 ? 200 : 206).header('Content-Type','application/octet-stream')
      .header('Content-Length',String(opened.length)).header('X-Cauce-Artifact-Sha256',artifact.sha256);
    if (artifact.offset !== 0) reply.header('Content-Range',`bytes ${String(artifact.offset)}-${String(artifact.size - 1)}/${String(artifact.size)}`);
    return reply.send(opened.stream);
  });
}
