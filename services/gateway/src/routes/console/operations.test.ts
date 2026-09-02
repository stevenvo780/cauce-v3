import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevOnlyAuthProvider } from '../../auth.js';
import { fakePool } from '../../test-support/gateway-doubles.js';
import type { ConsoleRouteRepository } from './contracts.js';
import { registerConsoleOperationsRoutes } from './operations.js';

const apps: FastifyInstance[] = [];
const HEADERS = { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' };

function fixture(terminalCapability?: Readonly<Record<string, unknown>>) {
  const repository = {
    assertPermission: vi.fn(async () => undefined),
    getConfiguration: vi.fn(async () => ({ revision: 7 })),
    applyConfigurationChange: vi.fn(async () => ({ applied: true })),
    rollbackConfiguration: vi.fn(async () => ({ applied: true })),
    status: vi.fn(async () => ({ online: 3 })),
    queueSnapshot: vi.fn(async () => ({ pending: 2 })),
    listJobs: vi.fn(async () => ({ items: [{ id: 'job-1' }] })),
    listOriginRelays: vi.fn(async () => ({ items: [{ relay_id: 'relay-1' }] })),
  };
  const app = Fastify({ logger: false });
  registerConsoleOperationsRoutes(app, {
    options: {
      pool: fakePool(),
      authProvider: DevOnlyAuthProvider.forTests(),
      ...(terminalCapability === undefined ? {} : { terminalCapability }),
    },
    repository: repository as unknown as ConsoleRouteRepository,
    allowedJobKinds: new Set(),
  });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('rutas de operación de la consola', () => {
  it('publica la capacidad terminal exacta sólo después de autorizar control', async () => {
    const capability = { available: true, backend: 'terminal-relay', protocol: 3 };
    const { app, repository } = fixture(capability);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/terminal/capability', headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(capability);
    expect(repository.assertPermission).toHaveBeenCalledWith('Steven', 'kant', 'control');
  });

  it('falla explícitamente cuando el backend terminal no está configurado', async () => {
    const { app, repository } = fixture();
    const response = await app.inject({
      method: 'GET', url: '/v3/console/terminal/capability', headers: HEADERS,
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      available: false, reason: 'PTY backend capability is not configured',
    });
    expect(repository.assertPermission).toHaveBeenCalledWith('Steven', 'kant', 'control');
  });

  it.each(['0', '1.5', 'infinita'])('rechaza la revisión %s antes del repositorio', async (revisionId) => {
    const { app, repository } = fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/config/revisions/${revisionId}/rollback`,
      headers: HEADERS,
      payload: { dry_run: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request', message: 'revision id must be positive',
    });
    expect(repository.rollbackConfiguration).not.toHaveBeenCalled();
  });

  it('compone observabilidad con las cuatro fuentes del mismo actor', async () => {
    const { app, repository } = fixture();
    const response = await app.inject({
      method: 'GET', url: '/v3/console/observability', headers: HEADERS,
    });
    const body = response.json<{
      readonly observed_at: string;
      readonly status: { readonly online: number };
      readonly queues: { readonly pending: number };
      readonly jobs: { readonly items: readonly { readonly id: string }[] };
      readonly origin_relays: { readonly items: readonly { readonly relay_id: string }[] };
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(body).toEqual({
      observed_at: body.observed_at,
      status: { online: 3 },
      queues: { pending: 2 },
      jobs: { items: [{ id: 'job-1' }] },
      origin_relays: { items: [{ relay_id: 'relay-1' }] },
    });
    for (const source of [
      repository.status,
      repository.queueSnapshot,
      repository.listJobs,
      repository.listOriginRelays,
    ]) {
      expect(source).toHaveBeenCalledOnce();
      expect(source).toHaveBeenCalledWith('Steven', 'kant');
    }
  });
});
