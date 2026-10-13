import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetCapability, FleetHost } from '@cauce/protocol';
import { FleetOperationError, type CompanyAuthoritySource, type DatabaseClient, type DatabasePool } from '@cauce/store';
import type { FastifyRequest } from 'fastify';
import { AuthError, type AuthProvider } from '../auth.js';
import { FixedAuthProvider, testPrincipal } from '../test-support/gateway-doubles.js';
import { registerFleetHostRoutes, type FleetHostHumanAccess, type FleetHostRepository } from './fleet-hosts.routes.js';

const PATH = '/v3/console/fleet/hosts';
const HOST_ID = 'server';
const operator = testPrincipal({ tenant_id: 'Steven', alias: 'kant', roles: ['operator'], permissions: ['read', 'control'] });
const capability: FleetCapability = { available: true, actions: ['create', 'update', 'start', 'stop', 'retire'],
  placements: [{ host_id: HOST_ID, modes: ['native'], runtime_users: ['dev'], systemd_users: [],
    home_roots: ['/home/dev'], state_roots: ['/home/dev/state'] }] };
const authority: CompanyAuthoritySource = async () => ({ humanId: 'human-id', homeTenant: 'Steven', alias: 'kant',
  homeCompany: 'humanizar', actingCompany: 'humanizar', role: 'company_owner', scope: 'company', platformOverride: false });
const host: FleetHost = {
  host_id: HOST_ID, display_name: 'Servidor', notes: '', enabled: true, status: 'reachable', status_source: 'controller',
  last_seen_at: '2026-10-07T20:00:00.000Z', registered: true, approved: true, version: 3, agents: [],
};
const apps: FastifyInstance[] = [];

class DenyAuthProvider implements AuthProvider {
  readonly name = 'deny-test';
  readonly mode = 'test' as const;
  async authenticateHttp(_request: FastifyRequest): Promise<never> { throw new AuthError(); }
  async authenticateHello(_request: FastifyRequest): Promise<never> { throw new AuthError(); }
}

function repositoryDouble() {
  return {
    list: vi.fn(async (): Promise<unknown> => [host]),
    create: vi.fn(async (): Promise<unknown> => ({ ...host, host_id: 'nueva', display_name: 'Nueva', version: 0, approved: false, registered: true })),
    update: vi.fn(async (): Promise<unknown> => ({ ...host, enabled: false, version: 4 })),
    delete: vi.fn(async (): Promise<void> => undefined),
  } satisfies Record<keyof FleetHostRepository, unknown>;
}

