import type { AdapterView, PresenceLease, SystemStatus, TopologySnapshot } from '../../api/types';
import { leaseExpiry, leaseState, type LeaseState } from '../../lib';
import type { TerminalTarget } from './api';

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

interface FleetFilters {
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
  // Identity keys preserve canonical wire values case-sensitively.
  return `${tenantId}:${alias}`;
}

/** Combines server topology and observed leases without inventing fleet members. */
export function buildFleetAgents(status?: SystemStatus, topology?: TopologySnapshot): FleetAgent[] {
  const records = new Map<string, MutableFleetAgent>();
  // A stale presence lease must not resurrect a membership the canonical registry explicitly
  // says is not an agent. The identity is tenant-qualified: aliases may repeat across tenants.
  const explicitlyNotAgents = new Set<string>();

  for (const tenant of topology?.tenants ?? []) {
    if (!tenant.id) continue;
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) {
        if (!member.alias) continue;
        const id = fleetAgentId(tenant.id, member.alias);
        if (member.registered === false) {
          explicitlyNotAgents.add(id);
          records.delete(id);
          continue;
        }
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
    if (explicitlyNotAgents.has(id)) continue;
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

export function filterFleetAgents<T extends FleetAgent>(agents: readonly T[], filters: FleetFilters): T[] {
  const query = normalized(filters.query);
  return agents.filter((agent) => {
    if (filters.tenantId !== 'all' && agent.tenantId !== filters.tenantId) return false;
    if (filters.roomId !== 'all' && !agent.roomIds.includes(filters.roomId)) return false;
    if (!query) return true;
    return [agent.alias, agent.tenantId, ...agent.roomIds, ...(agent.presence?.capabilities ?? [])]
      .some((value) => normalized(value).includes(query));
  });
}

/**
 * Breakdown of adapters available, failing, or unreported,
 * avoiding interpreting unreported states as confirmed failures.
 */
interface AdapterBreakdown {
  disponibles: number;
  /** `degraded` + `unavailable`: the server DID report, and reported a problem. */
  conFallo: number;
  /** `unknown`, absent or malformed: no data, which is not the same as a failure. */
  sinReportar: number;
  total: number;
}

export function adapterBreakdown(adapters: AdapterView[]): AdapterBreakdown {
  const disponibles = adapters.filter((adapter) => adapter.state === 'available').length;
  const conFallo = adapters.filter((adapter) => adapter.state === 'degraded' || adapter.state === 'unavailable').length;
  return { disponibles, conFallo, sinReportar: adapters.length - disponibles - conFallo, total: adapters.length };
}

/** Counter text: counts each group by name and doesn't invent a fraction. */
export function adapterBreakdownText(adapters: AdapterView[]): string {
  const { disponibles, conFallo, sinReportar, total } = adapterBreakdown(adapters);
  if (total === 0) return 'UNKNOWN';
  return [
    `${String(disponibles)} disponibles`,
    conFallo ? `${String(conFallo)} con fallo` : undefined,
    sinReportar ? `${String(sinReportar)} sin reportar` : undefined,
  ].filter(Boolean).join(' · ');
}

/** Explicit PTY states. There is no implicit "available": absent data is UNKNOWN. */
export type TerminalAccessStatus = 'allowed' | 'denied' | 'offline' | 'not_installed' | 'unknown';

export interface TerminalTargetResolution {
  status: TerminalAccessStatus;
  /** Always populated: every disabled control must be able to say why. */
  reason: string;
  target?: TerminalTarget;
}

export const TERMINAL_ACCESS_LABELS: Readonly<Record<TerminalAccessStatus, string>> = {
  allowed: 'PTY online',
  denied: 'Sin autoridad',
  offline: 'Agente PTY offline',
  not_installed: 'Agente PTY no instalado',
  unknown: 'PTY desconocido',
};

/** Resolves a destination by exact tenant:alias identity; a bare alias never matches. */
export function terminalTargetForAgent(targets: TerminalTarget[] | null | undefined, agent: FleetAgent): TerminalTarget | undefined {
  return (targets ?? []).find((target) => fleetAgentId(target.tenant_id, target.alias) === agent.id);
}

/**
 * Per-destination gate. The server's `authorized` flag is the authority; the client only
 * translates it, and every path that is not an explicit allow stays closed with its motive.
 */
export function resolveTerminalTarget(targets: TerminalTarget[] | null | undefined, agent: FleetAgent): TerminalTargetResolution {
  if (!targets) {
    return { status: 'unknown', reason: 'El gateway no publicó el inventario de destinos PTY, así que no se sabe si este alias tiene canal. No se asume que sí.' };
  }
  const target = terminalTargetForAgent(targets, agent);
  if (!target) {
    return { status: 'unknown', reason: `El servidor no declaró un target PTY para ${agent.tenantId}:${agent.alias}.` };
  }
  if (!target.authorized) return { status: 'denied', reason: target.reason, target };
  // Rolling upgrades can briefly pair a new console with an old gateway which used `ok` for
  // every authorized row, even when its measured PTY state was unusable. Never surface that
  // authority placeholder as the explanation on a disabled control.
  const placeholderReason = target.reason.trim().length === 0 || /^\s*ok\.?\s*$/iu.test(target.reason);
  if (target.pty_state === 'not_installed') {
    return {
      status: 'not_installed',
      reason: placeholderReason
        ? 'El agente PTY figura como no instalado: el terminal-relay nunca registró este destino.'
        : target.reason,
      target,
    };
  }
  if (target.pty_state === 'agent_offline') {
    return {
      status: 'offline',
      reason: `${placeholderReason
        ? 'El agente PTY figura fuera de línea: no está conectado al terminal-relay.'
        : target.reason} Última presencia: ${target.last_seen ?? 'nunca se registró una'}.`,
      target,
    };
  }
  if (target.pty_state === 'online') return { status: 'allowed', reason: target.reason, target };
  if (placeholderReason) {
    return {
      status: 'unknown',
      reason: 'El estado del agente PTY es desconocido: el terminal-relay no publicó una medición verificable.',
      target,
    };
  }
  return { status: 'unknown', reason: `No se pudo determinar el estado del agente PTY de ${agent.alias}. ${target.reason}`, target };
}

/** How many destinations the server reports as reachable. UNKNOWN inventory stays UNKNOWN. */
export function countOnlinePtyTargets(targets: TerminalTarget[] | null | undefined): number | undefined {
  return targets ? targets.filter((target) => target.authorized && target.pty_state === 'online').length : undefined;
}

/* -------------------------------------------------------------------------- */
/* Live TUI                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The PTY agent's `harness` mode connects to the agent's active TUI (tmux session).
 * If HARNESS_COMMAND is not set or there is no grant, it degrades to shell mode.
 */
export const LIVE_TUI_MODE = 'harness';

/** New shell mode. Writes: still requires a hand-written reason. */
export const SHELL_MODE = 'shell';

export type LiveTuiStatus = 'available' | 'no_tui' | 'blocked' | 'unknown';

interface LiveTuiResolution {
  status: LiveTuiStatus;
  /** Always populated: a grey button without a reason is the same as saying nothing. */
  reason: string;
  target?: TerminalTarget;
}

export const LIVE_TUI_LABELS: Readonly<Record<LiveTuiStatus, string>> = {
  available: 'TUI en vivo',
  no_tui: 'Sin TUI que emitir',
  blocked: 'TUI bloqueada',
  unknown: 'TUI desconocida',
};

/**
 * Can this alias emit its TUI? It leans on the same per-destination authority as the rest of the
 * PTY plane and adds just one question: did the server publish the `harness` mode for it?
 */
export function resolveLiveTui(targets: TerminalTarget[] | null | undefined, agent: FleetAgent): LiveTuiResolution {
  const base = resolveTerminalTarget(targets, agent);
  if (base.status !== 'allowed') {
    return {
      status: base.status === 'unknown' ? 'unknown' : 'blocked',
      reason: base.reason,
      ...(base.target ? { target: base.target } : {}),
    };
  }
  const target = base.target;
  if (!target) return { status: 'unknown', reason: base.reason };
  if (target.modes.includes(LIVE_TUI_MODE)) {
    return { status: 'available', reason: 'El servidor publica el modo harness: hay TUI en vivo para este alias.', target };
  }
  return {
    status: 'no_tui',
    reason: `El agente PTY de ${agent.alias} no publica el modo ${LIVE_TUI_MODE}: no hay TUI que emitir, sólo shell nueva. Modos publicados: ${target.modes.length ? target.modes.join(', ') : 'ninguno'}.`,
    target,
  };
}

/** How many destinations can emit their TUI. Absent inventory remains UNKNOWN. */
export function countLiveTuiTargets(targets: TerminalTarget[] | null | undefined): number | undefined {
  return targets
    ? targets.filter((target) => target.authorized && target.pty_state === 'online' && target.modes.includes(LIVE_TUI_MODE)).length
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* The fleet list chip                                                        */
/* -------------------------------------------------------------------------- */

/**
 * State and visual reason of the terminal chip: indicates whether the destination has live TUI
 * available or degrades to shell/offline mode with its corresponding reason.
 */
interface FleetTerminalChip {
  status: TerminalAccessStatus | 'no_tui';
  label: string;
  /** Always populated: a chip without a reason is exactly the bug this fixes. */
  reason: string;
}

export function fleetTerminalChip(
  targets: TerminalTarget[] | null | undefined,
  agent: FleetAgent,
): FleetTerminalChip {
  const base = resolveTerminalTarget(targets, agent);
  if (base.status !== 'allowed') {
    return { status: base.status, label: TERMINAL_ACCESS_LABELS[base.status], reason: base.reason };
  }
  const live = resolveLiveTui(targets, agent);
  if (live.status === 'available') {
    return { status: 'allowed', label: LIVE_TUI_LABELS.available, reason: live.reason };
  }
  if (live.status === 'no_tui') {
    return { status: 'no_tui', label: LIVE_TUI_LABELS.no_tui, reason: live.reason };
  }
  return { status: 'unknown', label: TERMINAL_ACCESS_LABELS.unknown, reason: live.reason };
}
