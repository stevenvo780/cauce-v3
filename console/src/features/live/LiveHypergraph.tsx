import { useMemo } from 'react';
import type { FleetActivityThresholds, TopologySnapshot } from '../../api/types';
import { AgentAvatar } from './AgentAvatar';
import {
  AVATAR_UNIFORME,
  LIVE_STATE_META,
  aggregateEdges,
  aliasDe,
  edgePairKey,
  grosorDe,
  radioDe,
  type DelegationEdge,
  type HumanOrigin,
  type LiveAgentView,
  type LiveState,
} from './agent-state';
import {
  aclCaption, layoutHypergraph, type HyperGraphModel, type Point,
} from './hypergraph/hypergraph-layout';
import type { FleetDelegationEdge } from '../../api/types';
import { FlowArrow } from './hypergraph/FlowArrow';
import { Desplazable } from '../../components/Desplazable';

/**
 * The map: the fleet doughboys placed in their rooms, with what they are passing between hands.
 *
 * It is the center of the view and answers a single question — *who is passing work to whom, right now* — but it
 * can switch to a second layer, *who has PERMISSION to talk to whom*. Never both at once: the arrows do not mean
 * the same thing (one is a real in-flight delivery, the other is an ACL edge) and overlaying them forces one of the
 * two readings to worsen. With the switcher, the rooms and positions do not move: only what joins them changes, so
 * the comparison between "can" and "is" is done with the eyes, without having to find anyone again.
 *
 * Honesty, which weighs more here than the drawing: an arrow exists only if there is a real in-flight delivery
 * (`delegationEdges` derives them from `in_flight_items`; none is invented); an alias that topology declares but
 * activity does not report is drawn **unreported**, with its dashed ring and the written word; if the server does
 * not report the work closed in 24 h, ALL doughboys measure the same and the legend says so, instead of drawing a
 * zero that nobody measured.
 */

/**
 * What a real doughboy occupies, measured from its center, with the MAXIMUM radius.
 *
 * Computed with 34 and not with each node's radius on purpose: the layout is solved once, with the topology, and
 * cannot depend on a size that changes with activity — if it did, the doughboys would jump in place every time someone
 * closes a task. Always reserving the largest one's space costs a bit of air and guarantees that no pair ever overlaps.
 */
const FOOTPRINT = { halfWidth: 44, top: -40, bottom: 62 } as const;

/** Width of the left corridor where the "person" nodes live, outside of any room. */
const GUTTER = 132;

/** Minimum separation between two person nodes, so their names do not overlap. */
const GUTTER_GAP = 62;

/** RENDER state, not system state. `unknown` is not an eighth state: it is the absence of the seven. */
type NodeState = LiveState | 'unknown';

/** The word that ALWAYS goes below the alias. Color alone is not enough to distinguish free from dead. */
const WORD: Record<NodeState, string> = {
  down: 'caído',
  blocked: 'trabado',
  delegating: 'delegando',
  settled: 'salió de vuelo',
  receiving: 'recibiendo',
  thinking: 'trabajando',
  idle: 'libre',
  unknown: 'sin reportar',
};

function canvasFor(nodeCount: number): { width: number; height: number } {
  const width = Math.min(1760, 1240 + Math.max(0, nodeCount - 8) * 40);
  return { width, height: Math.round(width / 1.6 / 10) * 10 };
}

function countAliases(topology: TopologySnapshot | undefined): number {
  const seen = new Set<string>();
  for (const tenant of topology?.tenants ?? []) {
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) if (member.alias) seen.add(member.alias);
    }
  }
  return seen.size;
}

export type HypergraphLayer = 'ahora' | 'permisos';

