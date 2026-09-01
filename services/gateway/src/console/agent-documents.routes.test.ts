import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARCA_FIN, MARCA_INICIO, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO,
  marcaDeRevisionDelPerfil,
} from '@cauce/protocol';
import type { RuntimeFacts } from './agent-documents.js';
import {
  type AgentFactsProbe, type DocumentsResponse, type FactsSource, registerAgentDocumentRoutes
} from './agent-documents.routes.js';
import { hechosDelRegistro } from '../terminal/hechos-del-registro.js';
import { AgentRegistry, parseAgentPresence } from '../terminal/registry.js';

/**
 * The route is actually stood up and hit with `app.inject`. Not a test of whatever object a
 * function returns: it is the effect of a GET on a live fastify, which is the only thing that
 * proves the route exists, that it responds, and that the body comes out as expected.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MANAGED_DIRECTIVE = [
  '# Manual anterior',
  MARCA_INICIO,
  'contrato sellado',
  MARCA_FIN,
  marcaDeRevisionDelPerfil(7),
  MARCA_PERFIL_INICIO,
  'perfil proyectado',
  MARCA_PERFIL_FIN,
  'cola anterior',
  '',
].join('\n');

function probe(entradas: Record<string, { facts: RuntimeFacts; source: FactsSource }>): AgentFactsProbe {
  return {
    async factsFor(tenantId, alias) {
      return entradas[`${tenantId}:${alias}`];
    },
    // This route is the INVENTORY: it says which file is what and where it lives, never its content.
    // The doubles reject it so the day this route starts reading, the test notices.
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
    expect(directiva?.readable).toBe(true);
    expect(directiva?.editable).toBe(true);
    expect(body.items.find((d) => d.kind === 'tools')?.readable).toBe(false);
    expect(body.items.find((d) => d.kind === 'prompts')?.readable).toBe(false);
    expect(body.items.find((d) => d.kind === 'mcp')?.readable).toBe(false);
  });

  /**
   * Negative control of the whole design: if the facts come from the registry, NOTHING comes out
   * editable, and the warning travels in the body. A field that looks editable and writes to the
   * wrong file is worse than not having an editor.
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
    expect(body.items.every((d) => !d.readable)).toBe(true);
    expect(body.items.every((d) => !d.editable)).toBe(true);
    // On top of that, the path the DB gives is the wrong one: kant runs claude.js, not codex.
    expect(body.items.find((d) => d.kind === 'directive')?.path).toBe('/home/stev/.codex/AGENTS.md');
  });

  it('un arnés que la BD no reconoce no inventa rutas', async () => {
    vivo = servidor({
      authorizeTarget: async () => ({
        tenant_id: 'Steven', alias: 'argos', harness_id: 'opencode', home_directory: '/home/dev',
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
  it('un hello base sin marcador observado conserva terminal pero autoriza cero lecturas', async () => {
    const registry = new AgentRegistry();
    registry.observe({
      relay_instance_id: 'a'.repeat(64),
      relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, [parseAgentPresence({
      tenant_id: 'Steven', alias: 'zeus', container_id: 'ws-zeus', generation: '1',
      image_id: 'img', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      // Even with plausible roots from the bundle, without explicit observation they are not authority.
      home: '/home/dev', claude_config_dir: '/home/dev/.claude',
      modes: ['shell', 'harness'], connected_since: '2026-08-26T00:00:00.000Z',
    })]);
    const read = vi.fn(async () => ({ error: 'unavailable' as const, reason: 'no debe ocurrir' }));
    const measuredFacts = hechosDelRegistro(registry);
    vivo = servidor({
      probe: {
        factsFor: (tenantId, alias) => measuredFacts.factsFor(tenantId, alias),
        readGovernanceDocument: read,
        listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no debe ocurrir' }),
      },
    });
    expect(registry.state('Steven', 'zeus')).toBe('online');
    const response = await vivo.inject({
      method: 'GET', url: rutaContenido('Steven', 'zeus'),
    });
    expect(response.statusCode).toBe(409);
    expect(read).not.toHaveBeenCalled();
  });

  const FACTS: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
  const NO_MEDIDO_CASES: readonly (readonly [
    string,
    { facts: RuntimeFacts; source: FactsSource } | undefined,
  ])[] = [
    ['ausente', undefined],
    ['registry', { facts: FACTS, source: 'registry' }],
    ['database', { facts: FACTS, source: 'database' }],
  ];

  it.each(NO_MEDIDO_CASES)(
    'GET rechaza hechos %s antes de leer el home compartido',
    async (_label, facts) => {
      const readGovernanceDocument = vi.fn(async () => ({
        text: '# no debe leerse', bytes: 17, truncated: false,
        modified_at: '2026-08-25T00:00:00Z', sha: sha('# no debe leerse'),
      }));
      const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
      vivo = servidor({
        probe: {
          ...probe({}),
          factsFor: vi.fn(async () => facts),
          readGovernanceDocument,
          writeGovernanceDocument,
        },
      });

      const res = await vivo.inject({
        method: 'GET', url: rutaContenido('Miguel', 'kant'),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'no_medido' });
      expect(readGovernanceDocument).not.toHaveBeenCalled();
      expect(writeGovernanceDocument).not.toHaveBeenCalled();
    },
  );

  it.each(NO_MEDIDO_CASES)(
    'PUT rechaza hechos %s antes de leer o escribir el home compartido',
    async (_label, facts) => {
      const readGovernanceDocument = vi.fn(async () => ({
        text: '# anterior', bytes: 10, truncated: false,
        modified_at: '2026-08-25T00:00:00Z', sha: sha('# anterior'),
      }));
      const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
      vivo = servidor({
        probe: {
          ...probe({}),
          factsFor: vi.fn(async () => facts),
          readGovernanceDocument,
          writeGovernanceDocument,
        },
      });

      const res = await vivo.inject({
        method: 'PUT', url: rutaContenido('Miguel', 'kant'),
        payload: { content: 'nuevo', create_if_absent: true },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'no_medido' });
      expect(readGovernanceDocument).not.toHaveBeenCalled();
      expect(writeGovernanceDocument).not.toHaveBeenCalled();
    },
  );

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

  it('sirve perfil y manual allowlisted como sólo lectura sin habilitar PUT', async () => {
    const OPENCLAW: RuntimeFacts = {
      harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace',
    };
    const readGovernanceDocument = vi.fn(async () => ({
      text: '# identidad\n', bytes: 12, truncated: false,
      modified_at: '2026-08-25T00:00:00Z', sha: sha('# identidad\n'),
    }));
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: OPENCLAW, source: 'measured' } }),
        readGovernanceDocument,
        writeGovernanceDocument,
      },
    });

    const map = (await vivo.inject({ method: 'GET', url: rutaMapa('Miguel', 'kant') }))
      .json<DocumentsResponse>();
    expect(map.items.find((item) => item.kind === 'identity')).toMatchObject({
      category: 'profile', readable: true, editable: false,
    });
    expect(map.items.find((item) => item.kind === 'directive')).toMatchObject({
      category: 'manual', readable: true, editable: false,
    });

    const get = await vivo.inject({
      method: 'GET', url: rutaContenido('Miguel', 'kant', 'identity'),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      kind: 'identity', path: '/home/claw/workspace/IDENTITY.md',
      content: '# identidad\n', editable: false, exists: true,
    });
    expect(readGovernanceDocument).toHaveBeenCalledWith(
      '/home/claw/workspace/IDENTITY.md', OPENCLAW, 'Miguel', 'kant',
    );

    const put = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant', 'identity'),
      payload: { content: 'nuevo', expected_sha: sha('# identidad\n') },
    });
    expect(put.statusCode).toBe(403);
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['settings de Claude', FACTS, 'tools'],
    ['directorio de subagentes', FACTS, 'prompts'],
    ['MCP con OAuth', FACTS, 'mcp'],
    ['configuración OpenClaw con secretos', {
      harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace',
    }, 'configuration'],
  ] as const)('%s no llama a la sonda aunque se construya el GET a mano', async (_label, facts, kind) => {
    const readGovernanceDocument = vi.fn(async () => ({
      text: 'no debe salir', bytes: 13, truncated: false,
      modified_at: '2026-08-25T00:00:00Z', sha: sha('no debe salir'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts, source: 'measured' } }),
        readGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'GET', url: rutaContenido('Miguel', 'kant', kind),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not_readable' });
    expect(readGovernanceDocument).not.toHaveBeenCalled();
  });

  it('una respuesta malformada de la sonda es 502 y nunca una ausencia', async () => {
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: '# roto', bytes: 6, truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: '0'.repeat(64),
        }),
      },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaContenido('Miguel', 'kant') });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'invalid_probe_response' });
    expect(res.json()).not.toHaveProperty('exists', false);
  });

  it('unavailable se conserva como 503 y nunca se traduce a fichero ausente', async () => {
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({ error: 'unavailable', reason: 'relay desconectado' }),
      },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaContenido('Miguel', 'kant') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'unavailable', message: 'relay desconectado' });
    expect(res.json()).not.toHaveProperty('exists', false);
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

  it('permite cambiar texto manual externo y conserva los bloques gestionados con ACK exacto', async () => {
    const nuevo = MANAGED_DIRECTIVE
      .replace('# Manual anterior', '# Manual nuevo')
      .replace('cola anterior', 'cola nueva');
    const writeGovernanceDocument = vi.fn(async () => ({
      sha: sha(nuevo), bytes: Buffer.byteLength(nuevo, 'utf8'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: MANAGED_DIRECTIVE,
          bytes: Buffer.byteLength(MANAGED_DIRECTIVE, 'utf8'),
          truncated: false,
          modified_at: '2026-08-25T00:00:00Z',
          sha: sha(MANAGED_DIRECTIVE),
        }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, expected_sha: sha(MANAGED_DIRECTIVE) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true, evidence: 'probe_write_ack', sha: sha(nuevo),
    });
    expect(writeGovernanceDocument).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', nuevo,
      { state: 'present', sha256: sha(MANAGED_DIRECTIVE) }, FACTS, 'Miguel', 'kant',
    );
  });

  it.each([
    [
      'contenido gestionado alterado',
      MANAGED_DIRECTIVE.replace('perfil proyectado', 'perfil manual'),
      'managed_profile_changed',
    ],
    [
      'revisión retirada',
      MANAGED_DIRECTIVE.replace(`${marcaDeRevisionDelPerfil(7)}\n`, ''),
      'managed_profile_revision_changed',
    ],
    [
      'marcador retirado',
      MANAGED_DIRECTIVE.replace(`${MARCA_PERFIL_FIN}\n`, ''),
      'malformed_proposed',
    ],
    [
      'marcador reservado añadido',
      `${MANAGED_DIRECTIVE}<!-- CAUCE:OTRO v1 -->\n`,
      'unknown_reserved_markers_in_proposed',
    ],
    [
      'marcador reservado malformado',
      `${MANAGED_DIRECTIVE}texto <!-- CAUCE:OTRO v1 -->\n`,
      'malformed_proposed',
    ],
  ] as const)('%s responde 409 sin pedir escritura', async (_label, nuevo, conflict) => {
    const writeGovernanceDocument = vi.fn(async () => ({
      sha: sha(nuevo), bytes: Buffer.byteLength(nuevo, 'utf8'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: MANAGED_DIRECTIVE,
          bytes: Buffer.byteLength(MANAGED_DIRECTIVE, 'utf8'),
          truncated: false,
          modified_at: '2026-08-25T00:00:00Z',
          sha: sha(MANAGED_DIRECTIVE),
        }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, expected_sha: sha(MANAGED_DIRECTIVE) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'managed_context_conflict', conflict });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
  });

  it.each([
    `${MARCA_INICIO}\ncontrato\n${MARCA_FIN}\n`,
    '<!-- CAUCE:FUTURO v1 -->\n',
  ])('rechaza crear un manual ausente con marcadores reservados', async (nuevo) => {
    const writeGovernanceDocument = vi.fn(async () => ({
      sha: sha(nuevo), bytes: Buffer.byteLength(nuevo, 'utf8'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({ error: 'not_found', reason: 'no existe' }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, create_if_absent: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'managed_context_conflict', conflict: 'reserved_markers_on_create',
    });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
  });

  it('mantiene el CAS: una carrera de SHA responde 409 antes de comparar o escribir', async () => {
    const actual = '# cambio concurrente\n';
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: actual, bytes: Buffer.byteLength(actual, 'utf8'), truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: sha(actual),
        }),
        writeGovernanceDocument,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: '# nuevo\n', expected_sha: sha('# versión abierta\n') },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
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
