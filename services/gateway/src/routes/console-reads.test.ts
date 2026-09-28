import { afterEach, describe, expect, it, vi } from 'vitest';
import type { buildGateway } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';
import { buildTestGateway, fakePool, fakeRepository } from '../test-support/gateway-doubles.js';

/**
 * Console read contracts the auth-shape suites only smoke: who may ask, what identity reaches
 * the store, and which second allowlist runs on the way back. Reads that need no facade pass
 * the store answer through untouched, cross-tenant edges included.
 */

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

const HEADERS = {
  'x-cauce-tenant': 'Steven',
  'x-cauce-alias': 'kant',
  origin: 'http://localhost',
};

async function gateway(repository: ReturnType<typeof fakeRepository>, readPermission = true) {
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }),
    authProvider: DevOnlyAuthProvider.forTests(readPermission
      ? {}
      : { roles: ['agent'], permissions: [] }),
    repository,
  });
  apps.push(app);
  return app;
}

describe('GET /v3/console/origin-relays', () => {
  it('forwards the caller identity and keeps only rows that involve it', async () => {
    const repository = fakeRepository({
      listOriginRelays: vi.fn(async () => ({
        items: [
          { relay_id: 'propio', tenant_id: 'Steven', actor_alias: 'kant' },
          {
            relay_id: 'participante', tenant_id: 'Pablo',
            participants: [{ tenant_id: 'Steven', alias: 'kant' }],
          },
          {
            relay_id: 'destinatario', tenant_id: 'Pablo',
            recipient_tenant: 'Steven', recipient_alias: 'kant',
          },
          {
            relay_id: 'ajeno', tenant_id: 'Pablo', actor_alias: 'midas',
            recipient_tenant: 'Pablo', recipient_alias: 'midas',
          },
        ],
      })),
    });
    const app = await gateway(repository);
    const response = await app.inject({ method: 'GET', url: '/v3/console/origin-relays', headers: HEADERS });

    expect(response.statusCode).toBe(200);
    expect(repository.listOriginRelays).toHaveBeenCalledWith('Steven', 'kant');
    expect(response.json<{ items: { relay_id: string }[] }>().items.map((row) => row.relay_id))
      .toEqual(['propio', 'participante', 'destinatario']);
  });

  it('requires read and touches nothing without it', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, false);
    const response = await app.inject({ method: 'GET', url: '/v3/console/origin-relays', headers: HEADERS });

    expect(response.statusCode).toBe(403);
    expect(repository.listOriginRelays).not.toHaveBeenCalled();
  });
});

describe('GET /v3/console/chains/:traceId', () => {
  it('forwards the trace and returns the graph untouched, edges included', async () => {
    const graph = {
      trace_id: 'trace-1',
      nodes: [{ tenant_id: 'Pablo', alias: 'midas' }],
      edges: [{ from: 'Steven/kant', to: 'Pablo/midas' }],
      origin_relays: [],
    };
    const repository = fakeRepository({
      agentChain: vi.fn(async () => graph),
    });
    const app = await gateway(repository);
    const response = await app.inject({ method: 'GET', url: '/v3/console/chains/trace-1', headers: HEADERS });

    expect(response.statusCode).toBe(200);
    expect(repository.agentChain).toHaveBeenCalledWith('trace-1', 'Steven', 'kant');
    // No facade runs here: flattening by tenant would erase the cross-tenant edges the
    // endpoint exists to show.
    expect(response.json()).toEqual(graph);
  });

  it('requires read and touches nothing without it', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, false);
    const response = await app.inject({ method: 'GET', url: '/v3/console/chains/trace-1', headers: HEADERS });

    expect(response.statusCode).toBe(403);
    expect(repository.agentChain).not.toHaveBeenCalled();
  });
});

describe('GET /v3/console/queues', () => {
  it('drops foreign rows and recomputes the counts from what remains', async () => {
    const repository = fakeRepository({
      queueSnapshot: vi.fn(async () => ({
        pending: 99,
        retrying: 99,
        dead: 99,
        totals: { headline: 'withheld' },
        items: [
          { delivery_id: 'propia', tenant_id: 'Steven', recipient_alias: 'kant', state: 'pending' },
          {
            delivery_id: 'enviada', message_tenant_id: 'Steven', actor_alias: 'kant',
            state: 'retry',
          },
          { delivery_id: 'ajena', tenant_id: 'Pablo', recipient_alias: 'midas', state: 'pending' },
        ],
      })),
    });
    const app = await gateway(repository);
    const response = await app.inject({ method: 'GET', url: '/v3/console/queues', headers: HEADERS });

    expect(response.statusCode).toBe(200);
    expect(repository.queueSnapshot).toHaveBeenCalledWith('Steven', 'kant');
    expect(response.json()).toEqual({
      pending: 1,
      retrying: 1,
      dead: 0,
      items: [
        { delivery_id: 'propia', tenant_id: 'Steven', recipient_alias: 'kant', state: 'pending' },
        {
          delivery_id: 'enviada', message_tenant_id: 'Steven', actor_alias: 'kant',
          state: 'retry',
        },
      ],
    });
  });

  it('requires read and touches nothing without it', async () => {
    const repository = fakeRepository();
    const app = await gateway(repository, false);
    const response = await app.inject({ method: 'GET', url: '/v3/console/queues', headers: HEADERS });

    expect(response.statusCode).toBe(403);
    expect(repository.queueSnapshot).not.toHaveBeenCalled();
  });
});
