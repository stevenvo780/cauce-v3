import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';

interface RouteKey {
  readonly method: 'GET' | 'POST';
  readonly url: string;
}

const CONSOLE_PUBLISH_ROUTES: readonly RouteKey[] = [
  { method: 'POST', url: '/v3/console/publish-intents' },
  { method: 'POST', url: '/v3/console/publish-intents/confirm' },
];

const CHAIN_GATE_ROUTES: readonly RouteKey[] = [
  { method: 'GET', url: '/v3/console/chain-gates' },
  { method: 'POST', url: '/v3/console/chain-gates/:gateId/answer' },
  { method: 'POST', url: '/v3/console/chain-gates/:gateId/cancel' },
];

const NEIGHBOR_ROUTES: readonly RouteKey[] = [
  { method: 'GET', url: '/v3/console/messages' },
  { method: 'POST', url: '/v3/console/messages' },
  { method: 'GET', url: '/v3/console/chains/:traceId' },
  { method: 'GET', url: '/v3/console/config' },
];

const apps: FastifyInstance[] = [];

function pool(): DatabasePool {
  return {
    query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })),
  } as unknown as DatabasePool;
}

async function gateway(options: {
  readonly enableLegacyCandidateRoutes?: boolean;
  readonly missing?: 'answer' | 'cancel';
  readonly routePermission?: boolean;
} = {}) {
  const listChainGates = vi.fn(async () => ({ items: [{ gate_id: 'gate-1' }] }));
  const answerChainGate = vi.fn(async (gateId: string, answer: string) => ({
    gate_id: gateId, answer, state: 'answered',
  }));
  const cancelChainGate = vi.fn(async (gateId: string) => ({
    gate_id: gateId, state: 'cancelled',
  }));
  const repository = {
    claimWakeOutbox: vi.fn(async () => []),
    listChainGates,
    ...(options.missing === 'answer' ? {} : { answerChainGate }),
    ...(options.missing === 'cancel' ? {} : { cancelChainGate }),
  } as unknown as GatewayRepository;
  const app = await buildGateway({
    pool: pool(),
    authProvider: DevOnlyAuthProvider.forTests(options.routePermission === false ? {
      roles: ['operator'], permissions: ['read'],
    } : {}),
    repository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    outboxPollMs: 60_000,
    consoleOrigins: ['http://localhost'],
    logger: false,
    ...(options.enableLegacyCandidateRoutes === undefined
      ? {}
      : { enableLegacyCandidateRoutes: options.enableLegacyCandidateRoutes }),
  });
  await app.ready();
  apps.push(app);
  return { app, answerChainGate, cancelChainGate, listChainGates };
}

function hasRoute(app: FastifyInstance, route: RouteKey): boolean {
  return app.hasRoute(route);
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('legacy-candidate route flag', () => {
  it.each([
    ['omitted', undefined],
    ['true', true],
  ] as const)('registers publish and chain-gate routes when the flag is %s', async (_label, flag) => {
    const { app } = await gateway({
      ...(flag === undefined ? {} : { enableLegacyCandidateRoutes: flag }),
    });

    expect(CONSOLE_PUBLISH_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
    expect(CHAIN_GATE_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
    expect(NEIGHBOR_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
  });

  it('keeps publish routes live and disables only chain-gate routes when the flag is false', async () => {
    const { app } = await gateway({ enableLegacyCandidateRoutes: false });

    expect(CONSOLE_PUBLISH_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
    expect(CHAIN_GATE_ROUTES.every((route) => hasRoute(app, route))).toBe(false);
    expect(NEIGHBOR_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
  });

  it('forwards the chain-gate list query to the repository unchanged', async () => {
    const { app, listChainGates } = await gateway();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/chain-gates?status=all&limit=7',
      headers: {
        'x-cauce-tenant': 'Steven',
        'x-cauce-alias': 'kant',
        origin: 'http://localhost',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ gate_id: 'gate-1' }] });
    expect(listChainGates).toHaveBeenCalledWith('Steven', 'kant', {
      status: 'all',
      limit: 7,
    });
  });

  it('reenvía respuesta y cancelación con la identidad exacta del operador', async () => {
    const { app, answerChainGate, cancelChainGate } = await gateway();
    const headers = {
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': 'kant',
      origin: 'http://localhost',
    };

    const answer = await app.inject({
      method: 'POST', url: '/v3/console/chain-gates/gate-7/answer', headers,
      payload: { answer: 'aprobar' },
    });
    const cancel = await app.inject({
      method: 'POST', url: '/v3/console/chain-gates/gate-8/cancel', headers,
    });

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ gate_id: 'gate-7', answer: 'aprobar', state: 'answered' });
    expect(answerChainGate).toHaveBeenCalledWith('gate-7', 'aprobar', 'Steven', 'kant');
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ gate_id: 'gate-8', state: 'cancelled' });
    expect(cancelChainGate).toHaveBeenCalledWith('gate-8', 'Steven', 'kant');
  });

  it.each([
    ['answer', '/v3/console/chain-gates/gate-7/answer'],
    ['cancel', '/v3/console/chain-gates/gate-8/cancel'],
  ] as const)('responde 404 cuando el despliegue no monta %s', async (missing, url) => {
    const { app } = await gateway({ missing });
    const response = await app.inject({
      method: 'POST', url,
      headers: {
        'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant', origin: 'http://localhost',
      },
      ...(missing === 'answer' ? { payload: { answer: 'aprobar' } } : {}),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'not_found', message: 'chain gates are not available in this deployment',
    });
  });

  it('no alcanza el repositorio si el principal carece de route', async () => {
    const { app, answerChainGate } = await gateway({ routePermission: false });
    const response = await app.inject({
      method: 'POST', url: '/v3/console/chain-gates/gate-7/answer',
      headers: {
        'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant', origin: 'http://localhost',
      },
      payload: { answer: 'aprobar' },
    });

    expect(response.statusCode).toBe(403);
    expect(answerChainGate).not.toHaveBeenCalled();
  });
});
