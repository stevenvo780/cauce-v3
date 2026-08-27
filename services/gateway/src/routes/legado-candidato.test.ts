import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { buildGateway, type GatewayRepository } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';

interface RouteKey {
  readonly method: 'GET' | 'POST';
  readonly url: string;
}

const LEGACY_ROUTES: readonly RouteKey[] = [
  { method: 'POST', url: '/v3/console/publish-intents' },
  { method: 'POST', url: '/v3/console/publish-intents/confirm' },
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

async function gateway(enableLegacyCandidateRoutes?: boolean) {
  const listChainGates = vi.fn(async () => ({ items: [{ gate_id: 'gate-1' }] }));
  const repository = {
    claimWakeOutbox: vi.fn(async () => []),
    listChainGates,
  } as unknown as GatewayRepository;
  const app = await buildGateway({
    pool: pool(),
    authProvider: DevOnlyAuthProvider.forTests(),
    repository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    outboxPollMs: 60_000,
    consoleOrigins: ['http://localhost'],
    logger: false,
    ...(enableLegacyCandidateRoutes === undefined ? {} : { enableLegacyCandidateRoutes }),
  });
  await app.ready();
  apps.push(app);
  return { app, listChainGates };
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
  ] as const)('registers all five routes when the flag is %s', async (_label, flag) => {
    const { app } = await gateway(flag);

    expect(LEGACY_ROUTES.map((route) => hasRoute(app, route))).toEqual([
      true, true, true, true, true,
    ]);
    expect(NEIGHBOR_ROUTES.every((route) => hasRoute(app, route))).toBe(true);
  });

  it('removes only the five candidate routes from their live neighbors when disabled', async () => {
    const { app } = await gateway(false);

    expect(LEGACY_ROUTES.map((route) => hasRoute(app, route))).toEqual([
      false, false, false, false, false,
    ]);
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
});
