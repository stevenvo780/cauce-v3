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
 * Extracts the alias from a tenant/alias key. If the key does not contain '/', it returns the whole key.
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

/** Live delegation edge: `from` passed a delivery to `to`, and `to` has it in flight NOW. */
export interface DelegationEdge {
  from: string;
  to: string;
  deliveryId?: string | null;
  lane?: string | null;
  secondsInFlight?: number | null;
}

/**
 * Who passed work to whom, read from the in-flight deliveries. `in_flight_items[].from_alias` is the
 * sender of the delivery the agent is processing, so a delivery that `b` has in flight and sent `a` IS
 * the edge `a -> b`.
 *
 * Two cases that are not delegation between agents are discarded:
 *  - `from` equal to `to`: the Telegram bridge publishes the owner's message with the agent's own
 *    alias, and that is a person typing, not a delegation.
 *  - `from` that is no alias of the fleet: it comes from outside (a person, a channel).
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
 * What is remembered about ONE in-flight delivery, to be able to say something when it disappears.
 *
 * The `ack_deadline_at` that was last seen attests to a verifiable fact: if it had already passed,
 * that delivery did NOT leave flight through a clean close.
 */
export interface ItemMemory {
  deliveryId: string;
  /** Last seen state. Always one of leased/accepted/started: that is all the SQL lists. */
  status?: DeliveryState | null;
  /** `ack_deadline_at` in ms, or `null` if the server did not report it. Never filled with 0. */
  ackDeadlineMs: number | null;
}

/** What needs to be remembered from a snapshot to detect transitions in the next one. */
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
 * What is known about the outcome of a delivery that left flight.
 * `desconocido` by default; `deadline_vencido` when ack_deadline_at had already passed.
 */
export type PulseOutcome = 'desconocido' | 'deadline_vencido';

export interface Pulse {
  kind: 'received' | 'settled';
  atMs: number;
  deliveryId?: string;
  /** Only in `settled`. */
  outcome?: PulseOutcome;
}

export type PulseMap = Record<string, Pulse[]>;

/**
 * Compares two snapshots and returns the new pulses. A `delivery_id` that appears is work that CAME IN;
 * one that disappears is a delivery that stopped being in flight.
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
// Edges aggregated by pair.
// ----------------------------------------------------------------------------------------------

export interface EdgeAggregate {
  from: string;
  to: string;
  /** Deliveries of that pair in flight right now. Greater than 0 paints the arrow blue. */
  inFlight: number;
  /** Volume from which the thickness comes. Without server data, it is the `inFlight` itself. */
  total: number;
  /** The oldest one going that direction, used to decide amber against the threshold. */
  oldestSeconds: number | null;
  /** `true` if the volume is the server's window one and not a count of what is seen. */
  totalFromServer: boolean;
}

export function edgePairKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * Joins into ONE arrow the N deliveries that go from the same sender to the same receiver.
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
// The work that comes in through a human bridge.
// ----------------------------------------------------------------------------------------------

export interface HumanOrigin {
  /** `tenant/alias` of the agent that received the task. */
  agentKey: string;
  /** Adapter through which it came: 'telegram', 'whatsapp'… Never the `conversation_id`. */
  adapter: string;
  /** How many in-flight deliveries came in through there. */
  count: number;
}

export type OrigenEncargo =
  | { tipo: 'agente'; tenant: string | null; alias: string }
  | { tipo: 'puente'; adapter: string }
  | { tipo: 'actor'; tenant: string | null; alias: string }
  | { tipo: 'desconocido' };

/**
 * The sender governs `origin_adapter`, ALWAYS.
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

/** The origins of an agent's in-flight deliveries, in the SAME order as `in_flight_items`. */
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
// Geometry of the map.
// ----------------------------------------------------------------------------------------------

/** Radius of the doughboy when there is nothing to scale it with, and the extremes when there is. */
export const AVATAR_UNIFORME = 26;
export const AVATAR_MIN = 22;
export const AVATAR_MAX = 34;

export function radioDe(closed24h: number | undefined, maxClosed: number | null): number {
  if (maxClosed === null) return AVATAR_UNIFORME;
  if (typeof closed24h !== 'number' || !Number.isFinite(closed24h) || closed24h <= 0) return AVATAR_MIN;
  if (maxClosed <= 0) return AVATAR_MIN;
  return AVATAR_MIN + (AVATAR_MAX - AVATAR_MIN) * Math.sqrt(Math.min(1, closed24h / maxClosed));
}

/** Arrow thickness by volume. Explicit ceiling: a busy relationship cannot blanket the map. */
export function grosorDe(total: number, maxTotal: number): number {
  if (maxTotal <= 1) return 1.5;
  return 1.5 + 3.5 * Math.min(1, (total - 1) / (maxTotal - 1));
}
