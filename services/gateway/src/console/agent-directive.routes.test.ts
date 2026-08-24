import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeFacts } from './agent-documents.js';
import type {
  AgentFactsProbe, GovernanceDocumentContent, GovernanceReadError, MemoryDirectoryListing
} from './agent-documents.routes.js';
import type { AgentDirective } from './types-agent-directive.js';
import { registerAgentDirectiveRoutes } from './agent-directive.routes.js';

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

/**
 * Mock probe para tests. Devuelve contenido pre-grabado o errores controlados.
 */
interface MockProbeEntry {
  facts: RuntimeFacts;
  documents: Record<string, GovernanceDocumentContent | GovernanceReadError>;
  memory?: MemoryDirectoryListing;
}

function mockProbe(entries: Record<string, MockProbeEntry>): AgentFactsProbe {
  return {
    async factsFor(tenantId, alias) {
      const entry = entries[`${tenantId}:${alias}`];
      if (!entry) return undefined;
      return { facts: entry.facts, source: 'measured' };
    },
    async readGovernanceDocument(path, facts, tenantId, alias) {
      const entry = entries[`${tenantId}:${alias}`];
      if (!entry) {
        return { error: 'not_found', reason: 'alias no encontrado' };
      }
      return entry.documents[path] || {
        error: 'not_found',
        reason: `${path} no está disponible`,
      };
    },
    async listMemoryDirectory(memoryRoot, facts, tenantId, alias) {
      const entry = entries[`${tenantId}:${alias}`];
      if (!entry || !entry.memory) {
        return { error: 'not_found', reason: 'sin memoria' };
      }
      return entry.memory;
    },
  };
}

function servidor(deps: Partial<Parameters<typeof registerAgentDirectiveRoutes>[1]> = {}) {
  const app = Fastify();
  registerAgentDirectiveRoutes(app, {
    authorize: async () => ACTOR,
    probe: mockProbe({}),
    ...deps,
  });
  return app;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => {
  await vivo?.close();
  vivo = undefined;
});

describe('GET /v3/console/agents/:tenant/:alias/directive', () => {
  it('con hechos medidos devuelve contenido de CLAUDE.md + memoria', async () => {
    const claudeContent: GovernanceDocumentContent = {
      text: '# Manual de uso\n\nVer /docs para más info.',
      bytes: 42,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
    };
    const memoryIndex: MemoryDirectoryListing = {
      root: '/home/dev/.claude/projects',
      total: 3,
      truncated: false,
      entries: [
        { path: 'proyecto-a', bytes: 1024, modified_at: '2026-08-20T12:00:00Z' },
        { path: 'proyecto-b', bytes: 2048, modified_at: '2026-08-21T12:00:00Z' },
        { path: 'proyecto-c', bytes: 512, modified_at: '2026-08-22T12:00:00Z' },
      ],
    };

    vivo = servidor({
      probe: mockProbe({
        'Steven:zeus': {
          facts: { harness: 'claude', home: '/home/dev' },
          documents: {
            '/home/dev/.claude/CLAUDE.md': claudeContent,
            '/home/dev/.claude/settings.json': {
              text: '{"hooks": {}}',
              bytes: 14,
              truncated: false,
              modified_at: '2026-08-23T10:00:00Z',
            },
            '/home/dev/.claude.json': { error: 'permission_denied', reason: 'no se sirve' },
          },
          memory: memoryIndex,
        },
      }),
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.observed_at).toBeDefined();
    expect(body.files).toBeDefined();
    expect(body.files?.length).toBeGreaterThan(0);

    const claudeFile = body.files?.find((f) => f.path === '/home/dev/.claude/CLAUDE.md');
    expect(claudeFile).toBeDefined();
    expect(claudeFile?.text).toMatch(/Manual de uso/);
    expect(claudeFile?.truncated).toBe(false);
    expect(claudeFile?.scope).toBe('user');

    expect(body.memory).toBeDefined();
    expect(body.memory?.total).toBe(3);
    expect(body.memory?.entries?.length).toBe(3);
  });

  it('sin hechos medidos devuelve publicado: false', async () => {
    vivo = servidor({
      probe: mockProbe({}), // Vacío — sin mediciones
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.motivo).toMatch(/no medido|deducido/);
    expect(body.files).toBeNull();
    expect(body.memory).toBeNull();
  });

  it('errores de lectura marcan archivos como unavailable pero devuelven 200', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:kant': {
          facts: { harness: 'codex', home: '/home/stev' },
          documents: {
            '/home/stev/.codex/AGENTS.md': {
              error: 'not_found',
              reason: 'fichero no existe',
            },
          },
          memory: {
            root: '/home/stev/.codex/prompts',
            total: 0,
            truncated: false,
            entries: [],
          },
        },
      }),
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/kant/directive',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    const agentsFile = body.files?.find((f) => f.path === '/home/stev/.codex/AGENTS.md');
    expect(agentsFile?.text).toBeNull();
    expect(agentsFile?.bytes).toBeNull();
  });

  it('fichero truncado marca truncated: true', async () => {
    const gran_contenido = 'x'.repeat(300 * 1024); // 300 KB
    vivo = servidor({
      probe: mockProbe({
        'Steven:argos': {
          facts: { harness: 'openclaw', home: '/home/dev' },
          documents: {
            '/home/dev/.openclaw/openclaw.json': {
              text: gran_contenido.slice(0, 256 * 1024), // Recortado a 256 KB
              bytes: gran_contenido.length, // Pero el tamaño real es 300 KB
              truncated: true,
              modified_at: '2026-08-24T10:00:00Z',
            },
          },
          memory: { root: '/home/dev/.openclaw/memory', total: 0, truncated: false, entries: [] },
        },
      }),
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/argos/directive',
    });

    const body = res.json<AgentDirective>();
    const openlawFile = body.files?.find((f) => f.path === '/home/dev/.openclaw/openclaw.json');
    expect(openlawFile?.truncated).toBe(true);
    expect(openlawFile?.bytes).toBe(300 * 1024);
    expect(openlawFile?.text?.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('arnés unknown devuelve files vacío pero publicado: true', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:unknown': {
          facts: { harness: 'unknown', home: '/home/dev' },
          documents: {},
        },
      }),
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/unknown/directive',
    });

    const body = res.json<AgentDirective>();
    expect(body.publicado).toBe(true);
    expect(body.files).toEqual([]);
  });
});
