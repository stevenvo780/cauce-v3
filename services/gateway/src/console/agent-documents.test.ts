import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES, MAX_DOCUMENT_BYTES, NEVER_SERVE_BASENAMES,
  type RuntimeFacts, codexProjectDocMaxBytes, documentForKind, effectiveManualPaths,
  harnessFromCapabilities, harnessFromCommand, measuredCodexProjectDocumentConfig,
  resolveAgentDocuments, verifyReadableDocument, verifyWritablePath
} from './agent-documents.js';

/**
 * Sample of measured harness runtime facts for the document-resolution tests.
 */
// `satisfies` and not a `Record<string, …>` annotation: with `noUncheckedIndexedAccess`, indexing a
// `Record<string, T>` gives `T | undefined`, and `MEDIDO.zeus` — a literal key written below —
// stopped typechecking in 21 places. With `satisfies` the shape is checked the same way and the
// keys stay literal, so no `!` is needed per use.
const MEDIDO = {
  zeus:      { harness: 'claude',   harness_bd: 'claude',   contenedor: 'ws-zeus',                home: '/home/dev',  cwd: '/workspace/cauce-v3' },
  socrates:  { harness: 'codex',    harness_bd: 'codex',    contenedor: 'ws-prizma',              home: '/home/dev',  cwd: '/workspace' },
  atlas:     { harness: 'codex',    harness_bd: 'codex',    contenedor: 'ws-humanizar',           home: '/home/dev',  cwd: '/workspace', codexHome: '/home/dev/.codex/cuenta-b' },
  kratos:    { harness: 'claude',   harness_bd: 'codex',    contenedor: 'ws-humanizar',           home: '/home/dev',  cwd: '/workspace' },
  jarvis:    { harness: 'openclaw', harness_bd: 'openclaw', contenedor: 'claw',                   home: '/home/claw', cwd: '/home/claw', openclawWorkspace: '/home/claw/workspace' },
  argos:     { harness: 'openclaw', harness_bd: 'hermes',   contenedor: 'ctrl-infra',             home: '/home/dev',  cwd: '/workspace', openclawWorkspace: '/home/dev/workspace' },
  heraclito: { harness: 'claude',   harness_bd: 'openclaw', contenedor: 'agv2-jhon-heraclito-oc', home: '/home/claw', cwd: '/home/claw' },
  tales:     { harness: 'codex',    harness_bd: 'codex',    contenedor: 'agv2-jhon-tales-oc',     home: '/home/claw', cwd: '/home/claw' },
  salva:     { harness: 'claude',   harness_bd: 'codex',    contenedor: 'ws-isa',                 home: '/home/dev',  cwd: '/workspace' },
  kant:      { harness: 'claude',   harness_bd: 'codex',    contenedor: 'host:kratos',            home: '/home/stev', cwd: '/home/stev' }
} satisfies Record<string, RuntimeFacts & { harness_bd: string; contenedor: string }>;

function directivePath(facts: RuntimeFacts): string | undefined {
  return documentForKind(facts, 'directive')?.path;
}

