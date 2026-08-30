import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceRelayClient, MeasuredFactsSource } from '../../services/gateway/src/console/agent-documents.js';
import { HttpGovernanceRelayClient } from '../../services/gateway/src/console/relay-governance-client.js';
import { SondaCompartida } from '../../services/gateway/src/console/sonda-compartida.js';
import { createGovernanceProbes } from '../../services/gateway/src/terminal/governance-probes.js';
import { hechosDelRegistro } from '../../services/gateway/src/terminal/hechos-del-registro.js';
import {
  AGENT_STALE_AFTER_MS,
  AgentRegistry,
  RelayBootConflictError,
  parseAgentPresence,
  type AgentObservation,
  type RelayProcessIdentity,
} from '../../services/gateway/src/terminal/registry.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';

/**
 * Hermetic tests for the PTY registry, the measured-facts adapter, and the
 * governance probes — three files that share state and live in the same
 * sector. The filesystem is mocked so `buildRelay` never touches disk;
 * Fastify is started in-process so the registered route is observable.
 */

const fsFiles = vi.hoisted(() => new Map<string, Buffer>());
const fsMock = vi.hoisted(() => vi.fn<(path: string, encoding?: 'utf8') => Promise<Buffer | string>>());

vi.mock('node:fs/promises', () => ({
  readFile: fsMock
}));

const RELAY: RelayProcessIdentity = {
  relay_instance_id: 'a'.repeat(64),
  relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};
const RELAY_B: RelayProcessIdentity = {
  relay_instance_id: 'b'.repeat(64),
  relay_boot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};
const RELAY_REBOOT: RelayProcessIdentity = {
  relay_instance_id: RELAY.relay_instance_id,
  relay_boot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
};

function presencia(extras: Record<string, unknown> = {}): ReturnType<typeof parseAgentPresence> {
  return parseAgentPresence({
    tenant_id: 'Steven',
    alias: 'zeus',
    container_id: 'claw-zeus',
    generation: 'gen-1',
    image_id: 'img-1',
    runtime_user: 'dev',
    runtime_uid: 1000,
    harness: 'claude',
    runtime_facts_observed: true,
    home: '/home/dev',
    claude_config_dir: '/home/dev/.claude',
    modes: ['shell', 'harness'],
    connected_since: '2026-08-25T00:00:00.000Z',
    ...extras
  });
}

function configBase(): TerminalConfig {
  return {
    wsPath: '/v3/console/terminal/ws',
    ticketKey: Buffer.alloc(32, 7),
    relayToken: 'relay-token-must-be-at-least-32-chars-long',
    relayInstanceIds: new Set([RELAY.relay_instance_id]),
    grantsFile: '/run/cauce-terminal/grants.json',
    ticketTtlSeconds: 30,
    sessionTtlSeconds: 900,
    claimLeaseSeconds: 150,
    maxSessionsPerOperator: 2,
    operatorHeader: 'x-cauce-operator',
    operators: new Set()
  };
}

