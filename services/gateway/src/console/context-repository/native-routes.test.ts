import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, AuthorizationError } from '../../auth.js';
import { registerNativeContextRepositoryRoutes, type NativeContextRepositoryRouteDeps } from './native-routes.js';
import { writeNativeFixture } from './native-test-fixtures.js';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
let root: string;
let commit: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cauce-native-route-')); commit = await writeNativeFixture(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function route(overrides: Partial<NativeContextRepositoryRouteDeps> = {}) {
  const handlers = new Map<string, Handler>();
  const app = { get: (path: string, handler: Handler) => { handlers.set(path, handler); } } as unknown as FastifyInstance;
  const deps: NativeContextRepositoryRouteDeps = {
    binding: { repositoryPath: root, instance_id: 'fixture' },
    authorize: vi.fn(async () => ({ tenant_id: 'Steven', alias: 'operator' })),
    authorizeTarget: vi.fn<NativeContextRepositoryRouteDeps['authorizeTarget']>(async (_actor, tenant_id, alias) => ({ tenant_id, alias })), ...overrides,
  };
  registerNativeContextRepositoryRoutes(app, deps);
  async function request(query: Record<string, unknown> = { commit }, params = { tenantId: 'Steven', alias: 'helper' }) {
    let status = 200;
    let body: unknown;
    const headers: Record<string, string> = {};
    const reply = {
      header: (key: string, value: string) => { headers[key] = value; return reply; },
      code: (value: number) => { status = value; return reply; },
      send: (value: unknown) => { body = value; return reply; },
    };
    const handler = handlers.get('/v3/console/tenants/:tenantId/agents/:alias/context/repository/native-inspect');
    if (handler === undefined) throw new Error('Missing native route');
    const result = await handler({ query, params } as unknown as FastifyRequest, reply as unknown as FastifyReply);
    return { status, body: body ?? result, headers };
  }
  return { request, deps, handlers };
}

describe('native inspection route without server or sockets', () => {
  it('registers only GET and verifies authorization before/after reading', async () => {
    const { request, deps, handlers } = route();
    expect(handlers.size).toBe(1);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toMatchObject({ tenant_id: 'Steven', alias: 'helper', applySupported: false,
      desired: { scope: { instance_id: 'fixture', tenant_id: 'Steven', alias: 'helper' } } });
    expect(deps.authorize).toHaveBeenCalledTimes(2);
    expect(deps.authorizeTarget).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response.body)).not.toContain(root);
  });
  it.each([new AuthError('private'), new AuthorizationError('private')])('rejects denied authentication before IO', async (error) => {
    const { request, deps } = route({ binding: { instance_id: 'fixture', repositoryPath: '/absent' }, authorize: async () => { throw error; } });
    const response = await request();
    expect([401, 403]).toContain(response.status);
    expect(deps.authorizeTarget).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
  it.each(['denied', 'wrong-tenant', 'wrong-alias', 'session-revoked'])('does not release bytes after %s', async (change) => {
    let reads = 0;
    const target = { tenant_id: 'Steven', alias: 'helper' };
    const authorizeTarget: NativeContextRepositoryRouteDeps['authorizeTarget'] = async () => {
      reads += 1;
      if (reads === 1) return target;
      if (change === 'denied') return undefined;
      if (change === 'wrong-tenant') return { ...target, tenant_id: 'Other' };
      if (change === 'wrong-alias') return { ...target, alias: 'other' };
      throw new AuthError('revoked');
    };
    const response = await route({ authorizeTarget }).request();
    expect([401, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain('manualSource');
  });
  it.each([{ commit: 'main' }, { commit: 'a'.repeat(40), path: 'private' }, { commit: [] }, { commit: 'a'.repeat(40), previous_commit: [] }])(
    'rejects selectors outside the contract %#', async (query) => {
      expect([400, 422]).toContain((await route().request(query)).status);
    },
  );
  it('keeps errors bounded and binding immutable', async () => {
    const binding = { repositoryPath: root, instance_id: 'fixture' };
    const registered = route({ binding });
    binding.instance_id = 'other';
    expect((await registered.request()).status).toBe(200);
    expect((await registered.request({ commit: 'f'.repeat(40) })).body).toEqual({ error: 'context_snapshot_unavailable', reason: 'object_unavailable' });
  });
});
