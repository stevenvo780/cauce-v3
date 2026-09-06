import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@cauce/protocol';
import type { buildGateway } from './app.js';
import { buildTestGateway, fakePool, fakeRepository } from './test-support/gateway-doubles.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('console activity freshness', () => {
  it('marks each authenticated activity response as non-cacheable', async () => {
    const fleetActivity = vi.fn(async () => ({
      observed_at: '2026-09-05T21:00:00.000Z',
      summary: { connected: 15, in_flight: 1 },
      agents: [],
    }));
    const repository = fakeRepository({
      principalAccess: vi.fn(async () => ({
        roles: ['operator'] as string[],
        permissions: ['read'] as Permission[],
      })),
      fleetActivity,
    });
    const app = await buildTestGateway({
      pool: fakePool({ ssl: true }),
      repository,
      outboxPollMs: 60_000,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/activity',
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fleetActivity).toHaveBeenCalledWith('Steven', 'kant');
  });
});
