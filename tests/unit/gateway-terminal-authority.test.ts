import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../services/gateway/src/auth.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort,
  fleetIdentity, fleetIdentityLabel, fleetPlacement, loadFleetPlacements,
  resolveOperator, routingAuthority,
} from '../../services/gateway/src/terminal/authority.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { UNATTRIBUTED_OPERATOR, type FleetPlacement } from '../../services/gateway/src/terminal/types.js';

/**
 * Estrecha un opcional sin `!` ni `as`.
 *
 * Las dos reglas del preset se contradicen sobre un `T | undefined`: `no-non-null-assertion`
 * prohibe el `!` y `non-nullable-type-assertion-style` exige el `!` en lugar del `as`. La salida
 * no es elegir una, es no aseverar: si el valor falta, la prueba falla diciendo QUE falto, en vez
 * de reventar con «cannot read property of undefined».
 */
function exigir<T>(valor: T | undefined, que: string): T {
  if (valor === undefined) throw new Error(`se esperaba ${que} y no lo hubo`);
  return valor;
}

/**
 * Tests herméticos para `services/gateway/src/terminal/authority.ts`.
 *
 * El módulo cubre las cuatro entradas de autorización del plano terminal: la registry en vivo
 * (`loadFleetPlacements`), los cohorts por container, el archivo de grants rotable y la autoridad
 * de ruteo replicada del publish path. Cada función se prueba con entradas directas — sin
 * Fastify, sin PostgreSQL real — para fijar el contrato que `plugin.ts` consume por encima.
 *
 * Lo que aquí se valida NO es la implementación de SQL (eso vive en
 * `tests/store-hardening/...`), sino la lógica de autorización que se ejecuta entre la fila y
 * la decisión: cohort ordenado, deny-on-empty-cohort, attribution-required, SET RULE sobre
 * containers compartidos, etc.
 */

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

function consolePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Steven', alias: 'kant', session_id: 'session-1', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'], ...overrides
  };
}

function terminalConfig(overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    wsPath: '/v3/console/terminal/ws',
    ticketKey: Buffer.alloc(32),
    relayToken: 't'.repeat(48),
    relayInstanceIds: new Set(['a'.repeat(64)]),
    grantsFile: '/run/cauce-terminal/grants.json',
    ticketTtlSeconds: 30,
    sessionTtlSeconds: 900,
    claimLeaseSeconds: 150,
    maxSessionsPerOperator: 2,
    operatorHeader: 'x-cauce-operator',
    operators: new Set<string>(),
    ...overrides
  };
}

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function pool(
  rooms: Record<string, string[]>,
  edges: readonly string[] = [],
): DatabasePool {
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (text.includes('acl_edges')) {
      const [from, to] = values as [string, string];
      const rows = edges.includes(`${from}->${to}`) ? [{ ok: true }] : [];
      return { rows, rowCount: rows.length };
    }
    const [actorTenant, actorAlias, targetTenant, targetAlias] = values as [string, string, string, string];
    const rows = [
      ...(rooms[`${actorTenant}:${actorAlias}`] ?? []).map((room_id) => ({ side: 'actor', room_id })),
      ...(rooms[`${targetTenant}:${targetAlias}`] ?? []).map((room_id) => ({ side: 'target', room_id }))
    ];
    return { rows, rowCount: rows.length };
  };
  return { query } as unknown as DatabasePool;
}

describe('loadFleetPlacements', () => {
  it('solo lee filas enabled y mapea los nombres de columna al shape interno', async () => {
    let observed = '';
    const live = {
      query: async (text: string) => {
        observed = text;
        return {
          rows: [{ tenant_id: 'Steven', alias: 'zeus', container_name: 'ws-zeus', runtime_user: 'dev' }],
          rowCount: 1
        };
      },
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(live)).resolves.toEqual([
      { tenant_id: 'Steven', alias: 'zeus', container: 'ws-zeus', runtime_user: 'dev' }
    ]);
    expect(observed).toContain('WHERE enabled');
  });

  it('tira si una fila enabled tiene container o runtime_user nulo', async () => {
    const broken = {
      query: async () => ({
        rows: [{ tenant_id: 'Steven', alias: 'zeus', container_name: null, runtime_user: 'dev' }],
        rowCount: 1
      }),
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(broken)).rejects.toThrow(/incomplete placement/u);
  });

  it('tira si una fila enabled tiene tenant_id o alias nulo', async () => {
    const broken = {
      query: async () => ({
        rows: [{ tenant_id: '', alias: 'zeus', container_name: 'ws-zeus', runtime_user: 'dev' }],
        rowCount: 1
      }),
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(broken)).rejects.toThrow(/incomplete placement/u);
  });
});

