import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds, leaseState } from '../../lib';
import { LIVE_STATE_META, type LiveState } from './agent-state';

export { formatDurationSeconds } from '../../lib';

/** Same tone vocabulary already used by <Badge>; no new one is added. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

/**
 * Readable labels for the fleet's work states.
 */
export const WORK_STATE_LABEL: Record<FleetWorkState, string> = {
  idle: 'Libre',
  queued: 'Recibiendo',
  working: 'Trabajando',
  saturated: 'Trabajando',
  stalled: 'Trabado',
};

const WORK_STATE_TONE: Record<FleetWorkState, BadgeTone> = {
  idle: 'offline',
  queued: 'info',
  working: 'running',
  saturated: 'warning',
  stalled: 'danger',
};

/**
 * Labels for activity signals and fleet anomalies.
 */
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

export const FLAG_TONE: Record<FleetActivityFlag, BadgeTone> = {
  saturated: 'warning',
  ack_stalled: 'danger',
  overdue_acks: 'danger',
  lease_expired: 'offline',
  never_connected: 'unknown',
  unregistered: 'unknown',
  queued_without_consumer: 'warning',
  claimed_not_started: 'danger',
};

/**
 * Consolidated live-state mapping for the fleet's agents.
 */
export type EstadosVivos = ReadonlyMap<string, LiveState>;

/** Badge tone per state. Derived from the `tone` of `LIVE_STATE_META`, without inventing any. */
const LIVE_STATE_TONE: Record<LiveState, BadgeTone> = {
  down: 'danger',
  blocked: 'danger',
  delegating: 'info',
  settled: 'unknown',
  receiving: 'info',
  thinking: 'running',
  idle: 'offline',
};

/**
 * The header of the STATE column. With the derived state available, that one wins; without it, it falls
 * back to the server's `work_state`, which already speaks the same vocabulary — a silent `undefined`
 * cannot leave the cell blank.
 */
export function estadoDeFila(
  agent: FleetActivityAgent, estados?: EstadosVivos,
): { label: string; tone: BadgeTone; live?: LiveState } {
  const live = estados?.get(agentKeyOf(agent));
  if (live) return { label: LIVE_STATE_META[live].label, tone: LIVE_STATE_TONE[live], live };
  const state = agent.work_state ?? undefined;
  return {
    label: state ? WORK_STATE_LABEL[state] : 'sin dato',
    tone: state ? WORK_STATE_TONE[state] : 'unknown',
  };
}

/** Translates the row's state into the way it is shouted: `data-urgency` and the highlight in
 *  styles.css. It looks FIRST at the doughboy's state, which is also the one deciding its color. */
export function rowUrgency(
  state: FleetWorkState | null | undefined, live?: LiveState,
): 'critical' | 'warning' | undefined {
  if (live === 'down' || live === 'blocked') return 'critical';
  if (state === 'stalled') return 'critical';
  if (state === 'saturated') return 'warning';
  return undefined;
}

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

/**
 * "No in-flight deliveries" is a known zero, not an unknown: oldest_in_flight_seconds comes as null
 * exactly when in_flight = 0. It is distinguished explicitly from UNKNOWN with a dash, so the operator
 * is not left wondering "could this not be read, or is there simply nothing to read?".
 */
export function formatInFlightAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  return formatDurationSeconds(seconds);
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
const ORDEN_VIVO: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'settled', 'idle',
];

/** Triage order: the most urgent at the top, so that 71 in-flight deliveries do not go unnoticed
 *  among fifteen alphabetical rows. */
