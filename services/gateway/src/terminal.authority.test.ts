import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import type { Principal } from './auth.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetPlacement,
  loadFleetPlacements, resolveOperator, routingAuthority
} from './terminal/authority.js';
import {
  loadTerminalConfig, terminalCapabilityAnnouncement, type TerminalConfig
} from './terminal/config.js';
import { UNATTRIBUTED_OPERATOR, type FleetPlacement } from './terminal/types.js';

const PLACEMENTS: readonly FleetPlacement[] = [
  { tenant_id: 'Isa', alias: 'salva', container: 'ws-isa', runtime_user: 'dev' },
  { tenant_id: 'Miguel', alias: 'atlas', container: 'ws-humanizar', runtime_user: 'dev' },
  { tenant_id: 'Miguel', alias: 'iza', container: 'ws-humanizar', runtime_user: 'dev' },
  { tenant_id: 'Miguel', alias: 'kratos', container: 'ws-humanizar', runtime_user: 'dev' },
  { tenant_id: 'Steven', alias: 'argos', container: 'ctrl-infra', runtime_user: 'dev' },
  { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw' },
  { tenant_id: 'Steven', alias: 'kant', container: 'ctrl-infra', runtime_user: 'dev' },
  { tenant_id: 'Steven', alias: 'zeus', container: 'ws-zeus', runtime_user: 'dev' },
];

interface RoomRow { side: 'actor' | 'target'; room_id: string }

/** Minimal pool double: rooms per (tenant, alias) and the ACL edges that exist. */
function pool(
  rooms: Record<string, string[]>,
  edges: readonly string[] = []
): { pool: DatabasePool; queries: number } {
  const state = { queries: 0 };
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    state.queries += 1;
    if (text.includes('acl_edges')) {
      const [from, to] = values as [string, string];
      const rows = edges.includes(`${from}->${to}`) ? [{ ok: true }] : [];
      return { rows, rowCount: rows.length };
    }
    const [actorTenant, actorAlias, targetTenant, targetAlias] = values as [string, string, string, string];
    const rows: RoomRow[] = [
      ...(rooms[`${actorTenant}:${actorAlias}`] ?? []).map((room_id) => ({ side: 'actor' as const, room_id })),
      ...(rooms[`${targetTenant}:${targetAlias}`] ?? []).map((room_id) => ({ side: 'target' as const, room_id }))
    ];
    return { rows, rowCount: rows.length };
  };
  return { pool: { query } as unknown as DatabasePool, queries: state.queries };
}

function consolePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Steven',
    alias: 'kant',
    session_id: 'session-1',
    channel: 'console',
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
    ...overrides
  };
}

