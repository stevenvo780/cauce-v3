import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type AuthProvider } from '../auth.js';
import { isAuthorizedTlsSocket } from '../runtime-guards.js';
import {
  BootstrapAckSchema, BootstrapClaimSchema, BootstrapCreateSchema, BootstrapError, BootstrapPhaseSchema,
  type BootstrapIdentity, type BootstrapPhase,
} from './bootstrap-contracts.js';
import type { BootstrapRepository } from './bootstrap-repository.js';

const OperationQuery = z.object({ operation_id: z.uuid() }).strict();
const ProbeParams = z.object({ probe_id: z.uuid() }).strict();
export function registerBootstrapRoutes(app: FastifyInstance, bootstrapProvider: AuthProvider, normalProvider: AuthProvider,
  repository: Pick<BootstrapRepository, 'create' | 'read' | 'claim' | 'ack' | 'profile' | 'state'>): void {
  const authenticate = async (request: FastifyRequest, phase: BootstrapPhase): Promise<BootstrapIdentity> => {
    if (!isAuthorizedTlsSocket(request.raw.socket) || request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      throw new BootstrapError('forbidden');
    }
    const principal = await (phase === 'bootstrap' ? bootstrapProvider : normalProvider).authenticateHttp(request);
    if (principal.channel !== (phase === 'bootstrap' ? 'bootstrap' : 'adapter') || principal.roles.includes('operator')
        || (phase === 'bootstrap' && (principal.roles.length !== 0 || principal.permissions.length !== 0))) throw new BootstrapError('forbidden');
    return { tenant_id: principal.tenant_id, alias: principal.alias };
  };
  const phaseHeader = (request: FastifyRequest) => BootstrapPhaseSchema.parse(request.headers['x-cauce-bootstrap-phase']);
  const respond = async (reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> => {
    reply.header('cache-control', 'no-store');
    try { return await action(); } catch (error) {
      const code = error instanceof z.ZodError ? 'invalid_request' : error instanceof BootstrapError ? error.code : error instanceof AuthError ? 'forbidden' : 'unverified';
      const status = { invalid_request: 400, forbidden: 403, conflict: 409, not_found: 404, unverified: 503 }[code];
      return reply.code(status).send({ error: code });
    }
  };
  app.post('/v3/bootstrap/probes', { bodyLimit: 4096 }, async (request, reply) => respond(reply, async () => {
    const input = BootstrapCreateSchema.parse(request.body);
    const identity = await authenticate(request, input.phase);
    return reply.code(201).send(await repository.create(identity, input));
  }));
  app.get('/v3/bootstrap/probes/:probe_id', async (request, reply) => respond(reply, async () => {
    const { probe_id } = ProbeParams.parse(request.params); const phase = phaseHeader(request);
    return repository.read(await authenticate(request, phase), phase, probe_id);
  }));
  app.post('/v3/bootstrap/claim', { bodyLimit: 4096 }, async (request, reply) => respond(reply, async () => {
    const input = BootstrapClaimSchema.parse(request.body);
    return repository.claim(await authenticate(request, input.phase), input.operation_id, input.phase, input.runtime_key);
  }));
  app.post('/v3/bootstrap/probes/:probe_id/ack', { bodyLimit: 4096 }, async (request, reply) => respond(reply, async () => {
    const { probe_id } = ProbeParams.parse(request.params); const input = BootstrapAckSchema.parse(request.body);
    return repository.ack(await authenticate(request, input.phase), probe_id, input);
  }));
  app.get('/v3/bootstrap/profile', async (request, reply) => respond(reply, async () => {
    const { operation_id } = OperationQuery.parse(request.query); const phase = phaseHeader(request);
    return repository.profile(await authenticate(request, phase), operation_id, phase);
  }));
  app.get('/v3/bootstrap/state', async (request, reply) => respond(reply, async () => {
    const { operation_id } = OperationQuery.parse(request.query); const phase = phaseHeader(request);
    return repository.state(await authenticate(request, phase), operation_id, phase);
  }));
}