describe('fleetPlacement / fleetIdentity / fleetIdentityLabel / containerCohort', () => {
  it('fleetPlacement devuelve el matching exacto (tenant_id, alias)', () => {
    expect(fleetPlacement(PLACEMENTS, 'Steven', 'jarvis')?.container).toBe('claw');
    expect(fleetPlacement(PLACEMENTS, 'Steven', 'jarvis')?.runtime_user).toBe('claw');
  });

  it('fleetPlacement no se confunde entre tenants aunque el alias coincida (Miguel:jarvis)', () => {
    const extended: readonly FleetPlacement[] = [
      ...PLACEMENTS,
      { tenant_id: 'Miguel', alias: 'jarvis', container: 'other', runtime_user: 'dev' }
    ];
    expect(fleetPlacement(extended, 'Steven', 'jarvis')?.container).toBe('claw');
    expect(fleetPlacement(extended, 'Miguel', 'jarvis')?.container).toBe('other');
  });

  it('fleetPlacement devuelve undefined para un alias desconocido o vacío', () => {
    expect(fleetPlacement(PLACEMENTS, 'Steven', 'no-existe')).toBeUndefined();
    expect(fleetPlacement([] as readonly FleetPlacement[], 'Steven', 'jarvis')).toBeUndefined();
  });

  it('fleetIdentity y fleetIdentityLabel exponen el par (tenant, alias) sin filtrar runtime', () => {
    const placement = exigir(fleetPlacement(PLACEMENTS, 'Miguel', 'iza'), 'la colocación de Miguel/iza');
    expect(fleetIdentity(placement)).toEqual({ tenant_id: 'Miguel', alias: 'iza' });
    expect(fleetIdentityLabel(fleetIdentity(placement))).toBe('Miguel:iza');
  });

  it('containerCohort devuelve todos los miembros del container, ordenados (tenant, alias)', () => {
    expect(containerCohort(PLACEMENTS, 'Miguel', 'iza').map((item) => `${item.tenant_id}:${item.alias}`))
      .toEqual(['Miguel:atlas', 'Miguel:iza', 'Miguel:kratos']);
    expect(containerCohort(PLACEMENTS, 'Steven', 'argos').map((item) => `${item.tenant_id}:${item.alias}`))
      .toEqual(['Steven:argos', 'Steven:kant']);
  });

  it('containerCohort devuelve un array vacío si el alias no está colocado', () => {
    expect(containerCohort(PLACEMENTS, 'Steven', 'no-existe')).toEqual([]);
    expect(containerCohort([] as readonly FleetPlacement[], 'Miguel', 'iza')).toEqual([]);
  });
});

