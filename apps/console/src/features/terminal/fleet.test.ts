import type { TerminalTarget } from './api';
import {
  buildFleetAgents,
  countLiveTuiTargets,
  countOnlinePtyTargets,
  fleetTerminalChip,
  resolveLiveTui,
  resolveTerminalTarget,
  terminalTargetForAgent,
  terminalTargetMatchesAgent,
  filterFleetAgents,
} from './fleet';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'claw', runtime_user: 'claw', harness: 'claude-code', shares_container_with: [],
    modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true, reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

it('builds the fleet from server topology and merges authoritative lease observations', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const agents = buildFleetAgents({
    presence: [
      { tenant_id: 'Steven', alias: 'kant', epoch: 7, lease_expires_at: future, capabilities: ['messages'] },
      { tenant_id: 'Isa', alias: 'salva', epoch: 2, lease_expires_at: null },
    ],
  }, {
    tenants: [
      { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'kant', enabled: true }, { alias: 'argos', enabled: true }] }] },
      { id: 'Isa', rooms: [{ id: 'grp.isa', members: [{ alias: 'salva', enabled: true }] }] },
    ],
  });

  expect(agents).toHaveLength(3);
  expect(agents.find((agent) => agent.alias === 'kant')).toMatchObject({
    tenantId: 'Steven', roomIds: ['grp.steven'], leaseState: 'online', membershipEnabled: true,
  });
  expect(agents.find((agent) => agent.alias === 'argos')?.leaseState).toBe('unknown');
  expect(filterFleetAgents(agents, { tenantId: 'Steven', roomId: 'grp.steven', query: 'messages' }).map((agent) => agent.alias)).toEqual(['kant']);
});

it('does not resurrect an explicitly unregistered membership from a stale presence lease', () => {
  const agents = buildFleetAgents({
    presence: [
      { tenant_id: 'Steven', alias: 'system-principal' },
      { tenant_id: 'Miguel', alias: 'system-principal' },
      { tenant_id: 'Steven', alias: 'legacy-agent' },
    ],
  }, {
    tenants: [
      {
        id: 'Steven',
        rooms: [{ id: 'grp.steven', members: [
          { alias: 'system-principal', enabled: true, registered: false },
          // Missing field is a legacy gateway and remains backward compatible.
          { alias: 'legacy-agent', enabled: true },
        ] }],
      },
    ],
  });

  expect(agents.map((agent) => agent.id)).toEqual(['Miguel:system-principal', 'Steven:legacy-agent']);
});

it('fails closed when a PTY target is not an exact agent identity', () => {
  const [agent] = buildFleetAgents({ presence: [{ tenant_id: 'Steven', alias: 'kant' }] });
  expect(terminalTargetMatchesAgent('Steven:kant', agent)).toBe(true);
  expect(terminalTargetMatchesAgent('kant', agent)).toBe(false);
  expect(terminalTargetMatchesAgent('shell for kant', agent)).toBe(false);
  expect(terminalTargetMatchesAgent(7, agent)).toBe(false);
  expect(terminalTargetMatchesAgent(undefined, agent)).toBe(false);
});

it('resolves PTY authority per destination from the server inventory', () => {
  const agents = buildFleetAgents({ presence: [
    { tenant_id: 'Steven', alias: 'jarvis' },
    { tenant_id: 'Steven', alias: 'argos' },
    { tenant_id: 'Isa', alias: 'salva' },
    { tenant_id: 'Pablo', alias: 'midas' },
    { tenant_id: 'Jhon', alias: 'hegel' },
  ] });
  const find = (alias: string) => agents.find((agent) => agent.alias === alias)!;
  const targets = [
    target({ tenant_id: 'Steven', alias: 'jarvis' }),
    target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', reason: 'El agente PTY no está instalado en ctrl-infra.' }),
    target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' }),
    target({ tenant_id: 'Pablo', alias: 'midas', pty_state: 'agent_offline', last_seen: '2026-07-24T10:00:00.000Z', reason: 'El agente no está conectado.' }),
  ];

  expect(resolveTerminalTarget(targets, find('jarvis'))).toMatchObject({ status: 'allowed' });
  expect(resolveTerminalTarget(targets, find('argos'))).toMatchObject({ status: 'not_installed' });
  // Denial wins over any state: an unauthorised destination is never shown as merely offline.
  expect(resolveTerminalTarget(targets, find('salva'))).toMatchObject({ status: 'denied', reason: expect.stringContaining('attribution_required') });
  expect(resolveTerminalTarget(targets, find('midas')).reason).toContain('2026-07-24T10:00:00.000Z');
  // An alias the server never mentioned is UNKNOWN, not implicitly denied nor implicitly allowed.
  expect(resolveTerminalTarget(targets, find('hegel'))).toMatchObject({ status: 'unknown' });
  expect(countOnlinePtyTargets(targets)).toBe(1);
});