describe('resolveAgentDocuments — la ruta sale de lo medido, no de la base', () => {
  it('acierta la directiva de cada alias medido', () => {
    expect(directivePath(MEDIDO.zeus)).toBe('/home/dev/.claude/CLAUDE.md');
    expect(directivePath(MEDIDO.socrates)).toBe('/home/dev/.codex/AGENTS.md');
    expect(directivePath(MEDIDO.jarvis)).toBe('/home/claw/workspace/AGENTS.md');
    expect(directivePath(MEDIDO.tales)).toBe('/home/claw/.codex/AGENTS.md');
    expect(directivePath(MEDIDO.kant)).toBe('/home/stev/.claude/CLAUDE.md');
    expect(directivePath(MEDIDO.salva)).toBe('/home/dev/.claude/CLAUDE.md');
  });

  /**
   * The negative control for the whole module: for the 5 aliases where `agents.harness_id` does
   * not match the binary running, resolving through the database gives a DIFFERENT path. Different
   * and existing, which is the dangerous part: the editor would save without error to a file
   * that agent never reads.
   */
  it('resolver por el harness de la BD daría otra ruta en los 5 alias donde la BD miente', () => {
    const mienten = Object.entries(MEDIDO).filter(([, f]) => f.harness !== f.harness_bd);
    expect(mienten.map(([alias]) => alias).sort())
      .toEqual(['argos', 'heraclito', 'kant', 'kratos', 'salva']);

    for (const [alias, facts] of mienten) {
      const real = directivePath(facts);
      const segunLaBase = directivePath({ ...facts, harness: facts.harness_bd as RuntimeFacts['harness'] });
      expect(real, alias).toBeDefined();
      expect(segunLaBase, alias).not.toBe(real);
    }
  });

  /**
   * atlas runs with CODEX_HOME pointing at a subfolder. `~/.codex/AGENTS.md` ALSO exists and
   * measures the same (12,942 B), so a resolver that ignores the environment does not fail: it
   * gets the size right and the file wrong.
   */
  it('respeta CODEX_HOME (atlas) y CLAUDE_CONFIG_DIR', () => {
    expect(directivePath(MEDIDO.atlas)).toBe('/home/dev/.codex/cuenta-b/AGENTS.md');
    // The negative control is WITHOUT the key, not with the key set to `undefined`: with
    // `exactOptionalPropertyTypes` they are not the same, and the latter is not even a legal
    // value of `RuntimeFacts`. What we want to measure is "the same facts, but without CODEX_HOME".
    const { harness, home, cwd } = MEDIDO.atlas;
    expect(directivePath({ harness, home, cwd })).toBe('/home/dev/.codex/AGENTS.md');
    expect(directivePath({ harness: 'claude', home: '/home/dev', claudeConfigDir: '/home/dev/.claude-steven' }))
      .toBe('/home/dev/.claude-steven/CLAUDE.md');
  });

  it('dos alias en el mismo contenedor con arneses distintos no comparten fichero', () => {
    // ws-humanizar hosts atlas (codex) and kratos (claude) with the SAME $HOME.
    expect(directivePath(MEDIDO.atlas)).not.toBe(directivePath(MEDIDO.kratos));
  });

  it('un arnés desconocido no resuelve nada, en vez de adivinar', () => {
    expect(resolveAgentDocuments({ harness: 'unknown', home: '/home/dev' })).toEqual([]);
    expect(resolveAgentDocuments({ harness: 'claude', home: 'relativo' })).toEqual([]);
  });

  it('Hermes resuelve exactamente el AGENTS.md global que el pty-agent permite', () => {
    const facts: RuntimeFacts = { harness: 'hermes', home: '/home/dev' };
    expect(resolveAgentDocuments(facts)).toEqual([expect.objectContaining({
      kind: 'directive', category: 'manual', path: '/home/dev/AGENTS.md', editable: true,
    })]);
    expect(effectiveManualPaths(facts).map(({ path }) => path)).toEqual(['/home/dev/AGENTS.md']);
    const document = documentForKind(facts, 'directive')
      ?? expect.unreachable('Hermes directive document is missing');
    expect(verifyReadableDocument(facts, document)).toEqual({ allowed: true });
    expect(verifyWritablePath(facts, 'directive', document.path)).toEqual({ allowed: true });
  });

  /**
   * The presence capabilities resolve the effective harness independently of discrepancies
   * in the `agents.harness_id` column.
   */
  it('las capabilities del latido aciertan donde la columna de la BD falla', () => {
    let columnaMal = 0;
    for (const [alias, facts] of Object.entries(MEDIDO)) {
      const porLatido = harnessFromCapabilities(['messages.receive', `harness.${facts.harness}`]);
      expect(porLatido, alias).toBe(facts.harness);
      if (facts.harness_bd !== facts.harness) columnaMal += 1;
    }
    expect(columnaMal).toBe(5);
  });

  it('unas capabilities sin arnés no adivinan uno', () => {
    expect(harnessFromCapabilities(['messages.receive', 'jobs.interactive'])).toBe('unknown');
    expect(harnessFromCapabilities([])).toBe('unknown');
    expect(harnessFromCapabilities(['harness.hermes'])).toBe('hermes');
  });

  it('harnessFromCommand lee el binario que corre', () => {
    expect(harnessFromCommand('node /opt/cauce-v3-adapter/zeus/releases/x/dist/src/bin/claude.js')).toBe('claude');
    expect(harnessFromCommand('node /opt/.../bin/openclaw.js')).toBe('openclaw');
    expect(harnessFromCommand('node /opt/.../bin/codex.js')).toBe('codex');
    expect(harnessFromCommand('node /opt/.../bin/hermes.js')).toBe('hermes');
    expect(harnessFromCommand('/usr/bin/python3 cauce-container-runtime.py run --alias salva')).toBe('unknown');
  });
});