describe('GrantStore: archivo de grants rotable', () => {
  let directory: string;
  let grantsPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-authority-'));
    grantsPath = join(directory, 'grants.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('niega todo cuando el archivo no existe y registra el warning exactamente una vez por minuto', async () => {
    const warnings: string[] = [];
    const store = new GrantStore(join(directory, 'missing.json'), (message) => warnings.push(message));
    expect(await store.grants(1_000)).toEqual([]);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(false);
    const cohort = containerCohort(PLACEMENTS, 'Steven', 'jarvis');
    expect(await store.allowsCohort('steven', cohort, 'shell', 1_500)).toBe(false);
    // Within the minute, it only logs once.
    expect(await store.grants(30_000)).toEqual([]);
    expect(warnings).toHaveLength(1);
    // A minute later, it logs again.
    expect(await store.grants(120_000)).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('missing.json');
  });

  it('niega todo cuando el archivo es JSON inválido o su versión no es 1', async () => {
    const store = new GrantStore(grantsPath);
    await writeFile(grantsPath, 'not json at all');
    expect(await store.grants(1_000)).toEqual([]);
    await writeFile(grantsPath, JSON.stringify({ version: 2, grants: [{ operator: '*' }] }));
    expect(await store.grants(10_000)).toEqual([]);
  });

  it('relee el archivo cuando vence el cache de 1 segundo', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const store = new GrantStore(grantsPath);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(true);
    await writeFile(grantsPath, JSON.stringify({ version: 1, grants: [] }));
    // Inside the cache, the previous one still holds.
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_500)).toBe(true);
    // Past the cache, the gate closes without a restart.
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 2_100)).toBe(false);
  });

  it('allows: el wildcard "*" atribuye a cualquier operator; de lo contrario matchea exacto', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const wildcard = new GrantStore(grantsPath);
    expect(await wildcard.allows('cualquiera', 'Steven', 'jarvis', 'shell', 1_000)).toBe(true);

    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: 'steven', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const exact = new GrantStore(grantsPath);
    expect(await exact.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(true);
    expect(await exact.allows('miguel', 'Steven', 'jarvis', 'shell', 1_000)).toBe(false);
  });

  it('allows: rechaza cuando el modo solicitado no está en la lista modes', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const store = new GrantStore(grantsPath);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'shell', 1_000)).toBe(true);
    expect(await store.allows('steven', 'Steven', 'jarvis', 'harness', 1_000)).toBe(false);
  });

  it('allows: rechaza con un grant sobre otro tenant o alias', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const store = new GrantStore(grantsPath);
    expect(await store.allows('steven', 'Miguel', 'jarvis', 'shell', 1_000)).toBe(false);
    expect(await store.allows('steven', 'Steven', 'kant', 'shell', 1_000)).toBe(false);
  });

  it('SET RULE: allowsCohort requiere un grant por cada miembro del container compartido', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Miguel', alias: 'iza', modes: ['shell'] }]
    }));
    const partial = new GrantStore(grantsPath);
    const cohort = containerCohort(PLACEMENTS, 'Miguel', 'iza');
    expect(await partial.allows('steven', 'Miguel', 'iza', 'shell', 1_000)).toBe(true);
    expect(await partial.allowsCohort('steven', cohort, 'shell', 1_000)).toBe(false);
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: ['iza', 'atlas', 'kratos'].map((alias) => ({
        operator: '*', tenant_id: 'Miguel', alias, modes: ['shell']
      }))
    }));
    const complete = new GrantStore(grantsPath);
    expect(await complete.allowsCohort('steven', cohort, 'shell', 10_000)).toBe(true);
  });

  it('allowsCohort devuelve false para un cohort vacío', async () => {
    await writeFile(grantsPath, JSON.stringify({
      version: 1,
      grants: [{ operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] }]
    }));
    const store = new GrantStore(grantsPath);
    expect(await store.allowsCohort('steven', [], 'shell', 1_000)).toBe(false);
  });
});

