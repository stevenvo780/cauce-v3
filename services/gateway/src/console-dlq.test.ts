import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@cauce/protocol';
import type { DatabasePool, OperationalDlqPage, OperationalDlqResolutionResult } from '@cauce/store';
import { StoreError } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { DevOnlyAuthProvider } from './auth.js';

const INCIDENT_ID = '8b31b078-dd9f-4da2-8d1e-f4050965db83';
const EVIDENCE_SHA256 = 'a'.repeat(64);
const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

function pool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })) } as unknown as DatabasePool;
}

const page: OperationalDlqPage = {
  schemaVersion: 1,
  total: 1,
  truncated: true,
  nextCursor: 'ab12',
  items: [{
    target: 'outbox',
    id: INCIDENT_ID,
    tenantId: 'Steven',
    kind: 'origin_relay',
    adapter: 'telegram',
    disposition: 'ambiguous',
    open: true,
    actionable: true,
    evidenceSha256: EVIDENCE_SHA256,
    attempts: 3,
    resolutionRule: 'telegram_effect_ambiguous_v1',
    createdAt: '2026-08-26T10:00:00.000Z',
    dispositionAt: '2026-08-26T10:01:00.000Z',
    resolvedAt: null,
    reopenCount: 0,
    lastReopenedAt: null,
  }],
};

const resolution: OperationalDlqResolutionResult = {
  schemaVersion: 1,
  suite: 'cauce-v3-dlq-no-replay-resolution',
  phase: 'resolved',
  appliedCount: 1,
  alreadyApplied: false,
  evidenceSha256: EVIDENCE_SHA256,
  reasonSha256: 'b'.repeat(64),
  possibleDuplicateAcknowledged: true,
  possibleNoDeliveryAcknowledged: true,
};

function repository() {
  return {
    principalAccess: vi.fn(async () => ({
      roles: ['operator'] as string[],
      permissions: ['route', 'read', 'control'] as Permission[],
    })),
    listOperationalDlq: vi.fn(async () => ({
      ...page,
      secretPayload: 'DO_NOT_EXPOSE',
      items: [{
        ...page.items[0],
        payload: { text: 'DO_NOT_EXPOSE' },
        lastError: 'DO_NOT_EXPOSE',
        providerMessageId: 'DO_NOT_EXPOSE',
      }],
    }) as unknown as OperationalDlqPage),
    resolveOperationalDlqWithoutReplay: vi.fn(async () => ({
      ...resolution,
      operatorReason: 'DO_NOT_EXPOSE',
      providerMessageId: 'DO_NOT_EXPOSE',
    }) as unknown as OperationalDlqResolutionResult),
    claimWakeOutbox: vi.fn(async () => []),
  };
}

async function gateway(options: {
  authProvider?: DevOnlyAuthProvider;
  repository?: ReturnType<typeof repository>;
} = {}) {
  const store = options.repository ?? repository();
  const app = await buildGateway({
    pool: pool(),
    authProvider: options.authProvider ?? DevOnlyAuthProvider.forTests(),
    repository: store as unknown as GatewayRepository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    outboxPollMs: 60_000,
    consoleOrigins: ['http://localhost'],
    logger: false,
  });
  apps.push(app);
  return { app, store };
}

