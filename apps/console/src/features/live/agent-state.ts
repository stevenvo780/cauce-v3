import type {
  FleetActivityAgent,
  FleetActivityItem,
  FleetActivitySnapshot,
  FleetActivityThresholds,
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
  idle: { label: 'Ocioso', hint: 'Conectado y sin nada en vuelo. Esperando.', tone: 'neutral' },
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
