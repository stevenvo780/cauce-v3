import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_BYTES, NEVER_SERVE_BASENAMES, type RuntimeFacts, documentForKind,
  harnessFromCapabilities, harnessFromCommand, resolveAgentDocuments, verifyWritablePath
} from './agent-documents.js';

/**
 * Hechos MEDIDOS el 23-ago-2026 dentro de los contenedores, leyendo `/proc/<pid>/cmdline` y
 * `/proc/<pid>/environ` del proceso del arnés que de verdad corría. La columna `harness_bd` es lo
 * que `GET /v3/console/agents` devolvía ese mismo día: donde no coincide con `harness`, la base
 * miente, y esa discrepancia es el motivo de que este módulo exista.
 */
// `satisfies` y no una anotación `Record<string, …>`: con `noUncheckedIndexedAccess`, indexar un
// `Record<string, T>` da `T | undefined`, y `MEDIDO.zeus` —que es una clave literal que está
// escrita ahí abajo— dejaba de typecheckear en 21 sitios. Con `satisfies` se comprueba la forma
// igual y las claves siguen siendo literales, así que no hace falta un `!` por uso.
const MEDIDO = {
  zeus:      { harness: 'claude',   harness_bd: 'claude',   contenedor: 'ws-zeus',                home: '/home/dev',  cwd: '/workspace/cauce-v3' },
  socrates:  { harness: 'codex',    harness_bd: 'codex',    contenedor: 'ws-prizma',              home: '/home/dev',  cwd: '/workspace' },
  atlas:     { harness: 'codex',    harness_bd: 'codex',    contenedor: 'ws-humanizar',           home: '/home/dev',  cwd: '/workspace', codexHome: '/home/dev/.codex/cuenta-b' },
  kratos:    { harness: 'claude',   harness_bd: 'codex',    contenedor: 'ws-humanizar',           home: '/home/dev',  cwd: '/workspace' },
  jarvis:    { harness: 'openclaw', harness_bd: 'openclaw', contenedor: 'claw',                   home: '/home/claw', cwd: '/home/claw' },
  argos:     { harness: 'openclaw', harness_bd: 'hermes',   contenedor: 'ctrl-infra',             home: '/home/dev',  cwd: '/workspace' },
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
    expect(directivePath(MEDIDO.jarvis)).toBe('/home/claw/.openclaw/openclaw.json');
    expect(directivePath(MEDIDO.tales)).toBe('/home/claw/.codex/AGENTS.md');
    expect(directivePath(MEDIDO.kant)).toBe('/home/stev/.claude/CLAUDE.md');
    expect(directivePath(MEDIDO.salva)).toBe('/home/dev/.claude/CLAUDE.md');
  });

  /**
   * El control negativo del módulo entero: para los 5 alias en los que `agents.harness_id` no
   * coincide con el binario que corre, resolver por la base da una ruta DISTINTA. Distinta y
   * existente, que es lo peligroso: el editor guardaría sin error en un fichero que ese agente
   * no lee jamás.
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
   * atlas corre con CODEX_HOME apuntando a una subcarpeta. `~/.codex/AGENTS.md` TAMBIÉN existe y
   * mide lo mismo (12.942 B), así que un resolutor que ignore el entorno no falla: acierta de
   * tamaño y se equivoca de fichero.
   */
  it('respeta CODEX_HOME (atlas) y CLAUDE_CONFIG_DIR', () => {
    expect(directivePath(MEDIDO.atlas)).toBe('/home/dev/.codex/cuenta-b/AGENTS.md');
    // El control negativo es SIN la clave, no con la clave puesta a `undefined`: con
    // `exactOptionalPropertyTypes` no son lo mismo, y el segundo ni siquiera es un valor legal
    // de `RuntimeFacts`. Lo que se quiere medir es «los mismos hechos, pero sin CODEX_HOME».
    const { harness, home, cwd } = MEDIDO.atlas;
    expect(directivePath({ harness, home, cwd })).toBe('/home/dev/.codex/AGENTS.md');
    expect(directivePath({ harness: 'claude', home: '/home/dev', claudeConfigDir: '/home/dev/.claude-steven' }))
      .toBe('/home/dev/.claude-steven/CLAUDE.md');
  });

  it('dos alias en el mismo contenedor con arneses distintos no comparten fichero', () => {
    // ws-humanizar aloja atlas (codex) y kratos (claude) con el MISMO $HOME.
    expect(directivePath(MEDIDO.atlas)).not.toBe(directivePath(MEDIDO.kratos));
  });

  it('un arnés desconocido no resuelve nada, en vez de adivinar', () => {
    expect(resolveAgentDocuments({ harness: 'unknown', home: '/home/dev' })).toEqual([]);
    expect(resolveAgentDocuments({ harness: 'claude', home: 'relativo' })).toEqual([]);
  });

  /**
   * `GET /v3/status` -> `presence[].capabilities` llevaba el arnés correcto de los 14 alias el
   * 23-ago-2026, comparado uno a uno contra el binario en ejecución. La columna `harness_id` de
   * la base fallaba en 5 de esos 14. Este test fija esa tabla: si mañana alguien vuelve a resolver
   * por la columna, el número 5 lo delata.
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
    expect(harnessFromCapabilities(['harness.hermes'])).toBe('unknown');
  });

  it('harnessFromCommand lee el binario que corre', () => {
    expect(harnessFromCommand('node /opt/cauce-v3-adapter/zeus/releases/x/dist/src/bin/claude.js')).toBe('claude');
    expect(harnessFromCommand('node /opt/.../bin/openclaw.js')).toBe('openclaw');
    expect(harnessFromCommand('node /opt/.../bin/codex.js')).toBe('codex');
    expect(harnessFromCommand('/usr/bin/python3 cauce-container-runtime.py run --alias salva')).toBe('unknown');
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
   * Control negativo que importa de verdad: en `ctrl-infra` el `.credentials.json` es un
   * bind-mount de UN SOLO FICHERO metido dentro de un `.claude` que por lo demás es propio del
   * contenedor. Si la directiva fuese un symlink a él, comprobar sólo el nombre pedido lo dejaría
   * pasar. Por eso la puerta exige también el `realpath`.
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
    const doc = documentForKind(MEDIDO.socrates, 'tools');
    expect(doc?.path).toBe('/home/dev/.codex/config.toml');
    expect(doc?.editable).toBe(false);
    expect(doc?.reason).toMatch(/TOML|MCP/);
    expect(verifyWritablePath(MEDIDO.socrates, 'tools', doc!.path).allowed).toBe(false);
  });

  it('openclaw no expone nada editable: su json lleva auth y secrets', () => {
    const docs = resolveAgentDocuments(MEDIDO.jarvis);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => !d.editable)).toBe(true);
    expect(docs[0]?.reason).toMatch(/secrets/);
    expect(verifyWritablePath(MEDIDO.jarvis, 'directive', docs[0]!.path).allowed).toBe(false);
  });

  it('los MCP de claude no se sirven: viven con el OAuth', () => {
    const mcp = documentForKind(zeus, 'mcp');
    expect(mcp?.path).toBe('/home/dev/.claude.json');
    expect(mcp?.editable).toBe(false);
    expect(verifyWritablePath(zeus, 'mcp', mcp!.path).allowed).toBe(false);
  });

  it('settings.json se muestra con el aviso de hooks pero no se edita sin validacion estructural', () => {
    const doc = documentForKind(zeus, 'tools');
    expect(doc?.editable).toBe(false);
    expect(doc?.warning).toMatch(/hooks/);
    expect(verifyWritablePath(zeus, 'tools', doc!.path).allowed).toBe(false);
  });

  it('ningún documento resuelto cae nunca en la lista negra', () => {
    for (const facts of Object.values(MEDIDO)) {
      for (const doc of resolveAgentDocuments(facts)) {
        if (!doc.editable) continue;
        const base = doc.path.slice(doc.path.lastIndexOf('/') + 1);
        expect(NEVER_SERVE_BASENAMES, `${doc.path}`).not.toContain(base);
      }
    }
  });

  it('el tope deja pasar el CLAUDE.md más grande medido y no un volcado', () => {
    expect(MAX_DOCUMENT_BYTES).toBeGreaterThan(75_142); // el AGENTS.md de hermes en ctrl-infra
    expect(MAX_DOCUMENT_BYTES).toBeLessThan(1024 * 1024);
  });
});
