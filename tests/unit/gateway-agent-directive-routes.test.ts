import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  construirRespuestaDegradada,
  memoryRootForHarness,
  registerAgentDirectiveRoutes,
  type AgentDirectiveDeps,
} from '../../services/gateway/src/console/agent-directive.routes.js';
import type {
  AgentFactsProbe,
  FactsSource,
  GovernanceDocumentContent,
  GovernanceReadError,
  MemoryDirectoryListing,
} from '../../services/gateway/src/console/agent-documents.routes.js';
import type { RuntimeFacts } from '../../services/gateway/src/console/agent-documents.js';
import type { AgentDirective } from '../../services/gateway/src/console/types-agent-directive.js';

/**
 * Tests herméticos para `services/gateway/src/console/agent-directive.routes.ts`.
 *
 * El módulo publica una sola ruta `GET /v3/console/agents/:tenant/:alias/directive` y
 * reexporta `memoryRootForHarness` además de exponer `construirRespuestaDegradada`.
 * Estos tests se ejecutan contra `app.inject` sin red, sin Postgres real y sin WebSocket:
 * el probe, el authorize y el reloj son dobles puros. La meta es cobertura de líneas y
 * ramas (≥70 %) sobre el módulo con asserts concretos, no `toBeTruthy` flojo.
 */

interface ProbeStub {
  readonly factsFor: AgentFactsProbe['factsFor'];
  readonly readGovernanceDocument: AgentFactsProbe['readGovernanceDocument'];
  readonly listMemoryDirectory: AgentFactsProbe['listMemoryDirectory'];
}

function probeConComportamiento(): {
  probe: ProbeStub;
  factsForCalls: { tenantId: string; alias: string }[];
  readCalls: { path: string; tenantId: string; alias: string }[];
  listCalls: { root: string; tenantId: string; alias: string }[];
  responderFacts(facts: RuntimeFacts, source?: FactsSource): void;
  responderRead(contenido: GovernanceDocumentContent | GovernanceReadError): void;
  responderList(contenido: MemoryDirectoryListing | GovernanceReadError): void;
  responderListIndefinido(): void;
  factsForLanza(mensaje: string): void;
  readLanza(mensaje: string): void;
  listLanza(mensaje: string): void;
} {
  let factsImpl: AgentFactsProbe['factsFor'] = async () => undefined;
  let readImpl: AgentFactsProbe['readGovernanceDocument'] = async () => ({
    error: 'not_found',
    reason: 'sin contenido',
  });
  let listImpl: AgentFactsProbe['listMemoryDirectory'] = async () => ({
    error: 'not_found',
    reason: 'sin memoria',
  });
  const factsForCalls: { tenantId: string; alias: string }[] = [];
  const readCalls: { path: string; tenantId: string; alias: string }[] = [];
  const listCalls: { root: string; tenantId: string; alias: string }[] = [];
  return {
    probe: {
      async factsFor(tenantId, alias) {
        factsForCalls.push({ tenantId, alias });
        return factsImpl(tenantId, alias);
      },
      async readGovernanceDocument(path, _facts, tenantId, alias) {
        readCalls.push({ path, tenantId, alias });
        return readImpl(path, _facts, tenantId, alias);
      },
      async listMemoryDirectory(root, _facts, tenantId, alias) {
        listCalls.push({ root, tenantId, alias });
        return listImpl(root, _facts, tenantId, alias);
      },
    },
    factsForCalls,
    readCalls,
    listCalls,
    responderFacts(facts, source = 'measured') {
      const snapshot = { facts, source };
      factsImpl = async () => snapshot;
    },
    responderRead(contenido) {
      readImpl = async () => contenido;
    },
    responderList(contenido) {
      listImpl = async () => contenido;
    },
    responderListIndefinido() {
      listImpl = async () => undefined as never;
    },
    factsForLanza(mensaje) {
      factsImpl = async () => {
        throw new Error(mensaje);
      };
    },
    readLanza(mensaje) {
      readImpl = async () => {
        throw new Error(mensaje);
      };
    },
    listLanza(mensaje) {
      listImpl = async () => {
        throw new Error(mensaje);
      };
    },
  };
}

interface ServidorOpciones {
  readonly authorize?: AgentDirectiveDeps['authorize'];
  readonly readBudgetMs?: number;
}

let vivo: FastifyInstance | undefined;

async function servidor(
  stub: ReturnType<typeof probeConComportamiento>,
  opciones: ServidorOpciones = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAgentDirectiveRoutes(app, {
    authorize: opciones.authorize ?? (async (_request, requested) => requested),
    probe: stub.probe,
    ...(opciones.readBudgetMs === undefined ? {} : { readBudgetMs: opciones.readBudgetMs }),
  });
  vivo = app;
  return app;
}

