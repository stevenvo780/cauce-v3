import type {
  FleetActivityAgent,
  FleetActivityItem,
  FleetActivitySnapshot,
  FleetActivityThresholds,
  FleetDelegationEdge,
} from '../../api/types';

/**
 * Los siete estados que Steven pidió ver de un vistazo, cada uno con su muñeco. El orden del
 * union es el de precedencia: `down` gana a todo, `idle` pierde con todo.
 *
 * Regla dura heredada del manual del médico: **un lease vivo NO prueba que el agente responda.**
 * Por eso `blocked` NO se deriva de la presencia sino de señales de trabajo real que no avanza
 * (`work_state: 'stalled'`, `ack_stalled`, `overdue_acks`), y `down` sólo se declara cuando el
 * servidor mismo dice que el lease venció o que nunca hubo conexión. Un agente con lease latiendo
 * y una entrega tomada hace 40 minutos sale **bloqueado**, que es justo el caso que hoy se ve
 * como "un agente que tarda" y no como un error.
 */
export type LiveState =
  | 'down'
  | 'blocked'
  | 'delegating'
  | 'responding'
  | 'receiving'
  | 'thinking'
  | 'idle';

export const LIVE_STATES: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'responding', 'receiving', 'thinking', 'idle',
];

export interface LiveStateMeta {
  label: string;
  /** Una línea, en castellano, que explica qué está pasando sin jerga de base de datos. */
  hint: string;
  tone: 'neutral' | 'info' | 'positive' | 'warning' | 'danger';
}

export const LIVE_STATE_META: Record<LiveState, LiveStateMeta> = {
  down: { label: 'Caído', hint: 'Sin lease vigente o nunca conectó: nadie va a tomar su trabajo.', tone: 'danger' },
  blocked: { label: 'Bloqueado', hint: 'Tomó trabajo y no avanza. Es el fallo que se ve como "tarda", no como error.', tone: 'danger' },
  delegating: { label: 'Delegando', hint: 'Le pasó trabajo a otro agente, que ya lo tiene en vuelo.', tone: 'info' },
  responding: { label: 'Respondiendo', hint: 'Acaba de cerrar una entrega: terminó su turno.', tone: 'positive' },
  receiving: { label: 'Recibiendo', hint: 'Le entró trabajo nuevo y todavía no empezó el turno.', tone: 'info' },
  thinking: { label: 'Trabajando', hint: 'Turno en curso: el arnés está masticando la entrega.', tone: 'positive' },
  idle: {
    label: 'Libre',
    hint: 'Conectado, con lease vigente y nada en vuelo. NO es un fallo.',
    tone: 'neutral',
  },
};

/** Cuánto dura en pantalla un estado transitorio antes de caer al estado estable. */
export const BURST_MS = 4500;

export interface AgentKey { tenantId: string; alias: string }

export function agentKey(agent: { tenant_id: string; alias: string }): string {
  return `${agent.tenant_id}/${agent.alias}`;
}

/** Arista de delegación viva: `from` le pasó una entrega a `to`, y `to` la tiene en vuelo AHORA. */
export interface DelegationEdge {
  from: string;
  to: string;
  deliveryId?: string | null;
  lane?: string | null;
  secondsInFlight?: number | null;
}

/**
 * Quién le pasó trabajo a quién, leído de las entregas en vuelo. `in_flight_items[].from_alias`
 * es el emisor de la entrega que el agente está procesando, así que una entrega que `b` tiene en
 * vuelo y que mandó `a` ES la arista `a → b`.
 *
 * Se descartan dos casos que no son delegación entre agentes:
 *  - `from` igual a `to`: el puente de Telegram publica el mensaje del dueño con el alias del
 *    propio agente, y eso es una persona escribiendo, no una delegación.
 *  - `from` que no es ningún alias de la flota: viene de fuera (una persona, un canal).
 */
export function delegationEdges(snapshot: FleetActivitySnapshot | undefined): DelegationEdge[] {
  const agents = snapshot?.agents ?? [];
  const known = new Set(agents.map(agentKey));
  const edges: DelegationEdge[] = [];
  for (const agent of agents) {
    const to = agentKey(agent);
    for (const item of agent.in_flight_items ?? []) {
      if (!item.from_tenant || !item.from_alias) continue;
      const from = `${item.from_tenant}/${item.from_alias}`;
      if (from === to || !known.has(from)) continue;
      edges.push({
        from,
        to,
        deliveryId: item.delivery_id,
        lane: item.lane,
        secondsInFlight: item.seconds_in_flight,
      });
    }
  }
  return edges;
}