export function sortByUrgency(
  agents: readonly FleetActivityAgent[], estados?: EstadosVivos,
): FleetActivityAgent[] {
  const rango = (agent: FleetActivityAgent): number => {
    const live = estados?.get(agentKeyOf(agent));
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

/** Same visual criterion as FleetPage.agentStateBadge: online/expired/unknown per lease_until,
 *  distinguishing "never had presence" (missing presence) from "presence with unreadable epoch/expiry". */
export function presenceBadge(agent: FleetActivityAgent): { tone: BadgeTone; label: string } {
  const state = leaseState(agent.presence?.lease_until);
  if (state === 'online') return { tone: 'online', label: 'Conectado' };
  if (state === 'expired') return { tone: 'offline', label: 'Caído' };
  return { tone: 'unknown', label: agent.presence ? 'Sin dato' : 'Nunca conectó' };
}

export function agentRowKey(agent: FleetActivityAgent): string {
  return `${agent.tenant_id}:${agent.alias}`;
}

/**
 * Agent identification key (`tenant/alias`) used in the hypergraph and activity.
 */
export function agentKeyOf(agent: FleetActivityAgent): string {
  return `${agent.tenant_id}/${agent.alias}`;
}

export function agentDisplayName(agent: FleetActivityAgent): string {
  return agent.display_name ?? agent.alias;
}

/** started moved further than leased/accepted; soft nuance, not a single alarm on its own. */
export function inFlightItemTone(status: string | null | undefined): BadgeTone {
  if (status === 'started') return 'running';
  if (status === 'leased' || status === 'accepted') return 'info';
  return 'unknown';
}

/* ============================================================================================ *
 * Per-row signal summary: deduplication of signals visible in the table.
 * ============================================================================================ */

interface SenalPintada {
  clave: string;
  label: string;
  tone: BadgeTone;
}

interface ResumenDeSenales {
  /** The headline of the cell. Always exactly one. */
  estado: SenalPintada;
  /** The signals that ADD something to the headline. At most `TOPE_DE_SENALES`. */
  senales: SenalPintada[];
  /** How many were left out of the box because of the cap. 0 when they all fit. */
  ocultas: number;
  /** Full detail of measured signals for the tooltip. */
  detalle: string;
}

/**
 * What the "Presence" column of the same row is already saying. Passed in to avoid repeating it.
 * `sin-presencia` means "not known / not being shown", and then nothing is deduplicated.
 */
type PresenciaDeLaFila = 'conectado' | 'caido' | 'nunca' | 'sin-presencia';

/** Translates the presence badge already painted into the deduplication vocabulary. */
export function presenciaDeLaFila(agent: FleetActivityAgent): PresenciaDeLaFila {
  const estado = leaseState(agent.presence?.lease_until);
  if (estado === 'online') return 'conectado';
  if (estado === 'expired') return 'caido';
  return agent.presence ? 'sin-presencia' : 'nunca';
}

/** How many signals fit next to the state before folding into a "+N". */
const TOPE_DE_SENALES = 2;

/**
 * Decides which signals are omitted because they are already implicit in the main state or presence.
 */
function implicadas(
  state: FleetWorkState | undefined,
  flags: readonly FleetActivityFlag[],
  presencia: PresenciaDeLaFila,
): Set<FleetActivityFlag> {
  const fuera = new Set<FleetActivityFlag>();
  if (presencia === 'caido') fuera.add('lease_expired');
  if (presencia === 'nunca') { fuera.add('never_connected'); fuera.add('lease_expired'); }
  if (state === 'stalled') { fuera.add('ack_stalled'); fuera.add('overdue_acks'); }
  if (state === 'saturated') fuera.add('saturated');
  if (flags.includes('never_connected')) fuera.add('lease_expired');
  if (flags.includes('lease_expired') || flags.includes('never_connected')) fuera.add('queued_without_consumer');
  if (state !== 'stalled' && flags.includes('overdue_acks') && flags.includes('ack_stalled')) fuera.add('ack_stalled');
  return fuera;
}

/**
 * What is painted in the "State" cell of a row: a headline and, at most, two signals that add
 * something. The rest folds into "+N" and the `title=` says it all.
 */
export function resumirSenales(
  state: FleetWorkState | null | undefined,
  flags: readonly FleetActivityFlag[] | null | undefined,
  presencia: PresenciaDeLaFila = 'sin-presencia',
  titular?: SenalPintada,
): ResumenDeSenales {
  const estadoValido = state ?? undefined;
  const activas = (flags ?? []).filter((flag) => Object.hasOwn(FLAG_LABEL, flag));

  const estado: SenalPintada = titular
    ?? (estadoValido
      ? { clave: estadoValido, label: WORK_STATE_LABEL[estadoValido], tone: WORK_STATE_TONE[estadoValido] }
      : { clave: 'sin-estado', label: 'Sin dato de estado', tone: 'unknown' });

  const fuera = implicadas(estadoValido, activas, presencia);
  // Keep the 'saturated' signal if the headline does not spell it out.
  if (estado.label !== FLAG_LABEL.saturated) fuera.delete('saturated');

  const visibles = activas
    .filter((flag) => !fuera.has(flag))
    // And what the headline already says in those same words is not repeated next to it either.
    .filter((flag) => FLAG_LABEL[flag] !== estado.label)
    .map((flag): SenalPintada => ({ clave: flag, label: FLAG_LABEL[flag], tone: FLAG_TONE[flag] }));

  const partes = [
    `Estado del servidor: ${estado.label}.`,
    activas.length
      ? `Señales medidas: ${activas.map((flag) => FLAG_LABEL[flag]).join(', ')}.`
      : 'Sin ninguna señal activa.',
  ];

  return {
    estado,
    senales: visibles.slice(0, TOPE_DE_SENALES),
    ocultas: Math.max(0, visibles.length - TOPE_DE_SENALES),
    detalle: partes.join(' '),
  };
}