function headers(alias = 'kant', origin = true) {
  return {
    'x-cauce-tenant': 'Steven',
    'x-cauce-alias': alias,
    ...(origin ? { origin: 'http://localhost' } : {}),
  };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('operational DLQ console boundary', () => {
  it('advertises dlq.resolve only when authenticated and database authority intersect', async () => {
    const allowed = await gateway();
    const allowedResponse = await allowed.app.inject({
      method: 'GET', url: '/v3/console/access', headers: headers(),
    });
    expect(allowedResponse.statusCode).toBe(200);
    expect(allowedResponse.json<{ permissions: string[] }>().permissions).toContain('dlq.resolve');

    const deniedStore = repository();
    deniedStore.principalAccess.mockResolvedValueOnce({ roles: ['operator'], permissions: ['read'] });
    const denied = await gateway({ repository: deniedStore });
    const deniedResponse = await denied.app.inject({
      method: 'GET', url: '/v3/console/access', headers: headers(),
    });
    expect(deniedResponse.statusCode).toBe(200);
    expect(deniedResponse.json<{ permissions: string[] }>().permissions).not.toContain('dlq.resolve');
  });

  it('lists one actor-bound keyset page through a second privacy allowlist', async () => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/dlq?limit=17&cursor=ab12',
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.listOperationalDlq).toHaveBeenCalledWith('Steven', 'kant', 17, 'ab12');
    expect(response.json()).toEqual(page);
    expect(response.body).not.toContain('DO_NOT_EXPOSE');
  });

  it.each([
    '/v3/console/dlq?limit=0',
    '/v3/console/dlq?limit=501',
    '/v3/console/dlq?limit=1x',
    '/v3/console/dlq?cursor=ABC0',
    '/v3/console/dlq?cursor=a',
  ])('rejects malformed pagination before querying the store: %s', async (url) => {
    const { app, store } = await gateway();
    const response = await app.inject({ method: 'GET', url, headers: headers() });

    expect(response.statusCode).toBe(422);
    expect(store.listOperationalDlq).not.toHaveBeenCalled();
  });

  it('denies a read-only agent before any DLQ query', async () => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/dlq',
      headers: headers('socrates'),
    });

    expect(response.statusCode).toBe(403);
    expect(store.listOperationalDlq).not.toHaveBeenCalled();
  });

  it('records an exact no-replay decision using only authenticated actor authority', async () => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/outbox/${INCIDENT_ID}/resolve-without-replay`,
      headers: headers(),
      payload: {
        evidence_sha256: EVIDENCE_SHA256,
        reason: '  Evidencia causal comprobada  ',
        possible_duplicate_acknowledged: true,
        possible_no_delivery_acknowledged: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(store.resolveOperationalDlqWithoutReplay).toHaveBeenCalledWith('Steven', 'kant', {
      target: 'outbox',
      id: INCIDENT_ID,
      evidenceSha256: EVIDENCE_SHA256,
      reason: 'Evidencia causal comprobada',
      possibleDuplicateAcknowledged: true,
      possibleNoDeliveryAcknowledged: true,
    });
    expect(response.json()).toEqual(resolution);
    expect(response.body).not.toContain('DO_NOT_EXPOSE');
  });

  it.each([
    { target: 'message', id: INCIDENT_ID, body: {} },
    { target: 'outbox', id: 'not-an-id', body: {} },
    {
      target: 'outbox', id: INCIDENT_ID,
      body: {
        evidence_sha256: EVIDENCE_SHA256,
        reason: 'Motivo',
        possible_duplicate_acknowledged: true,
        possible_no_delivery_acknowledged: true,
        tenant_id: 'Miguel',
      },
    },
    {
      target: 'outbox', id: INCIDENT_ID,
      body: {
        evidence_sha256: EVIDENCE_SHA256,
        reason: 'Motivo',
        possible_duplicate_acknowledged: 'true',
        possible_no_delivery_acknowledged: true,
      },
    },
  ])('rejects malformed or authority-bearing resolution input before the store', async ({ target, id, body }) => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/${target}/${id}/resolve-without-replay`,
      headers: headers(),
      payload: body,
    });

    expect(response.statusCode).toBe(422);
    expect(store.resolveOperationalDlqWithoutReplay).not.toHaveBeenCalled();
  });

  it('requires same-origin CSRF evidence and operator control before mutation', async () => {
    const { app, store } = await gateway();
    const body = {
      evidence_sha256: EVIDENCE_SHA256,
      reason: 'Motivo comprobado',
      possible_duplicate_acknowledged: true,
      possible_no_delivery_acknowledged: true,
    };
    const withoutOrigin = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/outbox/${INCIDENT_ID}/resolve-without-replay`,
      headers: headers('kant', false),
      payload: body,
    });
    const agent = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/outbox/${INCIDENT_ID}/resolve-without-replay`,
      headers: headers('socrates'),
      payload: body,
    });

    expect(withoutOrigin.statusCode).toBe(403);
    expect(agent.statusCode).toBe(403);
    expect(store.resolveOperationalDlqWithoutReplay).not.toHaveBeenCalled();
  });

  it('maps a stale evidence CAS to conflict without inventing a success body', async () => {
    const store = repository();
    store.resolveOperationalDlqWithoutReplay.mockRejectedValueOnce(
      new StoreError('conflict', 'DLQ evidence changed'),
    );
    const { app } = await gateway({ repository: store });
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/outbox/${INCIDENT_ID}/resolve-without-replay`,
      headers: headers(),
      payload: {
        evidence_sha256: EVIDENCE_SHA256,
        reason: 'Motivo comprobado',
        possible_duplicate_acknowledged: true,
        possible_no_delivery_acknowledged: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
    expect(response.body).not.toContain('schemaVersion');
  });

  it('never emits 2xx when the store mutation lacks an exact durable receipt', async () => {
    const store = repository();
    store.resolveOperationalDlqWithoutReplay.mockResolvedValueOnce({
      ...resolution,
      appliedCount: 0,
      alreadyApplied: false,
      evidenceSha256: 'c'.repeat(64),
    });
    const { app } = await gateway({ repository: store });
    const response = await app.inject({
      method: 'POST',
      url: `/v3/console/dlq/outbox/${INCIDENT_ID}/resolve-without-replay`,
      headers: headers(),
      payload: {
        evidence_sha256: EVIDENCE_SHA256,
        reason: 'Motivo comprobado',
        possible_duplicate_acknowledged: true,
        possible_no_delivery_acknowledged: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
    expect(response.body).not.toContain('schemaVersion');
  });
});
