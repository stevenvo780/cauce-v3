import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentFactsProbe, GovernanceReadError, TerminalAuditEntry,
} from './agent-documents.routes.js';
import { registerAgentDocumentRoutes } from './agent-documents.routes.js';
import {
  type GovernanceRelayClient, type MeasuredFactsSource, type RelayFileRead,
  type RelayDirectoryRead, type RuntimeFacts, TerminalRelayFactsProbe, verifyReadablePath
} from './agent-documents.js';

/**
 * READ path of the Directive modal. What is tested here is mostly what is NOT read: the gate
 * opens for two names and closes for everything else, including any path that does not come
 * from measured facts.
 */

const CLAUDE: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
const RUTA_CLAUDE = '/home/dev/.claude/CLAUDE.md';
const MEMORY_ROOT = '/home/dev/.claude/projects';

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function relayQueDevuelve(answer: RelayFileRead | GovernanceReadError): GovernanceRelayClient {
  return { readFile: vi.fn(async () => answer) };
}

function relayQueLista(answer: RelayDirectoryRead | GovernanceReadError): GovernanceRelayClient & {
  readonly listCalls: () => readonly unknown[][];
} {
  const listDirectory = vi.fn(async () => answer);
  return {
    readFile: vi.fn(async (): Promise<GovernanceReadError> => ({ error: 'unavailable', reason: 'no aplica' })),
    listDirectory,
    listCalls: () => listDirectory.mock.calls,
  };
}

const SIN_HECHOS: MeasuredFactsSource = { factsFor: async () => undefined };

function lectura(overrides: Partial<RelayFileRead> = {}): RelayFileRead {
  const content = overrides.content ?? '# Manual del sitio\n';
  return {
    path: RUTA_CLAUDE,
    bytes: overrides.bytes ?? Buffer.byteLength(content, 'utf8'),
    truncated: false,
    modified_at: '2026-08-24T10:00:00Z',
    sha: overrides.sha ?? sha(content),
    content,
    ...overrides
  };
}

describe('verifyReadablePath abre para el manual del sitio', () => {
  it('deja pasar el CLAUDE.md que sale de los hechos medidos', () => {
    expect(verifyReadablePath(CLAUDE, RUTA_CLAUDE)).toEqual({ allowed: true });
  });
});

describe('verifyReadablePath se cierra para todo lo demás', () => {
  it('no sirve credenciales aunque estén en el juego cerrado', () => {
    // `.claude.json` DOES come out of `resolveAgentDocuments`: this is what actually stops it.
    const verdict = verifyReadablePath(CLAUDE, '/home/dev/.claude.json');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('no se sirve nunca');
  });
});

describe('TerminalRelayFactsProbe.readGovernanceDocument', () => {
  it('devuelve el contenido que trae el relay', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueDevuelve(lectura()));

    const result = await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus');

    expect(result).toEqual({
      text: '# Manual del sitio\n',
      bytes: Buffer.byteLength('# Manual del sitio\n'),
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: sha('# Manual del sitio\n'),
    });
  });
});

