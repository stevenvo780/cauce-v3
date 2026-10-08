import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetCapability, FleetHost } from '@cauce/protocol';
import { FleetOperationError, type DatabasePool } from '@cauce/store';
import type { FastifyRequest } from 'fastify';
import { AuthError, type AuthProvider } from '../auth.js';
import { FixedAuthProvider, testPrincipal } from '../test-support/gateway-doubles.js';
import { registerFleetHostRoutes, type FleetHostRepository } from './fleet-hosts.routes.js';

const PATH = '/v3/console/fleet/hosts';
const HOST_ID = 'server';
const operator = testPrincipal({ tenant_id: 'Steven', alias: 'kant', roles: ['operator'], permissions: ['read', 'control'] });
const capability: FleetCapability = { available: true, actions: ['create', 'update', 'start', 'stop', 'retire'],
  placements: [{ host_id: HOST_ID, modes: ['native'], runtime_users: ['stev'], systemd_users: [],
    home_roots: ['/home/stev'], state_roots: ['/home/stev/state'] }] };
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

function poolDouble(isHub: boolean | 'missing' = true) {
  const query = vi.fn(async () => ({ rows: isHub === 'missing' ? [] : [{ is_hub: isHub }], rowCount: 1 }));
  return { pool: { query } as unknown as DatabasePool, query };
}

async function fixture(options: { actor?: FixedAuthProvider | AuthProvider; isHub?: boolean | 'missing'; capability?: FleetCapability } = {}) {
  const repository = repositoryDouble();
  const { pool, query } = poolDouble(options.isHub);
  const app = Fastify({ logger: false });
  apps.push(app);
  registerFleetHostRoutes(app, options.actor ?? new FixedAuthProvider(operator), pool, options.capability ?? capability, repository);
  return { app, repository, query };
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
    expect(repository.list).toHaveBeenCalledWith([HOST_ID]);
  });

  it('lists hosts only for a hub actor', async () => {
    const hub = await fixture();
    expect((await hub.app.inject({ method: 'GET', url: PATH })).statusCode).toBe(200);
    expect(hub.query).toHaveBeenCalledWith(expect.stringContaining('role.allow_control'), ['Steven', 'kant']);

    const notHub = await fixture({ isHub: false, actor: new FixedAuthProvider(testPrincipal({ permissions: ['read'] })) });
    expect((await notHub.app.inject({ method: 'GET', url: PATH })).statusCode).toBe(403);
    expect(notHub.repository.list).not.toHaveBeenCalled();

    const noControlRow = await fixture({ isHub: 'missing', actor: new FixedAuthProvider(testPrincipal({ permissions: ['read'] })) });
    expect((await noControlRow.app.inject({ method: 'GET', url: PATH })).statusCode).toBe(403);
    expect(noControlRow.repository.list).not.toHaveBeenCalled();
  });

  it('lists no approved hosts when the fleet capability is unavailable', async () => {
    const { app, repository } = await fixture({ capability: { available: false, actions: [], placements: [], reason: 'executor_unconfigured' } });
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(200);
    expect(repository.list).toHaveBeenCalledWith([]);
  });

  it('requires the read permission for listing', async () => {
    const { app, repository } = await fixture({ actor: new FixedAuthProvider(testPrincipal({ permissions: ['route'] })) });
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(403);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('requires operator control and hub authority before mutations', async () => {
    const readOnly = await fixture({ actor: new FixedAuthProvider(testPrincipal({ roles: ['operator'], permissions: ['read'] })) });
    const response = await readOnly.app.inject({ method: 'POST', url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } });
    expect(response.statusCode).toBe(403);
    expect(readOnly.repository.create).not.toHaveBeenCalled();

    const notHub = await fixture({ isHub: false });
    for (const request of [
      { method: 'POST' as const, url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } },
      { method: 'PATCH' as const, url: `${PATH}/${HOST_ID}`, payload: { expected_version: 3, enabled: false } },
      { method: 'DELETE' as const, url: `${PATH}/${HOST_ID}?expected_version=3` },
    ]) {
      expect((await notHub.app.inject(request)).statusCode).toBe(403);
    }
    const noControlRow = await fixture({ isHub: 'missing' });
    expect((await noControlRow.app.inject({ method: 'DELETE', url: `${PATH}/${HOST_ID}?expected_version=3` })).statusCode).toBe(403);
    for (const method of [...Object.values(notHub.repository), ...Object.values(noControlRow.repository)]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('creates a host for a hub operator and returns the validated receipt', async () => {
    const { app, repository, query } = await fixture();
    const response = await app.inject({ method: 'POST', url: PATH, payload: { host_id: 'nueva', display_name: 'Nueva' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ host_id: 'nueva', display_name: 'Nueva' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('role.allow_control'), ['Steven', 'kant']);
    expect(repository.create).toHaveBeenCalledWith({ host_id: 'nueva', display_name: 'Nueva', notes: '' }, [HOST_ID]);
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
    expect(repository.update).toHaveBeenCalledWith(HOST_ID, { expected_version: 3, enabled: false }, [HOST_ID]);

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
    expect(repository.delete).toHaveBeenCalledWith(HOST_ID, 3);
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
