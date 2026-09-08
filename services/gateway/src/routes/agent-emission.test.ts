import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevOnlyAuthProvider, type AuthProvider } from '../auth.js';
import { registerAgentEmissionRoutes } from './agent-emission.js';

const apps: FastifyInstance[] = [];
const headers = { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'socrates' };
const id = '10000000-0000-4000-8000-000000000001';
function gateway(provider: AuthProvider = DevOnlyAuthProvider.forTests()) {
  const app = Fastify();
  const calls = {
    agentQueue: vi.fn(async () => ({ deliveries: [], total: 0 })),
    recordAgentProgress: vi.fn(async () => ({ delivery_id: id, recorded: true, duplicate: false })),
    retryOwnDelivery: vi.fn(async () => ({ replayed: true })),
  };
  registerAgentEmissionRoutes(app, provider, calls);
  apps.push(app);
  return { app, calls };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('agent emission HTTP authority', () => {
  it('takes queue scope only from authenticated identity', async () => {
    const { app, calls } = gateway();
    const response = await app.inject({ method: 'GET', url: '/v3/agent/queue?tenant_id=Isa&alias=salva', headers });
    expect(response.statusCode).toBe(200);
    expect(calls.agentQueue).toHaveBeenCalledWith('Steven', 'socrates');
  });

  it('requires verified TLS for production even if another provider accepts the request', async () => {
    const auth = DevOnlyAuthProvider.forTests();
    const provider: AuthProvider = { name: 'production-test', mode: 'production',
      authenticateHttp: auth.authenticateHttp.bind(auth), authenticateHello: auth.authenticateHello.bind(auth) };
    const { app, calls } = gateway(provider);
    const response = await app.inject({ method: 'GET', url: '/v3/agent/queue', headers });
    expect(response.statusCode).toBe(401);
    expect(calls.agentQueue).not.toHaveBeenCalled();
  });

  it('does not accept a console operator as an agent identity', async () => {
    const { app, calls } = gateway(DevOnlyAuthProvider.forTests({ roles: ['operator'] }));
    const response = await app.inject({ method: 'GET', url: '/v3/agent/queue', headers });
    expect(response.statusCode).toBe(403);
    expect(calls.agentQueue).not.toHaveBeenCalled();
  });

  it('rejects injected authority fields and malformed progress before calling store', async () => {
    const { app, calls } = gateway();
    const response = await app.inject({ method: 'POST', url: `/v3/agent/deliveries/${id}/progress`, headers,
      payload: { text: '', attempt: 1, epoch: 1, claim_token: id, instance_id: 'test', tenant_id: 'Isa' } });
    expect(response.statusCode).toBe(422);
    expect(calls.recordAgentProgress).not.toHaveBeenCalled();
  });

  it('forwards exact fencing and scopes retry to the authenticated agent', async () => {
    const { app, calls } = gateway();
    const payload = { text: 'Checked input', attempt: 1, epoch: 2, claim_token: id, instance_id: 'test' };
    const progress = await app.inject({ method: 'POST', url: `/v3/agent/deliveries/${id}/progress`, headers, payload });
    const retry = await app.inject({ method: 'POST', url: `/v3/agent/deliveries/${id}/retry`, headers, payload: {} });
    expect(progress.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(calls.recordAgentProgress).toHaveBeenCalledWith(id, 'Steven', 'socrates', payload);
    expect(calls.retryOwnDelivery).toHaveBeenCalledWith(id, 'Steven', 'socrates');
  });
});