it.each([
  ['not_installed', 'not_installed', 'ok', /no instalado/iu, 'Agente PTY no instalado'],
  ['agent_offline', 'offline', ' OK ', /fuera de línea/iu, 'Agente PTY offline'],
  ['unknown', 'unknown', 'Ok', /desconocido/iu, 'PTY desconocido'],
] as const)(
  'replaces a legacy ok placeholder for authorized %s with a state-specific UI reason',
  (ptyState, status, reportedReason, expectedReason, label) => {
    const [agent] = buildFleetAgents({ presence: [{ tenant_id: 'Steven', alias: 'jarvis' }] });
    const targets = [target({
      tenant_id: 'Steven', alias: 'jarvis', pty_state: ptyState, reason: reportedReason,
    })];
    const resolution = resolveTerminalTarget(targets, agent);
    const chip = fleetTerminalChip(targets, agent);

    expect(resolution.status).toBe(status);
    expect(resolution.reason).toMatch(expectedReason);
    expect(resolution.reason).not.toMatch(/\bok\b/iu);
    expect(chip).toMatchObject({ status, label, reason: resolution.reason });
  },
);

it('treats an absent inventory as UNKNOWN and authorises nothing', () => {
  const [agent] = buildFleetAgents({ presence: [{ tenant_id: 'Steven', alias: 'jarvis' }] });
  expect(resolveTerminalTarget(undefined, agent)).toMatchObject({ status: 'unknown' });
  expect(resolveTerminalTarget(null, agent).reason).toMatch(/no publicó el inventario/i);
  expect(countOnlinePtyTargets(null)).toBeUndefined();
  expect(countOnlinePtyTargets([])).toBe(0);
});

it('matches a target by exact tenant and alias, never by alias alone', () => {
  const agents = buildFleetAgents({ presence: [
    { tenant_id: 'Steven', alias: 'kant' },
    { tenant_id: 'Miguel', alias: 'kant' },
  ] });
  const targets = [target({ tenant_id: 'Miguel', alias: 'kant', container: 'ws-miguel' })];

  expect(terminalTargetForAgent(targets, agents.find((agent) => agent.tenantId === 'Miguel')!)?.container).toBe('ws-miguel');
  expect(terminalTargetForAgent(targets, agents.find((agent) => agent.tenantId === 'Steven')!)).toBeUndefined();
  expect(resolveTerminalTarget(targets, agents.find((agent) => agent.tenantId === 'Steven')!).status).toBe('unknown');
});

it('never resolves a duplicated alias without its tenant', () => {
  const agents = buildFleetAgents({ presence: [
    { tenant_id: 'Steven', alias: 'operator' },
    { tenant_id: 'Miguel', alias: 'operator' },
  ] });
  expect(agents.every((agent) => !terminalTargetMatchesAgent('operator', agent))).toBe(true);
  expect(terminalTargetMatchesAgent('Miguel:operator', agents.find((agent) => agent.tenantId === 'Miguel')!)).toBe(true);
});

it('keeps tenants that differ only by case as distinct identities', () => {
  const agents = buildFleetAgents({ presence: [
    { tenant_id: 'Steven', alias: 'operator' },
    { tenant_id: 'steven', alias: 'operator' },
  ] });
  const upper = agents.find((agent) => agent.tenantId === 'Steven')!;
  const lower = agents.find((agent) => agent.tenantId === 'steven')!;
  const targets = [target({ tenant_id: 'steven', alias: 'operator', container: 'lower-tenant' })];

  expect(new Set(agents.map((agent) => agent.id))).toEqual(new Set(['Steven:operator', 'steven:operator']));
  expect(terminalTargetForAgent(targets, upper)).toBeUndefined();
  expect(terminalTargetForAgent(targets, lower)?.container).toBe('lower-tenant');
  expect(terminalTargetMatchesAgent('steven:operator', upper)).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* TUI en vivo                                                                */
/* -------------------------------------------------------------------------- */

const zeus = { id: 'Steven:zeus', tenantId: 'Steven', alias: 'zeus', roomIds: [], roomMembership: {}, leaseState: 'online' as const };

it('sólo declara TUI en vivo cuando el servidor publica el modo harness', () => {
  expect(resolveLiveTui([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })], zeus))
    .toMatchObject({ status: 'available' });

  // CONTROL NEGATIVO: mismo destino, autorizado y online, pero sin el modo. No hay TUI.
  const sinTui = resolveLiveTui([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell'] })], zeus);
  expect(sinTui.status).toBe('no_tui');
  expect(sinTui.reason).toMatch(/no publica el modo harness/i);
  expect(sinTui.reason).toMatch(/Modos publicados: shell/);
});

it('propaga el motivo del destino cuando la puerta se cierra antes de llegar al modo', () => {
  expect(resolveLiveTui(null, zeus)).toMatchObject({ status: 'unknown' });
  expect(resolveLiveTui([], zeus)).toMatchObject({ status: 'unknown' });
  expect(resolveLiveTui([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['harness'], authorized: false, reason: 'no_grant' })], zeus))
    .toMatchObject({ status: 'blocked', reason: 'no_grant' });
  expect(resolveLiveTui([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['harness'], pty_state: 'agent_offline', reason: 'sin agente.' })], zeus).status)
    .toBe('blocked');
});

it('cuenta sólo los destinos que pueden emitir la TUI viva', () => {
  expect(countLiveTuiTargets(null)).toBeUndefined();
  expect(countLiveTuiTargets([
    target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'kant', modes: ['shell'] }),
    target({ tenant_id: 'Steven', alias: 'argos', modes: ['shell', 'harness'], pty_state: 'agent_offline' }),
    target({ tenant_id: 'Isa', alias: 'salva', modes: ['harness'], authorized: false }),
  ])).toBe(1);
});
