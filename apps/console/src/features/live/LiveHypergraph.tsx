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
} from '../topology/hypergraph-layout';
import type { FleetDelegationEdge } from '../../api/types';
import { FlowArrow } from './live-hypergraph/FlowArrow';

/**
 * El mapa: los muñecos de la flota colocados en su sala, con lo que se están pasando entre manos.
 *
 * Es el centro de la vista y responde una sola pregunta —*quién le está pasando trabajo a quién,
 * ahora*—, pero admite conmutar a una segunda capa, *quién tiene PERMISO de hablarle a quién*.
 * Nunca las dos a la vez: las flechas no significan lo mismo (una es una entrega real en vuelo, la
 * otra es una arista ACL) y superponerlas obliga a que la lectura de una de las dos empeore. Con
 * el conmutador, las salas y las posiciones no se mueven: cambia sólo lo que las une, así que la
 * comparación entre "puede" y "está" se hace con los ojos, sin volver a buscar a nadie.
 *
 * Honestidad, que acá pesa más que el dibujo:
 *  - una flecha existe sólo si hay una entrega en vuelo de verdad (`delegationEdges` las deriva de
 *    `in_flight_items`; no se inventa ninguna);
 *  - un alias que la topología declara y la actividad no reporta se dibuja **sin reportar**, con
 *    su anillo punteado y la palabra escrita;
 *  - si el servidor no informa el trabajo cerrado en 24 h, TODOS los muñecos miden lo mismo y la
 *    leyenda lo dice, en vez de dibujar un cero que nadie midió.
 */

/**
 * Lo que ocupa un muñeco de verdad, medido desde su centro, con el radio MÁXIMO.
 *
 * Se calcula con 34 y no con el radio de cada nodo a propósito: el layout se resuelve una vez, con
 * la topología, y no puede depender de un tamaño que cambia con la actividad — si dependiera, los
 * muñecos saltarían de sitio cada vez que alguien cierra un encargo. Reservar siempre el hueco del
 * más grande cuesta un poco de aire y garantiza que ningún par se pise nunca.
 */
const FOOTPRINT = { halfWidth: 44, top: -40, bottom: 62 } as const;

/** Ancho del pasillo de la izquierda donde viven los nodos «persona», fuera de toda sala. */
const GUTTER = 132;

/** Separación mínima entre dos nodos persona, para que sus nombres no se pisen. */
const GUTTER_GAP = 62;

/** Estado de RENDER, no del sistema. `unknown` no es un octavo estado: es la ausencia de los siete. */
type NodeState = LiveState | 'unknown';

/** La palabra que va SIEMPRE debajo del alias. El color solo no alcanza para distinguir libre de muerto. */
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

export interface LiveHypergraphProps {
  topology: TopologySnapshot | undefined;
  views: readonly LiveAgentView[];
  edges: readonly DelegationEdge[];
  /** Agregado por par que informa el servidor. Ausente hasta que la fase de backend se despliegue. */
  serverEdges?: readonly FleetDelegationEdge[] | null;
  /** Umbrales del SERVIDOR. El ámbar de una flecha sale de acá, nunca de un 300 escrito a mano. */
  thresholds?: FleetActivityThresholds | null;
  /** Encargos que entraron por un puente humano, para dibujar el nodo persona fuera de las salas. */
  origins?: readonly HumanOrigin[];
  layer?: HypergraphLayer;
  focusKey?: string | null;
  spotlight?: Set<string> | null;
  loadingTopology?: boolean;
  /**
   * La lectura de la topología FALLÓ. Es distinto de "no hay salas", y hasta ahora se veían igual:
   * el mismo cartel de «el control plane todavía no informó ninguna sala» cubría los dos casos, así
   * que un `GET /v3/console/topology` caído se leía como una flota sin configurar.
   */
  topologyError?: Error | null;
  onRetryTopology?: () => void;
  onFocus?: (key: string | null) => void;
  onOpen?: (view: LiveAgentView) => void;
  /** Rectángulo del nodo en coordenadas de viewport, para colgarle el globo desde la página. */
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

  // El layout depende SOLO de la topología. Es lo que hace que los muñecos no salten de sitio en
  // cada refresco: si dependiera de la actividad sería imposible seguir a nadie con la vista, y un
  // mapa que se reordena solo cada cuatro segundos no es un mapa.
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

