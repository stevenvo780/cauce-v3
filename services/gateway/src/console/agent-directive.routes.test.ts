import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TerminalRelayFactsProbe, type GovernanceRelayClient, type RuntimeFacts,
} from './agent-documents.js';
import type {
  AgentFactsProbe, GovernanceDocumentContent, GovernanceReadError, MemoryDirectoryListing
} from './agent-documents.routes.js';
import type { AgentDirective } from './types-agent-directive.js';
import { memoryRootForHarness, registerAgentDirectiveRoutes } from './agent-directive.routes.js';

/**
 * Mock probe for tests. Returns pre-recorded content or controlled errors.
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
      return entry.documents[path] ?? {
        error: 'not_found',
        reason: `${path} no está disponible`,
      };
    },
    async listMemoryDirectory(memoryRoot, facts, tenantId, alias) {
      const entry = entries[`${tenantId}:${alias}`];
      if (!entry?.memory) {
        return { error: 'not_found', reason: 'sin memoria' };
      }
      return entry.memory;
    },
  };
}

function servidor(deps: Partial<Parameters<typeof registerAgentDirectiveRoutes>[1]> = {}) {
  const app = Fastify();
  registerAgentDirectiveRoutes(app, {
    authorize: async (_request, requested) => requested,
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
  it('lleva el índice absoluto real del relay hasta la API como rutas relativas', async () => {
    const facts: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
    const manual = '# Manual\n';
    let listSignal: AbortSignal | undefined;
    const relay: GovernanceRelayClient = {
      readFile: async (_tenantId, _alias, path) => ({
        path,
        bytes: Buffer.byteLength(manual),
        truncated: false,
        modified_at: '2026-08-24T10:00:00Z',
        sha: createHash('sha256').update(manual).digest('hex'),
        content: manual,
      }),
      listDirectory: async (_tenantId, _alias, _path, signal) => {
        listSignal = signal;
        return {
          path: '/home/dev/.claude/projects',
          total: 1,
          observed_at_least: 1,
          truncated: false,
          entries: [{
            path: '/home/dev/.claude/projects/cauce/sesion.md',
            bytes: 12,
            modified_at: '2026-08-24T09:00:00Z',
          }],
        };
      },
    };
    vivo = servidor({
      probe: new TerminalRelayFactsProbe({
        factsFor: async () => ({ facts, source: 'measured' }),
      }, relay),
    });

    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });

    expect(response.statusCode).toBe(200);
    expect(listSignal).toBeInstanceOf(AbortSignal);
    expect(response.json<AgentDirective>().memory).toEqual({
      root: '/home/dev/.claude/projects',
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{ path: 'cauce/sesion.md', bytes: 12, modified_at: '2026-08-24T09:00:00Z' }],
    });
  });

  it('devuelve el fallo de memoria discriminado, nunca memory:null ni un cero inventado', async () => {
    vivo = servidor({
      probe: {
        factsFor: async () => ({
          facts: { harness: 'claude', home: '/home/dev' }, source: 'measured',
        }),
        readGovernanceDocument: async () => ({ error: 'not_found', reason: 'sin manual' }),
        listMemoryDirectory: async () => ({ error: 'timeout', reason: 'el agente no contestó' }),
      },
    });

    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AgentDirective>().memory).toEqual({
      root: '/home/dev/.claude/projects',
      error: 'timeout',
      reason: 'el agente no contestó',
    });
  });

  it('conserva total desconocido y el límite inferior observado', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:zeus': {
          facts: { harness: 'claude', home: '/home/dev' },
          documents: {},
          memory: {
            root: '/home/dev/.claude/projects',
            total: null,
            observed_at_least: 5_000,
            truncated: true,
            entries: [],
          },
        },
      }),
    });

    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.json<AgentDirective>().memory).toMatchObject({
      total: null, observed_at_least: 5_000, truncated: true,
    });
  });

  it('con hechos medidos devuelve contenido de CLAUDE.md + memoria', async () => {
    const claudeContent: GovernanceDocumentContent = {
      text: '# Manual de uso\n\nVer /docs para más info.',
      bytes: 42,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: 'a'.repeat(64),
    };
    const memoryIndex: MemoryDirectoryListing = {
      root: '/home/dev/.claude/projects',
      total: 3,
      observed_at_least: 3,
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
              sha: 'b'.repeat(64),
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
      probe: mockProbe({}), // Empty — no measurements
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
    expect(body.memory).toMatchObject({ error: 'unavailable' });
    expect(body.memory && 'error' in body.memory ? body.memory.reason : '')
      .toMatch(/no medido|sin hechos/u);
  });

  it('not_found medido se omite: files vacío significa miró y no existe', async () => {
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
            root: '/home/stev/.codex/memories',
            total: 0,
            observed_at_least: 0,
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
    expect(body.files).toEqual([]);
  });

  it('mezcla existente + not_found devuelve sólo el manual que realmente existe', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:zeus': {
          facts: {
            harness: 'claude', home: '/home/dev', workspaceRoot: '/workspace',
            projectRoot: '/workspace/repo', cwd: '/workspace/repo',
          },
          documents: {
            // Counterexample: it exists in the mount, but it is above projectRoot and does not govern.
            '/workspace/CLAUDE.md': {
              text: '# ajeno\n', bytes: 8, truncated: false,
              modified_at: '2026-08-26T00:00:00Z', sha: 'a'.repeat(64),
            },
            '/workspace/repo/CLAUDE.local.md': {
              text: '# local\n', bytes: 8, truncated: false,
              modified_at: '2026-08-26T00:00:00Z', sha: 'd'.repeat(64),
            },
          },
        },
      }),
    });
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.json<AgentDirective>().files).toEqual([expect.objectContaining({
      path: '/workspace/repo/CLAUDE.local.md', scope: 'workspace', sha: 'd'.repeat(64),
    })]);
    expect(response.json<AgentDirective>().files?.some(({ path }) => path === '/workspace/CLAUDE.md'))
      .toBe(false);
  });

  it('mezcla existente + timeout conserva el fallo discriminado y no finge ausencia', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:zeus': {
          facts: { harness: 'claude', home: '/home/dev', cwd: '/workspace/repo' },
          documents: {
            '/home/dev/.claude/CLAUDE.md': {
              text: '# global\n', bytes: 9, truncated: false,
              modified_at: '2026-08-26T00:00:00Z', sha: 'e'.repeat(64),
            },
            '/workspace/repo/CLAUDE.md': { error: 'timeout', reason: 'panel no respondió' },
          },
        },
      }),
    });
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(response.json<AgentDirective>().files).toEqual([
      expect.objectContaining({ path: '/home/dev/.claude/CLAUDE.md', text: '# global\n' }),
      expect.objectContaining({
        path: '/workspace/repo/CLAUDE.md', text: null, error: 'timeout', reason: 'panel no respondió',
      }),
    ]);
  });

  it('Codex selecciona override, salta AGENTS; un override vacío sí cae al fallback', async () => {
    const facts: RuntimeFacts = {
      harness: 'codex', home: '/home/dev', projectRoot: '/workspace/repo', cwd: '/workspace/repo',
    };
    const calls: string[] = [];
    vivo = servidor({
      probe: {
        factsFor: async () => ({ facts, source: 'measured' }),
        readGovernanceDocument: async (path) => {
          calls.push(path);
          if (path === '/home/dev/.codex/AGENTS.override.md') {
            return { text: '', bytes: 0, truncated: false, modified_at: '2026-08-26T00:00:00Z', sha: '0'.repeat(64) };
          }
          if (path === '/home/dev/.codex/AGENTS.md') {
            return { text: '# user\n', bytes: 7, truncated: false, modified_at: '2026-08-26T00:00:00Z', sha: '1'.repeat(64) };
          }
          if (path === '/workspace/repo/AGENTS.override.md') {
            return { text: '# override\n', bytes: 11, truncated: false, modified_at: '2026-08-26T00:00:00Z', sha: '2'.repeat(64) };
          }
          return { error: 'not_found', reason: 'ausente' };
        },
        listMemoryDirectory: async () => ({ error: 'not_found', reason: 'sin memoria' }),
      },
    });
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    const body = response.json<AgentDirective>();
    expect(body.files?.map((file) => file.path)).toEqual([
      '/home/dev/.codex/AGENTS.md', '/workspace/repo/AGENTS.override.md',
    ]);
    expect(calls).not.toContain('/workspace/repo/AGENTS.md');
    expect(body.manual_order).toBe('codex_precedence');
    expect(body.context_limitations?.join(' ')).toMatch(/fallback_filenames.*max_bytes/u);
  });

  it('Codex aplica project_doc_max_bytes al agregado y no consulta niveles fuera del cap', async () => {
    const chunk = 'x'.repeat(20 * 1024);
    const facts: RuntimeFacts = {
      harness: 'codex', home: '/home/dev', projectRoot: '/workspace/repo',
      cwd: '/workspace/repo/sub/deep', projectDocMaxBytes: 32 * 1024,
      projectDocFallbackFilenames: [],
    };
    const calls: string[] = [];
    vivo = servidor({
      probe: {
        factsFor: async () => ({ facts, source: 'measured' }),
        readGovernanceDocument: async (path) => {
          calls.push(path);
          if (path === '/workspace/repo/AGENTS.md' || path === '/workspace/repo/sub/AGENTS.md') {
            return {
              text: chunk, bytes: Buffer.byteLength(chunk), truncated: false,
              modified_at: '2026-08-26T00:00:00Z', sha: createHash('sha256').update(chunk).digest('hex'),
            };
          }
          return { error: 'not_found', reason: 'ausente' };
        },
        listMemoryDirectory: async () => ({ error: 'not_found', reason: 'sin memoria' }),
      },
    });
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    const projectFiles = response.json<AgentDirective>().files
      ?.filter(({ scope }) => scope === 'workspace') ?? [];
    expect(projectFiles).toHaveLength(2);
    expect(projectFiles[0]).toMatchObject({
      path: '/workspace/repo/AGENTS.md', truncated: false, bytes: 20 * 1024,
    });
    expect(Buffer.byteLength(projectFiles[0]?.text ?? '', 'utf8')).toBe(20 * 1024);
    expect(projectFiles[1]).toMatchObject({
      path: '/workspace/repo/sub/AGENTS.md', truncated: true, bytes: 20 * 1024,
    });
    expect(Buffer.byteLength(projectFiles[1]?.text ?? '', 'utf8')).toBe(12 * 1024);
    expect(calls.some((path) => path.startsWith('/workspace/repo/sub/deep/'))).toBe(false);
    expect(response.json<AgentDirective>().context_limitations).toEqual([]);
  });

  it('corta varias sondas colgadas con un deadline global y publica cada fila como timeout', async () => {
    const signals: AbortSignal[] = [];
    let reads = 0;
    let lists = 0;
    vivo = servidor({
      readBudgetMs: 25,
      probe: {
        factsFor: async () => ({
          facts: {
            harness: 'claude', home: '/home/dev', projectRoot: '/workspace/repo',
            cwd: '/workspace/repo/a/b',
          },
          source: 'measured',
        }),
        readGovernanceDocument: async (_path, _facts, _tenant, _alias, signal) => {
          reads += 1;
          if (signal !== undefined) signals.push(signal);
          return new Promise<GovernanceDocumentContent>(() => { return; });
        },
        listMemoryDirectory: async (_root, _facts, _tenant, _alias, signal) => {
          lists += 1;
          if (signal !== undefined) signals.push(signal);
          return new Promise<MemoryDirectoryListing>(() => { return; });
        },
      },
    });
    const started = Date.now();
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/zeus/directive',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    const body = response.json<AgentDirective>();
    expect(reads).toBe(3);
    expect(lists).toBe(1);
    expect(body.files).toHaveLength(10);
    expect(body.files?.every(({ error, reason }) => error === 'timeout'
      && reason?.includes('presupuesto global'))).toBe(true);
    expect(body.memory).toMatchObject({ error: 'timeout' });
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('OpenClaw sirve AGENTS.md como manual y nunca confunde openclaw.json con directiva', async () => {
    const gran_contenido = 'x'.repeat(300 * 1024); // 300 KB
    const workspace = '/home/dev/.openclaw/workspace';
    vivo = servidor({
      probe: mockProbe({
        'Steven:argos': {
          facts: { harness: 'openclaw', home: '/home/dev', openclawWorkspace: workspace },
          documents: {
            [`${workspace}/AGENTS.md`]: {
              text: gran_contenido.slice(0, 256 * 1024), // Trimmed to 256 KB
              bytes: gran_contenido.length, // But the real size is 300 KB
              truncated: true,
              modified_at: '2026-08-24T10:00:00Z',
              sha: 'c'.repeat(64),
            },
          },
          memory: {
            root: `${workspace}/memory`, total: 0, observed_at_least: 0,
            truncated: false, entries: [],
          },
        },
      }),
    });

    const res = await vivo.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/argos/directive',
    });

    const body = res.json<AgentDirective>();
    expect(body.files).toHaveLength(1);
    expect(body.files?.[0]).toMatchObject({ path: `${workspace}/AGENTS.md`, truncated: true });
    expect(body.files?.[0]?.bytes).toBe(300 * 1024);
    expect(body.files?.[0]?.text?.length).toBeLessThanOrEqual(256 * 1024);
    expect(body.files?.some((file) => file.path?.endsWith('/openclaw.json'))).toBe(false);
  });

  it('arnés unknown queda no medido y nunca fabrica medido:true con files vacío', async () => {
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
    expect(body.medido).toBe(false);
    expect(body.motivo).toMatch(/no está soportado/u);
    expect(body.files).toBeNull();
  });

  it('Hermes sirve su AGENTS.md medido en lugar de una ausencia falsa', async () => {
    vivo = servidor({
      probe: mockProbe({
        'Steven:hermes': {
          facts: { harness: 'hermes', home: '/home/dev' },
          documents: {
            '/home/dev/AGENTS.md': {
              text: '# Hermes\n', bytes: 9, truncated: false,
              modified_at: '2026-08-26T00:00:00Z', sha: 'f'.repeat(64),
            },
          },
        },
      }),
    });
    const response = await vivo.inject({
      method: 'GET', url: '/v3/console/agents/Steven/hermes/directive',
    });
    expect(response.json<AgentDirective>()).toMatchObject({
      medido: true,
      manual_order: 'workspace_only',
      files: [{ path: '/home/dev/AGENTS.md', text: '# Hermes\n' }],
    });
  });
});

describe('raíces de memoria separadas de manuales e inventario', () => {
  it('respeta CLAUDE_CONFIG_DIR, CODEX_HOME y el workspace OpenClaw medidos', () => {
    expect(memoryRootForHarness({
      harness: 'claude', home: '/home/dev', claudeConfigDir: '/home/dev/.claude-kant',
    })).toBe('/home/dev/.claude-kant/projects');
    expect(memoryRootForHarness({
      harness: 'codex', home: '/home/dev', codexHome: '/home/dev/.codex-kant',
    })).toBe('/home/dev/.codex-kant/memories');
    expect(memoryRootForHarness({
      harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace-kant',
    })).toBe('/home/claw/workspace-kant/memory');
  });

  it('OpenClaw sin workspace medido no inventa una memoria bajo ~/.openclaw', () => {
    expect(memoryRootForHarness({ harness: 'openclaw', home: '/home/claw' })).toBeNull();
  });
});