/** Lo que hay que recordar de un snapshot para detectar transiciones en el siguiente. */
export interface AgentMemory {
  inFlightIds: string[];
  startedIds: string[];
  queued: number;
  observedAtMs: number;
}

export type FleetMemory = Record<string, AgentMemory>;

function itemIds(items: readonly FleetActivityItem[] | null | undefined): string[] {
  return (items ?? []).map((item) => item.delivery_id).filter((id): id is string => typeof id === 'string');
}

function startedIds(items: readonly FleetActivityItem[] | null | undefined): string[] {
  return (items ?? [])
    .filter((item) => item.status === 'started')
    .map((item) => item.delivery_id)
    .filter((id): id is string => typeof id === 'string');
}

export function rememberFleet(snapshot: FleetActivitySnapshot | undefined, nowMs: number): FleetMemory {
  const memory: FleetMemory = {};
  for (const agent of snapshot?.agents ?? []) {
    memory[agentKey(agent)] = {
      inFlightIds: itemIds(agent.in_flight_items),
      startedIds: startedIds(agent.in_flight_items),
      queued: agent.queued ?? 0,
      observedAtMs: nowMs,
    };
  }
  return memory;
}

/**
 * Un "pulso": algo que ACABA de pasar y merece una animación, detectado comparando el snapshot
 * nuevo contra el anterior. No es un estado del servidor, es una transición observada por el
 * cliente — y se etiqueta como tal para no hacerla pasar por un dato del backend.
 */
export interface Pulse {
  kind: 'received' | 'answered';
  atMs: number;
  deliveryId?: string;
}

export type PulseMap = Record<string, Pulse[]>;

/**
 * Compara dos snapshots y devuelve los pulsos nuevos. Un `delivery_id` que aparece es trabajo que
 * ENTRÓ; uno que desaparece es un turno que SE CERRÓ. Si `previous` no tiene entrada para el
 * agente (primer snapshot, o alias recién aparecido) no se emite nada: al abrir la consola no
 * tiene que explotar una lluvia de animaciones falsas por trabajo que ya estaba en curso.
 */
export function detectPulses(
  previous: FleetMemory,
  snapshot: FleetActivitySnapshot | undefined,
  nowMs: number,
): PulseMap {
  const pulses: PulseMap = {};
  for (const agent of snapshot?.agents ?? []) {
    const key = agentKey(agent);
    const before = previous[key];
    if (!before) continue;
    const now = itemIds(agent.in_flight_items);
    const beforeSet = new Set(before.inFlightIds);
    const nowSet = new Set(now);
    const emitted: Pulse[] = [];
    for (const id of now) {
      if (!beforeSet.has(id)) emitted.push({ kind: 'received', atMs: nowMs, deliveryId: id });
    }
    for (const id of before.inFlightIds) {
      if (!nowSet.has(id)) emitted.push({ kind: 'answered', atMs: nowMs, deliveryId: id });
    }
    // Cola que crece sin que aparezca una entrega en vuelo: también entró trabajo, sólo que
    // todavía no lo tomó nadie. Vale el mismo pulso de "recibiendo".
    if (emitted.length === 0 && (agent.queued ?? 0) > before.queued) {
      emitted.push({ kind: 'received', atMs: nowMs });
    }
    if (emitted.length > 0) pulses[key] = emitted;
  }
  return pulses;
}

