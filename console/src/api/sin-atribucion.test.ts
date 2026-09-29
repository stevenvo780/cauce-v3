/**
 * T041 · Las cuatro escrituras de gobierno niegan a la sesión sin atribución.
 *
 * El gateway contesta 403 `{ error: 'forbidden', reason: 'writable_requires_attribution' }`
 * en las cuatro rutas que escriben gobierno (documento, perfil, recarga y las dos fases de
 * reconciliación). La consola NO puede confundir ese 403 con el 403 de la política de rutas:
 * el primero dice qué hacer (entrar con identidad de persona), el segundo dice que la ruta
 * mezcla credenciales. Este fichero fija que el cliente separa los dos en TODAS las rutas,
 * no sólo en la de documentos, y que las lecturas (GET) no se bloquean: T042 deja shell y
 * lectura como están.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError, CauceApi } from './client';
import { server } from '../mocks/server';

const TENANT = 'Steven';
const ALIAS = 'kant';
const PERFIL = {
  purpose: 'el médico de la flota',
  role_summary: null,
  human_brief: null,
  responsibilities: [],
  restrictions: [],
  tools: [],
  operating_rules: [],
};
const NEGADA = {
  error: 'forbidden',
  reason: 'writable_requires_attribution',
  message: 'escribir la gobernanza de un alias exige una persona con nombre',
};

function niega(ruta: string, metodo: 'put' | 'post'): void {
  const handler = metodo === 'put' ? http.put : http.post;
  server.use(handler(ruta, () => HttpResponse.json(NEGADA, { status: 403 })));
}

describe('T041 · escribir gobierno exige persona con nombre en las cuatro rutas', () => {
  it('el PUT de documento separa el 403 sin persona del 403 de la ruta', async () => {
    niega(
      `http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/documents/directive/content`,
      'put',
    );
    const api = new CauceApi('http://localhost');

    const fallo = await api
      .putAgentDocumentContent(TENANT, ALIAS, 'directive', '# nuevo', 'b'.repeat(64), 'corrijo la ruta del manual')
      .catch((error: unknown) => error);

    expect(fallo).toBeInstanceOf(ApiError);
    expect(fallo).toMatchObject({ status: 403, code: 'writable_requires_attribution' });
    expect((fallo as ApiError).message).toMatch(/persona con nombre/);
  });

  it('el PUT de perfil niega igual y no se confunde con un 400 de campos', async () => {
    niega(`http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/perfil`, 'put');
    const api = new CauceApi('http://localhost');

    const fallo = await api
      .putAgentPerfil(TENANT, ALIAS, PERFIL, 4, 'ajusto el rol declarado')
      .catch((error: unknown) => error);

    expect(fallo).toBeInstanceOf(ApiError);
    expect(fallo).toMatchObject({ status: 403, code: 'writable_requires_attribution' });
    expect((fallo as ApiError).message).toMatch(/persona con nombre/);
  });

  it('el POST de recarga niega igual y conserva el código para la vista', async () => {
    niega(`http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/context/reload`, 'post');
    const api = new CauceApi('http://localhost');

    const fallo = await api
      .postContextReload(TENANT, ALIAS, 'rehago el contexto a mano')
      .catch((error: unknown) => error);

    expect(fallo).toBeInstanceOf(ApiError);
    expect(fallo).toMatchObject({ status: 403, code: 'writable_requires_attribution' });
  });

  it('las dos fases de reconciliación niegan igual', async () => {
    niega(
      `http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/context/reconcile/preview`,
      'post',
    );
    niega(
      `http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/context/reconcile/apply`,
      'post',
    );
    const api = new CauceApi('http://localhost');

    const previa = await api
      .previewContextReconciliation(TENANT, ALIAS, 'reconcilio a mano lo de fuera')
      .catch((error: unknown) => error);
    expect(previa).toMatchObject({ status: 403, code: 'writable_requires_attribution' });

    const aplicada = await api
      .applyContextReconciliation(TENANT, ALIAS, {
        reason: 'reconcilio a mano lo de fuera',
        expected_revision: 4,
        expected_runtime_generation: 'gen-4',
        preserve_external: true,
        documents: [],
      })
      .catch((error: unknown) => error);
    expect(aplicada).toMatchObject({ status: 403, code: 'writable_requires_attribution' });
  });

  it('CONTROL NEGATIVO: un 403 de la política de rutas NO se disfraza de falta de persona', async () => {
    server.use(
      http.put(
        `http://localhost/v3/console/tenants/${TENANT}/agents/${ALIAS}/perfil`,
        () => HttpResponse.json(
          { error: 'forbidden', message: 'esa ruta mezcla configuración con credenciales' },
          { status: 403 },
        ),
      ),
    );
    const api = new CauceApi('http://localhost');

    const fallo = await api
      .putAgentPerfil(TENANT, ALIAS, PERFIL, 4, 'ajusto el rol declarado')
      .catch((error: unknown) => error);

    expect(fallo).toMatchObject({ status: 403, code: 'forbidden' });
    expect((fallo as ApiError).code).not.toBe('writable_requires_attribution');
  });
});

describe('T042 · leer no se bloquea: la sesión sin atribuir sigue leyendo', () => {
  it('los GET de gobierno contestan 200 y la consola los entrega tal cual', async () => {
    const api = new CauceApi('http://localhost');

    const contenido = await api.getAgentDocumentContent(TENANT, ALIAS, 'directive');
    expect(contenido.tenant_id).toBe(TENANT);

    const perfil = await api.getAgentPerfil(TENANT, ALIAS);
    expect(perfil.publicado).toBe(true);
  });
});
