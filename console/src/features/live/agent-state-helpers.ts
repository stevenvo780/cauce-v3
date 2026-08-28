import type {
  DeliveryState,
  FleetActivityAgent,
  FleetActivityItem,
  FleetActivitySnapshot,
  FleetDelegationEdge,
} from '../../api/types';
import {
  agentKey,
  liveState,
  type LiveAgentView,
} from './agent-state';

/**
 * Extrae el alias de una clave tenant/alias.
 * Si la clave no contiene '/', devuelve la clave completa.
 */
export function aliasDe(key: string): string {
  const corte = key.indexOf('/');
  return corte === -1 ? key : key.slice(corte + 1);
}

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export function humanSeconds(seconds: number): string {
  if (seconds < 60) return `${String(Math.round(seconds))} s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
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
 * El `ack_deadline_at` que se le vio por última vez acredita un hecho comprobable: si ya
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

export type FleetMemory = Record<string, AgentMemory | undefined>;

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
 * Qué se sabe del desenlace de una entrega que salió de vuelo.
 * `desconocido` por defecto; `deadline_vencido` cuando ack_deadline_at ya había pasado.
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
 * ENTRÓ; uno que desaparece es una entrega que dejó de estar en vuelo.
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
      const vencido = item.ackDeadlineMs !== null && item.ackDeadlineMs <= nowMs;
      emitted.push({
        kind: 'settled',
        atMs: nowMs,
        deliveryId: item.deliveryId,
        outcome: vencido ? 'deadline_vencido' : 'desconocido',
      });
    }
    if (emitted.length === 0 && (agent.queued ?? 0) > before.queued) {
      emitted.push({ kind: 'received', atMs: nowMs });
    }
    if (emitted.length > 0) pulses[key] = emitted;
  }
  return pulses;
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

export type OrigenEncargo =
  | { tipo: 'agente'; tenant: string | null; alias: string }
  | { tipo: 'puente'; adapter: string }
  | { tipo: 'actor'; tenant: string | null; alias: string }
  | { tipo: 'desconocido' };

/**
 * El emisor manda sobre `origin_adapter`, SIEMPRE.
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
  if (typeof adapter === 'string' && adapter.length > 0 && adapter !== 'bus') {
    return { tipo: 'puente', adapter };
  }

  if (alias !== null && emisor !== contexto.selfKey) return { tipo: 'actor', tenant, alias };

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
// Geometría del mapa.
// ----------------------------------------------------------------------------------------------

/** Radio del muñeco cuando no hay con qué escalarlo, y los extremos cuando sí lo hay. */
export const AVATAR_UNIFORME = 26;
export const AVATAR_MIN = 22;
export const AVATAR_MAX = 34;

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