export interface LiveAgentView {
  key: string;
  tenantId: string;
  alias: string;
  displayName?: string | null;
  harnessId?: string | null;
  state: LiveState;
  /** Motivo concreto y verificable del estado, para el tooltip y el lector de pantalla. */
  reason: string;
  /** `working` con `in_flight >= saturation_in_flight`: el muñeco piensa, pero recalentado. */
  overloaded: boolean;
  inFlight: number;
  queued: number;
  oldestInFlightSeconds?: number | null;
  secondsSinceLastAck?: number | null;
  delegatesTo: string[];
  delegatedFrom: string[];
  flags: string[];
  /**
   * Entregas cerradas en 24 h, o `undefined` si el servidor no lo informa. La diferencia gobierna
   * el tamaño del muñeco: sin el campo, TODOS miden lo mismo y la leyenda lo dice. Un `0` por
   * defecto convertiría "no sé" en "no cerró nada", que es una afirmación distinta.
   */
  closed24h?: number;
  rooms: string[];
  agent: FleetActivityAgent;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function humanSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * El estado del muñeco. Precedencia explícita, de arriba abajo, y cada rama deja escrito POR QUÉ
 * decidió eso: si mañana un muñeco miente, el motivo dice contra qué campo contrastarlo.
 */
export function liveState(
  agent: FleetActivityAgent,
  context: {
    pulses?: readonly Pulse[];
    delegatesTo?: readonly string[];
    thresholds?: FleetActivityThresholds | null;
    nowMs: number;
  },
): { state: LiveState; reason: string; overloaded: boolean } {
  const flags = agent.flags ?? [];
  const saturation = context.thresholds?.saturation_in_flight ?? 8;
  const stallAfter = context.thresholds?.stall_after_seconds ?? 300;
  const inFlight = agent.in_flight ?? 0;
  const overloaded = inFlight >= saturation;

  if (agent.agent_enabled === false) {
    return { state: 'down', reason: 'Deshabilitado en el registro de agentes: no se le asigna trabajo.', overloaded };
  }
  if (flags.includes('never_connected')) {
    return { state: 'down', reason: 'Nunca abrió una conexión: no hay lease de este alias.', overloaded };
  }
  if (flags.includes('lease_expired') || agent.presence?.online === false) {
    return { state: 'down', reason: 'El lease venció. El adaptador no está sosteniendo la conexión.', overloaded };
  }

  if (agent.work_state === 'stalled') {
    const age = agent.oldest_in_flight_seconds;
    return {
      state: 'blocked',
      reason: typeof age === 'number'
        ? `Tomó una entrega hace ${humanSeconds(age)} y no la cerró (umbral: ${humanSeconds(stallAfter)}).`
        : 'El servidor lo marcó estancado: trabajo tomado que no avanza.',
      overloaded,
    };
  }
  if (flags.includes('overdue_acks')) {
    return { state: 'blocked', reason: 'Tiene entregas con el deadline de ACK vencido: el turno se le está muriendo.', overloaded };
  }
  if (flags.includes('ack_stalled')) {
    const since = agent.seconds_since_last_ack;
    return {
      state: 'blocked',
      reason: since === null || since === undefined
        ? 'Trabajo en vuelo y ningún ACK dentro de la ventana de búsqueda: la señal más grave.'
        : `Trabajo en vuelo y el último ACK fue hace ${humanSeconds(since)}.`,
      overloaded,
    };
  }
  if (flags.includes('queued_without_consumer')) {
    return { state: 'blocked', reason: 'Tiene cola encolada y ningún consumidor conectado que la tome.', overloaded };
  }

  const pulses = context.pulses ?? [];
  const answered = pulses.find((pulse) => pulse.kind === 'answered');
  const received = pulses.find((pulse) => pulse.kind === 'received');

  if (answered && context.nowMs - answered.atMs < BURST_MS) {
    return { state: 'responding', reason: 'Cerró una entrega en el último refresco: terminó el turno.', overloaded };
  }

  const delegatesTo = context.delegatesTo ?? [];
  if (delegatesTo.length > 0) {
    return {
      state: 'delegating',
      reason: `Le pasó trabajo a ${delegatesTo.map((key) => key.split('/')[1]).join(', ')}, que lo tiene en vuelo.`,
      overloaded,
    };
  }

  if (received && context.nowMs - received.atMs < BURST_MS) {
    return { state: 'receiving', reason: 'Le entró una entrega nueva en el último refresco.', overloaded };
  }

  const claimedNotStarted = agent.claimed_not_started ?? 0;
  if (claimedNotStarted > 0 && (agent.started ?? 0) === 0) {
    return { state: 'receiving', reason: `${plural(claimedNotStarted, 'entrega tomada', 'entregas tomadas')} y todavía sin empezar.`, overloaded };
  }

  if (agent.work_state === 'working' || agent.work_state === 'saturated' || inFlight > 0) {
    return {
      state: 'thinking',
      reason: overloaded
        ? `${plural(inFlight, 'entrega', 'entregas')} en vuelo: por encima del umbral de saturación (${saturation}).`
        : `${plural(inFlight, 'entrega', 'entregas')} en vuelo.`,
      overloaded,
    };
  }

  if ((agent.queued ?? 0) > 0) {
    return { state: 'receiving', reason: `${plural(agent.queued ?? 0, 'entrega esperando', 'entregas esperando')} en cola.`, overloaded };
  }

  return { state: 'idle', reason: 'Conectado, con lease vigente y nada en vuelo.', overloaded };
}

export function buildLiveViews(
  snapshot: FleetActivitySnapshot | undefined,
  pulses: PulseMap,
  nowMs: number,
): { views: LiveAgentView[]; edges: DelegationEdge[] } {
  const edges = delegationEdges(snapshot);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const views = (snapshot?.agents ?? []).map((agent) => {
    const key = agentKey(agent);
    const delegatesTo = [...new Set(outgoing.get(key) ?? [])];
    const { state, reason, overloaded } = liveState(agent, {
      pulses: pulses[key],
      delegatesTo,
      thresholds: snapshot?.thresholds,
      nowMs,
    });
    return {
      key,
      tenantId: agent.tenant_id,
      alias: agent.alias,
      displayName: agent.display_name,
      harnessId: agent.harness_id,
      state,
      reason,
      overloaded,
      inFlight: agent.in_flight ?? 0,
      queued: agent.queued ?? 0,
      oldestInFlightSeconds: agent.oldest_in_flight_seconds,
      secondsSinceLastAck: agent.seconds_since_last_ack,
      delegatesTo,
      delegatedFrom: [...new Set(incoming.get(key) ?? [])],
      flags: agent.flags ?? [],
      closed24h: typeof agent.closed_24h === 'number' ? agent.closed_24h : undefined,
      rooms: agent.rooms ?? [],
      agent,
    } satisfies LiveAgentView;
  });

  return { views, edges };
}

/** Cuenta por estado, para la barra de resumen. Siempre publica los siete, incluso en cero. */
export function stateTally(views: readonly LiveAgentView[]): Record<LiveState, number> {
  const tally = Object.fromEntries(LIVE_STATES.map((state) => [state, 0])) as Record<LiveState, number>;
  for (const view of views) tally[view.state] += 1;
  return tally;
}

export { humanSeconds };

// ==============================================================================================
// El veredicto, y lo que hace falta para poder emitirlo honestamente.
// ==============================================================================================

/**
 * Los siete estados son la verdad del sistema; estos tres son la pregunta del dueño.
 *
 * Nadie mira la pantalla para saber si un alias está `receiving` o `delegating`: la mira para
 * saber si tiene que hacer algo. La partición gruesa existe para poder escribir UNA frase arriba
 * de todo, y se DERIVA de los siete — no los reemplaza ni los reordena.
 */
export type OwnerBucket = 'problema' | 'trabajando' | 'libre';

export function ownerBucket(state: LiveState): OwnerBucket {
  if (state === 'down' || state === 'blocked') return 'problema';
  if (state === 'idle') return 'libre';
  return 'trabajando';
}

export interface VerdictCulprit {
  key: string;
  alias: string;
  /** Frase corta y comprobable: "trabado hace 22 min", "caído". Es lo que va dentro del chip. */
  motivo: string;
}

export interface Verdict {
  tone: 'ok' | 'alerta' | 'desconocido';
  /** Una sola frase, la que se lee en tres segundos. */
  frase: string;
  /** La línea de apoyo, con las cifras que sostienen la frase. */
  apoyo: string;
  culpables: VerdictCulprit[];
}

export interface VerdictInput {
  /** La última lectura falló. Basta por sí solo para que el veredicto NO sea verde. */
  error?: Error | null;
  /** `observed_at` del snapshot que se está mostrando. */
  observedAt?: string | null;
  nowMs: number;
  /** A partir de qué antigüedad el snapshot deja de acreditar nada. */
  staleAfterMs: number;
}

function motivoDe(view: LiveAgentView): string {
  if (view.state === 'down') return 'caído';
  const edad = view.oldestInFlightSeconds;
  if (typeof edad === 'number') return `trabado hace ${humanSeconds(edad)}`;
  const ack = view.secondsSinceLastAck;
  // null NO es cero: es "ni una señal en toda la ventana de búsqueda", que es la señal más grave.
  if (ack === null || ack === undefined) return 'trabado, sin una sola señal';
  return `trabado, último ACK hace ${humanSeconds(ack)}`;
}

function horaCorta(marca: number): string {
  return new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(marca));
}