interface LiveHypergraphProps {
  topology: TopologySnapshot | undefined;
  views: readonly LiveAgentView[];
  edges: readonly DelegationEdge[];
  /** Aggregated by pair as reported by the server. Absent until the backend phase ships. */
  serverEdges?: readonly FleetDelegationEdge[] | null;
  /** SERVER thresholds. An arrow's amber comes from here, never from a hand-written 300. */
  thresholds?: FleetActivityThresholds | null;
  /** Tasks that came in through a human bridge, used to draw the person node outside the rooms. */
  origins?: readonly HumanOrigin[];
  layer?: HypergraphLayer;
  focusKey?: string | null;
  spotlight?: Set<string> | null;
  loadingTopology?: boolean;
  /**
   * The topology read FAILED. It is different from "there are no rooms", and until now they
   * looked the same: the same banner of "the control plane has not reported any rooms yet"
   * covered both cases, so a downed `GET /v3/console/topology` was read as an unconfigured fleet.
   */
  topologyError?: Error | null;
  onRetryTopology?: () => void;
  onFocus?: (key: string | null) => void;
  onOpen?: (view: LiveAgentView) => void;
  /** Bounding rectangle of the node in viewport coordinates, used to hang the balloon from the page. */
  onHover?: (key: string | null, anchor: DOMRect | null, view: LiveAgentView | null, alias: string) => void;
}

interface Placed {
  key: string;
  alias: string;
  tenantId: string;
  point: Point;
  view: LiveAgentView | null;
  radius: number;
}