describe('TerminalRelayFactsProbe.listMemoryDirectory', () => {
  function indice(overrides: Partial<RelayDirectoryRead> = {}): RelayDirectoryRead {
    return {
      path: MEMORY_ROOT,
      total: 2,
      observed_at_least: 2,
      truncated: false,
      entries: [
        { path: `${MEMORY_ROOT}/sesiones/hoy.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z' },
        { path: `${MEMORY_ROOT}/ayer.md`, bytes: 7, modified_at: '2026-08-23T10:00:00Z' },
      ],
      ...overrides,
    };
  }

  it('exige la raíz exacta de los hechos y devuelve rutas relativas', async () => {
    const relay = relayQueLista(indice());
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay);

    expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toEqual({
      root: MEMORY_ROOT,
      total: 2,
      observed_at_least: 2,
      truncated: false,
      entries: [
        { path: 'sesiones/hoy.md', bytes: 12, modified_at: '2026-08-24T10:00:00Z' },
        { path: 'ayer.md', bytes: 7, modified_at: '2026-08-23T10:00:00Z' },
      ],
    });
    expect(relay.listCalls()).toEqual([['Steven', 'zeus', MEMORY_ROOT, undefined]]);
  });

  it('rechaza marcadores de symlink, campos extra, más de 200 y totales incoherentes', async () => {
    const malformed: RelayDirectoryRead[] = [
      indice({ entries: [{
        path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z', symlink: true,
      } as RelayDirectoryRead['entries'][number]], total: 1 }),
      { ...indice(), extra: true } as RelayDirectoryRead,
      indice({
        total: 201,
        truncated: true,
        entries: Array.from({ length: 201 }, (_, index) => ({
          path: `${MEMORY_ROOT}/${String(index)}.md`, bytes: index, modified_at: '2026-08-24T10:00:00Z',
        })),
      }),
      indice({ total: 1 }),
      indice({ total: 3, truncated: false }),
      indice({ total: null, observed_at_least: 5_000, truncated: false }),
      indice({ total: 2, observed_at_least: 1 }),
    ];
    for (const answer of malformed) {
      const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueLista(answer));
      expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toHaveProperty('error');
    }
  });
});

const ACTOR_LECTOR = { tenant_id: 'Steven', alias: 'zeus' };
const CONTENIDO = '# Manual del sitio\n';
const filasDeLectura: TerminalAuditEntry[] = [];

const ANONIMO = { operator_id: 'unattributed:console-basic-auth', attributed: false };

function servidorDeLectura(probe: AgentFactsProbe) {
  const app = Fastify();
  registerAgentDocumentRoutes(app, {
    authorize: async () => ACTOR_LECTOR,
    resolveOperator: () => ANONIMO,
    authorizeTarget: async (_actor, tenant_id, alias) => ({
      tenant_id, alias, harness_id: 'claude', home_directory: '/home/dev', enabled: true,
    }),
    recordAudit: async (entry) => { filasDeLectura.push(entry); },
    probe,
  });
  return app;
}

function sondaDeLectura(overrides: Partial<AgentFactsProbe> = {}): AgentFactsProbe {
  return {
    factsFor: async () => ({ facts: CLAUDE, source: 'measured' }),
    readGovernanceDocument: async () => ({
      text: CONTENIDO, bytes: Buffer.byteLength(CONTENIDO, 'utf8'), truncated: false,
      modified_at: '2026-08-25T00:00:00Z', sha: sha(CONTENIDO),
    }),
    listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no aplica' }),
    ...overrides,
  };
}

const BASE_LECTURA = '/v3/console/tenants/Miguel/agents/kant/documents';

let servidorVivo: ReturnType<typeof servidorDeLectura> | undefined;
afterEach(async () => {
  await servidorVivo?.close();
  servidorVivo = undefined;
  filasDeLectura.length = 0;
});

describe('solo la lectura de contenido real deja fila en audit_events', () => {
  it('el GET de contenido audita agent_document.read sin el texto servido', async () => {
    servidorVivo = servidorDeLectura(sondaDeLectura());
    const res = await servidorVivo.inject({
      method: 'GET', url: `${BASE_LECTURA}/directive/content`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: CONTENIDO, exists: true });
    expect(filasDeLectura).toHaveLength(1);
    const fila = filasDeLectura[0];
    expect(fila).toMatchObject({
      tenant_id: 'Steven', actor_alias: 'zeus',
      action: 'agent_document.read', decision: 'allow',
    });
    expect(fila?.metadata).toEqual({
      operator_id: 'Steven:zeus', target_tenant: 'Miguel', target_alias: 'kant',
      harness_id: 'claude', home_directory: '/home/dev', facts_source: 'measured',
      kind: 'directive', path: RUTA_CLAUDE, sha_before: sha(CONTENIDO), sha_after: null,
      bytes: Buffer.byteLength(CONTENIDO, 'utf8'),
    });
    expect(JSON.stringify(fila?.metadata)).not.toContain('Manual del sitio');
  });
});

describe('la sesión sin atribuir lee la gobernanza pero no la escribe', () => {

  it('el PUT de la misma sesión anónima se cierra con 403 writable_requires_attribution', async () => {
    const writeGovernanceDocument = vi.fn(async () => ({
      sha: sha(CONTENIDO), bytes: Buffer.byteLength(CONTENIDO, 'utf8'),
    }));
    servidorVivo = servidorDeLectura(sondaDeLectura({ writeGovernanceDocument }));

    const res = await servidorVivo.inject({
      method: 'PUT', url: `${BASE_LECTURA}/directive/content`,
      payload: {
        content: '# reescrito\n', expected_sha: sha(CONTENIDO),
        reason: 'quiero reescribir el manual sin decir quién soy',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'forbidden', reason: 'writable_requires_attribution',
    });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
  });
});
