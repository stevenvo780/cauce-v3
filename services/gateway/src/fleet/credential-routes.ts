import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../auth.js';
import { FleetCredentialRejectedError } from './mtls-identities.js';
import { isAuthorizedTlsSocket } from '../runtime-guards.js';
import { BootstrapPhaseSchema } from './bootstrap-contracts.js';

export interface FleetCredentialProviders { bootstrap: AuthProvider; normal: AuthProvider; token?: AuthProvider }
export function registerFleetCredentialRoutes(app: FastifyInstance, providers: FleetCredentialProviders): void {
  app.get('/v3/bootstrap/credentials/:kind', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = z.object({ kind: z.enum(['mtls', 'token']) }).strict().safeParse(request.params);
    const phase = BootstrapPhaseSchema.safeParse(request.headers['x-cauce-bootstrap-phase']);
    if (!input.success || !phase.success) return reply.code(400).send({ error: 'INVALID_CREDENTIAL_PROBE' });
    if (!isAuthorizedTlsSocket(request.raw.socket) || request.headers.cookie !== undefined) {
      return reply.code(403).send({ error: 'INVALID_CREDENTIAL_TRANSPORT' });
    }
    const provider = input.data.kind === 'token' ? providers.token : providers[phase.data];
    if (provider === undefined || (input.data.kind === 'mtls' && request.headers.authorization !== undefined)) {
      return reply.code(403).send({ error: 'INVALID_CREDENTIAL_TRANSPORT' });
    }
    try {
      const principal = await provider.authenticateHttp(request);
      if (principal.channel !== (phase.data === 'bootstrap' ? 'bootstrap' : 'adapter')) {
        return await reply.code(403).send({ error: 'INVALID_CREDENTIAL_NAMESPACE' });
      }
      return { credential_accepted: true, phase: phase.data, tenant_id: principal.tenant_id, alias: principal.alias, session_id: principal.session_id };
    } catch (error) {
      if (error instanceof FleetCredentialRejectedError) return reply.code(401).send({ error: 'CREDENTIAL_REJECTED' });
      return reply.code(503).send({ error: 'CREDENTIAL_PROBE_UNAVAILABLE' });
    }
  });
}
