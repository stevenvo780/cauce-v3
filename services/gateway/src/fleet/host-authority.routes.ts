import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HostId, SignedHostRequestSchema } from '@cauce/store';
import { SignedFleetAuthorityClient, SignedFleetAuthorityError } from './authority/signed-client.js';

const Params = z.object({ host_id: HostId }).strict();
export function registerHostAuthorityRoutes(app: FastifyInstance, client: SignedFleetAuthorityClient): void {
  app.post('/v3/fleet/hosts/:host_id/authority', { bodyLimit: 262_144 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.headers.cookie !== undefined) return reply.code(403).send({ error: 'AUTHORITY_REVOKED' });
    const abort = new AbortController(); const aborted = () => { abort.abort(); };
    request.raw.once('aborted', aborted);
    try {
      const { host_id } = Params.parse(request.params); const packet = SignedHostRequestSchema.parse(request.body);
      if (packet.host_id !== host_id) return await reply.code(403).send({ error: 'AUTHORITY_REVOKED' });
      return await client.invoke(host_id, packet, abort.signal);
    } catch (error) {
      return await reply.code(error instanceof z.ZodError ? 400 : error instanceof SignedFleetAuthorityError ? error.statusCode : 503)
        .send({ error: error instanceof z.ZodError ? 'INVALID_REQUEST' : error instanceof SignedFleetAuthorityError ? error.code : 'AUTHORITY_UNAVAILABLE' });
    } finally { request.raw.removeListener('aborted', aborted); }
  });
}