function putFile(path: string, contents: Buffer | string): void {
  fsFiles.set(path, typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
}

beforeEach(() => {
  fsFiles.clear();
  fsMock.mockReset();
  fsMock.mockImplementation(async (path: string, encoding?: 'utf8') => {
    const value = fsFiles.get(path);
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return encoding === 'utf8' ? value.toString('utf8') : value;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* parseAgentPresence                                                          */
/* -------------------------------------------------------------------------- */

describe('parseAgentPresence', () => {
  it('admite la presencia canónica y conserva alias/tenant/container/generation', () => {
    const parsed = presencia();
    expect(parsed.tenant_id).toBe('Steven');
    expect(parsed.alias).toBe('zeus');
    expect(parsed.container_id).toBe('claw-zeus');
    expect(parsed.generation).toBe('gen-1');
    expect(parsed.runtime_uid).toBe(1000);
    expect(parsed.harness).toBe('claude');
    expect(parsed.runtime_facts_observed).toBe(true);
    expect(parsed.home).toBe('/home/dev');
    expect(parsed.claude_config_dir).toBe('/home/dev/.claude');
    expect(parsed.modes).toEqual(['shell', 'harness']);
  });

  it('rechaza entradas que no son objeto (null, array, primitivo)', () => {
    for (const value of [null, 'string', 42, true, []]) {
      expect(() => parseAgentPresence(value)).toThrow();
    }
  });

  it('rechaza runtime_uid negativo, no entero o no numérico', () => {
    expect(() => parseAgentPresence({ ...presencia(), runtime_uid: -1 })).toThrow(/runtime_uid/);
    expect(() => parseAgentPresence({ ...presencia(), runtime_uid: 1.5 })).toThrow(/runtime_uid/);
    expect(() => parseAgentPresence({ ...presencia(), runtime_uid: Number.NaN })).toThrow(/runtime_uid/);
  });

  it('rechaza modes que no son string', () => {
    expect(() => parseAgentPresence({ ...presencia(), modes: [1, 2] })).toThrow(/modes/);
    expect(() => parseAgentPresence({ ...presencia(), modes: 'shell' })).toThrow(/modes/);
  });

  it('rechaza campos string vacíos o ausentes (tenant_id, alias, generation, ...)', () => {
    expect(() => parseAgentPresence({ ...presencia(), alias: '' })).toThrow(/alias/);
    expect(() => parseAgentPresence({ ...presencia(), tenant_id: '' })).toThrow(/tenant_id/);
    expect(() => parseAgentPresence({ ...presencia(), connected_since: '' })).toThrow(/connected_since/);
  });

  it('descarta paths que no empiezan con / o que incluyen null bytes / segmentos inválidos', () => {
    expect(presencia({ home: 'relative/path' }).home).toBeUndefined();
    expect(presencia({ home: '/home/dev/with\0null' }).home).toBeUndefined();
    expect(presencia({ home: '/home/dev/../escape' }).home).toBeUndefined();
    expect(presencia({ home: '/home/dev/' }).home).toBeUndefined();
  });

  it('descarta context cwd/workspace/project cruzados y deja la presencia sin ellos', () => {
    const parsed = presencia({ cwd: '/workspace/a', workspace_root: '/workspace/b', project_root: '/workspace/a' });
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.workspace_root).toBeUndefined();
    expect(parsed.project_root).toBeUndefined();
  });

  it('harness no soportado deja runtime_facts_observed en false aunque mande home', () => {
    const parsed = presencia({ harness: 'opencode', home: '/home/dev' });
    expect(parsed.runtime_facts_observed).toBe(false);
    expect(parsed.home).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* AgentRegistry                                                                */
/* -------------------------------------------------------------------------- */

describe('AgentRegistry.observe / accepts / resolve / state / snapshot', () => {
  it('seeded es false hasta que el primer observe tiene éxito', () => {
    const registry = new AgentRegistry();
    expect(registry.seeded).toBe(false);
    registry.observe(RELAY, [presencia()]);
    expect(registry.seeded).toBe(true);
  });

  it('observe rechaza identidades de relay mal formadas', () => {
    const registry = new AgentRegistry();
    expect(() => registry.observe({ relay_instance_id: 'short', relay_boot_id: RELAY.relay_boot_id }, []))
      .toThrow(/identity is invalid/);
    expect(() => registry.observe({ relay_instance_id: RELAY.relay_instance_id, relay_boot_id: 'not-a-uuid' }, []))
      .toThrow(/identity is invalid/);
  });

  it('observe rechaza duplicados dentro del mismo snapshot', () => {
    const registry = new AgentRegistry();
    expect(() => registry.observe(RELAY, [presencia(), presencia()])).toThrow(/duplicate alias/);
  });

  it('observe acepta el mismo relay con boot_id nuevo cuando el dueño anterior quedó stale', () => {
    const registry = new AgentRegistry();
    const now = Date.now();
    registry.observe(RELAY, [presencia()], now);
    registry.observe(RELAY_REBOOT, [presencia({ generation: 'gen-2' })], now + AGENT_STALE_AFTER_MS + 1);
    expect(registry.accepts(RELAY_REBOOT, now + AGENT_STALE_AFTER_MS + 1)).toBe(true);
    expect(registry.accepts(RELAY, now + AGENT_STALE_AFTER_MS + 1)).toBe(false);
  });

  it('observe lanza RelayBootConflictError si un reboot llega antes de que el dueño aceptado quede stale', () => {
    const registry = new AgentRegistry();
    const now = Date.now();
    registry.observe(RELAY, [presencia()], now);
    expect(() => registry.observe(RELAY_REBOOT, [presencia()], now + 1)).toThrow(RelayBootConflictError);
  });

  it('resolve devuelve "unknown" antes del primer observe y "not_installed" para alias ausente', () => {
    const registry = new AgentRegistry();
    expect(registry.resolve('Steven', 'zeus')).toEqual({ status: 'unknown' });
    registry.observe(RELAY, [presencia()], Date.now());
    expect(registry.resolve('Steven', 'kant')).toEqual({ status: 'not_installed' });
  });

  it('resolve devuelve "online" cuando un solo relay fresco reporta el alias', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()], Date.now());
    const result = registry.resolve('Steven', 'zeus');
    expect(result.status).toBe('online');
    if (result.status !== 'online') throw new Error('expected online');
    expect(result.observation.relay_instance_id).toBe(RELAY.relay_instance_id);
    expect(result.observation.stale).toBe(false);
  });

  it('resolve devuelve "ambiguous" cuando dos relays frescos reportan el mismo alias', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()], Date.now());
    registry.observe(RELAY_B, [presencia({ generation: 'gen-2' })], Date.now());
    expect(registry.resolve('Steven', 'zeus')).toEqual({
      status: 'ambiguous',
      relay_instance_ids: [RELAY.relay_instance_id, RELAY_B.relay_instance_id]
    });
    expect(registry.state('Steven', 'zeus')).toBe('agent_offline');
    expect(registry.get('Steven', 'zeus')).toBeUndefined();
  });

  it('resolve devuelve "offline" cuando el alias fue visto antes pero el snapshot quedó stale', () => {
    const registry = new AgentRegistry();
    const t0 = Date.now();
    registry.observe(RELAY, [presencia()], t0);
    registry.observe(RELAY, [], t0 + AGENT_STALE_AFTER_MS + 1);
    const result = registry.resolve('Steven', 'zeus');
    expect(result.status).toBe('offline');
    if (result.status !== 'offline') throw new Error('expected offline');
    expect(result.observation.stale).toBe(true);
  });

  it('snapshot enumera todas las observaciones (online y offline) y omite never-seen', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia(), presencia({ alias: 'kant' })], Date.now());
    const snapshot = registry.snapshot();
    const aliases = snapshot.map((observation: AgentObservation) => observation.presence.alias).sort();
    expect(aliases).toEqual(['kant', 'zeus']);
  });

  it('accepts rechaza el mismo relay_instance_id con un boot_id distinto aunque sea reciente', () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()], Date.now());
    expect(registry.accepts(RELAY_REBOOT)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* hechos-del-registro.ts                                                       */
/* -------------------------------------------------------------------------- */

describe('hechosDelRegistro', () => {
  it('devuelve undefined cuando el alias nunca fue publicado', async () => {
    const registry = new AgentRegistry();
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('devuelve undefined cuando la observación está stale', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()], Date.now() - AGENT_STALE_AFTER_MS - 1);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('devuelve undefined cuando runtime_facts_observed no es true', async () => {
    const parsed = presencia({ runtime_facts_observed: false });
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parsed]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('devuelve undefined cuando el harness no es uno de los conocidos', async () => {
    const parsed = presencia({ harness: 'opencode' });
    const registry = new AgentRegistry();
    registry.observe(RELAY, [parsed]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('emite RuntimeFacts completos cuando la presencia es canónica', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const facts = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(facts?.source).toBe('measured');
    expect(facts?.facts).toMatchObject({
      harness: 'claude',
      home: '/home/dev',
      claudeConfigDir: '/home/dev/.claude',
      containerId: 'claw-zeus',
      generation: 'gen-1'
    });
    expect(facts?.facts.modes).toEqual(['shell', 'harness']);
  });

  it('aísla hechos por tenant:alias — un alias de otro tenant no ve el home del primero', async () => {
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const source = hechosDelRegistro(registry);
    expect((await source.factsFor('Steven', 'zeus'))?.facts.home).toBe('/home/dev');
    expect(await source.factsFor('Miguel', 'zeus')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* governance-probes.ts                                                         */
/* -------------------------------------------------------------------------- */

describe('createGovernanceProbes.buildRelay', () => {
  it('devuelve un cliente "unavailable" cuando relayUrl no está configurada', async () => {
    const config = configBase();
    const { buildRelay } = createGovernanceProbes(buildApp(), buildContext(config, new AgentRegistry()));
    const relay = await buildRelay();
    const result = await relay.readFile('Steven', 'zeus', '/home/dev/.claude/CLAUDE.md');
    const failure = result as { error: string; reason: string };
    expect(failure.error).toBe('unavailable');
    expect(failure.reason).toContain('CAUCE_TERMINAL_RELAY_URL');
  });

  it('lee los TLS files y construye HttpGovernanceRelayClient cuando hay relayUrl', async () => {
    const config: TerminalConfig = {
      ...configBase(),
      relayUrl: 'https://relay.local:8443',
      relayCaFile: '/etc/cauce/ca.pem',
      relayClientCertFile: '/etc/cauce/client.crt',
      relayClientKeyFile: '/etc/cauce/client.key'
    };
    putFile('/etc/cauce/ca.pem', 'ca-bytes');
    putFile('/etc/cauce/client.crt', 'cert-bytes');
    putFile('/etc/cauce/client.key', 'key-bytes');
    const { buildRelay } = createGovernanceProbes(buildApp(), buildContext(config, new AgentRegistry()));
    const relay = await buildRelay();
    expect(relay).toBeInstanceOf(HttpGovernanceRelayClient);
  });

  it('lee solo los TLS files presentes y omite los ausentes sin tirar', async () => {
    const config: TerminalConfig = {
      ...configBase(),
      relayUrl: 'https://relay.local:8443',
      relayCaFile: '/etc/cauce/ca.pem'
    };
    putFile('/etc/cauce/ca.pem', 'ca-bytes');
    const { buildRelay } = createGovernanceProbes(buildApp(), buildContext(config, new AgentRegistry()));
    const relay = await buildRelay();
    expect(relay).toBeInstanceOf(HttpGovernanceRelayClient);
  });
});

describe('createGovernanceProbes.register', () => {
  it('monta el probe en app.sondaDeDocumentos cuando el slot está presente', async () => {
    const app = buildApp();
    const sonda = new SondaCompartida();
    app.sondaDeDocumentos = sonda;
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const { register } = createGovernanceProbes(app, buildContext(configBase(), registry));
    const relay: GovernanceRelayClient = { readFile: vi.fn() };
    await register(relay);
    expect(sonda.instalada).toBe(true);
    await app.close();
  });

  it('no toca sondaDeDocumentos cuando el slot no está definido', async () => {
    const app = buildApp();
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const { register } = createGovernanceProbes(app, buildContext(configBase(), registry));
    await register({ readFile: vi.fn() });
    await app.close();
  });

  it('registra la ruta /v3/console/agents/:tenant/:alias/directive y enruta la autorización', async () => {
    const app = buildApp();
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const principal = vi.fn().mockResolvedValue({
      tenant_id: 'Steven' as never,
      alias: 'zeus',
      session_id: 's1',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read']
    });
    const authorizeAgentTarget = vi.fn().mockResolvedValue({
      tenant_id: 'Steven',
      alias: 'zeus',
      container: 'claw-zeus',
      runtime_user: 'dev',
      tenant_name: 'Steven',
      alias_kind: 'claude',
      status: 'enabled'
    });
    const replyError = vi.fn();
    const context = {
      ...buildContext(configBase(), registry),
      principal,
      repository: { authorizeAgentTarget },
      replyError
    };
    const { register } = createGovernanceProbes(app, context);
    await register({ readFile: vi.fn() });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive'
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ publicado: boolean; medido: boolean }>();
    expect(body.publicado).toBe(true);
    expect(body.medido).toBe(true);
    expect(authorizeAgentTarget).toHaveBeenCalledWith(
      'Steven', 'zeus', 'Steven', 'zeus', 'read'
    );
    await app.close();
  });

  it('responde 404 cuando la autorización falla y no expone datos del target', async () => {
    const app = buildApp();
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const principal = vi.fn().mockResolvedValue({
      tenant_id: 'Steven' as never,
      alias: 'zeus',
      session_id: 's1',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read']
    });
    const authorizeAgentTarget = vi.fn().mockResolvedValue(undefined);
    const replyError = vi.fn();
    const context = {
      ...buildContext(configBase(), registry),
      principal,
      repository: { authorizeAgentTarget },
      replyError
    };
    const { register } = createGovernanceProbes(app, context);
    await register({ readFile: vi.fn() });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive'
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'not_found',
      message: 'agent not found or not visible'
    });
    await app.close();
  });

  it('respuesta degradada cuando el facts source NO es measured', async () => {
    const app = buildApp();
    const registry = new AgentRegistry();
    const principal = vi.fn().mockResolvedValue({
      tenant_id: 'Steven' as never,
      alias: 'zeus',
      session_id: 's1',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read']
    });
    const authorizeAgentTarget = vi.fn().mockResolvedValue({
      tenant_id: 'Steven',
      alias: 'zeus',
      container: 'claw-zeus',
      runtime_user: 'dev',
      tenant_name: 'Steven',
      alias_kind: 'claude',
      status: 'enabled'
    });
    const measuredFacts: MeasuredFactsSource = {
      async factsFor() {
        return undefined;
      }
    };
    const context = {
      ...buildContext(configBase(), registry),
      principal,
      repository: { authorizeAgentTarget },
      replyError: vi.fn(),
      runtimeOptions: { measuredFacts }
    };
    const { register } = createGovernanceProbes(app, context);
    await register({ readFile: vi.fn() });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive'
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ medido: boolean; motivo: string }>();
    expect(body.medido).toBe(false);
    expect(body.motivo).toMatch(/contenedor no medido/);
    await app.close();
  });

  it('usa hechosDelRegistro(registry) cuando runtimeOptions.measuredFacts no se inyecta', async () => {
    const app = buildApp();
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    const principal = vi.fn().mockResolvedValue({
      tenant_id: 'Steven' as never,
      alias: 'zeus',
      session_id: 's1',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read']
    });
    const authorizeAgentTarget = vi.fn().mockResolvedValue({
      tenant_id: 'Steven',
      alias: 'zeus',
      container: 'claw-zeus',
      runtime_user: 'dev',
      tenant_name: 'Steven',
      alias_kind: 'claude',
      status: 'enabled'
    });
    const context = {
      config: configBase(),
      registry,
      principal,
      repository: { authorizeAgentTarget },
      replyError: vi.fn(),
      runtimeOptions: {}
    };
    const { register } = createGovernanceProbes(app, context);
    await register({ readFile: vi.fn() });
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v3/console/agents/Steven/zeus/directive'
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ medido: boolean }>();
    expect(body.medido).toBe(true);
    await app.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function buildApp(): FastifyInstance {
  return Fastify({ logger: false });
}

type ProbeContext = Parameters<typeof createGovernanceProbes>[1];

function buildContext(config: TerminalConfig, registry: AgentRegistry): ProbeContext {
  return {
    config,
    registry,
    repository: {
      authorizeAgentTarget: vi.fn().mockResolvedValue(undefined)
    },
    runtimeOptions: {},
    principal: vi.fn().mockResolvedValue({
      tenant_id: 'Steven' as never,
      alias: 'zeus',
      session_id: 's1',
      channel: 'console',
      roles: ['operator'],
      permissions: ['read']
    }),
    replyError: vi.fn()
  };
}