async function fixture(options: { actor?: FixedAuthProvider | AuthProvider; human?: boolean; capability?: FleetCapability } = {}) {
  const repository = repositoryDouble();
  const pool = {} as DatabasePool;
  const app = Fastify({ logger: false }); apps.push(app);
  const access: FleetHostHumanAccess = async () => options.human === false ? undefined : ({
    options: { signal: new AbortController().signal, humanAuthority: async () => ({ humanId: 'human-id', tenantId: 'Steven', actorAlias: 'kant' }) },
    companyAuthority: authority, close: () => undefined,
  });
  registerFleetHostRoutes(app, options.actor ?? new FixedAuthProvider(operator), pool, options.capability ?? capability, repository, access);
  return { app, repository };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('fleet host routes', () => {
  it('rejects missing authentication before any read or write', async () => {
    const { app, repository } = await fixture({ actor: new DenyAuthProvider() });
    for (const request of [
      { method: 'GET' as const, url: PATH },
      { method: 'POST' as const, url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } },
      { method: 'PATCH' as const, url: `${PATH}/${HOST_ID}`, payload: { expected_version: 3, enabled: false } },
      { method: 'DELETE' as const, url: `${PATH}/${HOST_ID}?expected_version=3` },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it('lists hosts with approval derived from the configured fleet placements', async () => {
    const { app, repository } = await fixture({ actor: new FixedAuthProvider(testPrincipal({ permissions: ['read'] })) });
    const response = await app.inject({ method: 'GET', url: PATH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hosts: [host] });
    expect(repository.list).toHaveBeenCalledWith(expect.any(Function), [HOST_ID]);
  });
  it('invokes company authority with its verified session receiver before releasing it', async () => {
    const app = Fastify({ logger: false });apps.push(app);
    const client = {} as DatabaseClient;const repository = repositoryDouble();let closed = false;
    const human = {
      options: { signal: new AbortController().signal, humanAuthority: async () => ({ humanId: 'human-id', tenantId: 'Steven', actorAlias: 'kant' }) },
      async companyAuthority(actual: DatabaseClient) {
        expect(this).toBe(human);expect(actual).toBe(client);expect(closed).toBe(false);
        return authority(actual);
      },
      close: () => { closed = true; },
    };
    const list = vi.fn(async (source: CompanyAuthoritySource) => {
      expect(await source(client)).toMatchObject({ humanId: 'human-id', actingCompany: 'humanizar' });return [host];
    });
    registerFleetHostRoutes(app, new FixedAuthProvider(operator), {} as DatabasePool, capability, { ...repository, list }, async () => human);
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(200);
    expect(list).toHaveBeenCalledOnce();expect(closed).toBe(true);
  });

  it('requires a verified human session even when an operator alias has hub topology', async () => {
    const { app, repository } = await fixture({ human: false });
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(403);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('lists no approved hosts when the fleet capability is unavailable', async () => {
    const { app, repository } = await fixture({ capability: { available: false, actions: [], placements: [], reason: 'executor_unconfigured' } });
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(200);
    expect(repository.list).toHaveBeenCalledWith(expect.any(Function), []);
  });

  it('requires the read permission for listing', async () => {
    const { app, repository } = await fixture({ actor: new FixedAuthProvider(testPrincipal({ permissions: ['route'] })) });
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(403);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('requires operator control and a verified human before mutations', async () => {
    const readOnly = await fixture({ actor: new FixedAuthProvider(testPrincipal({ roles: ['operator'], permissions: ['read'] })) });
    const response = await readOnly.app.inject({ method: 'POST', url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } });
    expect(response.statusCode).toBe(403);
    expect(readOnly.repository.create).not.toHaveBeenCalled();

    const notHub = await fixture({ human: false });
    for (const request of [
      { method: 'POST' as const, url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } },
      { method: 'PATCH' as const, url: `${PATH}/${HOST_ID}`, payload: { expected_version: 3, enabled: false } },
      { method: 'DELETE' as const, url: `${PATH}/${HOST_ID}?expected_version=3` },
    ]) {
      expect((await notHub.app.inject(request)).statusCode).toBe(403);
    }
    const noControlRow = await fixture({ human: false });
    expect((await noControlRow.app.inject({ method: 'DELETE', url: `${PATH}/${HOST_ID}?expected_version=3` })).statusCode).toBe(403);
    for (const method of [...Object.values(notHub.repository), ...Object.values(noControlRow.repository)]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('passes the human company resolver to creation and validates the durable receipt', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'POST', url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ host_id: 'nueva', display_name: 'Nueva' });
    expect(repository.create).toHaveBeenCalledWith({ host_id: 'nueva', display_name: 'Nueva', notes: '' }, expect.any(Function), [HOST_ID]);
  });

  it('rejects invalid create bodies before writing', async () => {
    const { app, repository } = await fixture();
    for (const payload of [
      { host_id: 'Nueva', display_name: 'Nueva' }, { host_id: 'nueva', display_name: '' },
      { host_id: 'nueva', display_name: 'Nueva', enabled: false }, { host_id: 'nueva' },
    ]) {
      expect((await app.inject({ method: 'POST', url: PATH, payload })).statusCode).toBe(400);
    }
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('updates a host with the expected version and maps version conflicts and missing hosts', async () => {
    const { app, repository } = await fixture();
    const updated = await app.inject({ method: 'PATCH', url: `${PATH}/${HOST_ID}`, payload: { expected_version: 3, enabled: false } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: false, version: 4 });
    expect(repository.update).toHaveBeenCalledWith(HOST_ID, { expected_version: 3, enabled: false }, expect.any(Function), [HOST_ID]);

    repository.update.mockRejectedValueOnce(new FleetOperationError('conflict', 'fleet host version changed; reload and retry'));
    const conflict = await app.inject({ method: 'PATCH', url: `${PATH}/${HOST_ID}`, payload: { expected_version: 2, enabled: true } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'conflict', message: 'fleet host version changed; reload and retry' });

    repository.update.mockRejectedValueOnce(new FleetOperationError('not_found', 'fleet host was not found'));
    expect((await app.inject({ method: 'PATCH', url: `${PATH}/otro`, payload: { expected_version: 1, enabled: true } })).statusCode).toBe(404);
  });

  it('rejects invalid host ids and update bodies without touching the store', async () => {
    const { app, repository } = await fixture();
    for (const [url, payload] of [
      [`${PATH}/Servidor`, { expected_version: 3, enabled: false }],
      [`${PATH}/${HOST_ID}`, { enabled: false }],
      [`${PATH}/${HOST_ID}`, { expected_version: 0, enabled: false }],
      [`${PATH}/${HOST_ID}`, { expected_version: 3 }],
      [`${PATH}/${HOST_ID}`, { expected_version: 3, enabled: false, host_id: 'otro' }],
    ] as const) {
      expect((await app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(400);
    }
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('deletes with the expected version and returns 204', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({ method: 'DELETE', url: `${PATH}/${HOST_ID}?expected_version=3` });
    expect(response.statusCode).toBe(204);
    expect(repository.delete).toHaveBeenCalledWith(HOST_ID, 3, expect.any(Function));
  });

  it('requires a positive integer expected version for delete', async () => {
    const { app, repository } = await fixture();
    for (const url of [`${PATH}/${HOST_ID}`, `${PATH}/${HOST_ID}?expected_version=0`, `${PATH}/${HOST_ID}?expected_version=1.5`,
      `${PATH}/${HOST_ID}?expected_version=abc`]) {
      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(400);
    }
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('maps a computer that still has agents to 409 and a missing computer to 404 on delete', async () => {
    const { app, repository } = await fixture();
    repository.delete.mockRejectedValueOnce(new FleetOperationError('conflict', 'the computer still has agents; move or remove them first'));
    const conflict = await app.inject({ method: 'DELETE', url: `${PATH}/${HOST_ID}?expected_version=3` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'conflict' });

    repository.delete.mockRejectedValueOnce(new FleetOperationError('not_found', 'fleet host was not found'));
    expect((await app.inject({ method: 'DELETE', url: `${PATH}/${HOST_ID}?expected_version=3` })).statusCode).toBe(404);
  });

  it('refuses to return a host receipt that does not match the contract', async () => {
    const { app, repository } = await fixture();
    repository.create.mockResolvedValueOnce({ host_id: 'nueva' });
    const response = await app.inject({ method: 'POST', url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });
});