/**
 * La regla innegociable de esta vista.
 *
 * **Si la lectura falló o el snapshot está rancio, el veredicto NUNCA es verde.** Se degrada a
 * "No lo sé". Un cartel verde apoyado en datos de hace tres minutos miente exactamente igual que
 * un `systemctl is-active` sobre un proceso que ya no atiende: las dos son señales que hablan del
 * instrumento y se leen como si hablaran del sistema. Por eso la comprobación va PRIMERA, antes
 * de mirar un solo estado — si estuviera al final, cualquier rama anterior podría colarse en verde.
 */
export function fleetVerdict(views: readonly LiveAgentView[], input: VerdictInput): Verdict {
  const marca = typeof input.observedAt === 'string' ? Date.parse(input.observedAt) : Number.NaN;
  const edadMs = Number.isFinite(marca) ? input.nowMs - marca : Number.NaN;
  const rancio = !Number.isFinite(edadMs) || edadMs > input.staleAfterMs;

  if (input.error || rancio) {
    const desde = Number.isFinite(marca)
      ? `Datos de hace ${humanSeconds(Math.max(0, edadMs) / 1000)} (última lectura buena ${horaCorta(marca)}).`
      : 'Todavía no llegó ninguna lectura con hora del servidor.';
    return {
      tone: 'desconocido',
      frase: input.error ? 'No lo sé: la última lectura falló.' : 'No lo sé: el dato está viejo.',
      apoyo: desde,
      culpables: [],
    };
  }

  const problemas = views.filter((view) => ownerBucket(view.state) === 'problema');
  const trabajando = views.filter((view) => ownerBucket(view.state) === 'trabajando').length;
  const libres = views.filter((view) => ownerBucket(view.state) === 'libre').length;
  const conectados = views.filter((view) => view.state !== 'down').length;

  if (problemas.length > 0) {
    return {
      tone: 'alerta',
      frase: problemas.length === 1
        ? '1 agente necesita atención.'
        : `${problemas.length} agentes necesitan atención.`,
      apoyo: `${conectados} conectados · ${trabajando} trabajando · ${libres} libres.`,
      culpables: problemas.map((view) => ({ key: view.key, alias: view.alias, motivo: motivoDe(view) })),
    };
  }

  return {
    tone: 'ok',
    frase: 'Todo en orden.',
    apoyo: `${conectados} conectados · ${trabajando} trabajando · ${libres} libres · ninguno trabado.`,
    culpables: [],
  };
}

