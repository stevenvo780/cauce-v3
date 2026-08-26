import { describe, expect, it } from 'vitest';
import {
  AGENT_STALE_AFTER_MS, AgentRegistry, RelayBootConflictError, parseAgentPresence,
} from './registry.js';
import { hechosDelRegistro } from './hechos-del-registro.js';
import {
  codexProjectDocMaxBytes, effectiveManualPaths, profileDocumentPaths,
} from '../console/agent-documents.js';

const RELAY = {
  relay_instance_id: 'a'.repeat(64),
  relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;
const RELAY_B = {
  relay_instance_id: 'b'.repeat(64),
  relay_boot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;
const RELAY_REBOOT = {
  relay_instance_id: RELAY.relay_instance_id,
  relay_boot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

/**
 * 🔴 **LA FUENTE DE HECHOS MEDIDOS ESTABA VACÍA EN PRODUCCIÓN, Y ESO CERRABA TODA LA VÍA.**
 *
 * `MeasuredFactsSource` existía, `TerminalRelayFactsProbe` la consumía y de ella colgaba la
 * lectura y edición de los ficheros de gobierno de cada agente. En producción se inyectaba
 * `{ factsFor: async () => undefined }`: un doble que dice «nadie ha medido nada» SIEMPRE.
 *
 * El motivo estaba escrito en el propio plugin —«el pty-agent conoce su `home` y su `harness` por
 * el bundle con el que arranca, pero no los publica»—. El `harness` sí viajaba en la presencia;
 * el `home` no. Una línea de Python.
 *
 * Estas pruebas cubren sobre todo lo que esta pieza se NIEGA a contestar, porque ahí está el
 * daño: un hecho a medias hace que la consola pase de decir honestamente «no se miró» a servir un
 * fichero equivocado con cara de medido.
 */

function presencia(extra: Record<string, unknown> = {}) {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    container_id: 'abc123',
    generation: '1',
    image_id: 'img1',
    runtime_user: 'dev',
    runtime_uid: 1000,
    harness: 'claude',
    runtime_facts_observed: true,
    home: '/home/dev',
    claude_config_dir: '/home/dev/.claude',
    modes: ['shell', 'harness'],
    connected_since: '2026-08-25T00:00:00.000Z',
    ...extra
  } as never;
}

describe('los hechos salen de lo que el agente publica', () => {
  it('un agente que publica harness y home da hechos MEDIDOS', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const hechos = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(hechos?.source).toBe('measured');
    expect(hechos?.facts.harness).toBe('claude');
    expect(hechos?.facts.home).toBe('/home/dev');
    expect(hechos?.facts.generation).toBe('1');
    expect(hechos?.facts.containerId).toBe('abc123');
  });

  it.each([
    {
      harness: 'codex', extra: { codex_home: '/home/dev/.codex-cuenta-b' },
      camel: 'codexHome', path: '/home/dev/.codex-cuenta-b/AGENTS.md',
    },
    {
      harness: 'claude', extra: { claude_config_dir: '/home/dev/.claude-steven' },
      camel: 'claudeConfigDir', path: '/home/dev/.claude-steven/CLAUDE.md',
    },
    {
      harness: 'openclaw', extra: { openclaw_workspace: '/home/claw/workspace' },
      camel: 'openclawWorkspace', path: '/home/claw/workspace/SOUL.md', home: '/home/claw',
    },
  ])(
    'E2E relay→parser→registry→facts→paths conserva $camel',
    async ({ harness, extra, camel, path, home = '/home/dev' }) => {
      const registry = new AgentRegistry();
      /* La forma de entrada es exactamente la JSON snake_case que publica terminal-relay. */
      registry.observe(RELAY, [parseAgentPresence(presencia({ harness, home, ...extra }))]);
      const measured = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');

      expect(measured?.facts).toHaveProperty(camel, Object.values(extra)[0]);
      expect(profileDocumentPaths(measured!.facts)).toContain(path);
    },
  );

  it('usa el CODEX_HOME efectivo publicado y no otro root implícito', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parseAgentPresence(presencia({
      harness: 'codex', codex_home: '/home/dev/.codex',
    }))]);
    const measured = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(measured?.facts.codexHome).toBe('/home/dev/.codex');
    expect(profileDocumentPaths(measured!.facts)).toEqual(['/home/dev/.codex/AGENTS.md']);
  });

  it('conserva la proyección Codex relay→registry→facts y deriva fallbacks efectivos', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parseAgentPresence(presencia({
      harness: 'codex', cwd: '/workspace/repo/sub', workspace_root: '/workspace',
      project_root: '/workspace/repo', codex_home: '/home/dev/.codex',
      project_doc_max_bytes: 65_536,
      project_doc_fallback_filenames: ['TEAM.md', 'LOCAL.md'],
    }))]);
    const measured = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(measured?.facts).toMatchObject({
      projectDocMaxBytes: 65_536,
      projectDocFallbackFilenames: ['TEAM.md', 'LOCAL.md'],
    });
    expect(codexProjectDocMaxBytes(measured!.facts)).toBe(65_536);
    expect(effectiveManualPaths(measured!.facts).map(({ path }) => path)).toContain(
      '/workspace/repo/sub/TEAM.md',
    );
  });

  it('una proyección Codex parcial o sensible se omite sin perder presencia ni hechos seguros', async () => {
    for (const extra of [
      { project_doc_max_bytes: 65_536 },
      { project_doc_max_bytes: 65_536, project_doc_fallback_filenames: ['secreto.key'] },
      { project_doc_max_bytes: 65_536, project_doc_fallback_filenames: ['SECRET.PEM'] },
      { project_doc_max_bytes: 65_536, project_doc_fallback_filenames: ['Auth.Json'] },
      { project_doc_max_bytes: 65_536, project_doc_fallback_filenames: ['private.KEY'] },
      { project_doc_max_bytes: 65_536, project_doc_fallback_filenames: ['TEAM.md', 'TEAM.md'] },
    ]) {
      const parsed = parseAgentPresence(presencia({
        harness: 'codex', codex_home: '/home/dev/.codex', ...extra,
      }));
      expect(parsed.project_doc_max_bytes).toBeUndefined();
      expect(parsed.project_doc_fallback_filenames).toBeUndefined();
      const registry = new AgentRegistry();
      expect(() => registry.observe(RELAY, [parsed])).not.toThrow();
      expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeDefined();
    }
  });

  it('Hermes publica $HOME/AGENTS.md como hecho medido coherente con pty-agent', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parseAgentPresence(presencia({
      harness: 'hermes', cwd: '/workspace/repo', workspace_root: '/workspace',
      project_root: '/workspace/repo',
    }))]);
    const measured = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(measured?.facts.harness).toBe('hermes');
    expect(profileDocumentPaths(measured!.facts)).toEqual(['/home/dev/AGENTS.md']);
    expect(effectiveManualPaths(measured!.facts).map(({ path }) => path))
      .toEqual(['/home/dev/AGENTS.md']);
  });

  it('propaga cwd/workspace/project por alias y conserva el cwd exacto legacy sin raíz', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parseAgentPresence(presencia({
      cwd: '/workspace/repo/sub', workspace_root: '/workspace', project_root: '/workspace/repo',
    }))]);
    expect((await hechosDelRegistro(registry).factsFor('Steven', 'zeus'))?.facts).toMatchObject({
      cwd: '/workspace/repo/sub', workspaceRoot: '/workspace', projectRoot: '/workspace/repo',
    });
    const measured = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(effectiveManualPaths(measured!.facts).map(({ path }) => path)).toContain(
      '/workspace/repo/sub/CLAUDE.local.md',
    );

    const legacy = new AgentRegistry();
    legacy.observe(RELAY, [parseAgentPresence(presencia({ cwd: '/workspace/exacto' }))]);
    expect((await hechosDelRegistro(legacy).factsFor('Steven', 'zeus'))?.facts).toMatchObject({
      cwd: '/workspace/exacto',
    });
    expect((await hechosDelRegistro(legacy).factsFor('Steven', 'zeus'))?.facts.workspaceRoot)
      .toBeUndefined();
  });

  it('un contexto cruzado se descarta sin tirar la presencia ni inventar rutas', async () => {
    const parsed = parseAgentPresence(presencia({
      cwd: '/workspace/a', workspace_root: '/workspace/b', project_root: '/workspace/a',
    }));
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.workspace_root).toBeUndefined();
    expect(parsed.project_root).toBeUndefined();
    const registry = new AgentRegistry();
    expect(() => registry.observe(RELAY, [parsed])).not.toThrow();
    expect(registry.state('Steven', 'zeus')).toBe('online');
  });

  it('CONTROL NEGATIVO: un alias que nadie reportó no tiene hechos', async () => {
    const registry = new AgentRegistry();
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });
});