describe('manuales efectivos de proyecto', () => {
  it('Claude ordena global y cada nivel root→cwd, incluido .claude y local', () => {
    const paths = effectiveManualPaths({
      harness: 'claude', home: '/home/dev', workspaceRoot: '/workspace',
      projectRoot: '/workspace/repo', cwd: '/workspace/repo/packages/api',
    });
    expect(paths.map(({ path, scope }) => [path, scope])).toEqual([
      ['/home/dev/.claude/CLAUDE.md', 'user'],
      ['/workspace/repo/CLAUDE.md', 'workspace'],
      ['/workspace/repo/.claude/CLAUDE.md', 'workspace'],
      ['/workspace/repo/CLAUDE.local.md', 'workspace'],
      ['/workspace/repo/packages/CLAUDE.md', 'workspace'],
      ['/workspace/repo/packages/.claude/CLAUDE.md', 'workspace'],
      ['/workspace/repo/packages/CLAUDE.local.md', 'workspace'],
      ['/workspace/repo/packages/api/CLAUDE.md', 'workspace'],
      ['/workspace/repo/packages/api/.claude/CLAUDE.md', 'workspace'],
      ['/workspace/repo/packages/api/CLAUDE.local.md', 'workspace'],
    ]);
    expect(paths.map(({ precedence }) => precedence)).toEqual(paths.map((_, index) => index));
  });

  it('Codex empieza en projectRoot y el override precede al AGENTS de cada nivel', () => {
    const paths = effectiveManualPaths({
      harness: 'codex', home: '/home/dev', workspaceRoot: '/workspace',
      projectRoot: '/workspace/repo', cwd: '/workspace/repo/sub',
    });
    expect(paths.map(({ path }) => path)).toEqual([
      '/home/dev/.codex/AGENTS.override.md', '/home/dev/.codex/AGENTS.md',
      '/workspace/repo/AGENTS.override.md', '/workspace/repo/AGENTS.md',
      '/workspace/repo/sub/AGENTS.override.md', '/workspace/repo/sub/AGENTS.md',
    ]);
    expect(paths.some(({ path }) => path === '/workspace/AGENTS.md')).toBe(false);
    expect(paths.every(({ selection }) => selection === 'first_existing')).toBe(true);
  });

  it('Codex intercala fallbacks medidos y aplica el par de config de forma indivisible', () => {
    const measured: RuntimeFacts = {
      harness: 'codex', home: '/home/dev', projectRoot: '/workspace/repo',
      cwd: '/workspace/repo/sub', projectDocMaxBytes: 65_536,
      projectDocFallbackFilenames: ['TEAM.md', 'LOCAL.md'],
    };
    expect(measuredCodexProjectDocumentConfig(measured)).toEqual({
      maxBytes: 65_536, fallbackFilenames: ['TEAM.md', 'LOCAL.md'],
    });
    expect(codexProjectDocMaxBytes(measured)).toBe(65_536);
    expect(effectiveManualPaths(measured).map(({ path }) => path)).toEqual([
      '/home/dev/.codex/AGENTS.override.md', '/home/dev/.codex/AGENTS.md',
      '/workspace/repo/AGENTS.override.md', '/workspace/repo/AGENTS.md',
      '/workspace/repo/TEAM.md', '/workspace/repo/LOCAL.md',
      '/workspace/repo/sub/AGENTS.override.md', '/workspace/repo/sub/AGENTS.md',
      '/workspace/repo/sub/TEAM.md', '/workspace/repo/sub/LOCAL.md',
    ]);

    for (const partialOrUnsafe of [
      { ...measured, projectDocFallbackFilenames: undefined },
      { ...measured, projectDocFallbackFilenames: ['TEAM.md', 'TEAM.md'] },
      { ...measured, projectDocFallbackFilenames: ['secreto.key'] },
      { ...measured, projectDocFallbackFilenames: ['SECRET.PEM'] },
      { ...measured, projectDocFallbackFilenames: ['Auth.Json'] },
    ] as RuntimeFacts[]) {
      expect(measuredCodexProjectDocumentConfig(partialOrUnsafe)).toBeUndefined();
      expect(codexProjectDocMaxBytes(partialOrUnsafe)).toBe(DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES);
      expect(effectiveManualPaths(partialOrUnsafe).some(({ path }) => path.endsWith('/TEAM.md')))
        .toBe(false);
    }
  });

  it('sin raíz acreditada sólo añade el cwd exacto y deduplica una ruta global coincidente', () => {
    expect(effectiveManualPaths({
      harness: 'claude', home: '/home/dev', cwd: '/workspace/repo/sub',
    }).map(({ path }) => path)).toEqual([
      '/home/dev/.claude/CLAUDE.md', '/workspace/repo/sub/CLAUDE.md',
      '/workspace/repo/sub/.claude/CLAUDE.md', '/workspace/repo/sub/CLAUDE.local.md',
    ]);
    expect(effectiveManualPaths({
      harness: 'claude', home: '/home/dev', claudeConfigDir: '/workspace/repo', cwd: '/workspace/repo',
    }).map(({ path }) => path)).toEqual([
      '/workspace/repo/CLAUDE.md', '/workspace/repo/.claude/CLAUDE.md',
      '/workspace/repo/CLAUDE.local.md',
    ]);
  });

  it('workspace / o cwd fuera de la raíz no amplían el juego', () => {
    const base = { harness: 'claude' as const, home: '/home/dev' };
    expect(effectiveManualPaths({ ...base, projectRoot: '/', cwd: '/workspace/repo' }))
      .toHaveLength(1);
    expect(effectiveManualPaths({
      ...base, projectRoot: '/workspace/a', cwd: '/workspace/b',
    })).toHaveLength(1);
  });
});

