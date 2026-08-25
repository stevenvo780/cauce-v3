import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/index.js';
import { FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal } from './helpers.js';

/**
 * 🔴 **`registerAgentDocumentRoutes` estaba escrita, exportada y PROBADA — y no la llamaba nadie.**
 *
 * Medido el 2026-08-25 con `grep -rn registerAgentDocumentRoutes --include=*.ts services/ apps/`:
 * cero sitios fuera de su propia definición y de sus pruebas. Por eso
 * `GET /v3/console/agents/:alias/documents` daba 404 en producción y la consola enseñaba
 * «las directivas no están en capa 2 y 3». No era que el dato faltara: era que la ruta no estaba
 * montada.
 *
 * Y las dos rutas de CONTENIDO —`.../documents/:kind/content`, GET y PUT— que
 * `apps/console/src/api/client.ts` llamaba desde hacía semanas ni siquiera existían en el
 * servidor: `agent-documents.routes.ts` sólo declaraba el inventario.
 *
 * ── Por qué esta prueba y no la que ya había ─────────────────────────────────────────────────
 *
 * `console-api-contract.test.ts` recorre `client.ts` con una expresión regular buscando la ruta
 * INCRUSTADA en la llamada. Cuando el método arma la ruta en una variable primero
 *
 *     const ruta = `/v3/console/agents/${...}/documents`;
 *     await this.request(ruta);
 *
 * el extractor no la ve, y la ruta queda fuera de la comprobación sin que nada avise. Es
 * exactamente el patrón de `getAgentDocuments` y de `getAgentPerfil`. Así que esa prueba —que es
 * la que tenía que haber cazado el 404— era ciega justo para estos casos.
 *
 * Ésta no depende de ningún extractor: nombra las rutas a mano y las inyecta en el gateway REAL
 * que devuelve `buildGateway`. Lo único que comprueba es que la respuesta NO sea 404, que es la
 * diferencia entre «la función existe» y «el servidor la sirve».
 */

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function gatewayDeOperador() {
  const app = await buildGateway({
    pool: fakePool(),
    repository: fakeRepository(),
    authProvider: new FixedAuthProvider(testPrincipal({
      roles: roles('operator'),
      permissions: grants('route', 'read', 'control')
    })),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000
  });
  apps.push(app);
  return app;
}

/** Las rutas del perfil y de los documentos, nombradas a mano y sin extractor de por medio. */
const RUTAS = [
  { method: 'GET' as const, url: '/v3/console/agents/zeus/perfil' },
  { method: 'GET' as const, url: '/v3/console/agents/zeus/documents' },
  { method: 'GET' as const, url: '/v3/console/agents/zeus/documents/directive/content' },
  { method: 'PUT' as const, url: '/v3/console/agents/zeus/documents/directive/content' }
];

describe('las rutas del perfil y de los documentos están MONTADAS en el gateway', () => {
  for (const ruta of RUTAS) {
    it(`${ruta.method} ${ruta.url} no contesta 404`, async () => {
      const app = await gatewayDeOperador();
      const res = await app.inject({
        method: ruta.method,
        url: ruta.url,
        ...(ruta.method === 'PUT' ? { payload: { content: 'hola' } } : {})
      });
      /*
       * Lo que se exige NO es un 200 —con un `fakePool` la lectura puede fallar por cualquier
       * motivo, y sin pty-agent el contenido contesta 409 a propósito— y tampoco es «no 404» a
       * secas: `GET /documents` contesta 404 con todo el derecho cuando el alias no está en el
       * registro, que es justo lo que devuelve el repositorio falso.
       *
       * Lo que se exige es que el 404, si lo hay, sea del MANEJADOR y no del ENRUTADOR. Fastify
       * contesta a una ruta que no existe con `{"message":"Route GET:/... not found"}`; el
       * manejador contesta con `{"error":"not_found", ...}`. Distinguirlos es exactamente la
       * diferencia entre «no encontré ese alias» y «esa función no está montada», que es la
       * confusión que dejó la consola diciendo que catorce alias no tenían directiva.
       */
      const cuerpo = res.json() as { message?: string };
      expect(cuerpo.message ?? '').not.toContain('not found');
      expect(res.statusCode === 404 ? (res.json() as { error?: string }).error : 'ruta-viva')
        .not.toBeUndefined();
    });
  }

  it('CONTROL NEGATIVO: una ruta que NADIE registró sí contesta 404', async () => {
    /*
     * Sin esto la prueba de arriba podría estar verde por un `setNotFoundHandler` que devuelve
     * 500, o por un prefijo que traga todo. Se exige que el 404 siga siendo alcanzable.
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/inventado-que-no-existe' });
    expect(res.statusCode).toBe(404);
  });

  it('sin plano de terminal, el contenido dice que NO HAY CANAL en vez de lanzar un 500', async () => {
    /*
     * Este gateway se monta sin `registerTerminalControlPlane`, así que nadie instaló la sonda que
     * lee el disco del contenedor. La degradada contesta «no hay canal hasta el disco» —503— en
     * lugar de lanzar: un throw se vería como «internal error» y el operador no podría accionarlo.
     *
     * Como además no hay hechos medidos, el manejador corta antes con el 409. Lo que se afirma acá
     * es que en NINGUNA de las dos ausencias sale un 500.
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/directive/content' });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('el contenido de un documento contesta «no medido» y NO 404, que dicen cosas distintas', async () => {
    /*
     * Es la distinción por la que existe todo esto. Un 404 le dice a la consola «este gateway no
     * tiene la función» y un 409 le dice «la función está, pero nadie ha medido el contenedor de
     * este alias». Con el 404, la consola concluía lo primero cuando pasaba lo segundo — y eso es
     * literalmente lo que el operador leyó como «no están en capa 2 y 3».
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/directive/content' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_medido');
    expect(res.json().message).toContain('no se ha mirado');
  });

  it('un `kind` inventado se rechaza por 400 y no por 404', async () => {
    // 404 sobre un kind inválido sería indistinguible de «la ruta no existe», que es la confusión
    // que esta suite entera viene a cerrar.
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/credenciales/content' });
    expect(res.statusCode).toBe(400);
  });
});