describe('lo que se NIEGA a contestar', () => {
  it.each([undefined, false, 'true'])(
    'sin runtime_facts_observed===true (%s) no autoriza lecturas aunque hello traiga harness+home',
    async (runtimeFactsObserved) => {
      const registry = new AgentRegistry();
      registry.observe(RELAY, [parseAgentPresence(presencia({
        runtime_facts_observed: runtimeFactsObserved,
      }))]);
      expect(registry.state('Steven', 'zeus')).toBe('online');
      expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
    },
  );

  it.each([
    { harness: 'codex', codex_home: undefined },
    { harness: 'claude', claude_config_dir: undefined },
    { harness: 'openclaw', openclaw_workspace: undefined },
    { harness: 'hermes', cwd: undefined, project_root: undefined },
  ])('marker true pero hechos parciales ($harness) se normaliza a no medido', async (extra) => {
    const parsed = parseAgentPresence(presencia(extra));
    expect(parsed.runtime_facts_observed).toBe(false);
    expect(parsed.home).toBeUndefined();
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parsed]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('hechosDelRegistro tampoco infiere roots si una presencia tipada evita el parser', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia({
      harness: 'codex', runtime_facts_observed: true, codex_home: undefined,
    })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('un agente VIEJO, que no publica `home`, no da hechos — no se deduce', async () => {
    /*
     * Deducir el `home` del registro de la base sería exactamente el fallo que esta vía evita: el
     * 23-ago-2026 `agents.harness_id` era incorrecto en 5 de los 14 alias, así que resolver
     * `~/.claude/CLAUDE.md` con esos datos no da «no se pudo leer», da el fichero de OTRO arnés
     * servido como si fuera el bueno.
     */
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia({ home: undefined })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('un `home` que no es ruta absoluta se descarta', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia({ home: 'home/dev' })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('un arnés que esta vía no sabe resolver no da hechos, aunque el `home` esté', async () => {
    // Son dos ausencias distintas y ninguna autoriza a inventar la otra.
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia({ harness: 'algo-que-no-conozco' })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('OpenCode queda explícitamente no medido; nunca produce medido:true con files vacío', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia({ harness: 'opencode' })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('una medición VIEJA no vale: el contenedor pudo recrearse con otro $HOME', async () => {
    /*
     * `stale` cuenta como no medido. Recrear un contenedor es una operación normal en esta flota y
     * puede cambiar el `$HOME`; servir la ruta de antes sería afirmar sobre un proceso que ya no
     * existe. La ventana la decide `AGENT_STALE_AFTER_MS` del registro, no este módulo.
     */
    const registry = new AgentRegistry();
    const hace = Date.now() - 24 * 60 * 60 * 1000;
    registry.observe(RELAY, [presencia()], hace);
    const observacion = registry.get('Steven', 'zeus');
    expect(observacion?.stale).toBe(true);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('CONTROL NEGATIVO: recién reportado NO está viejo, o esta pieza no serviría nunca', async () => {
    // Sin esto, una implementación que devolviera `undefined` siempre pasaría las cinco de arriba.
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeDefined();
  });

  it('los hechos son POR ALIAS: el `home` de zeus no se le sirve a otro', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [
      presencia(),
      presencia({
        alias: 'argos', harness: 'openclaw', home: '/home/argos',
        openclaw_workspace: '/home/argos/workspace',
      })
    ]);
    const fuente = hechosDelRegistro(registry);
    expect((await fuente.factsFor('Steven', 'zeus'))?.facts.home).toBe('/home/dev');
    expect((await fuente.factsFor('Steven', 'argos'))?.facts.home).toBe('/home/argos');
    // Y un alias del mismo nombre en OTRO inquilino es otro agente.
    expect(await fuente.factsFor('Miguel', 'zeus')).toBeUndefined();
  });
});

describe('la presencia acepta el `home` sin exigirlo', () => {
  it('un agente viejo NO tira su propia presencia por no mandarlo', async () => {
    /*
     * Ésta es la que evita el incidente de despliegue. `parseAgentPresence` lanza cuando un campo
     * obligatorio falta, y `registry.observe` recibe el array ya mapeado: una excepción ahí tira
     * la presencia de TODOS los alias del informe, no sólo la del que va viejo. Desplegar el
     * gateway antes que el agente dejaría terminales caídas por toda la flota — la misma lección
     * que el comentario de `features` en el propio pty-agent.
     */
    const registry = new AgentRegistry();
    expect(() => registry.observe(RELAY, [presencia({ home: undefined })])).not.toThrow();
    expect(registry.state('Steven', 'zeus')).toBe('online');
  });
});

describe('fencing y resolución multi-relay', () => {
  it('trata cada presencia como snapshot completo y marca ausencias offline inmediatamente', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    registry.observe(RELAY, []);
    expect(registry.resolve('Steven', 'zeus')).toMatchObject({ status: 'offline' });
    expect(registry.get('Steven', 'zeus')?.stale).toBe(true);
  });

  it('nunca elige arbitrariamente cuando dos certificados frescos publican el mismo alias', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    registry.observe(RELAY_B, [presencia({ generation: '2' })]);
    expect(registry.resolve('Steven', 'zeus')).toEqual({
      status: 'ambiguous',
      relay_instance_ids: [RELAY.relay_instance_id, RELAY_B.relay_instance_id],
    });
    expect(registry.get('Steven', 'zeus')).toBeUndefined();
    expect(registry.state('Steven', 'zeus')).toBe('agent_offline');
  });

  it('rechaza dos boots bajo el mismo certificado hasta que el dueño aceptado queda stale', () => {
    const registry = new AgentRegistry();
    const now = Date.now();
    registry.observe(RELAY, [presencia()], now);
    expect(() => registry.observe(RELAY_REBOOT, [presencia()], now + 1))
      .toThrow(RelayBootConflictError);
    expect(registry.accepts(RELAY, now + 1)).toBe(true);
    expect(registry.accepts(RELAY_REBOOT, now + 1)).toBe(false);

    registry.observe(RELAY_REBOOT, [presencia({ generation: '2' })], now + AGENT_STALE_AFTER_MS + 1);
    expect(registry.accepts(RELAY, now + AGENT_STALE_AFTER_MS + 1)).toBe(false);
    expect(registry.accepts(RELAY_REBOOT, now + AGENT_STALE_AFTER_MS + 1)).toBe(true);
  });
});
