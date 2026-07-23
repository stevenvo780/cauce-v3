import { buildFleetAgents, filterFleetAgents, terminalTargetMatchesAgent } from './fleet';

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

it('fails closed when a PTY target is not an exact agent identity', () => {
  const [agent] = buildFleetAgents({ presence: [{ tenant_id: 'Steven', alias: 'kant' }] });
  expect(terminalTargetMatchesAgent('Steven:kant', agent)).toBe(true);
  expect(terminalTargetMatchesAgent('kant', agent)).toBe(false);
  expect(terminalTargetMatchesAgent('shell for kant', agent)).toBe(false);
  expect(terminalTargetMatchesAgent(7, agent)).toBe(false);
  expect(terminalTargetMatchesAgent(undefined, agent)).toBe(false);
});

it('never resolves a duplicated alias without its tenant', () => {
  const agents = buildFleetAgents({ presence: [
    { tenant_id: 'Steven', alias: 'operator' },
    { tenant_id: 'Miguel', alias: 'operator' },
  ] });
  expect(agents.every((agent) => !terminalTargetMatchesAgent('operator', agent))).toBe(true);
  expect(terminalTargetMatchesAgent('Miguel:operator', agents.find((agent) => agent.tenantId === 'Miguel')!)).toBe(true);
});
