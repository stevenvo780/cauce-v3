import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function probe(entradas: Record<string, { facts: RuntimeFacts; source: FactsSource }>): AgentFactsProbe {
  return {
    async factsFor(tenantId, alias) {
      return entradas[`${tenantId}:${alias}`];
    },
    // Esta ruta es el INVENTARIO: dice qué fichero es cada cosa y dónde vive, nunca su contenido.
    // El doble los rechaza para que un día en que la ruta empiece a leer, el test lo note.
    async readGovernanceDocument() {
      return { error: 'unavailable', reason: 'el inventario no lee contenido' };
    },
    async listMemoryDirectory() {
      return { error: 'unavailable', reason: 'el inventario no lee memoria' };
    },
  };
}

function servidor(deps: Partial<Parameters<typeof registerAgentDocumentRoutes>[1]> = {}) {
  const app = Fastify();
  registerAgentDocumentRoutes(app, {
    authorize: async () => ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({
      tenant_id: tenantId, alias, harness_id: null, home_directory: null, enabled: true,
    }),
    probe: probe({}),
    ...deps,
  });
  return app;
}

function rutaMapa(tenantId: string, alias: string): string {
  return `/v3/console/tenants/${tenantId}/agents/${alias}/documents`;
}

function rutaContenido(tenantId: string, alias: string, kind = 'directive'): string {
  return `${rutaMapa(tenantId, alias)}/${kind}/content`;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; });

describe('GET tenant-qualified del mapa de documentos', () => {
  it('con hechos MEDIDOS devuelve rutas editables', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:zeus': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'zeus') });
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
      authorizeTarget: async () => ({
        tenant_id: 'Steven', alias: 'kant', harness_id: 'codex', home_directory: '/home/stev',
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'kant') });
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
      authorizeTarget: async () => ({
        tenant_id: 'Steven', alias: 'argos', harness_id: 'hermes', home_directory: '/home/dev',
      }),
    });
    const body = (await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'argos') }))
      .json<DocumentsResponse>();
    expect(body.harness).toBe('unknown');
    expect(body.items).toEqual([]);
  });

  it('un alias que no se ve responde 404, no una lista vacía', async () => {
    vivo = servidor({ authorizeTarget: async () => undefined });
    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'fantasma') });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  it('la medición gana sobre la base cuando existen las dos', async () => {
    vivo = servidor({
      probe: probe({
        'Isa:salva': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
      }),
      authorizeTarget: async () => ({
        tenant_id: 'Isa', alias: 'salva', harness_id: 'codex', home_directory: '/home/dev',
      }),
    });
    const body = (await vivo.inject({ method: 'GET', url: rutaMapa('Isa', 'salva') }))
      .json<DocumentsResponse>();
    expect(body.harness).toBe('claude');
    expect(body.items.find((d) => d.kind === 'directive')?.path).toBe('/home/dev/.claude/CLAUDE.md');
  });

  it('el mismo alias en dos tenants usa únicamente el tenant de la URL', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:kant': { facts: { harness: 'claude', home: '/home/stev' }, source: 'measured' },
        'Miguel:kant': { facts: { harness: 'codex', home: '/home/miguel' }, source: 'measured' },
      }),
    });

    const body = (await vivo.inject({ method: 'GET', url: rutaMapa('Miguel', 'kant') }))
      .json<DocumentsResponse>();

    expect(body).toMatchObject({ tenant_id: 'Miguel', alias: 'kant', harness: 'codex' });
    expect(body.items.find((item) => item.kind === 'directive')?.path)
      .toBe('/home/miguel/.codex/AGENTS.md');
  });

  it('un destino denegado no llega ni a la sonda', async () => {
    const factsFor = vi.fn(async () => undefined);
    vivo = servidor({
      authorizeTarget: async () => undefined,
      probe: { ...probe({}), factsFor },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Miguel', 'kant') });

    expect(res.statusCode).toBe(404);
    expect(factsFor).not.toHaveBeenCalled();
  });

  it('la ruta legacy queda same-tenant y se marca deprecada', async () => {
    let destino: readonly unknown[] | undefined;
    vivo = servidor({
      authorizeTarget: async (_actor, tenantId, alias, _permission, legacy) => {
        destino = [tenantId, alias, legacy];
        return { tenant_id: tenantId, alias, harness_id: 'claude', home_directory: '/home/dev' };
      },
    });

    const res = await vivo.inject({ method: 'GET', url: '/v3/console/agents/kant/documents' });

    expect(res.statusCode).toBe(200);
    expect(res.headers.deprecation).toBe('true');
    expect(destino).toEqual(['Steven', 'kant', true]);
    expect(res.json()).toMatchObject({ tenant_id: 'Steven', alias: 'kant' });
  });
});

