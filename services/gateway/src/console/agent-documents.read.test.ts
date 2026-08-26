import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FactsSource, GovernanceReadError } from './agent-documents.routes.js';
import {
  type GovernanceRelayClient, MAX_DOCUMENT_BYTES, type MeasuredFactsSource, type RelayFileRead,
  type RelayDirectoryRead, type RuntimeFacts, TerminalRelayFactsProbe, verifyReadablePath
} from './agent-documents.js';

/**
 * Camino de LECTURA del modal de Directiva. Lo que se prueba aquí es sobre todo lo que NO se lee:
 * la puerta se abre para dos nombres y se cierra para todo lo demás, incluida cualquier ruta que
 * no salga de hechos medidos.
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

  it('sigue el CLAUDE_CONFIG_DIR en vez del home', () => {
    const facts: RuntimeFacts = { ...CLAUDE, claudeConfigDir: '/home/dev/.claude-b' };
    expect(verifyReadablePath(facts, '/home/dev/.claude-b/CLAUDE.md')).toEqual({ allowed: true });
    // Y el de por defecto deja de valer: existe en disco, pero ese agente NO lo lee.
    expect(verifyReadablePath(facts, RUTA_CLAUDE).allowed).toBe(false);
  });

  it('sigue el CODEX_HOME, que es el caso de atlas', () => {
    const facts: RuntimeFacts = { harness: 'codex', home: '/home/dev', codexHome: '/home/dev/.codex/cuenta-b' };
    expect(verifyReadablePath(facts, '/home/dev/.codex/cuenta-b/AGENTS.md')).toEqual({ allowed: true });
    expect(verifyReadablePath(facts, '/home/dev/.codex/AGENTS.md').allowed).toBe(false);
  });

  it('abre sólo la cadena proyecto acreditada y sus nombres oficiales', () => {
    const claude: RuntimeFacts = {
      ...CLAUDE, workspaceRoot: '/workspace', projectRoot: '/workspace/repo',
      cwd: '/workspace/repo/sub',
    };
    for (const path of [
      '/workspace/repo/CLAUDE.md', '/workspace/repo/sub/CLAUDE.local.md',
    ]) {
      expect(verifyReadablePath(claude, path), path).toEqual({ allowed: true });
    }
    expect(verifyReadablePath(claude, '/workspace/CLAUDE.md').allowed).toBe(false);
    expect(verifyReadablePath(claude, '/workspace/sibling/CLAUDE.md').allowed).toBe(false);

    const codex: RuntimeFacts = {
      harness: 'codex', home: '/home/dev', workspaceRoot: '/workspace',
      projectRoot: '/workspace/repo', cwd: '/workspace/repo/sub',
    };
    expect(verifyReadablePath(codex, '/workspace/repo/AGENTS.override.md')).toEqual({ allowed: true });
    expect(verifyReadablePath(codex, '/workspace/AGENTS.md').allowed).toBe(false);
  });
});

describe('verifyReadablePath se cierra para todo lo demás', () => {
  it('no sirve credenciales aunque estén en el juego cerrado', () => {
    // `.claude.json` SÍ sale de `resolveAgentDocuments` (es la fila de MCP), así que esta es la
    // comprobación que de verdad lo para.
    const verdict = verifyReadablePath(CLAUDE, '/home/dev/.claude.json');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('no se sirve nunca');
  });

  it('no sirve `settings.json`, que es del inventario pero no es un manual', () => {
    const verdict = verifyReadablePath(CLAUDE, '/home/dev/.claude/settings.json');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('manual efectivo permitido');
  });

  it.each([
    ['/home/dev/.ssh/id_ed25519', 'material de credencial o nombre vetado'],
    ['/home/dev/.claude/clave.pem', 'sufijo de credencial'],
    ['/home/dev/.env', 'nombre vetado']
  ])('rechaza %s', (ruta) => {
    expect(verifyReadablePath(CLAUDE, ruta).allowed).toBe(false);
  });

  it.each([
    ['.claude/CLAUDE.md', 'relativa'],
    ['/home/dev/../root/.claude/CLAUDE.md', 'sube de directorio'],
    ['/home/dev/./.claude/CLAUDE.md', 'punto suelto'],
    ['/home/dev//.claude/CLAUDE.md', 'barra doble'],
    ['/home/dev/.claude/CLAUDE.md/', 'barra final'],
    ['/home/dev/.claude/CLAUDE.md\0.pem', 'byte nulo']
  ])('rechaza la ruta %s por no ser canónica o absoluta', (ruta) => {
    expect(verifyReadablePath(CLAUDE, ruta).allowed).toBe(false);
  });

  it('rechaza una ruta que no es de ningún documento de ese alias', () => {
    // El nombre está permitido y la forma es correcta: lo único que la para es el juego cerrado.
    const verdict = verifyReadablePath(CLAUDE, '/etc/CLAUDE.md');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('no es la de ningún documento');
  });

  it('rechaza el AGENTS.md de codex cuando el arnés medido es claude', () => {
    expect(verifyReadablePath(CLAUDE, '/home/dev/.codex/AGENTS.md').allowed).toBe(false);
  });

  it('rechaza una basename permitida fuera de la cadena medida', () => {
    const facts: RuntimeFacts = {
      ...CLAUDE, workspaceRoot: '/workspace', projectRoot: '/workspace/repo',
      cwd: '/workspace/repo/sub',
    };
    for (const path of [
      '/workspace/sibling/CLAUDE.md', '/workspace/sibling/CLAUDE.local.md',
      '/workspace/sibling/.claude/CLAUDE.md',
    ]) {
      expect(verifyReadablePath(facts, path).allowed, path).toBe(false);
    }
  });

  it('no deja leer nada si el home no es una ruta absoluta', () => {
    expect(verifyReadablePath({ harness: 'claude', home: '' }, RUTA_CLAUDE).allowed).toBe(false);
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

  it('ni siquiera pregunta al relay cuando la ruta no pasa la puerta', async () => {
    const readFile = vi.fn(async () => lectura());
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, { readFile });

    const result = await probe.readGovernanceDocument('/home/dev/.claude.json', CLAUDE, 'Steven', 'zeus');

    expect(result).toMatchObject({ error: 'invalid_path' });
    // Lo importante: la petición no llegó a salir del gateway.
    expect(readFile).not.toHaveBeenCalled();
  });

  it('pasa tal cual el error del pty-agent', async () => {
    const probe = new TerminalRelayFactsProbe(
      SIN_HECHOS,
      relayQueDevuelve({ error: 'symlink_detected', reason: 'path resolves somewhere else' })
    );

    expect(await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus')).toEqual({
      error: 'symlink_detected',
      reason: 'path resolves somewhere else'
    });
  });

  it('convierte en error una excepción del relay, en vez de tumbar la pantalla', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, {
      readFile: async () => { throw new Error('socket colgado'); }
    });

    const result = await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus');

    expect(result).toMatchObject({ error: 'unknown' });
    expect((result as GovernanceReadError).reason).toContain('socket colgado');
  });

  it('rechaza una respuesta que viene por otra ruta', async () => {
    const probe = new TerminalRelayFactsProbe(
      SIN_HECHOS,
      relayQueDevuelve(lectura({ path: '/home/dev/.claude/.credentials.json' }))
    );

    expect(await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus')).toEqual({
      error: 'unknown',
      reason: 'la respuesta es de otra ruta distinta de la pedida'
    });
  });

  it('rechaza una respuesta con un tamaño que no es creíble', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueDevuelve(lectura({ bytes: -1 })));

    expect(await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus')).toMatchObject({
      error: 'unknown'
    });
  });

  it('recorta por BYTES, no por unidades UTF-16', async () => {
    // 200.000 «á» son 200.000 caracteres —por debajo del tope si se cuenta mal— pero 400.000
    // bytes. Comparar `content.length` con `MAX_DOCUMENT_BYTES` dejaría pasar el doble.
    const gordo = 'á'.repeat(200_000);
    expect(gordo.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    expect(Buffer.byteLength(gordo, 'utf8')).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    const probe = new TerminalRelayFactsProbe(
      SIN_HECHOS,
      relayQueDevuelve(lectura({ content: gordo, bytes: 400_000, truncated: false }))
    );

    const result = await probe.readGovernanceDocument(RUTA_CLAUDE, CLAUDE, 'Steven', 'zeus');

    expect(result).toMatchObject({ truncated: true, bytes: 400_000 });
    expect(Buffer.byteLength((result as { text: string }).text, 'utf8')).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
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

  it.each([
    '/home/dev/.claude/projects-otro',
    '/home/dev/.claude/projects/..',
    '/etc',
    'home/dev/.claude/projects',
  ])('rechaza la raíz arbitraria %s sin llamar al relay', async (root) => {
    const relay = relayQueLista(indice());
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay);

    expect(await probe.listMemoryDirectory(root, CLAUDE, 'Steven', 'zeus')).toMatchObject({ error: 'invalid_path' });
    expect(relay.listCalls()).toEqual([]);
  });

  it('respeta exactamente CLAUDE_CONFIG_DIR y no admite la raíz por defecto', async () => {
    const facts = { ...CLAUDE, claudeConfigDir: '/home/dev/.claude-b' };
    const root = '/home/dev/.claude-b/projects';
    const relay = relayQueLista({
      path: root, total: 0, observed_at_least: 0, truncated: false, entries: [],
    });
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay);

    expect(await probe.listMemoryDirectory(root, facts, 'Steven', 'zeus')).toEqual({
      root, total: 0, observed_at_least: 0, truncated: false, entries: [],
    });
    expect(await probe.listMemoryDirectory(MEMORY_ROOT, facts, 'Steven', 'zeus')).toMatchObject({
      error: 'invalid_path',
    });
  });

  it('propaga el cap como límite inferior sin convertirlo en un total exacto', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueLista(indice({
      total: null,
      observed_at_least: 5_000,
      truncated: true,
    })));

    expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toMatchObject({
      root: MEMORY_ROOT,
      total: null,
      observed_at_least: 5_000,
      truncated: true,
    });
  });

  it.each([
    ['wrong root', indice({ path: '/home/dev/.claude/projects-otra' })],
    ['prefix collision', indice({ entries: [{
      path: `${MEMORY_ROOT}-otra/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }], total: 1 })],
    ['escape', indice({ entries: [{
      path: `${MEMORY_ROOT}/../auth.json`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }], total: 1 })],
    ['absolute outside', indice({ entries: [{
      path: '/etc/passwd', bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }], total: 1 })],
    ['duplicate', indice({ entries: [
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
    ] })],
    ['credential', indice({ entries: [{
      path: `${MEMORY_ROOT}/.credentials.json`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }], total: 1 })],
  ])('rechaza %s aunque el relay tipado lo entregue', async (_label, answer) => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueLista(answer));
    expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toHaveProperty('error');
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
          path: `${MEMORY_ROOT}/${index}.md`, bytes: index, modified_at: '2026-08-24T10:00:00Z',
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

  it('mantiene unavailable/error honestos y nunca los convierte en vacío', async () => {
    const legacy = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueDevuelve(lectura()));
    expect(await legacy.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toMatchObject({
      error: 'unavailable',
    });

    const failed = new TerminalRelayFactsProbe(
      SIN_HECHOS,
      relayQueLista({ error: 'timeout', reason: 'el agente no contestó' }),
    );
    expect(await failed.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toEqual({
      error: 'timeout', reason: 'el agente no contestó',
    });
  });
});

describe('TerminalRelayFactsProbe.factsFor', () => {
  it('delega los hechos en quien los mide', async () => {
    const medidos = { facts: CLAUDE, source: 'measured' as FactsSource };
    const probe = new TerminalRelayFactsProbe(
      { factsFor: async (tenantId, alias) => (tenantId === 'Steven' && alias === 'zeus' ? medidos : undefined) },
      relayQueDevuelve(lectura())
    );

    expect(await probe.factsFor('Steven', 'zeus')).toEqual(medidos);
    expect(await probe.factsFor('Steven', 'kant')).toBeUndefined();
  });
});