// ----------------------------------------------------------------------------------------------
// Aristas agregadas por par.
// ----------------------------------------------------------------------------------------------

export interface EdgeAggregate {
  from: string;
  to: string;
  /** Entregas de ese par en vuelo ahora. Mayor que 0 pinta la flecha de azul. */
  inFlight: number;
  /** Volumen del que sale el grosor. Sin dato del servidor, es el propio `inFlight`. */
  total: number;
  /** La más vieja de las que van en ese sentido, para decidir el ámbar contra el umbral. */
  oldestSeconds: number | null;
  /** `true` si el volumen es el de la ventana del servidor y no un recuento de lo que se ve. */
  totalFromServer: boolean;
}

export function edgePairKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * Junta en UNA flecha las N entregas que van del mismo emisor al mismo receptor.
 *
 * Antes cada entrega dibujaba su propia curva con la comba corrida, así que tres encargos de
 * `zeus` a `socrates` se leían como tres relaciones distintas en vez de como una relación cargada.
 * El volumen es un grosor, no un manojo de líneas.
 *
 * `serverEdges` es opcional a propósito: mientras la extensión de backend no esté desplegada el
 * grosor sale sólo de lo que hay en vuelo en este snapshot, y `totalFromServer` queda en `false`
 * para que la leyenda pueda declararlo en vez de aparentar una ventana de 24 h que nadie midió.
 */
export function aggregateEdges(
  edges: readonly DelegationEdge[],
  serverEdges?: readonly FleetDelegationEdge[] | null,
): Map<string, EdgeAggregate> {
  const salida = new Map<string, EdgeAggregate>();
  for (const edge of edges) {
    const clave = edgePairKey(edge.from, edge.to);
    const actual = salida.get(clave) ?? {
      from: edge.from, to: edge.to, inFlight: 0, total: 0, oldestSeconds: null, totalFromServer: false,
    };
    actual.inFlight += 1;
    actual.total += 1;
    const edad = edge.secondsInFlight;
    if (typeof edad === 'number' && (actual.oldestSeconds === null || edad > actual.oldestSeconds)) {
      actual.oldestSeconds = edad;
    }
    salida.set(clave, actual);
  }

  for (const server of serverEdges ?? []) {
    if (!server.from_tenant || !server.from_alias || !server.to_tenant || !server.to_alias) continue;
    const from = `${server.from_tenant}/${server.from_alias}`;
    const to = `${server.to_tenant}/${server.to_alias}`;
    const clave = edgePairKey(from, to);
    const actual = salida.get(clave) ?? {
      from, to, inFlight: 0, total: 0, oldestSeconds: null, totalFromServer: false,
    };
    // El servidor manda en el volumen de la ventana; el "en vuelo" se queda con el del snapshot,
    // que es el que está sincronizado con los muñecos que se dibujan en esta misma pasada.
    if (typeof server.total_window === 'number') {
      actual.total = server.total_window;
      actual.totalFromServer = true;
    }
    salida.set(clave, actual);
  }
  return salida;
}

