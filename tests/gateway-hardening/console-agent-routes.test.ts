import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GatewayRepository } from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, buildTestGateway, fakeRepository, grants, testPrincipal,
} from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function gateway(repository: GatewayRepository = fakeRepository()) {
  const app = await buildTestGateway({
    repository,
    authProvider: new FixedAuthProvider(testPrincipal({
      tenant_id: 'Steven', alias: 'kant', roles: [], permissions: grants('route', 'read'),
    })),
  });
  apps.push(app);
  return app;
}

describe('console agent routes and retired core aliases', () => {
  it('answers the tenant-qualified agent detail from its own handler', async () => {
    const repository = fakeRepository();
    repository.getAgentByIdentity = vi.fn(async (tenantId: string, alias: string) => ({
      tenant_id: tenantId, alias, enabled: true,
    }));
    const app = await gateway(repository);

    const response = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Steven/agents/zeus',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: 'Steven', alias: 'zeus' });
  });

  it('keeps POST /v3/messages mounted and leaves the retired /v3/publish alias unrouted', async () => {
    const app = await gateway();

    const retired = await app.inject({ method: 'POST', url: '/v3/publish', payload: {} });
    const canonical = await app.inject({ method: 'POST', url: '/v3/messages', payload: {} });

    // The default Fastify not-found body proves the alias has no route at all, which a handler
    // returning 404 for an absent resource could not produce.
    expect(retired.statusCode).toBe(404);
    expect(retired.json()).toMatchObject({ message: 'Route POST:/v3/publish not found' });
    expect(canonical.statusCode).not.toBe(404);
  });

  it('keeps both claim paths mounted while /v3/query still has a caller', async () => {
    const app = await gateway();

    const canonical = await app.inject({ method: 'POST', url: '/v3/deliveries/query', payload: {} });
    const alias = await app.inject({ method: 'POST', url: '/v3/query', payload: {} });

    expect(canonical.statusCode).not.toBe(404);
    expect(alias.statusCode).toBe(canonical.statusCode);
  });
});
