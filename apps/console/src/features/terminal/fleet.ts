import type { AdapterView, PresenceLease, SystemStatus, TopologySnapshot } from '../../api/types';
import { leaseExpiry, leaseState, type LeaseState } from '../../lib';

export interface FleetAgent {
  id: string;
  tenantId: string;
  alias: string;
  roomIds: string[];
  roomMembership: Record<string, boolean | undefined>;
  membershipEnabled?: boolean;
  presence?: PresenceLease;
  leaseState: LeaseState;
}

export interface FleetFilters {
  tenantId: string;
  roomId: string;
  query: string;
}

interface MutableFleetAgent {
  tenantId: string;
  alias: string;
  roomIds: Set<string>;
  roomMembership: Map<string, boolean | undefined>;
  membershipStates: boolean[];
  presence?: PresenceLease;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function fleetAgentId(tenantId: string, alias: string): string {
  return `${normalized(tenantId)}:${normalized(alias)}`;
}

/** Combines server topology and observed leases without inventing fleet members. */
export function buildFleetAgents(status?: SystemStatus, topology?: TopologySnapshot): FleetAgent[] {
  const records = new Map<string, MutableFleetAgent>();

  for (const tenant of topology?.tenants ?? []) {
    if (!tenant.id) continue;
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) {
        if (!member.alias) continue;
        const id = fleetAgentId(tenant.id, member.alias);
        const record = records.get(id) ?? {
          tenantId: tenant.id,
          alias: member.alias,
          roomIds: new Set<string>(),
          roomMembership: new Map<string, boolean | undefined>(),
          membershipStates: [],
        };
        if (room.id) {
          record.roomIds.add(room.id);
          record.roomMembership.set(room.id, member.enabled ?? record.roomMembership.get(room.id));
        }
        if (typeof member.enabled === 'boolean') record.membershipStates.push(member.enabled);
        records.set(id, record);
      }
    }
  }

  for (const presence of status?.presence ?? []) {
    if (!presence.tenant_id || !presence.alias) continue;
    const id = fleetAgentId(presence.tenant_id, presence.alias);
    const record = records.get(id) ?? {
      tenantId: presence.tenant_id,
      alias: presence.alias,
      roomIds: new Set<string>(),
      roomMembership: new Map<string, boolean | undefined>(),
      membershipStates: [],
    };
    record.presence = presence;
    records.set(id, record);
  }

  return [...records.entries()]
    .map(([id, record]) => ({
      id,
      tenantId: record.tenantId,
      alias: record.alias,
      roomIds: [...record.roomIds].sort((left, right) => left.localeCompare(right)),
      roomMembership: Object.fromEntries(record.roomMembership),
      membershipEnabled: record.membershipStates.length
        ? record.membershipStates.some(Boolean)
        : undefined,
      presence: record.presence,
      leaseState: leaseState(leaseExpiry(record.presence ?? {})),
    }))
    .sort((left, right) => {
      const stateRank = { online: 0, unknown: 1, expired: 2 };
      return stateRank[left.leaseState] - stateRank[right.leaseState]
        || left.tenantId.localeCompare(right.tenantId)
        || left.alias.localeCompare(right.alias);
    });
}

export function filterFleetAgents(agents: FleetAgent[], filters: FleetFilters): FleetAgent[] {
  const query = normalized(filters.query);
  return agents.filter((agent) => {
    if (filters.tenantId !== 'all' && agent.tenantId !== filters.tenantId) return false;
    if (filters.roomId !== 'all' && !agent.roomIds.includes(filters.roomId)) return false;
    if (!query) return true;
    return [agent.alias, agent.tenantId, ...agent.roomIds, ...(agent.presence?.capabilities ?? [])]
      .some((value) => normalized(value).includes(query));
  });
}

export function adapterSummary(adapters: AdapterView[]): { healthy: number; total: number } {
  return {
    healthy: adapters.filter((adapter) => adapter.state === 'available').length,
    total: adapters.length,
  };
}

export function terminalTargetMatchesAgent(targetLabel: unknown, agent: FleetAgent): boolean {
  if (typeof targetLabel !== 'string' || !targetLabel.trim()) return false;
  const target = normalized(targetLabel);
  return target === normalized(`${agent.tenantId}:${agent.alias}`)
    || target === normalized(agent.id);
}