function terminalConfig(overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    wsPath: '/v3/console/terminal/ws',
    ticketKey: Buffer.alloc(32),
    relayToken: 'r'.repeat(48),
    grantsFile: '/run/cauce-terminal/grants.json',
    ticketTtlSeconds: 30,
    sessionTtlSeconds: 900,
    maxSessionsPerOperator: 2,
    operatorHeader: 'x-cauce-operator',
    operators: new Set<string>(),
    ...overrides
  };
}

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('terminal configuration', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-config-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixtures(): Promise<{ keyFile: string; tokenFile: string }> {
    const keyFile = join(directory, 'ticket.key');
    const tokenFile = join(directory, 'relay.token');
    await writeFile(keyFile, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n');
    await writeFile(tokenFile, `${'t'.repeat(48)}\n`);
    return { keyFile, tokenFile };
  }

  it('stays off unless CAUCE_TERMINAL_ENABLED is exactly 1, so the gateway boots as it does today', async () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      await expect(loadTerminalConfig(value === undefined ? {} : { CAUCE_TERMINAL_ENABLED: value }))
        .resolves.toBeUndefined();
    }
  });

  it('applies the documented defaults and accepts the key in base64, hex or raw bytes', async () => {
    const { keyFile, tokenFile } = await fixtures();
    const config = await loadTerminalConfig({
      CAUCE_TERMINAL_ENABLED: '1',
      CAUCE_TERMINAL_TICKET_KEY_FILE: keyFile,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile
    });
    expect(config).toMatchObject({
      wsPath: '/v3/console/terminal/ws',
      grantsFile: '/run/cauce-terminal/grants.json',
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator'
    });
    expect(config?.ticketKey.toString('hex')).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    // No enrolled operators means nobody is ever attributed, hence no cross-tenant terminal.
    expect(config?.operators.size).toBe(0);
    const hexFile = join(directory, 'ticket.hex');
    await writeFile(hexFile, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const hex = await loadTerminalConfig({
      CAUCE_TERMINAL_ENABLED: '1',
      CAUCE_TERMINAL_TICKET_KEY_FILE: hexFile,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile
    });
    expect(hex?.ticketKey.equals(config!.ticketKey)).toBe(true);
  });

  it('refuses a short relay token, an oversized TTL and a missing key file', async () => {
    const { keyFile, tokenFile } = await fixtures();
    const shortToken = join(directory, 'short.token');
    await writeFile(shortToken, 'too-short');
    await expect(loadTerminalConfig({
      CAUCE_TERMINAL_ENABLED: '1', CAUCE_TERMINAL_TICKET_KEY_FILE: keyFile,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: shortToken
    })).rejects.toThrow(/at least 32 characters/);
    await expect(loadTerminalConfig({
      CAUCE_TERMINAL_ENABLED: '1', CAUCE_TERMINAL_TICKET_KEY_FILE: keyFile,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile, CAUCE_TERMINAL_TICKET_TTL_SECONDS: '600'
    })).rejects.toThrow(/between 1 and 120/);
    await expect(loadTerminalConfig({
      CAUCE_TERMINAL_ENABLED: '1', CAUCE_TERMINAL_TICKET_KEY_FILE: keyFile,
      CAUCE_TERMINAL_RELAY_TOKEN_FILE: tokenFile, CAUCE_TERMINAL_SESSION_TTL_SECONDS: '99999'
    })).rejects.toThrow(/between 1 and 3600/);
    await expect(loadTerminalConfig({ CAUCE_TERMINAL_ENABLED: '1' }))
      .rejects.toThrow(/CAUCE_TERMINAL_TICKET_KEY_FILE is required/);
  });

  it('announces the capability that unblocks ultimate-terminal.connect in the console', () => {
    expect(terminalCapabilityAnnouncement(terminalConfig({ wsPath: '/v3/console/terminal/ws' }))).toEqual({
      available: true,
      plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'],
      websocket_path: '/v3/console/terminal/ws',
      target_label: 'Cauce fleet PTY'
    });
  });
});

describe('fleet placement and container cohorts', () => {
  it('loads only enabled placements from PostgreSQL and fails on incomplete enabled rows', async () => {
    let query = '';
    const live = {
      query: async (text: string) => {
        query = text;
        return { rows: [{ tenant_id: 'Steven', alias: 'zeus', container_name: 'ws-zeus', runtime_user: 'dev' }] };
      },
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(live)).resolves.toEqual([
      { tenant_id: 'Steven', alias: 'zeus', container: 'ws-zeus', runtime_user: 'dev' },
    ]);
    expect(query).toContain('WHERE enabled');
    const broken = {
      query: async () => ({ rows: [{ tenant_id: 'Steven', alias: 'zeus', container_name: null, runtime_user: 'dev' }] }),
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(broken)).rejects.toThrow(/incomplete placement/);
  });

  it('keys placement by tenant plus alias and groups every identity sharing a container', () => {
    const duplicateAlias = [...PLACEMENTS,
      { tenant_id: 'Miguel', alias: 'jarvis', container: 'other', runtime_user: 'dev' }];
    expect(fleetPlacement(duplicateAlias, 'Steven', 'jarvis')?.container).toBe('claw');
    expect(fleetPlacement(duplicateAlias, 'Miguel', 'jarvis')?.container).toBe('other');
    expect(containerCohort(PLACEMENTS, 'Miguel', 'iza').map((item) => item.alias))
      .toEqual(['atlas', 'iza', 'kratos']);
    expect(containerCohort(PLACEMENTS, 'Steven', 'argos').map((item) => item.alias)).toEqual(['argos', 'kant']);
    expect(containerCohort(PLACEMENTS, 'Steven', 'jarvis').map((item) => item.alias)).toEqual(['jarvis']);
    expect(containerCohort(PLACEMENTS, 'Steven', 'nonexistent')).toEqual([]);
  });
});