export function LiveHypergraph({
  topology, views, edges, serverEdges, thresholds, origins, layer = 'ahora',
  focusKey, spotlight, loadingTopology, topologyError, onRetryTopology, onFocus, onOpen, onHover,
}: LiveHypergraphProps) {
  const byKey = useMemo(() => new Map(views.map((view) => [view.key, view])), [views]);

  // Layout depends ONLY on topology: that keeps the doughboys from jumping on every refresh.
  const model: HyperGraphModel = useMemo(
    () => {
      const canvas = canvasFor(countAliases(topology));
      return layoutHypergraph(topology, {
        ...canvas,
        padding: 52,
        nodeSpacing: Math.hypot(FOOTPRINT.halfWidth * 2, FOOTPRINT.bottom - FOOTPRINT.top),
        footprint: FOOTPRINT,
        labelBand: 30,
      });
    },
    [topology],
  );

  // `null` = no agent brings the field. Different from `0` = all closed zero.
  const maxClosed = useMemo(() => {
    let max: number | null = null;
    for (const view of views) {
      if (typeof view.closed24h !== 'number') continue;
      max = max === null ? view.closed24h : Math.max(max, view.closed24h);
    }
    return max;
  }, [views]);

  const placed = useMemo<Placed[]>(() => model.nodes.map((node) => {
    const tenantId = node.tenants[0] ?? '';
    const key = `${tenantId}/${node.alias}`;
    const view = byKey.get(key) ?? null;
    return {
      key, alias: node.alias, tenantId, point: { x: node.x, y: node.y }, view,
      radius: radioDe(view?.closed24h, maxClosed),
    };
  }), [model, byKey, maxClosed]);

  const position = useMemo(() => new Map(placed.map((item) => [item.key, item.point])), [placed]);
  const radios = useMemo(() => new Map(placed.map((item) => [item.key, item.radius])), [placed]);

  const sinSala = useMemo(
    () => views.filter((view) => !position.has(view.key)).map((view) => view.alias),
    [views, position],
  );

  const agregadas = useMemo(() => aggregateEdges(edges, serverEdges), [edges, serverEdges]);

  /**
   * The person nodes, in the left corridor.
   *
   * They are placed at the height of their agent and then separated in a sequential pass, so the position is
   * deterministic: two refreshes with the same data yield the same drawing. They are OUTSIDE the regions because a
   * person is not a member of any room, and putting one inside would be the same kind of lie as drawing an arrow no
   * one sent.
   */
  const personas = useMemo(() => {
    const lista = (origins ?? [])
      .filter((origin) => position.has(origin.agentKey))
      .map((origin) => ({ ...origin, y: position.get(origin.agentKey)?.y ?? 0 }))
      .sort((left, right) => left.y - right.y || left.agentKey.localeCompare(right.agentKey));
    let ultimo = -Infinity;
    return lista.map((origin) => {
      const y = Math.max(origin.y, ultimo + GUTTER_GAP);
      ultimo = y;
      return { ...origin, y };
    });
  }, [origins, position]);

  const conPasillo = personas.length > 0;
  const viewBox = conPasillo
    ? `${String(-GUTTER)} 0 ${String(model.width + GUTTER)} ${String(model.height)}`
    : `0 0 ${String(model.width)} ${String(model.height)}`;

  /**
   * CSS does not turn SMIL off.
   *
   * `prefers-reduced-motion` stops CSS animations, and `<animateMotion>` is not one: it has to be queried from JS or
   * this view fails to honor what the rest of the console already respects. With the setting on, the dot stays still
   * halfway through the curve instead of disappearing: a live arrow must keep being distinguishable from a dead one
   * without relying on motion.
   */
  const animar = useMemo(() => {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return true;
    }
  }, []);

  if (model.edges.length === 0) {
    if (topologyError) {
      return (
        <div className="lhg-empty">
          <p>
            <strong>No se pudo leer la topología</strong> ({topologyError.message}). El mapa no está
            vacío porque no haya salas: está vacío porque esta lectura falló y no se sabe cuáles hay.
          </p>
          {onRetryTopology ? (
            <button type="button" className="button small secondary" onClick={onRetryTopology}>
              Reintentar la topología
            </button>
          ) : null}
        </div>
      );
    }
    return loadingTopology ? (
      <p className="lhg-empty">Leyendo las salas de la topología…</p>
    ) : (
      <p className="lhg-empty">
        El control plane informó cero salas, así que no hay grupos que dibujar. Los muñecos siguen
        abajo, en la lista.
      </p>
    );
  }

  const vivas = [...agregadas.values()].filter((edge) => position.has(edge.from) && position.has(edge.to));
  const maxTotal = vivas.reduce((max, edge) => Math.max(max, edge.total), 1);
  const stallAfter = thresholds?.stall_after_seconds ?? 300;

  /** Focus adds to the active filter instead of replacing it. */
  const activos = new Set<string>(spotlight ?? []);
  if (focusKey) {
    const vecindario = new Set<string>([focusKey]);
    for (const edge of vivas) {
      if (edge.from === focusKey) vecindario.add(edge.to);
      if (edge.to === focusKey) vecindario.add(edge.from);
    }
    if (!spotlight) activos.clear();
    for (const key of vecindario) activos.add(key);
  }
  // An empty `Set` is truthy: a filter is set even if it matches nobody, and then EVERYTHING
  // is dimmed.
  const atenuando = Boolean(spotlight) || Boolean(focusKey);

  const trabajando = placed.filter((item) => item.view && item.view.state !== 'idle' && item.view.state !== 'down').length;
  const descripcion = layer === 'permisos'
    ? `Mapa de permisos: ${String(placed.length)} agentes en ${String(model.edges.length)} salas y ${String(model.arcs.length)} aristas ACL entre clientes.`
    : `Mapa vivo: ${String(placed.length)} agentes en ${String(model.edges.length)} salas. ${String(trabajando)} con trabajo en curso. `
      + `${String(vivas.length)} delegaciones en vuelo ahora mismo.`;

  return (
    <div className={`lhg${atenuando ? ' is-focusing' : ''}`} data-layer={layer}>
      <Desplazable etiqueta="Mapa de la flota" className="lhg-scroll">
      <svg
        className="lhg-svg"
        viewBox={viewBox}
        role="img"
        aria-label={descripcion}
        preserveAspectRatio="xMidYMid meet"
      >
        <desc>{descripcion}</desc>
        <defs>
          <marker id="lhg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* Layer 1 — the rooms. In the background: the doughboys always read above them. */}
        <g className="lhg-rooms">
          {model.edges.map((room) => (
            <g className={`lhg-room lhg-hue-${String(room.hue)}`} key={room.key}>
              <title>{`#${room.roomLabel ?? 'sala sin nombre'} — ${String(room.members.length)} miembros`}</title>
              <path className="lhg-room-fill" d={room.outline} />
              <path className="lhg-room-line" d={room.outline} />
              <text className="lhg-room-label" x={room.labelAnchor.x} y={room.labelAnchor.y} textAnchor="middle">
                #{room.roomLabel ?? 'sala sin nombre'}
              </text>
            </g>
          ))}
        </g>

        {/* Layer 2 — either the live delegations, or the permissions. Never both. */}
        {layer === 'permisos' ? (
          <g className="lhg-flows lhg-flows-acl">
            {model.arcs.map((arc) => (
              <g className={`lhg-flow-acl${arc.enabled === false ? ' is-denied' : ''}`} key={arc.key}>
                <title>{`${arc.fromTenant} → ${arc.toTenant} · ${aclCaption(arc)}`}</title>
                <path className="lhg-flow-acl-line" d={arc.path} markerEnd="url(#lhg-arrow)" />
                <text className="lhg-flow-acl-label" x={arc.labelAnchor.x} y={arc.labelAnchor.y} textAnchor="middle">
                  {aclCaption(arc)}
                </text>
              </g>
            ))}
          </g>
        ) : (
          <g className="lhg-flows">
            {vivas.map((edge, index) => {
              const fromPt = position.get(edge.from);
              const toPt = position.get(edge.to);
              if (!fromPt || !toPt) return null;
              return (
                <FlowArrow
                  key={edgePairKey(edge.from, edge.to)}
                  edge={edge}
                  index={index}
                  from={fromPt}
                  to={toPt}
                  fromRadius={radios.get(edge.from) ?? AVATAR_UNIFORME}
                  toRadius={radios.get(edge.to) ?? AVATAR_UNIFORME}
                  width={grosorDe(edge.total, maxTotal)}
                  lento={(edge.oldestSeconds ?? 0) > stallAfter}
                  dim={atenuando && !(activos.has(edge.from) && activos.has(edge.to))}
                  animar={animar}
                />
              );
            })}
          </g>
        )}

        {/* Layer 3 — the people, in the corridor, with a dashed line to their agent. */}
        {layer === 'ahora' ? (
          <g className="lhg-humans">
            {personas.map((persona) => {
              const destino = position.get(persona.agentKey);
              if (!destino) return null;
              const x = -GUTTER / 2;
              return (
                <g className="lhg-human" key={`${persona.agentKey}|${persona.adapter}`}>
                  <title>
                    {`Una persona, por ${persona.adapter} → ${aliasDe(persona.agentKey)}`}
                    {` · ${String(persona.count)} ${persona.count === 1 ? 'encargo' : 'encargos'} en vuelo`}
                  </title>
                  <path className="lhg-human-line" d={`M ${String(x + 22)} ${String(persona.y)} L ${String(destino.x - 40)} ${String(destino.y)}`} />
                  <circle className="lhg-human-dot" cx={x} cy={persona.y} r="15" />
                  <text className="lhg-human-glyph" x={x} y={persona.y + 5} textAnchor="middle">@</text>
                  <text className="lhg-human-name" x={x} y={persona.y + 32} textAnchor="middle">
                    {persona.adapter}
                  </text>
                </g>
              );
            })}
          </g>
        ) : null}

        {/* Layer 4 — the doughboys. */}
        <g className="lhg-bots">
          {placed.map((item) => {
            const view = item.view;
            const estado: NodeState = view?.state ?? 'unknown';
            const meta = estado === 'unknown' ? LIVE_STATE_META.idle : LIVE_STATE_META[estado];
            const dim = atenuando && !activos.has(item.key);
            const r = item.radius;
            const detalle = view
              ? `${item.alias} — ${meta.label}: ${view.reason}`
              : `${item.alias} — la actividad no lo reporta, así que su estado no se sabe. No se asume que esté sano.`;
            return (
              <g
                key={item.key}
                className={`lhg-bot${dim ? ' is-dim' : ''}${focusKey === item.key ? ' is-active' : ''}${view ? '' : ' is-unknown'}`}
                data-state={estado}
                // The verdict uses this key to bring the guilty doughboy into view.
                data-agent-key={item.key}
                transform={`translate(${String(item.point.x)} ${String(item.point.y)})`}
                tabIndex={0}
                role="button"
                aria-label={detalle}
                onMouseEnter={(event) => {
                  onFocus?.(item.key);
                  onHover?.(item.key, event.currentTarget.getBoundingClientRect(), view, item.alias);
                }}
                onMouseLeave={() => { onFocus?.(null); onHover?.(null, null, null, item.alias); }}
                onFocus={(event) => {
                  onFocus?.(item.key);
                  onHover?.(item.key, event.currentTarget.getBoundingClientRect(), view, item.alias);
                }}
                onBlur={() => { onFocus?.(null); onHover?.(null, null, null, item.alias); }}
                onClick={() => { if (view) onOpen?.(view); }}
                onKeyDown={(event) => {
                  if (view && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onOpen?.(view);
                  }
                }}
              >
                {/* The native `title` IS KEPT: it is the screen reader's fallback. The balloon
                    is added, not a replacement. */}
                <title>{detalle}</title>
                <circle className="lhg-bot-hit" r={r + 8} />
                {view ? null : <circle className="lhg-bot-unknown-ring" r={r + 3} />}
                <foreignObject x={-r} y={-r} width={r * 2} height={r * 2}>
                  <div className="lhg-bot-avatar" data-tone={meta.tone} data-unknown={view ? undefined : 'true'}>
                    <AgentAvatar
                      state={estado === 'unknown' ? 'idle' : estado}
                      overloaded={view?.overloaded ?? false}
                      label={item.alias}
                    />
                  </div>
                </foreignObject>
                <text className="lhg-bot-name" y={r + 16} textAnchor="middle">{item.alias}</text>
                {/* The WORD, always. Color alone does not distinguish free from dead, and the
                    measured normal state of this fleet is fifteen aliases with no work: if that
                    reads as a dead fleet, the view fails on exactly the day everything is fine. */}
                <text className="lhg-bot-word" y={r + 30} textAnchor="middle">{WORD[estado]}</text>
                {view && view.queued > 0 ? (
                  <g className="lhg-bot-queue" transform={`translate(${String(r - 4)} ${String(-r + 4)})`}>
                    <circle r="10" />
                    <text textAnchor="middle" dy="3.5">{view.queued > 99 ? '99+' : String(view.queued)}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      </Desplazable>

      {layer === 'permisos' ? (
        <p className="lhg-legend">
          Capa de <strong>permisos</strong>: cada flecha violeta es una <strong>arista ACL</strong> entre
          clientes —quién <em>puede</em> hablarle a quién—, no una entrega. Los cruces que nadie declaró
          no aparecen porque quedan <strong>denegados por defecto</strong> en el servidor. Las salas y las
          posiciones son las mismas que en «Ahora»: lo único que cambia es qué une a los muñecos.
        </p>
      ) : (
        <p className="lhg-legend">
          Cada región es una <strong>sala</strong> y envuelve a todos sus miembros a la vez; un muñeco
          en dos regiones es un <strong>puente</strong>. Cada flecha es una{' '}
          <strong>delegación con entrega en vuelo real</strong>, con el grosor por volumen y en{' '}
          <strong>ámbar</strong> cuando pasa el umbral del servidor ({Math.round(stallAfter)} s). El
          número en la esquina es cuántos <strong>esperan turno</strong> detrás.{' '}
          {maxClosed === null
            ? 'Tamaño uniforme: el servidor no informa el cierre de 24 h, así que no hay nada que escalar.'
            : 'El tamaño del muñeco es el trabajo que cerró en 24 h.'}
        </p>
      )}
      {sinSala.length > 0 ? (
        <p className="lhg-note">
          {sinSala.length} agente{sinSala.length === 1 ? '' : 's'} sin sala declarada
          ({sinSala.join(', ')}): no se dibuja{sinSala.length === 1 ? '' : 'n'} porque no habría dónde
          ponerlo sin inventarlo. Aparece{sinSala.length === 1 ? '' : 'n'} igual en la lista de abajo.
        </p>
      ) : null}
    </div>
  );
}
