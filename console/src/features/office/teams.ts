import type { TopologySnapshot } from '../../api/types';
import { seedOf } from './random';
import { hslHex } from './palette';

export interface OfficeTeam { id: string; label: string; hue?: number }

export const NO_TEAM: OfficeTeam = { id: '~sin-grupo', label: 'Sin grupo' };
const PRIMARY_PREFIX = 'grp.';
/** Dots shown next to a name tag before the rest collapse into «+N». */
export const MAX_DOTS = 3;

export interface Membership { team: OfficeTeam; groups: readonly string[] }

interface RosterAgent {
  tenantId: string;
  alias: string;
  roomIds: readonly string[];
  roomMembership: Readonly<Record<string, boolean | undefined>>;
}

/** Hue of a group, stable per id; the reserved «Sin grupo» team is a neutral grey (negative hue). */
export function teamHue(id: string): number {
  return id === NO_TEAM.id ? -1 : seedOf(`team:${id}`) % 360;
}

/** Colour of a team at the given saturation and lightness; greys for «Sin grupo». */
export function teamTone(hue: number, saturation: number, lightness: number): string {
  return hue < 0 ? hslHex(0, 0, lightness) : hslHex(hue, saturation, lightness);
}

const MIN_HUE_GAP = 40;
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Each group's preferred hue comes from its id; one too close to an earlier group's slides on, so neighbours differ. */
export function resolveHues(ids: Iterable<string>): Map<string, number> {
  const hues = new Map<string, number>();
  const taken: number[] = [];
  for (const id of [...ids].sort()) {
    let hue = teamHue(id);
    for (let tries = 0; tries < 9 && taken.some((other) => apart(hue, other) < MIN_HUE_GAP); tries += 1) hue = (hue + MIN_HUE_GAP) % 360;
    taken.push(hue);
    hues.set(id, hue);
  }
  return hues;
}

export interface GroupDirectory {
  order: ReadonlyMap<string, number>;
  labels: ReadonlyMap<string, string>;
  hues: ReadonlyMap<string, number>;
}

/** Room ids in topology order, with their display labels and colours. */
export function groupDirectory(topology: TopologySnapshot | undefined): GroupDirectory {
  const order = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const tenant of topology?.tenants ?? []) {
    for (const room of tenant.rooms ?? []) {
      if (!room.id || order.has(room.id)) continue;
      order.set(room.id, order.size);
      const label = room.label?.trim() ?? '';
      labels.set(room.id, label.length > 0 ? label : room.id);
    }
  }
  return { order, labels, hues: resolveHues(order.keys()) };
}

/**
 * The primary group is the first enabled membership in topology order, preferring `grp.*` rooms over
 * operational ones; every other enabled membership is a secondary group.
 */
export function membershipOf(agent: RosterAgent, directory: GroupDirectory): Membership {
  const rank = (id: string) => directory.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const enabled = agent.roomIds
    .filter((id) => agent.roomMembership[id] !== false)
    .sort((a, b) => rank(a) - rank(b));
  const primary = enabled.find((id) => id.startsWith(PRIMARY_PREFIX)) ?? enabled.at(0);
  if (!primary) return { team: NO_TEAM, groups: [] };
  return {
    team: { id: primary, label: directory.labels.get(primary) ?? primary, hue: directory.hues.get(primary) },
    groups: enabled.filter((id) => id !== primary),
  };
}

/** Membership per office key (`tenant/alias`) for the whole roster. */
export function membershipsOf(roster: readonly RosterAgent[], directory: GroupDirectory): Map<string, Membership> {
  return new Map(roster.map((agent) => [`${agent.tenantId}/${agent.alias}`, membershipOf(agent, directory)]));
}

export interface TeamSummary extends OfficeTeam { hue: number; ids: string[] }

/** Teams of the fleet agents (visitors belong to none), in a stable order with «Sin grupo» last. */
export function summarizeTeams(agents: readonly { id: string; team?: OfficeTeam; visitor?: boolean }[]): TeamSummary[] {
  const teams = new Map<string, TeamSummary>();
  for (const agent of agents) {
    if (agent.visitor) continue;
    const team = agent.team ?? NO_TEAM;
    const entry = teams.get(team.id) ?? { id: team.id, label: team.label, hue: team.hue ?? teamHue(team.id), ids: [] };
    entry.ids.push(agent.id);
    teams.set(team.id, entry);
  }
  const rank = (team: TeamSummary) => (team.id === NO_TEAM.id ? 1 : 0);
  return [...teams.values()]
    .map((team) => ({ ...team, ids: team.ids.sort() }))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export function sameTeams(a: readonly TeamSummary[], b: readonly TeamSummary[]): boolean {
  return a.length === b.length && a.every((team, index) => {
    const other = b[index];
    return team.id === other.id && team.label === other.label && team.ids.length === other.ids.length
      && team.ids.every((id, at) => id === other.ids[at]);
  });
}

/** Only real groups get zones; a fleet with nobody in a group keeps the plain office. */
export const hasGroups = (teams: readonly TeamSummary[]): boolean => teams.some((team) => team.id !== NO_TEAM.id);