describe('routing authority', () => {
  it('allows a same-tenant target only through a room both aliases are enabled in', async () => {
    const { pool: same } = pool({ 'Steven:kant': ['grp.steven'], 'Steven:jarvis': ['grp.steven'] });
    await expect(routingAuthority(same, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toEqual({
      allowed: true, reason: 'same_tenant_room', source_room_ids: ['grp.steven']
    });
    const { pool: disjoint } = pool({ 'Steven:kant': ['grp.steven'], 'Steven:jarvis': ['grp.other'] });
    await expect(routingAuthority(disjoint, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toMatchObject({
      allowed: false, reason: 'no_shared_room'
    });
  });

  it('denies when either side has no enabled room at all', async () => {
    const { pool: noTarget } = pool({ 'Steven:kant': ['grp.steven'] });
    await expect(routingAuthority(noTarget, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toMatchObject({
      allowed: false, reason: 'target_not_routable'
    });
    const { pool: noActor } = pool({ 'Steven:jarvis': ['grp.steven'] });
    await expect(routingAuthority(noActor, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toMatchObject({
      allowed: false, reason: 'actor_not_routable'
    });
  });

  it('requires an enabled acl_edge with allow_route and allow_control for a cross-tenant target', async () => {
    const rooms = { 'Steven:kant': ['grp.steven'], 'Miguel:iza': ['grp.miguel'] };
    const { pool: withEdge } = pool(rooms, ['Steven->Miguel']);
    await expect(routingAuthority(withEdge, 'Steven', 'kant', 'Miguel', 'iza')).resolves.toMatchObject({
      allowed: true, reason: 'acl_edge', source_room_ids: ['grp.steven']
    });
    const { pool: withoutEdge } = pool(rooms, ['Miguel->Steven']);
    await expect(routingAuthority(withoutEdge, 'Steven', 'kant', 'Miguel', 'iza')).resolves.toMatchObject({
      allowed: false, reason: 'acl_edge_missing'
    });
  });

  it('SET RULE: authority over iza but not over atlas denies the whole ws-humanizar container', async () => {
    // iza and kratos are routable, atlas is not: the cohort check must fail closed.
    const { pool: partial } = pool({
      'Steven:kant': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    }, ['Steven->Miguel']);
    const cohort = containerCohort(PLACEMENTS, 'Miguel', 'iza');
    await expect(cohortRoutingAuthority(partial, 'Steven', 'kant', cohort)).resolves.toMatchObject({
      allowed: false, reason: 'target_not_routable:Miguel:atlas'
    });
    const { pool: complete } = pool({
      'Steven:kant': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:atlas': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    }, ['Steven->Miguel']);
    await expect(cohortRoutingAuthority(complete, 'Steven', 'kant', cohort)).resolves.toMatchObject({
      allowed: true, source_room_ids: ['grp.steven']
    });
  });
});

describe('grants file', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-grants-'));
    path = join(directory, 'grants.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('denies everything when the file is absent, and logs at most once per minute', async () => {
    const warnings: string[] = [];
    const store = new GrantStore(join(directory, 'missing.json'), (message) => warnings.push(message));
    expect(await store.grants(1_000)).toEqual([]);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(false);
    expect(await store.allowsCohort('steven', containerCohort(PLACEMENTS, 'Steven', 'jarvis'), 'shell', 5_000)).toBe(false);
    expect(await store.grants(30_000)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(await store.grants(120_000)).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('missing.json');
  });

  it('denies everything when the file is unparseable or the version is unknown', async () => {
    const store = new GrantStore(path);
    await writeFile(path, 'not json at all');
    expect(await store.grants(1_000)).toEqual([]);
    await writeFile(path, JSON.stringify({ version: 2, grants: [{ operator: '*' }] }));
    expect(await store.grants(10_000)).toEqual([]);
  });

  it('re-reads the file within a second, so emptying grants.json closes the door immediately', async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], note: 'pilot' }]
    }));
    const store = new GrantStore(path);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(true);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'harness', 1_000)).toBe(false);
    await writeFile(path, JSON.stringify({ version: 1, grants: [] }));
    // Inside the 1 s cache the previous answer is still served...
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_500)).toBe(true);
    // ...and one second later the door is shut without restarting anything.
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 2_100)).toBe(false);
  });

  it('matches an explicit operator and refuses one that was never granted', async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      grants: [{ operator: 'steven', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }]
    }));
    const store = new GrantStore(path);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'harness', 1_000)).toBe(true);
    expect(await store.allows('miguel', 'Steven', 'jarvis', 'shell', 1_000)).toBe(false);
  });

  it('SET RULE: a grant on iza alone does not open the ws-humanizar container', async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Miguel', alias: 'iza', modes: ['shell'] }]
    }));
    const store = new GrantStore(path);
    expect(await store.allows('steven', 'Miguel', 'iza', 'shell', 1_000)).toBe(true);
    const cohort = containerCohort(PLACEMENTS, 'Miguel', 'iza');
    expect(await store.allowsCohort('steven', cohort, 'shell', 1_000)).toBe(false);
    await writeFile(path, JSON.stringify({
      version: 1,
      grants: ['iza', 'atlas', 'kratos'].map((alias) => ({
        operator: '*', tenant_id: 'Miguel', alias, modes: ['shell']
      }))
    }));
    expect(await store.allowsCohort('steven', cohort, 'shell', 10_000)).toBe(true);
  });
});

