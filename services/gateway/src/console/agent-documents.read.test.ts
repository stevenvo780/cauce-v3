import { describe, expect, it, vi } from 'vitest';
import type { FactsSource, GovernanceReadError } from './agent-documents.routes.js';
import {
  type GovernanceRelayClient, MAX_DOCUMENT_BYTES, type MeasuredFactsSource, type RelayFileRead,
  type RuntimeFacts, TerminalRelayFactsProbe, verifyReadablePath
} from './agent-documents.js';

/**
 * Camino de LECTURA del modal de Directiva. Lo que se prueba aquí es sobre todo lo que NO se lee:
 * la puerta se abre para dos nombres y se cierra para todo lo demás, incluida cualquier ruta que
 * no salga de hechos medidos.
 */

const CLAUDE: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
const RUTA_CLAUDE = '/home/dev/.claude/CLAUDE.md';

function relayQueDevuelve(answer: RelayFileRead | GovernanceReadError): GovernanceRelayClient {
  return { readFile: vi.fn(async () => answer) };
}

const SIN_HECHOS: MeasuredFactsSource = { factsFor: async () => undefined };

function lectura(overrides: Partial<RelayFileRead> = {}): RelayFileRead {
  return {
    path: RUTA_CLAUDE,
    bytes: 20,
    truncated: false,
    modified_at: '2026-08-24T10:00:00Z',
    content: '# Manual del sitio\n',
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
    expect(verdict.reason).toContain('sólo lee CLAUDE.md y AGENTS.md');
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
      bytes: 20,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z'
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

describe('TerminalRelayFactsProbe: lo que todavía no hace', () => {
  it('dice que el índice de memoria no se sirve, en vez de devolverlo vacío', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueDevuelve(lectura()));

    expect(await probe.listMemoryDirectory('/home/dev/.claude/projects')).toEqual({
      error: 'unavailable',
      reason: 'el índice de memoria (/home/dev/.claude/projects) todavía no se sirve por esta vía'
    });
  });

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
