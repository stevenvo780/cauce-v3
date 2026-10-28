import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { FixedAuthProvider, testPrincipal } from '../test-support/gateway-doubles.js';
import { replyError } from '../routes/shared.js';
import { BillingSettings } from './config.js';
import { BILLING_UNCONFIGURED, registerBillingRoutes, WEBHOOK_PATH } from './routes.js';
import { PlanLimitError } from './agent-allowance.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length > 0) await apps.pop()?.close(); });

function app(settings: BillingSettings | undefined) {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const instance = Fastify({ logger: false });
  registerBillingRoutes(instance, new FixedAuthProvider(testPrincipal()), { query } as unknown as DatabasePool, settings);
  apps.push(instance);
  return { instance, query };
}

describe('billing routes without a database', () => {
  it.each([
    ['GET', '/v3/console/billing'], ['POST', '/v3/console/billing/checkout'], ['POST', '/v3/console/billing/cancel'],
    ['POST', '/v3/console/billing/refresh'], ['POST', `${WEBHOOK_PATH}?data.id=mp1&type=subscription_preapproval`],
  ] as const)('answers 503 billing_unconfigured on %s %s when billing is disabled', async (method, url) => {
    const { instance, query } = app(undefined);
    const response = await instance.inject({ method, url, ...(method === 'POST' ? { payload: { plan: 'gestionado', quantity: 3 } } : {}) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(BILLING_UNCONFIGURED);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unsigned or tampered webhook with 401 before reading Mercado Pago or the database', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { instance, query } = app(new BillingSettings({ accessToken: 'token', webhookSecret: 'secret', currency: 'COP', usdRate: 4000,
      publicUrl: 'https://consola.example', client: { fetch } }));
    for (const headers of [{}, { 'x-signature': `ts=${String(Math.floor(Date.now() / 1000))},v1=${'0'.repeat(64)}`, 'x-request-id': 'r1' }]) {
      const response = await instance.inject({ method: 'POST', url: `${WEBHOOK_PATH}?data.id=mp1&type=subscription_preapproval`, headers,
        payload: { type: 'subscription_preapproval', data: { id: 'mp1' } } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'invalid_signature' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a webhook body over its limit', async () => {
    const { instance } = app(new BillingSettings({ accessToken: 'token', webhookSecret: 'secret', currency: 'COP', usdRate: 4000,
      publicUrl: 'https://consola.example' }));
    const response = await instance.inject({ method: 'POST', url: `${WEBHOOK_PATH}?data.id=mp1`,
      payload: { padding: 'x'.repeat(40_000) } });
    expect(response.statusCode).toBe(413);
  });

  it('maps a plan limit to 402 plan_limit_reached', async () => {
    const instance = Fastify({ logger: false });
    instance.get('/limit', async (_request, reply) => { replyError(reply, new PlanLimitError(3, 3)); });
    apps.push(instance);
    const response = await instance.inject({ method: 'GET', url: '/limit' });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: 'plan_limit_reached', limit: 3, used: 3 });
  });
});