afterEach(async () => {
  await vivo?.close();
  vivo = undefined;
});

describe('memoryRootForHarness: raíz de memoria por arnés medido', () => {
  it('Claude usa ~/.claude/projects cuando no hay claudeConfigDir', () => {
    expect(memoryRootForHarness({ harness: 'claude', home: '/home/dev' }))
      .toBe('/home/dev/.claude/projects');
  });

  it('Claude respeta un claudeConfigDir medido por encima de ~/.claude', () => {
    expect(memoryRootForHarness({
      harness: 'claude', home: '/home/dev', claudeConfigDir: '/etc/cauce/claude-kant',
    })).toBe('/etc/cauce/claude-kant/projects');
  });

  it('Codex usa ~/.codex/memories cuando no hay codexHome', () => {
    expect(memoryRootForHarness({ harness: 'codex', home: '/home/dev' }))
      .toBe('/home/dev/.codex/memories');
  });

  it('Codex respeta un codexHome medido por encima de ~/.codex', () => {
    expect(memoryRootForHarness({
      harness: 'codex', home: '/home/dev', codexHome: '/srv/codex-kant',
    })).toBe('/srv/codex-kant/memories');
  });

  it('OpenClaw une el workspace medido con /memory', () => {
    expect(memoryRootForHarness({
      harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace-kant',
    })).toBe('/home/claw/workspace-kant/memory');
  });

  it('OpenClaw sin workspace medido devuelve null y no inventa ~/.openclaw', () => {
    expect(memoryRootForHarness({ harness: 'openclaw', home: '/home/claw' })).toBeNull();
  });

  it('OpenClaw con workspace relativo (no absoluto) devuelve null', () => {
    expect(memoryRootForHarness({
      harness: 'openclaw', home: '/home/claw', openclawWorkspace: 'workspace-relativo',
    })).toBeNull();
  });

  it('Hermes no publica raíz de memoria y devuelve null', () => {
    expect(memoryRootForHarness({ harness: 'hermes', home: '/home/dev' })).toBeNull();
  });

  it('Arnés desconocido devuelve null y no fabrica ruta', () => {
    expect(memoryRootForHarness({ harness: 'unknown', home: '/home/dev' })).toBeNull();
  });
});

describe('construirRespuestaDegradada: decisión según source', () => {
  it('source undefined devuelve degrada con motivo "sin hechos de entorno"', () => {
    expect(construirRespuestaDegradada(undefined)).toEqual({
      publicado: true,
      medido: false,
      motivo: 'contenedor no medido todavía (sin hechos de entorno)',
      files: null,
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'contenedor no medido todavía (sin hechos de entorno)',
      },
    });
  });

  it('source registry devuelve degrada con motivo sobre "rutas deducidas"', () => {
    expect(construirRespuestaDegradada('registry')).toEqual({
      publicado: true,
      medido: false,
      motivo: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
      files: null,
      memory: {
        root: null,
        error: 'unavailable',
        reason: 'rutas deducidas del registro, no medidas (sin garantía de corrección)',
      },
    });
  });

  it('source database devuelve degrada con motivo sobre "rutas deducidas"', () => {
    expect(construirRespuestaDegradada('database')?.motivo)
      .toMatch(/rutas deducidas del registro/u);
  });

  it('source measured devuelve undefined y deja pasar al camino medido', () => {
    expect(construirRespuestaDegradada('measured')).toBeUndefined();
  });
});

describe('registerAgentDirectiveRoutes: registro y validación de entrada', () => {
  it('publica la ruta GET /v3/console/agents/:tenant/:alias/directive', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    expect(stub.factsForCalls).toEqual([{ tenantId: 'Steven', alias: 'zeus' }]);
  });

  it('rechaza con 400 cuando el tenant no pasa TenantSchema (arranca con dígito)', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/1Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_input',
      message: 'tenant or alias is invalid',
    });
    expect(stub.factsForCalls).toHaveLength(0);
  });

  it('rechaza con 400 cuando el alias no pasa AliasSchema (arranca con mayúscula)', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/Zeus/directive',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_input',
      message: 'tenant or alias is invalid',
    });
    expect(stub.factsForCalls).toHaveLength(0);
  });
});

describe('registerAgentDirectiveRoutes: autorización', () => {
  it('responde 404 not_found cuando authorize devuelve undefined y no revela motivo', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub, {
      authorize: async () => undefined,
    });
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'not_found',
      message: 'agent not found or not visible',
    });
    expect(stub.factsForCalls).toHaveLength(0);
  });

  it('responde 404 cuando authorize autoriza otro tenant distinto al pedido', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub, {
      authorize: async () => ({
        tenant_id: 'Miguel', alias: 'kratos',
      }),
    });
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(404);
    expect(stub.factsForCalls).toHaveLength(0);
  });

  it('responde 404 cuando authorize autoriza el mismo tenant pero otro alias', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub, {
      authorize: async () => ({
        tenant_id: 'Steven', alias: 'kant',
      }),
    });
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(404);
    expect(stub.factsForCalls).toHaveLength(0);
  });
});