describe('verifyWritablePath — falla cerrada', () => {
  const zeus = MEDIDO.zeus;

  it('deja escribir la directiva resuelta', () => {
    expect(verifyWritablePath(zeus, 'directive', '/home/dev/.claude/CLAUDE.md'))
      .toEqual({ allowed: true });
  });

  it('rechaza cualquier ruta que no sea la resuelta, aunque esté al lado', () => {
    for (const intento of [
      '/home/dev/.claude/CLAUDE.md.bak',
      '/home/dev/.claude/../.claude/CLAUDE.md',
      '/home/dev/.claude/CLAUDE.md/../.credentials.json',
      '/etc/passwd',
      'CLAUDE.md'
    ]) {
      expect(verifyWritablePath(zeus, 'directive', intento).allowed, intento).toBe(false);
    }
  });

  /**
   * Negative control that really matters: in `ctrl-infra` the `.credentials.json` is a
   * SINGLE-FILE bind-mount inserted into a `.claude` that is otherwise the container's own. If
   * the directive were a symlink to it, checking just the requested name would let it through.
   * Hence the gate also requires the `realpath`.
   */
  it('rechaza el symlink aunque el nombre pedido sea el correcto', () => {
    const veredicto = verifyWritablePath(
      zeus, 'directive', '/home/dev/.claude/CLAUDE.md', '/home/dev/.claude/.credentials.json'
    );
    expect(veredicto.allowed).toBe(false);
    expect(veredicto.reason).toContain('.credentials.json');
  });

  it('rechaza un realpath distinto aunque sea inocente', () => {
    expect(verifyWritablePath(zeus, 'directive', '/home/dev/.claude/CLAUDE.md', '/datos/agents/shared/.claude/CLAUDE.md').allowed)
      .toBe(false);
  });

  it('config.toml de codex es de sólo lectura y lo dice', () => {
    const doc = documentForKind(MEDIDO.socrates, 'tools')
      ?? expect.unreachable('Codex tools document is missing');
    expect(doc.path).toBe('/home/dev/.codex/config.toml');
    expect(doc.editable).toBe(false);
    expect(doc.reason).toMatch(/TOML|MCP/);
    expect(verifyWritablePath(MEDIDO.socrates, 'tools', doc.path).allowed).toBe(false);
  });

  it('openclaw separa perfil, manual, memoria y configuración sensible sin exponerla', () => {
    const docs = resolveAgentDocuments(MEDIDO.jarvis);
    expect(docs.map((doc) => [doc.kind, doc.category, doc.path])).toEqual([
      ['prompts', 'profile', '/home/claw/workspace/SOUL.md'],
      ['identity', 'profile', '/home/claw/workspace/IDENTITY.md'],
      ['human', 'profile', '/home/claw/workspace/USER.md'],
      ['memory', 'memory', '/home/claw/workspace/MEMORY.md'],
      ['heartbeat', 'memory', '/home/claw/workspace/HEARTBEAT.md'],
      ['directive', 'manual', '/home/claw/workspace/AGENTS.md'],
      ['tools', 'configuration', '/home/claw/workspace/TOOLS.md'],
      ['configuration', 'configuration', '/home/claw/.openclaw/openclaw.json'],
    ]);
    expect(docs.every((d) => !d.editable)).toBe(true);
    const canonicalKinds = new Set(['prompts', 'identity', 'human', 'directive', 'tools']);
    const canonicalReasons = docs
      .filter((doc) => canonicalKinds.has(doc.kind))
      .map((doc) => doc.reason);
    expect(canonicalReasons).toHaveLength(5);
    expect(canonicalReasons.every((reason) => reason?.includes('desde Contexto'))).toBe(true);
    expect(canonicalReasons.every((reason) => !reason?.includes('desde Perfil'))).toBe(true);
    expect(docs.find((doc) => doc.kind === 'configuration')?.reason).toMatch(/secrets/);
    expect(verifyWritablePath(
      MEDIDO.jarvis, 'directive', documentForKind(MEDIDO.jarvis, 'directive')?.path
        ?? expect.unreachable('OpenClaw directive document is missing'),
    ).allowed).toBe(false);
  });

  it('openclaw sin workspace medido no adivina ~/.openclaw ni sirve otro alias', () => {
    expect(resolveAgentDocuments({ harness: 'openclaw', home: '/home/claw' })).toEqual([]);
  });

  it('los MCP de claude no se sirven: viven con el OAuth', () => {
    const mcp = documentForKind(zeus, 'mcp')
      ?? expect.unreachable('Claude MCP document is missing');
    expect(mcp.path).toBe('/home/dev/.claude.json');
    expect(mcp.editable).toBe(false);
    expect(verifyWritablePath(zeus, 'mcp', mcp.path).allowed).toBe(false);
  });

  it('settings.json se muestra con el aviso de hooks pero no se edita sin validacion estructural', () => {
    const doc = documentForKind(zeus, 'tools')
      ?? expect.unreachable('Claude tools document is missing');
    expect(doc.editable).toBe(false);
    expect(doc.warning).toMatch(/hooks/);
    expect(verifyWritablePath(zeus, 'tools', doc.path).allowed).toBe(false);
  });

  it('ningún documento resuelto cae nunca en la lista negra', () => {
    for (const facts of Object.values(MEDIDO)) {
      for (const doc of resolveAgentDocuments(facts)) {
        if (!doc.editable) continue;
        const base = doc.path.slice(doc.path.lastIndexOf('/') + 1);
        expect(NEVER_SERVE_BASENAMES, doc.path).not.toContain(base);
      }
    }
  });

  it('el tope deja pasar el CLAUDE.md más grande medido y no un volcado', () => {
    expect(MAX_DOCUMENT_BYTES).toBeGreaterThan(75_142); // el AGENTS.md de hermes en ctrl-infra
    expect(MAX_DOCUMENT_BYTES).toBeLessThan(1024 * 1024);
  });
});

