import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds } from '../../lib';
import { agentKey, type LiveState } from './agent-state';

export { formatDurationSeconds } from '../../lib';

/** Same tone vocabulary already used by <Badge>; no new one is added. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

export const WORK_STATE_LABEL: Record<FleetWorkState, string> = {
  idle: 'Libre',
  queued: 'Recibiendo',
  working: 'Trabajando',
  saturated: 'Trabajando',
  stalled: 'Trabado',
};

export const FLAG_LABEL: Record<FleetActivityFlag, string> = {
  saturated: 'Saturado',
  ack_stalled: 'Sin ACK',
  overdue_acks: 'ACK vencido',
  lease_expired: 'Caído',
  never_connected: 'Nunca conectó',
  unregistered: 'Fuera del registro',
  queued_without_consumer: 'Cola sin quien la consuma',
  claimed_not_started: 'Tomó y no empezó',
};

export type EstadosVivos = ReadonlyMap<string, LiveState>;

/**
 * seconds_since_last_ack at null is NOT "just acked": it is "no ACK applied within the server's search
 * window (ack_lookback_seconds)", the most serious signal that exists on this panel. Returning "0" or
 * "-" here would paint healthy exactly the agent that motivated this panel. For that reason the result
 * always carries the word "ACK" and is never a bare number when it is null.
 */
export function formatAckAge(secondsSinceLastAck: number | null | undefined, ackLookbackSeconds: number | null | undefined): string {
  if (secondsSinceLastAck === null || secondsSinceLastAck === undefined) {
    return ackLookbackSeconds !== null && ackLookbackSeconds !== undefined
      ? `> ${formatDurationSeconds(ackLookbackSeconds)} sin ACK`
      : 'ningún ACK, y el servidor no dice desde cuándo';
  }
  return `hace ${formatDurationSeconds(secondsSinceLastAck)}`;
}

const STATE_RANK: Record<FleetWorkState, number> = {
  stalled: 0,
  saturated: 1,
  working: 2,
  queued: 3,
  idle: 4,
};

/**
 * Absence or unrecognized value of work_state is sorted FIRST, not last: it is the same "fail visibly"
 * principle as the rest of the contract. A server that stopped sending the field must not hide the
 * agent behind the ones that do report it.
 */
function stateRank(state: FleetWorkState | null | undefined): number {
  if (state && state in STATE_RANK) return STATE_RANK[state];
  return -1;
}

/**
 * The order of the chips on the strip, from left to right. The table sorts by the SAME thing: if the
 * strip says the first thing to look at is the fallen ones and the list below puts them somewhere in the
 * middle, the "sorted by urgency" subtitle stops being true.
 */
export const ORDEN_VIVO: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'settled', 'idle',
];

/** Triage order: the most urgent at the top, so that 71 in-flight deliveries do not go unnoticed
 *  among fifteen alphabetical rows. */
export function sortByUrgency(
  agents: readonly FleetActivityAgent[], estados?: EstadosVivos,
): FleetActivityAgent[] {
  const rango = (agent: FleetActivityAgent): number => {
    const live = estados?.get(agentKey(agent));
    // Without a derived state, it is sorted by the server's, shifted so the scales do not cross.
    if (!live) return estados ? -1 : stateRank(agent.work_state);
    return ORDEN_VIVO.indexOf(live);
  };
  return [...agents].sort((left, right) => {
    const rankDiff = rango(left) - rango(right);
    if (rankDiff !== 0) return rankDiff;
    const inFlightDiff = (right.in_flight ?? 0) - (left.in_flight ?? 0);
    if (inFlightDiff !== 0) return inFlightDiff;
    return `${left.tenant_id}:${left.alias}`.localeCompare(`${right.tenant_id}:${right.alias}`);
  });
}