describe('registerAgentDirectiveRoutes: respuesta 200 cuando el camino medido existe', () => {
  it('devuelve publicado/medido/observed_at/files/manual_order/memory para Claude medido', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'claude', home: '/home/dev' });
    stub.responderRead({
      text: '# manual\n', bytes: 9, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'a'.repeat(64),
    });
    stub.responderList({
      root: '/home/dev/.claude/projects',
      total: 1, observed_at_least: 1, truncated: false,
      entries: [{
        path: 'sesion-x.md', bytes: 12, modified_at: '2026-08-30T00:00:00Z',
      }],
    });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(typeof body.observed_at).toBe('string');
    expect(body.container_id).toBeNull();
    expect(body.files?.length).toBeGreaterThan(0);
    expect(body.manual_order).toBe('claude_load_order');
    expect(body.context_coverage).toBe('standard_manuals');
    expect(body.context_limitations?.some((limitacion) => limitacion.includes('rules'))).toBe(true);
    expect(body.memory?.root).toBe('/home/dev/.claude/projects');
    expect(body.memory?.total).toBe(1);
    expect(body.memory?.entries?.[0]?.path).toBe('sesion-x.md');
  });

  it('Hermes medido devuelve manual_order workspace_only y un único manual del HOME', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'hermes', home: '/home/dev' });
    stub.responderRead({
      text: '# Hermes\n', bytes: 9, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'h'.repeat(64),
    });
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/hermes/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.medido).toBe(true);
    expect(body.manual_order).toBe('workspace_only');
  });

  it('Codex con projectDocMaxBytes medido devuelve context_limitations vacío', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({
      harness: 'codex', home: '/home/dev', projectRoot: '/workspace/repo',
      cwd: '/workspace/repo', projectDocMaxBytes: 32 * 1024,
      projectDocFallbackFilenames: [],
    });
    stub.responderRead({
      text: '# manual\n', bytes: 9, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'c'.repeat(64),
    });
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.context_limitations).toEqual([]);
  });

  it('Codex sin projectDocMaxBytes medido publica context_limitations con motivo y DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'codex', home: '/home/dev' });
    stub.responderRead({
      text: '# manual\n', bytes: 9, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'c'.repeat(64),
    });
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.context_limitations?.[0]).toMatch(/project_doc_fallback_filenames.*max_bytes/u);
    expect(body.context_limitations?.[0]).toContain('32768');
  });
});

describe('registerAgentDirectiveRoutes: probe que lanza errores', () => {
  it('factsFor que lanza devuelve 500 con cuerpo estándar de Fastify y no llama al relay', async () => {
    const stub = probeConComportamiento();
    stub.factsForLanza('relay no responde');
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(500);
    const body = response.json<{ statusCode: number; error: string; message: string }>();
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe('Internal Server Error');
    expect(body.message).toBe('relay no responde');
    expect(stub.readCalls).toHaveLength(0);
    expect(stub.listCalls).toHaveLength(0);
  });

  it('readGovernanceDocument que lanza se traduce a error "unknown" en files[] sin 5xx', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'claude', home: '/home/dev' });
    stub.readLanza('socket colgado');
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.files?.length).toBeGreaterThan(0);
    expect(body.files?.every((file) => file.error === 'unknown')).toBe(true);
    expect(body.files?.every((file) => (file.reason ?? '').includes('socket colgado'))).toBe(true);
    expect(body.files?.every((file) => file.text === null && file.sha === null)).toBe(true);
  });

  it('listMemoryDirectory que lanza se traduce a memory.error "unknown"', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'claude', home: '/home/dev' });
    stub.responderRead({
      text: '# manual\n', bytes: 9, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'a'.repeat(64),
    });
    stub.listLanza('índice cayó');
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const memory = response.json<AgentDirective>().memory;
    expect(memory).toMatchObject({
      root: '/home/dev/.claude/projects', error: 'unknown',
    });
    expect(memory && 'reason' in memory ? memory.reason : '').toMatch(/el índice falló: índice cayó/u);
  });
});

