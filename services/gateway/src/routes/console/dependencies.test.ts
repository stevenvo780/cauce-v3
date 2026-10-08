import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, ConfigurationError, ConfigurationRepository, type ConfigurationDependencyPreview } from '@cauce/store';
import { DevOnlyAuthProvider } from '../../auth.js';
import { fakePool } from '../../test-support/gateway-doubles.js';
import type { ConsoleRouteRepository } from './contracts.js';
import { registerConsoleOperationsRoutes } from './operations.js';

const apps: FastifyInstance[] = [];
const HEADERS = { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' };
const mutation = { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'group-a' } as const;
const preview: ConfigurationDependencyPreview = {
  revision: 7, resource: 'room', identity: { tenant_id: 'Steven', id: 'group-a' },
  dependencies: [{ type: 'memberships', identity: { alias: 'jarvis', room_id: 'group-a' }, blocking: true }],
  can_delete: false,
};

function fixture(permissions: ('read' | 'control')[] = ['read', 'control']) {
  const repository = {
    getConfigurationDependencies: vi.fn(async () => preview),
    applyConfigurationChange: vi.fn(async () => undefined),
  };
  const app = Fastify({ logger: false });
  registerConsoleOperationsRoutes(app, {
    options: { pool: fakePool(), authProvider: DevOnlyAuthProvider.forTests({ roles: ['operator'], permissions }) },
    repository: repository as unknown as ConsoleRouteRepository,
    allowedJobKinds: new Set(),
  });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  vi.restoreAllMocks();
});

describe('configuration dependency preview', () => {
  it('returns an actor-scoped preview at the observed revision without mutating', async () => {
    const { app, repository } = fixture();
    const response = await app.inject({
      method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(preview);
    expect(repository.getConfigurationDependencies).toHaveBeenCalledWith('Steven', 'kant', mutation, 7);
    expect(repository.applyConfigurationChange).not.toHaveBeenCalled();
  });

  it('requires operator control before resolving dependencies', async () => {
    const { app, repository } = fixture(['read']);
    const response = await app.inject({
      method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 },
    });
    expect(response.statusCode).toBe(403);
    expect(repository.getConfigurationDependencies).not.toHaveBeenCalled();
  });

  it.each([
    { mutation, expected_revision: -1 },
    { mutation, expected_revision: 0.5 },
    { mutation: { resource: 'batch', action: 'apply', mutations: [mutation] }, expected_revision: 7 },
    { mutation, expected_revision: 7, credential: 'must-not-pass' },
  ])('rejects invalid or non-leaf dependency requests before store access', async (payload) => {
    const { app, repository } = fixture();
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS, payload });
    expect(response.statusCode).toBe(400);
    expect(repository.getConfigurationDependencies).not.toHaveBeenCalled();
  });

  it('reports OCC conflicts as conflicts and preserves safe durable dependencies', async () => {
    const { app, repository } = fixture();
    repository.getConfigurationDependencies.mockRejectedValue(new ConfigurationError('conflict', 'configuration resource has durable dependencies', preview.dependencies));
    const response = await app.inject({
      method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', message: 'configuration resource has durable dependencies', dependencies: preview.dependencies });
  });

  it.each([
    { ...preview, revision: 8 },
    { ...preview, identity: { tenant_id: 'Pablo', id: 'another-group' } },
    { ...preview, can_delete: true },
    { ...preview, dependencies: [{ type: 'credentials', identity: { credential_ref: 'SECRET_SENTINEL' }, blocking: true }] },
  ])('does not publish a mismatched or unsafe dependency receipt', async (receipt) => {
    const { app, repository } = fixture();
    repository.getConfigurationDependencies.mockResolvedValue(receipt);
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 } });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('SECRET_SENTINEL');
  });

  it('does not expose secrets through malformed conflict dependencies', async () => {
    const { app, repository } = fixture();
    repository.getConfigurationDependencies.mockRejectedValue(new ConfigurationError('conflict', 'configuration resource has durable dependencies',
      [{ type: 'credentials', identity: { credential_ref: 'SECRET_SENTINEL' }, blocking: true }]));
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 } });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('SECRET_SENTINEL');
  });

  it('reports unsupported preview explicitly when the repository binding is missing', async () => {
    const { app, repository } = fixture();
    Reflect.deleteProperty(repository, 'getConfigurationDependencies');
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 } });
    expect(response.statusCode).toBe(501);
    expect(repository.applyConfigurationChange).not.toHaveBeenCalled();
  });

  it('does not expose unexpected database errors', async () => {
    const { app, repository } = fixture();
    repository.getConfigurationDependencies.mockRejectedValue(new Error('postgres password=SECRET_SENTINEL'));
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/dependencies', headers: HEADERS,
      payload: { mutation, expected_revision: 7 } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('SECRET_SENTINEL');
  });

  it('the Cauce facade forwards the exact actor and CAS revision and preserves safe dependency errors', async () => {
    const backend = vi.spyOn(ConfigurationRepository.prototype, 'getDependencies').mockResolvedValue(preview);
    const repository = new CauceRepository(fakePool());
    await expect(repository.getConfigurationDependencies('Steven', 'kant', mutation, 7)).resolves.toEqual(preview);
    expect(backend).toHaveBeenCalledWith('Steven', 'kant', mutation, 7);
    const conflict = new ConfigurationError('conflict', 'configuration resource has durable dependencies', preview.dependencies);
    backend.mockRejectedValue(conflict);
    await expect(repository.getConfigurationDependencies('Steven', 'kant', mutation, 7)).rejects.toBe(conflict);
  });
});
