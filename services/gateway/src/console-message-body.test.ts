import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { StoreError } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { DevOnlyAuthProvider } from './auth.js';

/**
 * Tests for retrieving the full message body in `GET /v3/console/messages/:messageId`.
 */

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

function pool(): DatabasePool {
  return { query: vi.fn(async () => ({ rows: [{ ssl: true }], rowCount: 1 })) } as unknown as DatabasePool;
}

const MENSAJE = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  tenant_id: 'Steven',
  room_id: 'grp.steven',
  actor_alias: 'kant',
  lane: 'interactive',
  // The FULL body, much longer than the 240 the list publishes.
  body: { text: `${'a'.repeat(600)} el dominio real es stevenvallejo.com` },
  created_at: '2026-08-23T02:02:52.000Z',
  deliveries: [
    { delivery_id: 'dddddddd-1111-4111-8111-111111111111', recipient_tenant: 'Steven', recipient_alias: 'argos', status: 'done' },
    { delivery_id: 'eeeeeeee-2222-4222-8222-222222222222', recipient_tenant: 'Miguel', recipient_alias: 'kratos', status: 'dead' },
  ],
};

async function gateway(getMessage = vi.fn(async () => MENSAJE as unknown as Record<string, unknown>)) {
  const app = await buildGateway({
    pool: pool(),
    authProvider: DevOnlyAuthProvider.forTests(),
    repository: { getMessage } as unknown as GatewayRepository,
    deliveryWakeSubscriber: async () => async () => undefined,
    exposeHealthRoutes: false,
    consoleOrigins: ['http://localhost'],
    logger: false,
  });
  apps.push(app);
  return { app, getMessage };
}

function leer(app: Awaited<ReturnType<typeof buildGateway>>, messageId: string, alias = 'kant') {
  return app.inject({
    method: 'GET',
    url: `/v3/console/messages/${messageId}`,
    headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': alias, origin: 'http://localhost' },
  });
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe('GET /v3/console/messages/:messageId', () => {
  it('devuelve el cuerpo ENTERO, que es lo que la lista recorta a 240', async () => {
    const { app, getMessage } = await gateway();
    const respuesta = await leer(app, MENSAJE.id);

    expect(respuesta.statusCode).toBe(200);
    const cuerpo: { body?: { text?: string } } = respuesta.json();
    expect(cuerpo.body?.text).toBe(MENSAJE.body.text);
    expect(cuerpo.body?.text?.length).toBeGreaterThan(240);
    // The id and the actor come straight from the store: the route does not invent identity.
    expect(getMessage).toHaveBeenCalledWith(MENSAJE.id, 'Steven', 'kant');
  });

  /**
   * NEGATIVE CONTROL of visibility. `visibleMessage` is the same filter the list already applies:
   * if the route forgot it, it would publish the full body of other people's messages to anyone
   * with read permission — which is exactly the hole the edge allowlist came to plug, reopened
   * one level further in.
   */
  it('a quien no participa del mensaje le responde 404, no el cuerpo', async () => {
    const { app } = await gateway();
    const respuesta = await leer(app, MENSAJE.id, 'socrates');

    expect(respuesta.statusCode).toBe(404);
    expect(respuesta.body).not.toContain('stevenvallejo');
  });

  /**
   * The other half of `visibleMessage`: the recipient gets THEIR delivery, not the whole fan-out.
   * Without this, argos would see who else got the message by reading their own conversation detail.
   */
  it('al destinatario le recorta las entregas ajenas del mismo publish', async () => {
    const { app } = await gateway();
    const respuesta = await leer(app, MENSAJE.id, 'argos');

    expect(respuesta.statusCode).toBe(200);
    const cuerpo: { deliveries?: Array<{ recipient_alias?: string }> } = respuesta.json();
    expect(cuerpo.deliveries?.map((entrega) => entrega.recipient_alias)).toEqual(['argos']);
  });

  it('un mensaje que el store no encuentra se responde 404 y no 500', async () => {
    const { app } = await gateway(vi.fn(async () => {
      throw new StoreError('not_found', 'message not found or not visible');
    }));
    const respuesta = await leer(app, '99999999-9999-4999-8999-999999999999');
    expect(respuesta.statusCode).toBe(404);
  });
});