describe('registerAgentDirectiveRoutes: respuesta parcial con archivos corruptos', () => {
  it('mezcla existente + not_found + permission_denied conserva cada fallo discriminado', async () => {
    const documentos = new Map<string, GovernanceDocumentContent | GovernanceReadError>();
    const textoBueno: GovernanceDocumentContent = {
      text: '# ok\n', bytes: 5, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: '1'.repeat(64),
    };
    documentos.set('/home/dev/.claude/CLAUDE.md', textoBueno);
    documentos.set('/workspace/repo/CLAUDE.md', {
      error: 'permission_denied', reason: 'no se sirve',
    });
    documentos.set('/workspace/repo/.claude/CLAUDE.md', {
      error: 'timeout', reason: 'panel no respondió',
    });
    documentos.set('/workspace/repo/CLAUDE.local.md', {
      error: 'not_found', reason: 'no existe',
    });
    const stub = probeConComportamiento();
    stub.responderFacts({
      harness: 'claude', home: '/home/dev',
      cwd: '/workspace/repo', projectRoot: '/workspace/repo',
    });
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const probeEspecifico: AgentFactsProbe = {
      factsFor: stub.probe.factsFor,
      readGovernanceDocument: async (path) => documentos.get(path) ?? {
        error: 'not_found', reason: 'no mapeado',
      },
      listMemoryDirectory: stub.probe.listMemoryDirectory,
    };
    const app = Fastify({ logger: false });
    registerAgentDirectiveRoutes(app, {
      authorize: async (_request, requested) => requested,
      probe: probeEspecifico,
    });
    vivo = app;
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const files = response.json<AgentDirective>().files ?? [];
    expect(files.some((file) => file.path === '/home/dev/.claude/CLAUDE.md'
      && file.text === '# ok\n' && file.error === undefined)).toBe(true);
    expect(files.some((file) => file.path === '/workspace/repo/CLAUDE.md'
      && file.error === 'permission_denied' && file.text === null && file.sha === null)).toBe(true);
    expect(files.some((file) => file.path === '/workspace/repo/.claude/CLAUDE.md'
      && file.error === 'timeout' && file.reason === 'panel no respondió')).toBe(true);
    expect(files.some((file) => file.path === '/workspace/repo/CLAUDE.local.md')).toBe(false);
  });
});

describe('registerAgentDirectiveRoutes: degradación cuando factsFor devuelve source distinto de measured', () => {
  it('source "registry" devuelve publicado/medido:false con motivo sobre "registro" y memory error unavailable', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'claude', home: '/home/dev' }, 'registry');
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.medido).toBe(false);
    expect(body.motivo).toMatch(/rutas deducidas del registro/u);
    expect(body.files).toBeNull();
    expect(body.memory).toMatchObject({
      root: null, error: 'unavailable',
    });
    expect(body.memory && 'reason' in body.memory ? body.memory.reason : '').toMatch(/registro/u);
    expect(stub.readCalls).toHaveLength(0);
  });

  it('factsFor que devuelve undefined cae en la rama "sin hechos de entorno"', async () => {
    const stub = probeConComportamiento();
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.medido).toBe(false);
    expect(body.motivo).toMatch(/sin hechos de entorno/u);
    expect(body.files).toBeNull();
    expect(stub.readCalls).toHaveLength(0);
  });
});

describe('registerAgentDirectiveRoutes: arnés unknown medido se rechaza como no soportado', () => {
  it('facts.harness unknown devuelve publicado/medido:false con motivo "no soportado" y files null', async () => {
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'unknown', home: '/home/dev' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/misterioso/directive',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.medido).toBe(false);
    expect(body.motivo).toMatch(/no está soportado/u);
    expect(body.files).toBeNull();
    expect(body.memory).toMatchObject({ root: null, error: 'unavailable' });
    expect(body.memory && 'reason' in body.memory ? body.memory.reason : '').toMatch(/no está soportado/u);
  });
});

describe('registerAgentDirectiveRoutes: arnés OpenClaw sirve el AGENTS.md del workspace medido', () => {
  it('OpenClaw mide el workspace y expone su AGENTS.md sin filtrar openclaw.json', async () => {
    const workspace = '/home/dev/.openclaw/workspace';
    const stub = probeConComportamiento();
    stub.responderFacts({ harness: 'openclaw', home: '/home/dev', openclawWorkspace: workspace });
    stub.responderRead({
      text: '# openclaw\n', bytes: 11, truncated: false,
      modified_at: '2026-08-30T00:00:00Z', sha: 'o'.repeat(64),
    });
    stub.responderList({ error: 'not_found', reason: 'sin memoria' });
    const app = await servidor(stub);
    const response = await app.inject({
      method: 'GET', url: '/v3/console/agents/Steven/argos/directive',
    });
    expect(response.statusCode).toBe(200);
    const files = response.json<AgentDirective>().files ?? [];
    const openclawJson = files.find((file) => file.path?.endsWith('/openclaw.json'));
    expect(openclawJson).toBeUndefined();
  });
});