describe('routingAuthority: replica del publish path', () => {
  it('same-tenant: permitido solo si comparten un room enabled (acl por pertenencia)', async () => {
    const same = pool({ 'Steven:kant': ['grp.steven'], 'Steven:jarvis': ['grp.steven'] });
    await expect(routingAuthority(same, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toEqual({
      allowed: true, reason: 'same_tenant_room', source_room_ids: ['grp.steven']
    });
    const disjoint = pool({ 'Steven:kant': ['grp.steven'], 'Steven:jarvis': ['grp.other'] });
    await expect(routingAuthority(disjoint, 'Steven', 'kant', 'Steven', 'jarvis')).resolves.toMatchObject({
      allowed: false, reason: 'no_shared_room'
    });
  });

  it('niega con target_not_routable / actor_not_routable cuando alguna parte no tiene rooms', async () => {
    const noTarget = pool({ 'Steven:kant': ['grp.steven'] });
    await expect(routingAuthority(noTarget, 'Steven', 'kant', 'Steven', 'jarvis'))
      .resolves.toMatchObject({ allowed: false, reason: 'target_not_routable' });
    const noActor = pool({ 'Steven:jarvis': ['grp.steven'] });
    await expect(routingAuthority(noActor, 'Steven', 'kant', 'Steven', 'jarvis'))
      .resolves.toMatchObject({ allowed: false, reason: 'actor_not_routable' });
  });

  it('cross-tenant: requiere un acl_edge enabled con allow_route y allow_control', async () => {
    const rooms = { 'Steven:kant': ['grp.steven'], 'Miguel:iza': ['grp.miguel'] };
    const withEdge = pool(rooms, ['Steven->Miguel']);
    await expect(routingAuthority(withEdge, 'Steven', 'kant', 'Miguel', 'iza'))
      .resolves.toMatchObject({ allowed: true, reason: 'acl_edge', source_room_ids: ['grp.steven'] });
    const withoutEdge = pool(rooms, ['Miguel->Steven']);
    await expect(routingAuthority(withoutEdge, 'Steven', 'kant', 'Miguel', 'iza'))
      .resolves.toMatchObject({ allowed: false, reason: 'acl_edge_missing' });
  });
});

describe('cohortRoutingAuthority: SET RULE sobre containers compartidos', () => {
  it('niega el container entero si un solo miembro del cohort no es ruteable', async () => {
    // iza and kratos are routable, atlas is not: the cohort check must fail closed.
    const partial = pool({
      'Steven:kant': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    }, ['Steven->Miguel']);
    const cohort = containerCohort(PLACEMENTS, 'Miguel', 'iza');
    await expect(cohortRoutingAuthority(partial, 'Steven', 'kant', cohort))
      .resolves.toMatchObject({ allowed: false, reason: 'target_not_routable:Miguel:atlas' });
  });

  it('permite el container cuando TODOS los miembros son ruteables', async () => {
    const complete = pool({
      'Steven:kant': ['grp.steven'],
      'Miguel:iza': ['grp.miguel'],
      'Miguel:atlas': ['grp.miguel'],
      'Miguel:kratos': ['grp.miguel']
    }, ['Steven->Miguel']);
    const cohort = containerCohort(PLACEMENTS, 'Miguel', 'iza');
    await expect(cohortRoutingAuthority(complete, 'Steven', 'kant', cohort))
      .resolves.toMatchObject({ allowed: true, source_room_ids: ['grp.steven'] });
  });

  it('niega con unknown_alias cuando el cohort está vacío', async () => {
    const p = pool({});
    await expect(cohortRoutingAuthority(p, 'Steven', 'kant', []))
      .resolves.toMatchObject({ allowed: false, reason: 'unknown_alias' });
  });
});

describe('resolveOperator: identidad humana del operador', () => {
  it('cuando el auth provider ya nombra al humano, gana sobre el header proxy', () => {
    const config = terminalConfig({ operators: new Set(['steven']) });
    const logged = consolePrincipal({ operator_id: 'miguel@elenxos.com' });
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), logged, config))
      .toEqual({ operator_id: 'miguel@elenxos.com', attributed: true });
    // Even with nobody enrolled in operators, the principal with operator_id stays attributed.
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), logged, terminalConfig()))
      .toEqual({ operator_id: 'miguel@elenxos.com', attributed: true });
  });

  it('el header proxy solo cuenta desde el canal console', () => {
    const config = terminalConfig({ operators: new Set(['steven']) });
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), consolePrincipal(), config))
      .toEqual({ operator_id: 'steven', attributed: true });
    expect(resolveOperator(
      request({ 'x-cauce-operator': 'steven' }), consolePrincipal({ channel: 'adapter' }), config
    )).toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
  });

  it('el header proxy solo atribuye cuando el valor está matriculado', () => {
    const config = terminalConfig({ operators: new Set(['steven', 'miguel']) });
    expect(resolveOperator(request({ 'x-cauce-operator': 'intruder' }), consolePrincipal(), config))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
    expect(resolveOperator(request(), consolePrincipal(), config))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
  });

  it('sin operator_id en el principal y sin nadie matriculado, nadie es atribuido', () => {
    const config = terminalConfig();
    expect(resolveOperator(request({ 'x-cauce-operator': 'steven' }), consolePrincipal(), config))
      .toEqual({ operator_id: UNATTRIBUTED_OPERATOR, attributed: false });
  });
});

describe('attributionAllows: invariante HARD', () => {
  it('sin atribuir solo se permite targetear el propio tenant', () => {
    expect(attributionAllows(false, 'Steven', 'Steven')).toBe(true);
    for (const tenant of ['Miguel', 'Pablo', 'Isa', 'Jhon']) {
      expect(attributionAllows(false, 'Steven', tenant)).toBe(false);
    }
  });

  it('con atribución cualquier tenant del fleet es alcanzable', () => {
    for (const tenant of ['Miguel', 'Pablo', 'Isa', 'Jhon']) {
      expect(attributionAllows(true, 'Steven', tenant)).toBe(true);
    }
    expect(attributionAllows(true, 'Steven', 'Steven')).toBe(true);
  });
});
