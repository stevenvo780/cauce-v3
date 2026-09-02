import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildGateway } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';
import { fakePool, fakeRepository } from '../test-support/gateway-doubles.js';

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

async function gateway(options: { readonly routePermission?: boolean } = {}) {
  const listChainGates = vi.fn(async () => ({ items: [{ gate_id: 'gate-1' }] }));
  const answerChainGate = vi.fn(async (gateId: string, answer: string) => ({
    gate_id: gateId, answer, state: 'answered',
  }));
  const cancelChainGate = vi.fn(async (gateId: string) => ({
    gate_id: gateId, state: 'cancelled',
  }));
  const repository = fakeRepository();
  repository.listChainGates = listChainGates;
  repository.answerChainGate = answerChainGate;
  repository.cancelChainGate = cancelChainGate;
  const app = await buildGateway({
    pool: fakePool(),
    authProvider: DevOnlyAuthProvider.forTests(options.routePermission === false ? {
      roles: ['operator'], permissions: ['read'],
    } : {}),
    repository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    outboxPollMs: 60_000,
    consoleOrigins: ['http://localhost'],
    logger: false,
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

describe('chain-gate routes', () => {
  it('mounts the chain-gate routes with no decision knob left to turn them off', async () => {
    const { app } = await gateway();

    expect(CONSOLE_PUBLISH_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
    expect(CHAIN_GATE_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
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
