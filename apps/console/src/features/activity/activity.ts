import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds, leaseState } from '../../lib';

export { formatDurationSeconds } from '../../lib';

/** Mismo vocabulario de tonos que ya usa <Badge>; no se agrega ninguno nuevo. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

export const WORK_STATE_LABEL: Record<FleetWorkState, string> = {
  idle: 'INACTIVO',
  queued: 'EN COLA',
  working: 'TRABAJANDO',
  saturated: 'SATURADO',
  stalled: 'COLGADO',
};

export const WORK_STATE_TONE: Record<FleetWorkState, BadgeTone> = {
  idle: 'offline',
  queued: 'info',
  working: 'running',
  saturated: 'warning',
  stalled: 'danger',
};

export const FLAG_LABEL: Record<FleetActivityFlag, string> = {
  saturated: 'Saturado',
  ack_stalled: 'ACK detenido',
  overdue_acks: 'ACK vencido',
  lease_expired: 'Lease vencido',
  never_connected: 'Nunca conectado',
  unregistered: 'No registrado',
  queued_without_consumer: 'Cola sin consumidor',
};

export const FLAG_TONE: Record<FleetActivityFlag, BadgeTone> = {
  saturated: 'warning',
  ack_stalled: 'danger',
  overdue_acks: 'danger',
  lease_expired: 'offline',
  never_connected: 'unknown',
  unregistered: 'unknown',
  queued_without_consumer: 'warning',
};

/** Traduce un work_state a la forma en que la fila lo grita: usado como data-attribute y para
 *  aplicar el resaltado visual de "saturado"/"colgado" definido en styles.css. */
export function rowUrgency(state: FleetWorkState | null | undefined): 'critical' | 'warning' | undefined {
  if (state === 'stalled') return 'critical';
  if (state === 'saturated') return 'warning';
  return undefined;
}

/**
 * seconds_since_last_ack en null NO es "recién ackeado": es "ningún ACK aplicado dentro de la
 * ventana de búsqueda del servidor (ack_lookback_seconds)", la señal más grave que existe en este
 * panel. Devolver "0" o "-" acá pintaría de sano justo al agente que motivó este panel. Por eso
 * el resultado siempre lleva la palabra "ACK" y nunca es un número desnudo cuando es null.
 */
export function formatAckAge(secondsSinceLastAck: number | null | undefined, ackLookbackSeconds: number | null | undefined): string {
  if (secondsSinceLastAck === null || secondsSinceLastAck === undefined) {
    return ackLookbackSeconds !== null && ackLookbackSeconds !== undefined
      ? `> ${formatDurationSeconds(ackLookbackSeconds)} sin ACK`
      : 'UNKNOWN (sin ACK)';
  }
  return `hace ${formatDurationSeconds(secondsSinceLastAck)}`;
}

/**
 * "Sin entregas en vuelo" es un cero conocido, no un desconocido: oldest_in_flight_seconds viene
 * null exactamente cuando in_flight = 0. Se distingue explícitamente de UNKNOWN con un guión,
 * para no hacerle preguntar al operador "¿esto no se pudo leer, o no hay nada que leer?".
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
 * Ausencia o valor no reconocido de work_state se ordena PRIMERO, no último: es el mismo
 * principio "fallar visible" del resto del contrato. Un servidor que dejara de mandar el campo
 * no debe esconder al agente detrás de los que sí lo reportan.
 */
function stateRank(state: FleetWorkState | null | undefined): number {
  if (state && state in STATE_RANK) return STATE_RANK[state];
  return -1;
}

/** Orden de triage: lo más urgente arriba, para que 71 entregas en vuelo no pasen inadvertidas
 *  entre quince filas alfabéticas. */
export function sortByUrgency(agents: readonly FleetActivityAgent[]): FleetActivityAgent[] {
  return [...agents].sort((left, right) => {
    const rankDiff = stateRank(left.work_state) - stateRank(right.work_state);
    if (rankDiff !== 0) return rankDiff;
    const inFlightDiff = (right.in_flight ?? 0) - (left.in_flight ?? 0);
    if (inFlightDiff !== 0) return inFlightDiff;
    return `${left.tenant_id}:${left.alias}`.localeCompare(`${right.tenant_id}:${right.alias}`);
  });
}

/** Mismo criterio visual que FleetPage.agentStateBadge: online/expirado/unknown según lease_until,
 *  distinguiendo "nunca hubo presencia" (presence ausente) de "presence con epoch/expiry ilegibles". */
export function presenceBadge(agent: FleetActivityAgent): { tone: BadgeTone; label: string } {
  const state = leaseState(agent.presence?.lease_until);
  if (state === 'online') return { tone: 'online', label: 'ONLINE' };
  if (state === 'expired') return { tone: 'offline', label: 'EXPIRADO' };
  return { tone: 'unknown', label: agent.presence ? 'UNKNOWN' : 'NUNCA CONECTADO' };
}

export function agentRowKey(agent: FleetActivityAgent): string {
  return `${agent.tenant_id}:${agent.alias}`;
}

/**
 * La MISMA clave que usa la sala de máquinas (`tenant/alias`).
 *
 * `agentRowKey` usa dos puntos y es la clave de React de la fila; ésta es la que viaja entre la
 * tabla y el hipergrafo. Se derivan las dos del mismo par a propósito, pero no se mezclan: si la
 * tabla emitiera su clave con dos puntos, el grafo nunca encontraría el nodo y el resaltado
 * fallaría en silencio, que es la clase de fallo que nadie ve hasta que importa.
 */
export function agentKeyOf(agent: FleetActivityAgent): string {
  return `${agent.tenant_id}/${agent.alias}`;
}

export function agentDisplayName(agent: FleetActivityAgent): string {
  return agent.display_name ?? agent.alias;
}

/** started avanzó más que leased/accepted; matiz suave, no una alarma nueva por sí sola. */
export function inFlightItemTone(status: string | null | undefined): BadgeTone {
  if (status === 'started') return 'running';
  if (status === 'leased' || status === 'accepted') return 'info';
  return 'unknown';
}