describe('lectura y escritura son capacidades independientes', () => {
  it('un manual global es legible y editable', () => {
    const doc = documentForKind(MEDIDO.zeus, 'directive')
      ?? expect.unreachable('Claude directive document is missing');
    expect(verifyReadableDocument(MEDIDO.zeus, doc)).toEqual({ allowed: true });
    expect(verifyWritablePath(MEDIDO.zeus, 'directive', doc.path)).toEqual({ allowed: true });
  });

  it('los siete ficheros allowlisted del perfil OpenClaw son legibles pero no escribibles por PUT', () => {
    const docs = resolveAgentDocuments(MEDIDO.jarvis)
      .filter((doc) => doc.path.startsWith('/home/claw/workspace/'));
    expect(docs).toHaveLength(7);
    for (const doc of docs) {
      expect(verifyReadableDocument(MEDIDO.jarvis, doc), doc.path).toEqual({ allowed: true });
      expect(verifyWritablePath(MEDIDO.jarvis, doc.kind, doc.path).allowed, doc.path).toBe(false);
    }
  });

  it('configuración sensible y directorios quedan inventariados pero no servibles', () => {
    for (const [facts, kinds] of [
      [MEDIDO.zeus, ['tools', 'prompts', 'mcp']],
      [MEDIDO.socrates, ['tools', 'prompts']],
    ] as const) {
      for (const kind of kinds) {
        const doc = documentForKind(facts, kind)
          ?? expect.unreachable(`Missing ${kind} document`);
        expect(verifyReadableDocument(facts, doc).allowed, doc.path).toBe(false);
      }
    }
    const sensitive = documentForKind(MEDIDO.jarvis, 'configuration')
      ?? expect.unreachable('OpenClaw configuration document is missing');
    expect(verifyReadableDocument(MEDIDO.jarvis, sensitive).allowed).toBe(false);
  });
});