describe('contenido y escritura tenant-qualified', () => {
  const FACTS: RuntimeFacts = { harness: 'claude', home: '/home/dev' };

  it('lee el contenido del tenant objetivo, no del tenant del actor', async () => {
    const readGovernanceDocument = vi.fn(async () => ({
      text: '# Miguel\n', bytes: 9, truncated: false, modified_at: '2026-08-25T00:00:00Z',
      sha: sha('# Miguel\n'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument,
      },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaContenido('Miguel', 'kant') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tenant_id: 'Miguel', alias: 'kant', content: '# Miguel\n', exists: true, projected: false,
    });
    expect(readGovernanceDocument).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', FACTS, 'Miguel', 'kant',
    );
  });

  it('si la sonda no sabe escribir responde 503 honesto', async () => {
    vivo = servidor({
      probe: probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: '# nuevo\n', expected_sha: 'a'.repeat(64) },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'unavailable' });
  });

  it('sólo afirma applied cuando recibió el ACK de escritura de la sonda', async () => {
    let permiso: string | undefined;
    const anterior = '# viejo';
    const nuevo = '# nuevo';
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha(nuevo), bytes: 7 }));
    vivo = servidor({
      authorize: async (_request, requested) => {
        permiso = requested;
        return ACTOR;
      },
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: anterior, bytes: 7, truncated: false, modified_at: '2026-08-25T00:00:00Z',
          sha: sha(anterior),
        }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT',
      url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, expected_sha: sha(anterior) },
    });

    expect(res.statusCode).toBe(200);
    expect(permiso).toBe('control');
    expect(res.json()).toEqual({
      ok: true,
      state: 'applied',
      evidence: 'probe_write_ack',
      path: '/home/dev/.claude/CLAUDE.md',
      sha: sha(nuevo),
      bytes: 7,
    });
    expect(writeGovernanceDocument).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', nuevo,
      { state: 'present', sha256: sha(anterior) }, FACTS, 'Miguel', 'kant',
    );
  });

  it('crea sólo cuando GET observó ausencia y el cliente manda create_if_absent', async () => {
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('# primero'), bytes: 9 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({ error: 'not_found', reason: 'no existe' }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: '# primero', create_if_absent: true },
    });

    expect(res.statusCode).toBe(200);
    expect(writeGovernanceDocument).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', '# primero', { state: 'absent' }, FACTS, 'Miguel', 'kant',
    );
  });

  it('un prefijo truncado nunca se puede reemplazar, aun con el SHA real', async () => {
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: 'prefijo', bytes: 900_000, truncated: true,
          modified_at: '2026-08-25T00:00:00Z', sha: 'c'.repeat(64),
        }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: 'nuevo', expected_sha: 'c'.repeat(64) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'truncated_source' });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
  });

  it('un 2xx interno sin ACK exacto se transforma en error y no en applied', async () => {
    const anterior = 'viejo';
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: anterior, bytes: 5, truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: sha(anterior),
        }),
        writeGovernanceDocument: async () => ({ sha: 'd'.repeat(64), bytes: 5 }),
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: 'nuevo', expected_sha: sha(anterior) },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'invalid_ack' });
  });

  it('un alias apagado falla cerrado antes de consultar el disco', async () => {
    const factsFor = vi.fn(async () => ({ facts: FACTS, source: 'measured' as const }));
    vivo = servidor({
      authorizeTarget: async (_actor, tenantId, alias) => ({
        tenant_id: tenantId, alias, enabled: false,
      }),
      probe: { ...probe({}), factsFor },
    });
    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: 'nuevo', create_if_absent: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent_disabled' });
    expect(factsFor).not.toHaveBeenCalled();
  });
});
