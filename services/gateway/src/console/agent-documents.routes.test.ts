import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeFacts } from './agent-documents.js';
import {
  type AgentFactsProbe, type DocumentsResponse, type FactsSource, registerAgentDocumentRoutes
} from './agent-documents.routes.js';

/**
 * La ruta se levanta de verdad y se le pega con `app.inject`. No es un test del objeto que
 * devuelve una función: es el efecto de un GET sobre un fastify vivo, que es lo único que prueba
 * que la ruta existe, que responde y que el cuerpo sale como se espera.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

function probe(entradas: Record<string, { facts: RuntimeFacts; source: FactsSource }>): AgentFactsProbe {
  return {
    async factsFor(tenantId, alias) {
      return entradas[`${tenantId}:${alias}`];
    },
  };
}

function servidor(deps: Partial<Parameters<typeof registerAgentDocumentRoutes>[1]> = {}) {
  const app = Fastify();
  registerAgentDocumentRoutes(app, {
    authorize: async () => ACTOR,
    probe: probe({}),
    lookupAgent: async () => undefined,
    ...deps,
  });
  return app;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; });

describe('GET /v3/console/agents/:alias/documents', () => {
  it('con hechos MEDIDOS devuelve rutas editables', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:zeus': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents' });
    expect(res.statusCode).toBe(200);
    const body = res.json<DocumentsResponse>();
    expect(body.facts_source).toBe('measured');
    expect(body.caveat).toBeUndefined();
    const directiva = body.items.find((d) => d.kind === 'directive');
    expect(directiva?.path).toBe('/home/dev/.claude/CLAUDE.md');
    expect(directiva?.editable).toBe(true);
  });

  /**
   * Control negativo del diseño entero: si los hechos vienen del registro, NADA sale editable, y
   * el aviso viaja en el cuerpo. Un campo que parece editable y guarda en el fichero equivocado
   * es peor que no tener editor.
   */
  it('sin medición nada es editable y el aviso viaja en el cuerpo', async () => {
    vivo = servidor({
      lookupAgent: async () => ({
        tenant_id: 'Steven', alias: 'kant', harness_id: 'codex', home_directory: '/home/stev',
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: '/v3/console/agents/kant/documents' });
    expect(res.statusCode).toBe(200);
    const body = res.json<DocumentsResponse>();
    expect(body.facts_source).toBe('database');
    expect(body.caveat).toMatch(/5 de los 14/);
    expect(body.items.every((d) => !d.editable)).toBe(true);
    // Y encima la ruta que da la BD es la equivocada: kant corre claude.js, no codex.
    expect(body.items.find((d) => d.kind === 'directive')?.path).toBe('/home/stev/.codex/AGENTS.md');
  });

  it('un arnés que la BD no reconoce no inventa rutas', async () => {
    vivo = servidor({
      lookupAgent: async () => ({
        tenant_id: 'Steven', alias: 'argos', harness_id: 'hermes', home_directory: '/home/dev',
      }),
    });
    const body = (await vivo.inject({ method: 'GET', url: '/v3/console/agents/argos/documents' }))
      .json<DocumentsResponse>();
    expect(body.harness).toBe('unknown');
    expect(body.items).toEqual([]);
  });

  it('un alias que no se ve responde 404, no una lista vacía', async () => {
    vivo = servidor();
    const res = await vivo.inject({ method: 'GET', url: '/v3/console/agents/fantasma/documents' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  it('la medición gana sobre la base cuando existen las dos', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:salva': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
      }),
      lookupAgent: async () => ({
        tenant_id: 'Isa', alias: 'salva', harness_id: 'codex', home_directory: '/home/dev',
      }),
    });
    const body = (await vivo.inject({ method: 'GET', url: '/v3/console/agents/salva/documents' }))
      .json<DocumentsResponse>();
    expect(body.harness).toBe('claude');
    expect(body.items.find((d) => d.kind === 'directive')?.path).toBe('/home/dev/.claude/CLAUDE.md');
  });
});
