import Fastify, { type FastifyInstance } from 'fastify';
import { buildTestGateway, fakePool, fakeRepository } from '../../test-support/gateway-doubles.js';
import type { ProfileRevisionEntry } from '@cauce/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, AuthorizationError } from '../../auth.js';
import { registerContextRepositoryRoutes, type ContextRepositoryRouteDeps } from './routes.js';

const PROFILE = {
  purpose: 'Review synthetic context', role_summary: null, human_brief: null,
  responsibilities: ['Review'], restrictions: [], tools: [], operating_rules: [],
};
const JOURNAL: ProfileRevisionEntry = {
  ...PROFILE, tenant_id: 'Steven', alias: 'helper', id: '42', revision: 1,
  operation: 'insert', actor_tenant: 'private-actor', actor_alias: 'private-actor', changed_at: 'private-time',
};
const BASE = '/v3/console/tenants/Steven/agents/helper/context/repository';
const ROOT = '/synthetic/context-repository';

describe('context repository capability', () => {
  let app: FastifyInstance;

  function server(overrides: Partial<ContextRepositoryRouteDeps> = {}, configured = true) {
    const deps: ContextRepositoryRouteDeps = {
      ...(configured ? { binding: { instance_id: 'fixture', repositoryPath: ROOT } } : {}),
      authorize: vi.fn(async () => ({ tenant_id: 'Steven', alias: 'operator' })),
      authorizeTarget: vi.fn<ContextRepositoryRouteDeps['authorizeTarget']>(async (_actor, tenant_id, alias) => ({ tenant_id, alias })),
      ...overrides,
    };
    app = Fastify();
    registerContextRepositoryRoutes(app, deps);
    return deps;
  }

  afterEach(async () => { await app.close(); });

  it('reports configured, without claiming source observation or exposing the local path', async () => {
    server();
    const response = await app.inject({ url: BASE });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ tenant_id: 'Steven', alias: 'helper', state: 'configured',
      instance_id: 'fixture', storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated' });
    expect(response.body).not.toContain(ROOT);
  });

  it('reports absent binding without creating one', async () => {
    server({}, false);
    expect((await app.inject({ url: BASE })).json()).toMatchObject({ state: 'not_configured', instance_id: null });
  });

  it.each([new AuthError('private-auth-detail'), new AuthorizationError('private-denial')])(
    'authenticates before resolving the target', async (error) => {
      const deps = server({ authorize: async () => { throw error; } });
      const response = await app.inject({ url: BASE });
      expect([401, 403]).toContain(response.statusCode);
      expect(response.body).not.toContain('private-');
      expect(deps.authorizeTarget).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { tenant_id: 'steven', alias: 'helper' }, { tenant_id: 'Steven', alias: 'other' }])(
    'hides inaccessible and nonexact targets %#', async (target) => {
      server({ authorizeTarget: async () => target });
      expect((await app.inject({ url: BASE })).statusCode).toBe(404);
    },
  );

  it('rejects unknown query fields', async () => {
    server();
    expect((await app.inject({ url: `${BASE}?root=/tmp` })).statusCode).toBe(400);
  });

  it('publishes no inspection or mutation route', async () => {
    server();
    expect((await app.inject({ url: `${BASE}/inspect?commit=${'a'.repeat(40)}` })).statusCode).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: BASE, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method, url: `${BASE}/inspect`, payload: {} })).statusCode).toBe(404);
    }
  });

  it('wires the server binding and canonical ACL through buildGateway', async () => {
    const pool = fakePool({ ...JOURNAL, changed_at: new Date('2026-01-01T00:00:00Z') });
    const repository = fakeRepository();
    app = await buildTestGateway({ pool, repository,
      contextRepository: { instance_id: 'fixture', repositoryPath: ROOT }, outboxPollMs: 60_000 });
    const response = await app.inject({ url: BASE,
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'operator' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'configured', instance_id: 'fixture' });
    expect(repository.authorizeAgentTarget).toHaveBeenCalledWith('Steven', 'operator', 'Steven', 'helper', 'read');
    expect((await app.inject({ url: `${BASE}/inspect?commit=${'a'.repeat(40)}`,
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'operator' } })).statusCode).toBe(404);
    const preview = await app.inject({ method: 'POST', url: `${BASE}/preview`, payload: {},
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'operator' } });
    expect([403, 404]).toContain(preview.statusCode);
  });
});
