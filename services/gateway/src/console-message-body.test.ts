import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreError } from '@cauce/store';
import type { buildGateway } from './app.js';
import { buildTestGateway, fakePool, fakeRepository } from './test-support/gateway-doubles.js';

/** Tests for retrieving the full message body in `GET /v3/console/messages/:messageId`. */

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

const ADJUNTO = {
  name: 'informe.pdf',
  mime_type: 'application/pdf',
  file_size: 96,
  sha256: 'f'.repeat(64),
};

const MENSAJE = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  tenant_id: 'Steven',
  room_id: 'grp.steven',
  actor_alias: 'kant',
  lane: 'interactive',
  // The FULL body, much longer than the 240 the list publishes; the store already took the bytes out.
  body: { text: `${'a'.repeat(600)} el dominio real es stevenvallejo.com` },
  attachments: [ADJUNTO],
  created_at: '2026-08-23T02:02:52.000Z',
  deliveries: [
    { delivery_id: 'dddddddd-1111-4111-8111-111111111111', tenant_id: 'Steven', alias: 'argos', status: 'done' },
    { delivery_id: 'eeeeeeee-2222-4222-8222-222222222222', tenant_id: 'Miguel', alias: 'kratos', status: 'dead' },
  ],
};

async function gateway(getMessage = vi.fn(async () => MENSAJE as unknown as Record<string, unknown>)) {
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }),
    repository: fakeRepository({ getMessage }),
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
   * A2A-04. The store projects `body - attachments_v1` plus this summary: the browser gets the metadata
   * of every file and none of its base64. The facade forwards it untouched, to the recipient as well.
   */
  it('lleva el resumen de adjuntos y nunca el base64', async () => {
    const { app } = await gateway();

    for (const alias of ['kant', 'argos']) {
      const respuesta = await leer(app, MENSAJE.id, alias);
      expect(respuesta.statusCode).toBe(200);
      const cuerpo: { attachments?: unknown; body?: Record<string, unknown> } = respuesta.json();
      expect(cuerpo.attachments).toEqual([ADJUNTO]);
      expect(cuerpo.body?.attachments_v1).toBeUndefined();
      expect(respuesta.body).not.toContain('content_base64');
    }
  });

  /**
   * NEGATIVE CONTROL of visibility. `visibleMessage` is the same filter the list applies: without it the route
   * would publish other people's bodies to anyone with read permission — the edge allowlist hole one level further in.
   */
  it('a quien no participa del mensaje le responde 404, no el cuerpo', async () => {
    const { app } = await gateway();
    const respuesta = await leer(app, MENSAJE.id, 'socrates');

    expect(respuesta.statusCode).toBe(404);
    expect(respuesta.body).not.toContain('stevenvallejo');
  });

  /**
   * The other half of `visibleMessage`: the recipient gets THEIR delivery, not the whole fan-out, or
   * argos would learn who else got the message by reading their own conversation detail.
   */
  it('al destinatario le recorta las entregas ajenas del mismo publish', async () => {
    const { app } = await gateway();
    const respuesta = await leer(app, MENSAJE.id, 'argos');

    expect(respuesta.statusCode).toBe(200);
    const cuerpo: { deliveries?: { alias?: string }[] } = respuesta.json();
    expect(cuerpo.deliveries?.map((entrega) => entrega.alias)).toEqual(['argos']);
  });

  it('un mensaje que el store no encuentra se responde 404 y no 500', async () => {
    const { app } = await gateway(vi.fn(async () => {
      throw new StoreError('not_found', 'message not found or not visible');
    }));
    const respuesta = await leer(app, '99999999-9999-4999-8999-999999999999');
    expect(respuesta.statusCode).toBe(404);
  });
});