describe('operator attribution', () => {
  it('accepts the operator header only from the console channel and only when enrolled', () => {
    const config = terminalConfig({ operators: new Set(['steven', 'miguel']) });
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), consolePrincipal(), config))
      .toEqual({ operator_id: 'steven', attributed: true });
    // Not enrolled.
    expect(resolveOperator(request({ 'x-cauce-operator': 'intruder' }), consolePrincipal(), config))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
    // Right value, wrong channel: an adapter cannot claim to be a human.
    expect(resolveOperator(
      request({ 'x-cauce-operator': 'steven' }), consolePrincipal({ channel: 'adapter' }), config
    )).toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
    // No enrolled operators at all: nobody is ever attributed.
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), consolePrincipal(), terminalConfig()))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
    expect(resolveOperator(request(), consolePrincipal(), config))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
  });

  it('an authenticated operator_id beats the proxy header, which is fixed to "steven" for everyone', () => {
    // Caddy y nginx inyectan `X-Cauce-Operator: steven` FIJO delante del gateway, así que
    // mientras la cabecera mandara, `audit_events` decía `steven` entrara quien entrara. Con el
    // login por contraseña el operador sale del JWT ya verificado: la cabecera ni se mira, y no
    // hace falta que el correo esté inscripto en CAUCE_TERMINAL_OPERATORS.
    const config = terminalConfig({ operators: new Set(['steven']) });
    const logged = consolePrincipal({ operator_id: 'miguel@elenxos.com' });
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), logged, config))
      .toEqual({ operator_id: 'miguel@elenxos.com', attributed: true });
    // Sin operadores inscriptos la cabecera no atribuye a nadie, pero la sesión sí.
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), logged, terminalConfig()))
      .toEqual({ operator_id: 'miguel@elenxos.com', attributed: true });
    // Y un principal sin identidad humana sigue exactamente como hoy: manda la cabecera.
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), consolePrincipal(), config))
      .toEqual({ operator_id: 'steven', attributed: true });
  });

  it('HARD INVARIANT: without attribution only the actor own tenant may be targeted', () => {
    expect(attributionAllows(false, 'Steven', 'Steven')).toBe(true);
    for (const tenant of ['Miguel', 'Pablo', 'Isa', 'Jhon']) {
      expect(attributionAllows(false, 'Steven', tenant)).toBe(false);
      expect(attributionAllows(true, 'Steven', tenant)).toBe(true);
    }
  });
});