  // `null` = ningún agente trae el campo. Distinto de `0` = todos cerraron cero.
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
   * Los nodos persona, en el pasillo de la izquierda.
   *
   * Se colocan a la altura de su agente y después se separan en una pasada secuencial, así que la
   * posición es determinista: dos refrescos con los mismos datos dan el mismo dibujo. Van FUERA de
   * las regiones porque una persona no es miembro de ninguna sala, y meterla dentro sería el mismo
   * tipo de mentira que dibujar una flecha que nadie mandó.
   */
  const personas = useMemo(() => {
    const lista = (origins ?? [])
      .filter((origin) => position.has(origin.agentKey))
      .map((origin) => ({ ...origin, y: position.get(origin.agentKey)!.y }))
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
    ? `${-GUTTER} 0 ${model.width + GUTTER} ${model.height}`
    : `0 0 ${model.width} ${model.height}`;

  /**
   * SMIL no lo apaga el CSS.
   *
   * `prefers-reduced-motion` frena animaciones CSS, y `<animateMotion>` no es una: hay que
   * preguntarlo desde JS o esta vista incumple lo que el resto de la consola ya respeta. Con el
   * ajuste puesto, el punto se queda quieto a mitad de la curva en vez de desaparecer: una flecha
   * viva tiene que seguir distinguiéndose de una muerta sin depender del movimiento.
   */
  const animar = useMemo(() => {
    try {
      return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
        El control plane todavía no informó ninguna sala, así que no hay grupos que dibujar. La
        topología no se pudo leer; los muñecos siguen abajo, en la lista.
      </p>
    );
  }

  const vivas = [...agregadas.values()].filter((edge) => position.has(edge.from) && position.has(edge.to));
  const maxTotal = vivas.reduce((max, edge) => Math.max(max, edge.total), 1);
  const stallAfter = thresholds?.stall_after_seconds ?? 300;

  /**
   * El foco suma al filtro activo en vez de reemplazarlo.
   */
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
  // Un `Set` vacío es truthy: hay filtro puesto aunque no case con nadie, y ahí TODO va atenuado.
  const atenuando = Boolean(spotlight) || Boolean(focusKey);

  const trabajando = placed.filter((item) => item.view && item.view.state !== 'idle' && item.view.state !== 'down').length;
  const descripcion = layer === 'permisos'
    ? `Mapa de permisos: ${placed.length} agentes en ${model.edges.length} salas y ${model.arcs.length} aristas ACL entre clientes.`
    : `Mapa vivo: ${placed.length} agentes en ${model.edges.length} salas. ${trabajando} con trabajo en curso. `
      + `${vivas.length} delegaciones en vuelo ahora mismo.`;

  return (
    <div className={`lhg${atenuando ? ' is-focusing' : ''}`} data-layer={layer}>
      <div className="lhg-scroll">
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

        {/* Capa 1 — las salas. Al fondo: los muñecos se leen siempre por encima. */}
        <g className="lhg-rooms">
          {model.edges.map((room) => (
            <g className={`lhg-room lhg-hue-${room.hue}`} key={room.key}>
              <title>{`#${room.roomLabel ?? 'sala sin nombre'} — ${room.members.length} miembros`}</title>
              <path className="lhg-room-fill" d={room.outline} />
              <path className="lhg-room-line" d={room.outline} />
              <text className="lhg-room-label" x={room.labelAnchor.x} y={room.labelAnchor.y} textAnchor="middle">
                #{room.roomLabel ?? 'sala sin nombre'}
              </text>
            </g>
          ))}
        </g>

        {/* Capa 2 — o las delegaciones vivas, o los permisos. Nunca las dos. */}
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
            {vivas.map((edge, index) => (
              <FlowArrow
                key={edgePairKey(edge.from, edge.to)}
                edge={edge}
                index={index}
                from={position.get(edge.from) as Point}
                to={position.get(edge.to) as Point}
                fromRadius={radios.get(edge.from) ?? AVATAR_UNIFORME}
                toRadius={radios.get(edge.to) ?? AVATAR_UNIFORME}
                width={grosorDe(edge.total, maxTotal)}
                lento={(edge.oldestSeconds ?? 0) > stallAfter}
                dim={atenuando && !(activos.has(edge.from) && activos.has(edge.to))}
                animar={animar}
              />
            ))}
          </g>
        )}

        {/* Capa 3 — las personas, en el pasillo, con hilo punteado a su agente. */}
        {layer === 'ahora' ? (
          <g className="lhg-humans">
            {personas.map((persona) => {
              const destino = position.get(persona.agentKey) as Point;
              const x = -GUTTER / 2;
              return (
                <g className="lhg-human" key={`${persona.agentKey}|${persona.adapter}`}>
                  <title>
                    {`Una persona, por ${persona.adapter} → ${aliasDe(persona.agentKey)}`}
                    {` · ${persona.count} ${persona.count === 1 ? 'encargo' : 'encargos'} en vuelo`}
                  </title>
                  <path className="lhg-human-line" d={`M ${x + 22} ${persona.y} L ${destino.x - 40} ${destino.y}`} />
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

        {/* Capa 4 — los muñecos. */}
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
                // El veredicto usa esta clave para traer al muñeco culpable a la vista.
                data-agent-key={item.key}
                transform={`translate(${item.point.x} ${item.point.y})`}
                tabIndex={0}
                role="button"
                aria-label={detalle}
                onMouseEnter={(event) => {
                  onFocus?.(item.key);
                  onHover?.(item.key, event.currentTarget.getBoundingClientRect(), view, item.alias);
                }}
                onMouseLeave={() => { onFocus?.(null); onHover?.(null, null, null, item.alias); }}
                // El globo tiene que abrirse también al TABULAR, no sólo al pasar el ratón: el mapa
                // se recorre con el teclado y ahí es donde el `title` nativo nunca aparecía.
                onFocus={(event) => {
                  onFocus?.(item.key);
                  onHover?.(item.key, event.currentTarget.getBoundingClientRect(), view, item.alias);
                }}
                onBlur={() => { onFocus?.(null); onHover?.(null, null, null, item.alias); }}
                onClick={() => view && onOpen?.(view)}
                onKeyDown={(event) => {
                  if (view && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onOpen?.(view);
                  }
                }}
              >
                {/* El `title` nativo SE CONSERVA: es el respaldo del lector de pantalla. El globo
                    se suma, no lo reemplaza. */}
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
                {/* La PALABRA, siempre. El color solo no distingue libre de muerto, y el estado
                    normal medido de esta flota son quince alias sin trabajo: si eso se lee como
                    flota muerta, la vista falla justo el día que todo está bien. */}
                <text className="lhg-bot-word" y={r + 30} textAnchor="middle">{WORD[estado]}</text>
                {view && view.queued > 0 ? (
                  <g className="lhg-bot-queue" transform={`translate(${r - 4} ${-r + 4})`}>
                    <circle r="10" />
                    <text textAnchor="middle" dy="3.5">{view.queued > 99 ? '99+' : view.queued}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      </div>

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
