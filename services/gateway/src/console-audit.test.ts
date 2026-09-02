import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@cauce/protocol';
import type { buildGateway } from './app.js';
import { buildTestGateway, fakePool, fakeRepository } from './test-support/gateway-doubles.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

function repository() {
  return fakeRepository({
    principalAccess: vi.fn(async () => ({
      roles: ['operator'] as string[],
      permissions: ['read'] as Permission[],
    })),
    listAudit: vi.fn(async () => ({
      next_cursor: '41',
      metadata: { token: 'PAGE_SECRET' },
      items: [{
        event_id: '42',
        at: '2026-08-26T08:00:00.000Z',
        tenant_id: 'Miguel',
        actor_alias: 'atlas',
        action: 'delivery.ack',
        decision: 'info',
        request_id: null,
        trace_id: 'trace-participant-visible',
        summary: JSON.stringify({ ack: 'done', body: 'ROW_SECRET', token: 'ROW_SECRET' }),
        metadata: { token: 'ROW_SECRET' },
      }],
    })),
    claimWakeOutbox: vi.fn(async () => []),
  });
}

async function gateway() {
  const store = repository();
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }),
    repository: store,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return { app, store };
}

function headers(alias = 'kant') {
  return { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': alias };
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('audit console boundary', () => {
  it('forwards one exact keyset page and preserves participant-visible cross-tenant events', async () => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'GET', url: '/v3/console/audit?limit=17&before=99', headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.listAudit).toHaveBeenCalledWith('Steven', 'kant', { limit: 17, before: '99' });
    expect(response.json()).toEqual({
      next_cursor: '41',
      items: [{
        event_id: '42',
        at: '2026-08-26T08:00:00.000Z',
        tenant_id: 'Miguel',
        actor_alias: 'atlas',
        action: 'delivery.ack',
        decision: 'info',
        request_id: null,
        trace_id: 'trace-participant-visible',
        summary: '{"ack":"done"}',
      }],
    });
    expect(response.body).not.toContain('SECRET');
    expect(response.body).not.toContain('metadata');
  });

  it.each([
    '/v3/console/audit?limit=0',
    '/v3/console/audit?limit=501',
    '/v3/console/audit?limit=1x',
    '/v3/console/audit?before=0',
    '/v3/console/audit?before=01',
    '/v3/console/audit?before=9223372036854775808',
    '/v3/console/audit?limit=1&limit=2',
    '/v3/console/audit?cursor=9',
  ])('rejects malformed, duplicate or unknown pagination before the store: %s', async (url) => {
    const { app, store } = await gateway();
    const response = await app.inject({ method: 'GET', url, headers: headers() });

    expect(response.statusCode).toBe(422);
    expect(store.listAudit).not.toHaveBeenCalled();
  });

  it('allows a read-only principal to query its visible audit rows', async () => {
    const { app, store } = await gateway();
    const response = await app.inject({
      method: 'GET', url: '/v3/console/audit', headers: headers('socrates'),
    });

    expect(response.statusCode).toBe(200);
    expect(store.listAudit).toHaveBeenCalledWith(
      'Steven', 'socrates', { limit: 100, before: null },
    );
  });
});
