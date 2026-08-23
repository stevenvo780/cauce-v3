import type {
  DeliveryState,
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
  | 'settled'
  | 'receiving'
  | 'thinking'
  | 'idle';

export const LIVE_STATES: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'settled', 'receiving', 'thinking', 'idle',
];

export interface LiveStateMeta {
  label: string;
  /** Una línea, en castellano, que explica qué está pasando sin jerga de base de datos. */
  hint: string;
  tone: 'neutral' | 'info' | 'positive' | 'warning' | 'danger';
}

export const LIVE_STATE_META: Record<LiveState, LiveStateMeta> = {
  down: { label: 'Caído', hint: 'Sin lease vigente o nunca conectó: nadie va a tomar su trabajo.', tone: 'danger' },
  // «Trabado» y no «Bloqueado»: es la palabra que ya usaba el veredicto de arriba («trabado hace
  // 22 min») y la que ahora usa la tabla para `work_state: 'stalled'`. Eran tres palabras para el
  // mismo hecho en la misma pantalla.
  blocked: { label: 'Trabado', hint: 'Tomó trabajo y no avanza. Es el fallo que se ve como "tarda", no como error.', tone: 'danger' },
  delegating: { label: 'Delegando', hint: 'Le pasó trabajo a otro agente, que ya lo tiene en vuelo.', tone: 'info' },
  /**
   * Antes esto se llamaba «Respondiendo», decía «acaba de cerrar una entrega», iba en tono
   * `positive` y se pintaba en `--lime`. Era falso, y del peor modo posible: la consola sólo ve
   * que un `delivery_id` DESAPARECIÓ de `in_flight_items`, y esa lista la produce un SQL que trae
   * `status IN ('leased','accepted','started')` (packages/store/src/fleet-activity.ts). Una entrega
   * sale de ahí igual si cerró `done`, si fue a `failed`, si acabó en dead-letter o si le venció
   * el `ack_deadline_at`. Con la etiqueta vieja, el fallo más caro de la flota se anunciaba como la
   * mejor noticia de la pantalla. Ahora se declara lo único que se observó de verdad —la entrega
   * dejó de estar en vuelo— y el resultado se declara desconocido.
   */
  settled: {
    label: 'Salió de vuelo',
    hint: 'Una entrega suya dejó de estar en vuelo. Si cerró bien o se murió NO se puede saber desde la consola.',
    tone: 'neutral',
  },
  // Mismo hecho que `work_state: 'queued'` en la tabla y que «esperando turno» en el veredicto.
  receiving: { label: 'Esperando turno', hint: 'Le entró trabajo nuevo y todavía no empezó el turno.', tone: 'info' },
  thinking: { label: 'Trabajando', hint: 'Turno en curso: el arnés está masticando la entrega.', tone: 'positive' },
  idle: {
    /**
     * El texto dice ahora la PRECEDENCIA, y no por gusto: desde que la tabla de abajo usa este
     * mismo vocabulario, «Libre» aparece también en la columna «Estado» de un alias cuyo lease
     * venció —porque el servidor manda `work_state: 'idle'` (no tiene trabajo) y `Caído` en la
     * columna de presencia—. Sin decir cuál gana, el glosario contradiría a la fila.
     */
    label: 'Libre',
    hint: 'Nada en vuelo. En el mapa, además, con lease vigente: un alias sin trabajo Y sin lease se dibuja Caído, que gana.',
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

/**
 * Lo que se recuerda de UNA entrega en vuelo, para poder decir algo cuando desaparezca.
 *
 * Antes acá sólo se guardaba el `delivery_id` (`itemIds()` tiraba el resto del ítem), y esa pérdida
 * era la que dejaba a la vista sin nada que contrastar en el momento en que más falta hace: cuando
 * la entrega ya no está. El `status` no alcanza para saber el desenlace —la entrega ya no se lista—
 * pero el `ack_deadline_at` que se le vio por última vez sí acredita un hecho comprobable: si ya
 * había pasado, esa entrega NO salió de vuelo por un cierre limpio.
 */
export interface ItemMemory {
  deliveryId: string;
  /** Último estado visto. Siempre uno de leased/accepted/started: es lo único que el SQL lista. */
  status?: DeliveryState | null;
  /** `ack_deadline_at` en ms, o `null` si el servidor no lo informó. Nunca se rellena con 0. */
  ackDeadlineMs: number | null;
}

/** Lo que hay que recordar de un snapshot para detectar transiciones en el siguiente. */
export interface AgentMemory {
  items: ItemMemory[];
  queued: number;
  observedAtMs: number;
}

export type FleetMemory = Record<string, AgentMemory>;

function itemMemories(items: readonly FleetActivityItem[] | null | undefined): ItemMemory[] {
  const salida: ItemMemory[] = [];
  for (const item of items ?? []) {
    if (typeof item.delivery_id !== 'string') continue;
    const deadline = typeof item.ack_deadline_at === 'string' ? Date.parse(item.ack_deadline_at) : Number.NaN;
    salida.push({
      deliveryId: item.delivery_id,
      status: item.status,
      ackDeadlineMs: Number.isFinite(deadline) ? deadline : null,
    });
  }
  return salida;
}

export function rememberFleet(snapshot: FleetActivitySnapshot | undefined, nowMs: number): FleetMemory {
  const memory: FleetMemory = {};
  for (const agent of snapshot?.agents ?? []) {
    memory[agentKey(agent)] = {
      items: itemMemories(agent.in_flight_items),
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
/**
 * Qué se sabe del desenlace de una entrega que salió de vuelo.
 *
 * `desconocido` es la respuesta honesta por defecto y no un caso raro: `/activity` sólo lista
 * `leased`, `accepted` y `started`, así que `done`, `failed` y dead-letter se ven EXACTAMENTE
 * igual desde el cliente — la desaparición no distingue. `deadline_vencido` es lo único que sí se
 * puede afirmar: el `ack_deadline_at` que se le vio a esa entrega ya había pasado cuando dejó de
 * listarse, y eso descarta el cierre limpio sin necesidad de suponer nada.
 */
export type PulseOutcome = 'desconocido' | 'deadline_vencido';

export interface Pulse {
  kind: 'received' | 'settled';
  atMs: number;
  deliveryId?: string;
  /** Sólo en `settled`. */
  outcome?: PulseOutcome;
}

export type PulseMap = Record<string, Pulse[]>;

/**
 * Compara dos snapshots y devuelve los pulsos nuevos. Un `delivery_id` que aparece es trabajo que
 * ENTRÓ; uno que desaparece es una entrega que dejó de estar en vuelo —y nada más que eso: quién
 * la cerró, y si la cerró bien, no está en el dato—. Si `previous` no tiene entrada para el
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
    const now = itemMemories(agent.in_flight_items).map((item) => item.deliveryId);
    const beforeSet = new Set(before.items.map((item) => item.deliveryId));
    const nowSet = new Set(now);
    const emitted: Pulse[] = [];
    for (const id of now) {
      if (!beforeSet.has(id)) emitted.push({ kind: 'received', atMs: nowMs, deliveryId: id });
    }
    for (const item of before.items) {
      if (nowSet.has(item.deliveryId)) continue;
      // El único hecho que la desaparición sí acredita. Todo lo demás queda en 'desconocido'
      // ANTES que inventarle un final feliz a una entrega que pudo haberse muerto.
      const vencido = item.ackDeadlineMs !== null && item.ackDeadlineMs <= nowMs;
      emitted.push({
        kind: 'settled',
        atMs: nowMs,
        deliveryId: item.deliveryId,
        outcome: vencido ? 'deadline_vencido' : 'desconocido',
      });
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
  /**
   * Quién pidió cada entrega en vuelo, en el MISMO orden que `agent.in_flight_items`.
   *
   * Se calcula acá y no en cada componente porque hace falta el conjunto de alias de la flota
   * ENTERA para decidirlo, y el globo y el cajón sólo tienen delante a un agente. Que los dos
   * lean la misma lista es lo que impide que el globo diga "una persona por telegram" mientras el
   * mapa dibuja la flecha de otro agente para ese mismo encargo.
   */
  origenes: OrigenEncargo[];
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

export interface LiveStateContext {
  pulses?: readonly Pulse[];
  delegatesTo?: readonly string[];
  thresholds?: FleetActivityThresholds | null;
  nowMs: number;
}

/**
 * El estado del muñeco. Precedencia explícita, de arriba abajo, y cada rama deja escrito POR QUÉ
 * decidió eso: si mañana un muñeco miente, el motivo dice contra qué campo contrastarlo.
 *
 * La nota de "sin registro" se pega al final del motivo en vez de repetirse rama por rama: es una
 * salvedad sobre la PROCEDENCIA del alias, no un estado, y vale igual esté trabajando o caído.
 */
export function liveState(
  agent: FleetActivityAgent,
  context: LiveStateContext,
): { state: LiveState; reason: string; overloaded: boolean } {
  const decidido = decidirEstado(agent, context);
  const flags = agent.flags ?? [];
  const sinRegistro = flags.includes('unregistered') || agent.registered === false;
  if (!sinRegistro) return decidido;
  return {
    ...decidido,
    reason: `${decidido.reason} No está en el registro de agentes: apareció por entregas o por lease.`,
  };
}

function decidirEstado(
  agent: FleetActivityAgent,
  context: LiveStateContext,
): { state: LiveState; reason: string; overloaded: boolean } {
  const flags = agent.flags ?? [];
  const saturation = context.thresholds?.saturation_in_flight ?? 8;
  const stallAfter = context.thresholds?.stall_after_seconds ?? 300;
  const inFlight = agent.in_flight ?? 0;
  const overloaded = inFlight >= saturation;

  /**
   * Un alias que no está en el registro NO tiene una decisión de registro que leer.
   *
   * El backend calcula `agent_enabled: COALESCE(ag.enabled, false)` y el LEFT JOIN no encuentra
   * fila para un participante que entró por `deliveries` o por `connection_leases`. Ese `false`
   * es el DEFAULT del COALESCE, no una baja que alguien dio: leerlo como "deshabilitado en el
   * registro" convertía un alias sin dar de alta —trabajando, con lease vivo y tres entregas en
   * vuelo— en un muñeco rojo con un motivo inventado. El propio servidor manda el flag
   * `unregistered` para distinguirlo, y esta vista no lo miraba.
   */
  const sinRegistro = flags.includes('unregistered') || agent.registered === false;

  if (agent.agent_enabled === false && !sinRegistro) {
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
  const received = pulses.find((pulse) => pulse.kind === 'received');
  // El vencido gana al desconocido: entre dos entregas que salieron de vuelo a la vez, la que se
  // sabe que no cerró limpia es la que hay que contar.
  const settled = pulses.find((pulse) => pulse.kind === 'settled' && pulse.outcome === 'deadline_vencido')
    ?? pulses.find((pulse) => pulse.kind === 'settled');

  if (settled && context.nowMs - settled.atMs < BURST_MS) {
    return {
      state: 'settled',
      reason: settled.outcome === 'deadline_vencido'
        ? 'Una entrega suya salió de vuelo con el deadline de ACK ya vencido: no fue un cierre limpio.'
        : 'Una entrega suya salió de vuelo en el último refresco. Si cerró bien o se murió no se puede '
          + 'saber desde acá: /activity sólo lista leased, accepted y started, así que done, failed y '
          + 'vencida por deadline se ven exactamente igual.',
      overloaded,
    };
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

  const agents = snapshot?.agents ?? [];
  const known = new Set(agents.map(agentKey));

  const views = agents.map((agent) => {
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
      origenes: origenesDeAgente(agent, known),
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

  /**
   * Cero mediciones NO es cero problemas.
   *
   * `fleetVerdict([], {observedAt fresco})` devolvía «Todo en orden · 0 conectados · 0 trabajando»,
   * que es un cartel verde sostenido por la nada. Y era alcanzable en producción sin ninguna
   * avería: basta con elegir en el selector un cliente cuyos alias no aparezcan en `/activity`, o
   * con que el servidor devuelva `agents: []`. La lectura puede haber llegado fresca y perfecta y
   * seguir sin acreditar absolutamente nada sobre nadie.
   */
  if (views.length === 0) {
    return {
      tone: 'desconocido',
      frase: 'No lo sé: no hay ni un alias que mirar.',
      apoyo: 'La lectura llegó fresca pero no trae ningún agente en este alcance. Cero mediciones no es lo mismo que cero problemas.',
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
 * De dónde salió UN encargo concreto, ya desambiguado.
 *
 * `agente`: otro alias de la flota se lo pasó. `puente`: entró por un adaptador (Telegram y
 * compañía) y detrás hay una persona o un canal. `actor`: hay un actor con nombre que no es
 * ningún alias de la flota — se lo nombra sin afirmar que sea una persona. `desconocido`: el dato
 * no alcanza para decir quién, y eso se declara en vez de rellenarse.
 */
export type OrigenEncargo =
  | { tipo: 'agente'; tenant: string | null; alias: string }
  | { tipo: 'puente'; adapter: string }
  | { tipo: 'actor'; tenant: string | null; alias: string }
  | { tipo: 'desconocido' };

/**
 * El emisor manda sobre `origin_adapter`, SIEMPRE, y ése es el arreglo.
 *
 * `origin` se copia byte a byte en cada salto de la cadena (ver el comentario largo de
 * `AGENT_TO_AGENT_MESSAGE_TYPES` en packages/protocol/src/schemas.ts): una cadena de cinco agentes
 * nacida en Telegram sigue diciendo `adapter:'telegram'` en el salto cinco — medido el 2026-07-27,
 * 2.374 de 2.429 entregas de 12 h decían 'telegram'. Leer ese campo a secas, como se hacía acá,
 * producía a la vez la arista `zeus → kant` (correcta) y la frase «se lo pidió una persona, por
 * telegram» (falsa) para el MISMO ítem. Y como la frase falsa iba primero, tapaba a la verdadera.
 *
 * `from_tenant/from_alias` es `m.actor_alias`: dice quién publicó ESTA entrega, no de qué
 * desciende. Por eso decide primero. La regla es la misma que ya aplicaba `delegationEdges` para
 * no dibujar flechas inventadas, y ahora las dos lecturas del mismo ítem no pueden contradecirse.
 *
 * El caso `emisor === selfKey` no es una excepción arbitraria: el puente publica el mensaje del
 * dueño CON EL ALIAS DEL PROPIO AGENTE, así que ahí `origin_adapter` sí es la única fuente que
 * queda y sí dice la verdad.
 */
export function origenDeItem(
  item: FleetActivityItem,
  contexto: { selfKey: string; known: ReadonlySet<string> },
): OrigenEncargo {
  const tenant = item.from_tenant ?? null;
  const alias = item.from_alias ?? null;
  const emisor = tenant && alias ? `${tenant}/${alias}` : null;

  if (emisor !== null && alias !== null && emisor !== contexto.selfKey && contexto.known.has(emisor)) {
    return { tipo: 'agente', tenant, alias };
  }

  const adapter = item.origin_adapter;
  // 'bus' es tráfico entre agentes: si llegó acá es que el emisor no se pudo identificar, y
  // "vino por el bus" no nombra a nadie.
  if (typeof adapter === 'string' && adapter.length > 0 && adapter !== 'bus') {
    return { tipo: 'puente', adapter };
  }

  // Un actor con nombre que la flota no declara. Se lo nombra tal cual, sin ascenderlo a "persona".
  if (alias !== null && emisor !== contexto.selfKey) return { tipo: 'actor', tenant, alias };

  // Queda el alias publicándose a sí mismo por el bus, o un ítem sin emisor: ninguno nombra a
  // quien pidió el trabajo, y eso se dice.
  return { tipo: 'desconocido' };
}

/** Los orígenes de las entregas en vuelo de un agente, en el MISMO orden que `in_flight_items`. */
export function origenesDeAgente(
  agent: FleetActivityAgent,
  known: ReadonlySet<string>,
): OrigenEncargo[] {
  const selfKey = agentKey(agent);
  return (agent.in_flight_items ?? []).map((item) => origenDeItem(item, { selfKey, known }));
}

/**
 * Los encargos que NO vienen de otro agente.
 *
 * `delegationEdges()` los descarta, y con razón: el puente de Telegram publica el mensaje del
 * dueño **con el alias del propio agente**, así que la arista sale `from === to` y como delegación
 * sería falsa. Pero descartarla entera pierde el dato entero: el trabajo aparece de la nada y el
 * mapa sugiere que el agente se lo inventó solo. Éstos son los mismos ítems leídos como lo que
 * son —una persona, por un canal— para poder dibujar un nodo aparte, fuera de las salas.
 *
 * Sólo cuentan los ítems que `origenDeItem` clasifica como `puente`: un ítem que otro alias de la
 * flota mandó ya está contado como delegación, y contarlo además como "una persona por telegram"
 * era dibujar dos veces el mismo encargo con dos historias incompatibles.
 */
export function humanOrigins(snapshot: FleetActivitySnapshot | undefined): HumanOrigin[] {
  const agents = snapshot?.agents ?? [];
  const known = new Set(agents.map(agentKey));
  const conteo = new Map<string, HumanOrigin>();
  for (const agent of agents) {
    const key = agentKey(agent);
    for (const origen of origenesDeAgente(agent, known)) {
      if (origen.tipo !== 'puente') continue;
      const clave = `${key}|${origen.adapter}`;
      const actual = conteo.get(clave) ?? { agentKey: key, adapter: origen.adapter, count: 0 };
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
