import type { FleetActivityAgent, FleetActivitySnapshot, TopologySnapshot } from '../../api/types';

const pendingStates = new Set(['working', 'queued', 'stalled', 'saturated']);
const pendingFlags = new Set(['ack_stalled', 'overdue_acks', 'queued_without_consumer', 'claimed_not_started', 'saturated']);
const keyOf = (agent: { tenant_id: string; alias: string }) => `${agent.tenant_id}/${agent.alias}`;

export function hasPendingWork(agent: FleetActivityAgent): boolean {
  return [agent.in_flight, agent.started, agent.claimed_not_started, agent.queued,
    agent.queued_ready, agent.retrying, agent.overdue_in_flight].some((value) => typeof value === 'number' && value > 0)
    || (agent.in_flight_items?.length ?? 0) > 0
    || pendingStates.has(agent.work_state ?? '')
    || (agent.flags ?? []).some((flag) => pendingFlags.has(flag));
}

/** Keep the original snapshot available for sender attribution and historical identity. */
export function projectLiveFleet(snapshot: FleetActivitySnapshot | undefined, topology: TopologySnapshot | undefined) {
  if (!snapshot?.agents) return { snapshot, topology };
  const pending = new Set(snapshot.agents.filter(hasPendingWork).map(keyOf));
  for (const agent of snapshot.agents) {
    for (const item of agent.in_flight_items ?? []) {
      if (item.from_tenant && item.from_alias) pending.add(`${item.from_tenant}/${item.from_alias}`);
    }
  }
  for (const edge of snapshot.edges ?? []) {
    if (typeof edge.in_flight !== 'number' || edge.in_flight <= 0) continue;
    if (edge.from_tenant && edge.from_alias) pending.add(`${edge.from_tenant}/${edge.from_alias}`);
    if (edge.to_tenant && edge.to_alias) pending.add(`${edge.to_tenant}/${edge.to_alias}`);
  }
  const hidden = new Set(snapshot.agents.filter((agent) =>
    (agent.agent_enabled === false || agent.registered === false) && !pending.has(keyOf(agent))).map(keyOf));
  const known = new Set(snapshot.agents.map(keyOf));
  const agents = snapshot.agents.filter((agent) => !hidden.has(keyOf(agent)));
  const totals = snapshot.totals;
  const projectedSnapshot = agents.length === snapshot.agents.length ? snapshot : {
    ...snapshot,
    agents,
    totals: totals ? {
      ...totals,
      ...(typeof totals.agents === 'number' ? { agents: agents.length } : {}),
      ...(totals.by_state ? { by_state: Object.fromEntries(Object.entries(totals.by_state).map(([state, count]) =>
        [state, typeof count === 'number' ? agents.filter((agent) => agent.work_state === state).length : count])) } : {}),
      ...(totals.flagged ? { flagged: Object.fromEntries(Object.entries(totals.flagged).map(([flag, count]) =>
        [flag, typeof count === 'number' ? agents.filter((agent) => (agent.flags ?? []).some((value) => value === flag)).length : count])) } : {}),
    } : totals,
  };
  const projectedTopology = topology ? {
    ...topology,
    tenants: topology.tenants?.map((tenant) => ({
      ...tenant,
      rooms: tenant.rooms?.map((room) => ({
        ...room,
        members: room.members?.filter((member) => {
          const key = `${tenant.id ?? ''}/${member.alias ?? ''}`;
          if (hidden.has(key)) return false;
          return known.has(key) || pending.has(key) || (member.agent_enabled !== false && member.registered !== false);
        }),
      })),
    })),
  } : topology;
  return { snapshot: projectedSnapshot, topology: projectedTopology };
}
