import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds, leaseState } from '../../lib';

export { formatDurationSeconds } from '../../lib';

/** Mismo vocabulario de tonos que ya usa <Badge>; no se agrega ninguno nuevo. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

/**
 * **Un solo vocabulario para toda la pantalla.**
 *
 * 🔴 Medido el 2026-08-23 en `/live`: el mismo agente `iza` salía como «caído» en el veredicto de
 * arriba, como `INACTIVO` en esta tabla, y el glosario del pie hablaba de «Libre» y de «Caído».
 * TRES palabras para el mismo estado, en la misma pantalla. Y la tabla usaba once palabras que el
 * glosario no explicaba, coincidiendo con él en una sola.
 *
 * Estas etiquetas se eligen para que COINCIDAN, palabra por palabra, con `LIVE_STATE_META` de
 * `../live/agent-state.ts`, que es lo que el glosario explica y lo que el mapa pinta:
 *
 *   servidor      esta tabla            mapa y glosario
 *   ────────      ─────────────────     ─────────────────
 *   idle          Libre                 Libre
 *   queued        Esperando turno       Esperando turno
 *   working       Trabajando            Trabajando
 *   saturated     Saturado              (señal, no estado del muñeco)
 *   stalled       Trabado               Trabado
 *
 * No se pierde ninguna distinción: `work_state` (cinco valores del servidor) y `LiveState` (siete,
 * derivados) siguen siendo particiones distintas y se calculan igual que antes. Lo que se unifica
 * es la PALABRA con la que se nombra un mismo hecho.
 *
 * Dejan de ir en MAYÚSCULAS: la mayúscula sostenida es más lenta de leer y acá hay quince filas.
 */
export const WORK_STATE_LABEL: Record<FleetWorkState, string> = {
  idle: 'Libre',
  queued: 'Esperando turno',
  working: 'Trabajando',
  saturated: 'Saturado',
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
 * Las señales, con las MISMAS palabras que el resto de la pantalla.
 *
 * `lease_expired` pasa a decirse «Caído» porque es exactamente lo que el veredicto de arriba llama
 * caído (`motivoDe`, en `agent-state.ts`) y lo que el glosario explica como caído. «Lease vencido»
 * era la tercera palabra para el mismo hecho. `unregistered` pasa a «Fuera del registro», que es
 * como ya se llama el chip de deriva de la cinta de triage.
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
  if (state === 'online') return { tone: 'online', label: 'Conectado' };
  if (state === 'expired') return { tone: 'offline', label: 'Caído' };
  return { tone: 'unknown', label: agent.presence ? 'Sin dato' : 'Nunca conectó' };
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

/* ============================================================================================ *
 * Resumen de señales por fila: UNA etiqueta por hecho, no cinco por el mismo.
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
  /**
   * TODAS las señales medidas, en castellano y sin deduplicar. Va al `title=` del titular: se
   * resume lo que se PINTA, nunca lo que se sabe.
   */
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
 * Qué señal deja de pintarse porque otra cosa ya visible la implica.
 *
 * 🔴 Medido el 2026-08-23: `jarvis` mostraba «SATURADO» DOS VECES en la misma celda —una desde
 * `work_state` y otra desde `flags`, que son dos campos del servidor para el mismo hecho— y
 * `midas` apilaba CINCO insignias (COLGADO, ACK DETENIDO, SATURADO, ACK VENCIDO, LEASE VENCIDO)
 * para decir «está trabado». Cinco palabras no informan cinco veces más: informan menos, porque
 * ninguna se lee.
 *
 * Las implicaciones son las del propio servidor, no un criterio estético:
 *  - `stalled` ES «pasó el umbral sin ACK aplicado», así que repetir `ack_stalled` y
 *    `overdue_acks` al lado no agrega un hecho: agrega la misma frase en tres idiomas.
 *  - `saturated` como estado y `saturated` como señal son literalmente el mismo campo.
 *  - Un alias `never_connected` no puede además tener un lease que «venció»: nunca tuvo uno.
 *  - Una cola sin consumidor es lo que le pasa a un alias caído que tiene entregas esperando; con
 *    «Caído» ya dicho, es la consecuencia, no una segunda avería.
 *
 * Lo implicado NO se pierde: sigue entero en `detalle`, que es el `title=` de la celda.
 */
function implicadas(
  state: FleetWorkState | undefined,
  flags: readonly FleetActivityFlag[],
  presencia: PresenciaDeLaFila,
): Set<FleetActivityFlag> {
  const fuera = new Set<FleetActivityFlag>();
  // La columna «Presencia» de la MISMA fila ya dice «Caído» o «Nunca conectó». Repetirlo tres
  // centímetros a la izquierda no es una segunda señal: es la misma palabra dos veces en la
  // misma fila, que es justo lo que este resumen existe para evitar.
  if (presencia === 'caido') fuera.add('lease_expired');
  if (presencia === 'nunca') { fuera.add('never_connected'); fuera.add('lease_expired'); }
  if (state === 'stalled') { fuera.add('ack_stalled'); fuera.add('overdue_acks'); }
  if (state === 'saturated') fuera.add('saturated');
  if (flags.includes('never_connected')) fuera.add('lease_expired');
  if (flags.includes('lease_expired') || flags.includes('never_connected')) fuera.add('queued_without_consumer');
  // Sin el estado `stalled`, «sin ACK» y «ACK vencido» siguen siendo la misma familia: se pinta el
  // más concreto de los dos y el otro queda en el detalle.
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
): ResumenDeSenales {
  const estadoValido = state ?? undefined;
  const activas = (flags ?? []).filter((flag) => Object.hasOwn(FLAG_LABEL, flag));
  const fuera = implicadas(estadoValido, activas, presencia);
  const visibles = activas
    .filter((flag) => !fuera.has(flag))
    .map((flag): SenalPintada => ({ clave: flag, label: FLAG_LABEL[flag], tone: FLAG_TONE[flag] }));

  const estado: SenalPintada = estadoValido
    ? { clave: estadoValido, label: WORK_STATE_LABEL[estadoValido], tone: WORK_STATE_TONE[estadoValido] }
    // El servidor no mandó `work_state`. Se dice, no se rellena con «inactivo».
    : { clave: 'sin-estado', label: 'Sin dato de estado', tone: 'unknown' };

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