// ----------------------------------------------------------------------------------------------
// El trabajo que entra por un puente humano.
// ----------------------------------------------------------------------------------------------

export interface HumanOrigin {
  /** `tenant/alias` del agente que recibió el encargo. */
  agentKey: string;
  /** Adaptador por el que entró: 'telegram', 'whatsapp'… Nunca el `conversation_id`. */
  adapter: string;
  /** Cuántas entregas en vuelo entraron por ahí. */
  count: number;
}

/**
 * Los encargos que NO vienen de otro agente.
 *
 * `delegationEdges()` los descarta, y con razón: el puente de Telegram publica el mensaje del
 * dueño **con el alias del propio agente**, así que la arista sale `from === to` y como delegación
 * sería falsa. Pero descartarla entera pierde el dato entero: el trabajo aparece de la nada y el
 * mapa sugiere que el agente se lo inventó solo. Éstos son los mismos ítems leídos como lo que
 * son —una persona, por un canal— para poder dibujar un nodo aparte, fuera de las salas.
 */
export function humanOrigins(snapshot: FleetActivitySnapshot | undefined): HumanOrigin[] {
  const conteo = new Map<string, HumanOrigin>();
  for (const agent of snapshot?.agents ?? []) {
    const key = agentKey(agent);
    for (const item of agent.in_flight_items ?? []) {
      const adapter = item.origin_adapter;
      // 'bus' es tráfico entre agentes y eso ya lo cuenta `delegationEdges`. Todo lo demás entró
      // por un puente, y detrás de un puente hay una persona o un canal.
      if (!adapter || adapter === 'bus') continue;
      const clave = `${key}|${adapter}`;
      const actual = conteo.get(clave) ?? { agentKey: key, adapter, count: 0 };
      actual.count += 1;
      conteo.set(clave, actual);
    }
  }
  return [...conteo.values()].sort((left, right) =>
    left.agentKey.localeCompare(right.agentKey) || left.adapter.localeCompare(right.adapter));
}

// ----------------------------------------------------------------------------------------------
// Geometría del mapa. Vive con el resto de la derivación pura y no dentro del componente: acá se
// puede afirmar en un test, y ahí sólo se podía mirar.
// ----------------------------------------------------------------------------------------------

/** Radio del muñeco cuando no hay con qué escalarlo, y los extremos cuando sí lo hay. */
export const AVATAR_UNIFORME = 26;
export const AVATAR_MIN = 22;
export const AVATAR_MAX = 34;

/**
 * El tamaño del muñeco.
 *
 * `maxClosed === null` significa que NINGÚN agente trae el campo: el servidor no informa el cierre
 * de 24 h, así que no hay nada que escalar y todos miden igual (y la leyenda lo declara). Es la
 * degradación explícita — la alternativa, tratar el campo ausente como 0 y dibujar a toda la flota
 * en el mínimo, haría que "no lo sé" y "no cerró nada" se vean idénticos en una pantalla donde el
 * tamaño significa cuánto trabajó cada uno.
 *
 * La raíz cuadrada, y no la proporción directa, porque lo que el ojo compara en un círculo es el
 * ÁREA: con escala lineal sobre el radio, un agente que cerró el doble parecería haber cerrado
 * cuatro veces más.
 */
export function radioDe(closed24h: number | undefined, maxClosed: number | null): number {
  if (maxClosed === null) return AVATAR_UNIFORME;
  if (typeof closed24h !== 'number' || !Number.isFinite(closed24h) || closed24h <= 0) return AVATAR_MIN;
  if (maxClosed <= 0) return AVATAR_MIN;
  return AVATAR_MIN + (AVATAR_MAX - AVATAR_MIN) * Math.sqrt(Math.min(1, closed24h / maxClosed));
}

/** Grosor de la flecha por volumen. Techo explícito: una relación cargada no puede tapar el mapa. */
export function grosorDe(total: number, maxTotal: number): number {
  if (maxTotal <= 1) return 1.5;
  return 1.5 + 3.5 * Math.min(1, (total - 1) / (maxTotal - 1));
}
