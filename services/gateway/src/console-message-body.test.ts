import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { StoreError } from '@cauce/store';
import { buildGateway, type GatewayRepository } from './app.js';
import { DevOnlyAuthProvider } from './auth.js';

/**
 * **EL CUERPO ENTERO DE UN MENSAJE, POR LA SUPERFICIE DE CONSOLA.**
 *
 * `GET /v3/console/messages` publica `left(body,240)`. Medido contra producción el 2026-08-23 con
 * la sesión de la propia consola: 100 items, largo máximo de `body_preview` = 240 exactos. En
 * pantalla se leía «…El dominio real es stevenvallejo», cortado a mitad de palabra, sin puntos
 * suspensivos y sin ninguna forma de ver el resto.
 *
 * 🔴 El gateway YA sabía devolver el mensaje entero: `GET /v3/messages/:messageId` existe desde
 * antes y hace exactamente esto. Lo que faltaba es que la consola pudiera llamarlo, y no puede:
 * `consola.humanizar.tech` corta en el borde con 404 todo `/v3/*` que no sea `/v3/auth/*`,
 * `/v3/status` o `/v3/console/*` (`ops/console-login/patch-caddy-lista-blanca.py`, puesto el
 * 2026-08-06 porque el nginx del contenedor presenta su mTLS en todo lo que proxea). Por eso la
 * lectura se publica bajo `/v3/console/`, con el mismo permiso y el mismo `visibleMessage`, en
 * vez de agujerear la lista blanca.
 *
 * Lo que estas pruebas NO cubren, y hay que decirlo: la consulta del store. `getMessage` ya estaba
 * y no se tocó; su autorización se prueba contra Postgres en `tests/store-hardening`, que necesita
 * testcontainers y no se corrió acá.
 *
 * Y lo que hay que saber para leer un fallo: de los cuatro casos, sólo DOS distinguen «la ruta
 * existe» de «la ruta no existe». Los dos que esperan 404 pasan igual sin la ruta, porque una ruta
 * inexistente también responde 404 — medido quitando el `app.get` y corriendo el fichero: 2 fallan,
 * 2 pasan. Un fichero entero en verde no probaría nada; son esos dos los que lo prueban.
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
  // El cuerpo ENTERO, mucho más largo que los 240 que publica la lista.
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
    // El id y el actor llegan tal cual del store: la ruta no inventa identidad.
    expect(getMessage).toHaveBeenCalledWith(MENSAJE.id, 'Steven', 'kant');
  });

  /**
   * CONTROL NEGATIVO de la visibilidad. `visibleMessage` es la misma criba que ya aplica la lista:
   * si la ruta la olvidara, publicaría el cuerpo entero de mensajes de otros a cualquiera con
   * permiso de lectura — que es exactamente el agujero que la lista blanca del borde vino a tapar,
   * reabierto un nivel más adentro.
   */
  it('a quien no participa del mensaje le responde 404, no el cuerpo', async () => {
    const { app } = await gateway();
    const respuesta = await leer(app, MENSAJE.id, 'socrates');

    expect(respuesta.statusCode).toBe(404);
    expect(respuesta.body).not.toContain('stevenvallejo');
  });

  /**
   * La otra mitad de `visibleMessage`: al destinatario se le da SU entrega y no el fan-out entero.
   * Sin esto, argos vería a quién más fue el mensaje leyendo el detalle de su propia conversación.
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
