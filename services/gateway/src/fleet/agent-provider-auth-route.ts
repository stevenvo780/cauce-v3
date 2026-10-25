import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, HostId, StoreError, type DatabasePool } from '@cauce/store';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { AgentAuthPacketSchema } from './agent-provider-auth-contracts.js';
import type { AgentProviderAuthBroker } from './agent-provider-auth-broker.js';
import { reconcileAgentRuntimes } from './agent-runtime-reconcile.js';

export function registerAgentProviderAuthHostRoute(app: FastifyInstance, pool: DatabasePool, broker: AgentProviderAuthBroker): void {
  const enrollment = new HostEnrollmentRepository(pool);
  app.post('/v3/fleet/hosts/:host_id/agent-auth', { bodyLimit: 262_144 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (request.headers.cookie !== undefined) throw new ProviderAuthError('AUTHORITY_REVOKED');
      const { host_id } = z.object({ host_id: HostId }).strict().parse(request.params);
      const outcome = await enrollment.request(host_id, 'POST', `/v3/fleet/hosts/${host_id}/agent-auth`, request.body, async (client, host) => {
        const packet = AgentAuthPacketSchema.parse((request.body as { payload: unknown }).payload);
        if (packet.action === 'reconcile') return { response: await reconcileAgentRuntimes(client, host, packet.receipts, packet.after), accept: (): void => undefined };
        return packet.action === 'exchange' ? broker.exchange(client, host, packet.events, packet.recovery_results)
          : { response: await broker.context(client, host, packet.id, packet.fence), accept: (): void => undefined };
      });
      outcome.accept(); return outcome.response;
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof ProviderAuthError || error instanceof StoreError ? 403 : 503;
      return reply.code(status).send({ error: 'agent_auth_unavailable', message: 'No se pudo acreditar la sesión de autenticación del agente.' });
    }
  });
  app.addHook('onClose', () => broker.shutdown());
}
