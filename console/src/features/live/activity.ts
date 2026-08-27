import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds, leaseState } from '../../lib';
import { LIVE_STATE_META, type LiveState } from './agent-state';

export { formatDurationSeconds } from '../../lib';

/** Mismo vocabulario de tonos que ya usa <Badge>; no se agrega ninguno nuevo. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

/**
 * Etiquetas legibles para los estados de trabajo de la flota.
 */
export const WORK_STATE_LABEL: Record<FleetWorkState, string> = {
  idle: 'Libre',
  queued: 'Recibiendo',
  working: 'Trabajando',
  saturated: 'Trabajando',
  stalled: 'Trabado',
};

export const WORK_STATE_TONE: Record<FleetWorkState, BadgeTone> = {
  idle: 'offline',
  queued: 'info',
  working: 'running',
  saturated: 'warning',
  stalled: 'danger',
};

/**
 * Etiquetas para señales de actividad y anomalías de la flota.
 */
export const FLAG_LABEL: Record<FleetActivityFlag, string> = {
  saturated: 'Saturado',
  ack_stalled: 'Sin ACK',
  overdue_acks: 'ACK vencido',
  lease_expired: 'Caído',
  never_connected: 'Nunca conectó',
  unregistered: 'Fuera del registro',
  queued_without_consumer: 'Cola sin quien la consuma',
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

/**
 * Mapeo de estados vivos consolidados para los agentes de la flota.
 */
export type EstadosVivos = ReadonlyMap<string, LiveState>;

/** Tono de insignia por estado. Deriva del `tone` de `LIVE_STATE_META`, sin inventar ninguno. */
export const LIVE_STATE_TONE: Record<LiveState, BadgeTone> = {
  down: 'danger',
  blocked: 'danger',
  delegating: 'info',
  settled: 'unknown',
  receiving: 'info',
  thinking: 'running',
  idle: 'offline',
};

/**
 * El rótulo de la columna ESTADO. Con el estado derivado disponible manda ése; sin él se cae al
 * `work_state` del servidor, que ya habla el mismo vocabulario — un `undefined` silencioso no
 * puede dejar la celda en blanco.
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

/** Traduce el estado de una fila a la forma en que se grita: `data-urgency` y el resaltado de
 *  styles.css. Mira PRIMERO el estado del muñeco, que es el que también decide su color. */
export function rowUrgency(
  state: FleetWorkState | null | undefined, live?: LiveState,
): 'critical' | 'warning' | undefined {
  if (live === 'down' || live === 'blocked') return 'critical';
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
      : 'ningún ACK, y el servidor no dice desde cuándo';
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

/**
 * El orden de los chips de la cinta, de izquierda a derecha. La tabla ordena por lo MISMO: si la
 * cinta dice que lo primero que hay que mirar son los caídos y la lista de abajo los pone entre
 * medias, el subtítulo «ordenados por urgencia» deja de ser cierto.
 */
const ORDEN_VIVO: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'settled', 'idle',
];

/** Orden de triage: lo más urgente arriba, para que 71 entregas en vuelo no pasen inadvertidas
 *  entre quince filas alfabéticas. */
export function sortByUrgency(
  agents: readonly FleetActivityAgent[], estados?: EstadosVivos,
): FleetActivityAgent[] {
  const rango = (agent: FleetActivityAgent): number => {
    const live = estados?.get(agentKeyOf(agent));
    // Sin estado derivado se ordena por el del servidor, desplazado para no cruzar las escalas.
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

/** Mismo criterio visual que FleetPage.agentStateBadge: online/expirado/unknown según lease_until,
 *  distinguiendo "nunca hubo presencia" (presence ausente) de "presence con epoch/expiry ilegibles". */
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
 * Clave de identificación del agente (`tenant/alias`) utilizada en el hipergrafo y actividad.
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

/* ============================================================================================ *
 * Resumen de señales por fila: deduplicación de señales visibles en tabla.
 * ============================================================================================ */

export interface SenalPintada {
  clave: string;
  label: string;
  tone: BadgeTone;
}

export interface ResumenDeSenales {
  /** El titular de la celda. Siempre exactamente uno. */
  estado: SenalPintada;
  /** Las señales que AÑADEN algo al titular. Como mucho `TOPE_DE_SENALES`. */
  senales: SenalPintada[];
  /** Cuántas quedaron fuera del recuadro por el tope. 0 cuando entran todas. */
  ocultas: number;
  /** Detalle completo de señales medidas para el tooltip. */
  detalle: string;
}

/**
 * Lo que la columna «Presencia» de la misma fila ya está diciendo. Se pasa para no repetirlo.
 * `sin-presencia` significa «no se sabe / no se está mostrando», y entonces no se deduplica nada.
 */
export type PresenciaDeLaFila = 'conectado' | 'caido' | 'nunca' | 'sin-presencia';

/** Traduce la insignia de presencia que ya se pinta al vocabulario de la deduplicación. */
export function presenciaDeLaFila(agent: FleetActivityAgent): PresenciaDeLaFila {
  const estado = leaseState(agent.presence?.lease_until);
  if (estado === 'online') return 'conectado';
  if (estado === 'expired') return 'caido';
  return agent.presence ? 'sin-presencia' : 'nunca';
}

/** Cuántas señales caben al lado del estado antes de plegarse en un «+N». */
export const TOPE_DE_SENALES = 2;

/**
 * Determina qué señales se omiten por estar ya implícitas en el estado principal o presencia.
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
 * Lo que se pinta en la celda «Estado» de una fila: un titular y, como mucho, dos señales que
 * añadan algo. El resto se pliega en «+N» y el `title=` lo dice todo.
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
  // Conserva la señal 'saturated' si el titular no la explicita.
  if (estado.label !== FLAG_LABEL.saturated) fuera.delete('saturated');

  const visibles = activas
    .filter((flag) => !fuera.has(flag))
    // Y lo que el titular ya dice con esas mismas palabras tampoco se repite al lado.
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
