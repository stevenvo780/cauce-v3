import type { FleetActivityAgent, FleetActivityFlag, FleetWorkState } from '../../api/types';
import { formatDurationSeconds, leaseState } from '../../lib';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';

export { formatDurationSeconds } from '../../lib';

/** Mismo vocabulario de tonos que ya usa <Badge>; no se agrega ninguno nuevo. */
export type BadgeTone = 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';

/**
 * **UN SOLO VOCABULARIO PARA TODA LA PANTALLA.**
 *
 * 🔴 Medido el 2026-08-23 en `/live` con 18 alias: la MISMA situación se llamaba de tres maneras
 * en el mismo scroll. Arriba —veredicto, chips, muñecos y la leyenda del pie— siete palabras en
 * castellano (`LIVE_STATE_META`, en `../live/agent-state.ts`). Abajo, esta tabla, cinco palabras
 * en mayúsculas que sólo coincidían con aquéllas en una. Choques concretos que se veían a la vez:
 *
 *   - `idle` era «Libre» en el chip y en la leyenda —que además dedica un párrafo a enseñar la
 *     palabra: «Libre no es caído ni es sin reportar»— y `INACTIVO` en la tabla, donde «Libre»
 *     no aparecía nunca.
 *   - `stalled` era «Bloqueado» en el chip, `COLGADO` en la tabla, «detenido» en el aviso de la
 *     portada y `stalled` crudo en el detalle de ese aviso: cuatro nombres para una condición.
 *   - `queued` era `EN COLA` acá y «Recibiendo» arriba.
 *
 * El operador no puede saber si son estados distintos o el mismo. Estas etiquetas se eligen para
 * COINCIDIR, palabra por palabra, con las que explica la leyenda:
 *
 *     servidor      esta tabla      chip, mapa y leyenda
 *     ────────      ──────────      ────────────────────
 *     idle          Libre           Libre
 *     queued        Recibiendo      Recibiendo
 *     working       Trabajando      Trabajando
 *     saturated     Trabajando      Trabajando + la señal «Saturado»
 *     stalled       Trabado         Trabado
 *
 * `saturated` dice «Trabajando» y no «Saturado» porque entre los siete estados del muñeco no hay
 * ninguno que se llame así: la saturación es una SEÑAL (`FLAG_LABEL.saturated`), y el servidor la
 * manda por separado en `flags`. Poniendo «Saturado» en la columna de estado, la misma fila decía
 * «Saturado» dos veces —una en el estado y otra en la señal— y encima inventaba un octavo estado
 * que la leyenda no explica. No se pierde nada: la señal sigue en su chip, la fila sigue
 * pintándose de ámbar (`rowUrgency`) y el orden de triage sigue poniéndola por encima de las que
 * sólo trabajan (`STATE_RANK`).
 *
 * No se pierde ninguna distinción: `work_state` (cinco valores del servidor) y `LiveState`
 * (siete, derivados) siguen siendo particiones distintas y se calculan igual que antes. Lo que se
 * unifica es la PALABRA con la que se nombra un mismo hecho.
 *
 * `queued` NO se llama «Esperando turno» a propósito, por tentador que sea: esa frase ya está
 * tomada en esta misma pantalla por la cifra de ENTREGAS `pending` + `retry` del veredicto, cuyo
 * tooltip dice literalmente «es la única definición de "en cola" que queda en la consola».
 * Reutilizarla acá pondría la misma frase con dos números distintos a un palmo de distancia, que
 * es exactamente el defecto de al lado.
 *
 * Dejan de ir en MAYÚSCULAS: la mayúscula sostenida se lee más despacio y acá hay quince filas.
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
 * Las señales, con las MISMAS palabras que el resto de la pantalla.
 *
 * `lease_expired` pasa a decirse «Caído» porque es exactamente lo que el veredicto de arriba
 * llama caído (`motivoDe`, en `agent-state.ts`) y lo que la leyenda explica como caído: «Lease
 * vencido» era una tercera palabra para el mismo hecho. `ack_stalled` deja de decir «ACK
 * detenido» porque «detenido» estaba tomado por el aviso de la portada para OTRA cosa —un agente
 * trabado—, y dos cosas distintas con la misma palabra en dos pantallas es un homónimo, no un
 * vocabulario. `unregistered` pasa a «Fuera del registro», que es como ya se llama el chip de
 * deriva de la cinta de triage.
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
 * **El estado que se pinta en la fila es el MISMO que el del muñeco, no otro.**
 *
 * 🔴 Renombrar `WORK_STATE_LABEL` no bastaba, y medirlo en Chrome lo demostró: `iza` salía
 * «Caído» en el chip y «LIBRE» en su fila, porque el servidor manda `work_state: 'idle'` (no
 * tiene trabajo) para un alias cuyo lease venció. Antes decía `INACTIVO`; con el rótulo nuevo
 * pasaba a decir «Libre», que para un agente caído es peor, no mejor. Lo mismo con `atlas`
 * («Recibiendo» en la fila, «Caído» en el chip) y con los que delegan («Libre» en la fila,
 * «Delegando» en el chip).
 *
 * `work_state` (cinco baldes del servidor, sobre el TRABAJO) y `LiveState` (siete, derivados,
 * que además miran la presencia y las delegaciones) son particiones distintas: ninguna traducción
 * de rótulos podía hacerlas coincidir. La fila consume ahora el estado ya derivado por la página
 * —el mismo objeto que pinta el muñeco y cuenta el chip—, así que decir cosas distintas dejó de
 * ser posible por construcción.
 *
 * No se pierde nada del `work_state`: la saturación y el estancamiento siguen llegando como
 * SEÑALES en `flags`, la fila sigue mostrando en vuelo, en cola, antigüedad y edad del ACK —los
 * números de los que sale— y el orden de triage los sigue usando de desempate.
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
  titular?: SenalPintada,
): ResumenDeSenales {
  const estadoValido = state ?? undefined;
  const activas = (flags ?? []).filter((flag) => Object.hasOwn(FLAG_LABEL, flag));

  const estado: SenalPintada = titular
    ?? (estadoValido
      ? { clave: estadoValido, label: WORK_STATE_LABEL[estadoValido], tone: WORK_STATE_TONE[estadoValido] }
      // El servidor no mandó `work_state`. Se dice, no se rellena con «inactivo».
      : { clave: 'sin-estado', label: 'Sin dato de estado', tone: 'unknown' });

  const fuera = implicadas(estadoValido, activas, presencia);
  /*
   * `saturated` sólo se pliega si el TITULAR lo está diciendo.
   *
   * El titular ya no sale siempre de `work_state`: la fila pinta el estado derivado
   * (`estadoDeFila`), que para un alias saturado dice «Trabajando» —la saturación no es uno de los
   * siete estados del muñeco, es una señal—. Plegar el chip mirando sólo `work_state` habría
   * borrado el único sitio donde la fila decía «Saturado», que es justo lo contrario de lo que
   * este resumen existe para hacer: quita lo repetido, nunca lo único.
   */
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
