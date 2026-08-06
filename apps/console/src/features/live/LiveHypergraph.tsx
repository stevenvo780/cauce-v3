import { useMemo } from 'react';
import type { TopologySnapshot } from '../../api/types';
import { AgentAvatar } from './AgentAvatar';
import { LIVE_STATE_META, type DelegationEdge, type LiveAgentView } from './agent-state';
import { layoutHypergraph, type HyperGraphModel, type Point } from '../topology/hypergraph-layout';

/**
 * El hipergrafo VIVO: los muñecos de la sala de máquinas, colocados dentro de la sala a la que
 * pertenecen, con las delegaciones reales viajando entre ellos.
 *
 * Por qué esto y no dos vistas separadas: la sala de máquinas ya decía *cómo está* cada agente, y
 * el hipergrafo de topología ya decía *quién está con quién*, pero ninguna de las dos respondía la
 * pregunta que de verdad se hace uno mirando la flota — **quién le está pasando trabajo a quién
 * ahora mismo, y dentro de qué grupo**. Esa pregunta necesita las dos capas a la vez.
 *
 * Una *room* se dibuja como una región que envuelve a todos sus miembros, no como líneas de a
 * pares: en Cauce una sala relaciona a N agentes simultáneamente, y un alias que aparece en dos
 * regiones es un puente entre salas. Las flechas quedan reservadas para lo que sí es de a dos y
 * tiene sentido: una delegación concreta, con su entrega en vuelo.
 *
 * Honestidad, que acá importa más que el dibujo: **una flecha solo existe si hay una entrega en
 * vuelo de verdad** (`delegationEdges` las deriva de `in_flight_items`, no las inventa), y un
 * agente que la topología declara pero que no está en la actividad se dibuja **apagado y marcado
 * como desconocido**, nunca como sano. Un panel bonito que rellena huecos es peor que una tabla,
 * porque parece completo.
 */

/** Radio del muñeco dentro del lienzo del grafo. */
const AVATAR = 26;

/**
 * Lo que ocupa un muñeco de verdad, medido desde su centro.
 *
 * No es `AVATAR`. Debajo cuelga el nombre (14 px, hasta ~8 caracteres) y arriba a la derecha
 * asoma el globo de la cola (r=10 desplazado 22 px). Separar por el radio del avatar dejaba
 * `zeus` encima de `argos`: los círculos no se tocaban, los nombres sí. Estos tres números son los
 * que el layout usa para garantizar —y el test para afirmar— que ningún par de muñecos se pisa.
 */
const FOOTPRINT = { halfWidth: 41, top: -38, bottom: 55 } as const;

/**
 * El lienzo crece con la flota en vez de ser una constante.
 *
 * 1040×660 alcanzaba para seis alias y quedaba chico para quince: los muñecos entraban, pero
 * hombro con hombro, y "no se solapan" no es lo mismo que "se leen". Ocho alias caben cómodos en el
 * lienzo base; a partir de ahí se ensancha 40 px por alias, con un techo para que en una pantalla
 * normal el dibujo no obligue a desplazarse para ver la mitad derecha.
 */
function canvasFor(nodeCount: number): { width: number; height: number } {
  const width = Math.min(1760, 1240 + Math.max(0, nodeCount - 8) * 40);
  return { width, height: Math.round(width / 1.6 / 10) * 10 };
}

/** Cuántos alias distintos declara la topología. Se necesita antes del layout para dimensionarlo. */
function countAliases(topology: TopologySnapshot | undefined): number {
  const seen = new Set<string>();
  for (const tenant of topology?.tenants ?? []) {
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) if (member.alias) seen.add(member.alias);
    }
  }
  return seen.size;
}

export interface LiveHypergraphProps {
  topology: TopologySnapshot | undefined;
  views: readonly LiveAgentView[];
  edges: readonly DelegationEdge[];
  /** Alias resaltado (hover/foco en la lista de al lado), en formato `tenant/alias`. */
  focusKey?: string | null;
  /** Filtro por estado: sólo estos alias quedan a plena intensidad. `null`/ausente = todos. */
  spotlight?: Set<string> | null;
  /** La topología todavía está en vuelo. Sin esto, "aún no llegó" se anunciaría como UNKNOWN. */
  loadingTopology?: boolean;
  onFocus?: (key: string | null) => void;
  onOpen?: (view: LiveAgentView) => void;
}

interface Placed {
  key: string;
  alias: string;
  tenantId: string;
  point: Point;
  view: LiveAgentView | null;
}

export function LiveHypergraph({ topology, views, edges, focusKey, spotlight, loadingTopology, onFocus, onOpen }: LiveHypergraphProps) {
  const byKey = useMemo(() => new Map(views.map((view) => [view.key, view])), [views]);

  // El layout es determinista y caro: depende SOLO de la topología, así que se recalcula cuando
  // cambian las salas — no en cada refresco de actividad. Si dependiera de la actividad, los
  // muñecos saltarían de lugar cada diez segundos y sería imposible seguir a nadie con la vista.
  const model: HyperGraphModel = useMemo(
    () => {
      const canvas = canvasFor(countAliases(topology));
      return layoutHypergraph(topology, {
        ...canvas,
        padding: 52,
        // La relajación apunta a la diagonal de la caja del nodo; la pasada de separación final
        // garantiza el resto. Pedirle sólo el radio del avatar era el bug.
        nodeSpacing: Math.hypot(FOOTPRINT.halfWidth * 2, FOOTPRINT.bottom - FOOTPRINT.top),
        footprint: FOOTPRINT,
        labelBand: 30,
      });
    },
    [topology],
  );

  const placed = useMemo<Placed[]>(() => model.nodes.map((node) => {
    const tenantId = node.tenants[0] ?? '';
    const key = `${tenantId}/${node.alias}`;
    return { key, alias: node.alias, tenantId, point: { x: node.x, y: node.y }, view: byKey.get(key) ?? null };
  }), [model, byKey]);

  const position = useMemo(() => new Map(placed.map((item) => [item.key, item.point])), [placed]);

  // Agentes que la actividad reporta pero que ninguna sala declara: no tienen lugar en el dibujo.
  // Se cuentan y se declaran abajo en vez de inventarles una posición.
  const sinSala = useMemo(
    () => views.filter((view) => !position.has(view.key)).map((view) => view.alias),
    [views, position],
  );

  if (model.edges.length === 0) {
    // "Todavía no llegó" y "el servidor no informó nada" no son lo mismo, y confundirlos hace que
    // la vista afirme UNKNOWN durante los cuatro segundos que tarda la topología en cargar. Un
    // panel que declara desconocido lo que simplemente no pidió todavía miente, aunque se corrija
    // solo un segundo después.
    return loadingTopology ? (
      <p className="lhg-empty">Leyendo las salas de la topología…</p>
    ) : (
      <p className="lhg-empty">
        El control plane todavía no informó ninguna sala, así que no hay grupos que dibujar. La
        topología es <strong>UNKNOWN</strong>; los muñecos siguen abajo, en la lista.
      </p>
    );
  }

  const vivas = edges.filter((edge) => position.has(edge.from) && position.has(edge.to));
  // Dos motivos para atenuar, y se combinan: el foco (un alias y con quién habla) y el filtro por
  // estado de los chips de arriba. Si hay foco manda el foco, porque es una acción del operador
  // sobre un filtro que ya estaba puesto.
  const activos = new Set<string>();
  if (focusKey) {
    activos.add(focusKey);
    for (const edge of vivas) {
      if (edge.from === focusKey) activos.add(edge.to);
      if (edge.to === focusKey) activos.add(edge.from);
    }
  } else if (spotlight) {
    for (const key of spotlight) activos.add(key);
  }
  const atenuando = activos.size > 0;

  const trabajando = placed.filter((item) => item.view && item.view.state !== 'idle' && item.view.state !== 'down').length;
  const descripcion = `Hipergrafo vivo: ${placed.length} agentes en ${model.edges.length} salas. `
    + `${trabajando} con trabajo en curso. ${vivas.length} delegaciones en vuelo ahora mismo.`;

  return (
    <div className={`lhg${atenuando ? ' is-focusing' : ''}`}>
      <div className="lhg-scroll">
      <svg
        className="lhg-svg"
        viewBox={`0 0 ${model.width} ${model.height}`}
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

        {/* Capa 1 — las salas. Al fondo: los muñecos tienen que leerse siempre por encima. */}
        <g className="lhg-rooms">
          {model.edges.map((room) => (
            <g className={`lhg-room lhg-hue-${room.hue}`} key={room.key}>
              <title>{`#${room.roomLabel ?? 'ROOM UNKNOWN'} — ${room.members.length} miembros`}</title>
              <path className="lhg-room-fill" d={room.outline} />
              <path className="lhg-room-line" d={room.outline} />
              {/* En el BORDE de arriba, nunca en el centroide: el centroide es donde están los
                  muñecos. `labelAnchor` ya viene separado de todo nodo y de toda otra etiqueta. */}
              <text className="lhg-room-label" x={room.labelAnchor.x} y={room.labelAnchor.y} textAnchor="middle">
                #{room.roomLabel ?? 'UNKNOWN'}
              </text>
            </g>
          ))}
        </g>

        {/* Capa 2 — delegaciones vivas. Cada flecha es una entrega real en vuelo. */}
        <g className="lhg-flows">
          {vivas.map((edge, index) => {
            const a = position.get(edge.from) as Point;
            const b = position.get(edge.to) as Point;
            const geo = curva(a, b, index);
            const dim = atenuando && !(activos.has(edge.from) && activos.has(edge.to));
            const lento = (edge.secondsInFlight ?? 0) > 300;
            return (
              <g className={`lhg-flow${dim ? ' is-dim' : ''}${lento ? ' is-slow' : ''}`} key={`${edge.from}->${edge.to}:${edge.deliveryId ?? index}`}>
                <title>
                  {`${aliasDe(edge.from)} → ${aliasDe(edge.to)}`}
                  {edge.secondsInFlight != null ? ` · ${Math.round(edge.secondsInFlight)} s en vuelo` : ''}
                  {lento ? ' · lleva demasiado' : ''}
                </title>
                <path className="lhg-flow-line" d={geo.path} markerEnd="url(#lhg-arrow)" />
                {/* El punto que viaja: muestra el SENTIDO, que una flecha quieta no comunica. */}
                <circle className="lhg-flow-dot" r="4">
                  <animateMotion dur={lento ? '5.5s' : '2.6s'} repeatCount="indefinite" path={geo.path} />
                </circle>
              </g>
            );
          })}
        </g>

        {/* Capa 3 — los muñecos. */}
        <g className="lhg-bots">
          {placed.map((item) => {
            const view = item.view;
            const estado = view?.state ?? 'down';
            const meta = LIVE_STATE_META[estado];
            const dim = atenuando && !activos.has(item.key);
            const detalle = view
              ? `${item.alias} — ${meta.label}: ${view.reason}`
              : `${item.alias} — la actividad no lo reporta: estado UNKNOWN. No se asume que esté sano.`;
            return (
              <g
                key={item.key}
                className={`lhg-bot${dim ? ' is-dim' : ''}${focusKey === item.key ? ' is-active' : ''}${view ? '' : ' is-unknown'}`}
                transform={`translate(${item.point.x} ${item.point.y})`}
                tabIndex={0}
                role="button"
                aria-label={detalle}
                onMouseEnter={() => onFocus?.(item.key)}
                onMouseLeave={() => onFocus?.(null)}
                onFocus={() => onFocus?.(item.key)}
                onBlur={() => onFocus?.(null)}
                onClick={() => view && onOpen?.(view)}
                onKeyDown={(event) => {
                  if (view && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onOpen?.(view);
                  }
                }}
              >
                <title>{detalle}</title>
                <circle className="lhg-bot-hit" r={AVATAR + 8} />
                {/* Anillo punteado = la topología lo declara y la actividad no lo reporta. Antes
                    esto se comunicaba bajando la opacidad al 38 %, y el resultado era que no se
                    leía. La marca va en el CONTORNO; el nombre se deja legible. */}
                {view ? null : <circle className="lhg-bot-unknown-ring" r={AVATAR + 3} />}
                <foreignObject x={-AVATAR} y={-AVATAR} width={AVATAR * 2} height={AVATAR * 2}>
                  <div className="lhg-bot-avatar" data-tone={meta.tone}>
                    <AgentAvatar state={estado} overloaded={view?.overloaded ?? false} label={item.alias} />
                  </div>
                </foreignObject>
                <text className="lhg-bot-name" y={AVATAR + 16} textAnchor="middle">{item.alias}</text>
                {view && view.queued > 0 ? (
                  <g className="lhg-bot-queue" transform={`translate(${AVATAR - 4} ${-AVATAR + 4})`}>
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

      <p className="lhg-legend">
        Cada región es una <strong>sala</strong> y envuelve a todos sus miembros a la vez; un muñeco
        dentro de dos regiones es un <strong>puente</strong> entre salas. Cada flecha es una
        <strong> delegación con entrega en vuelo real</strong> — si no hay flecha, nadie se está
        pasando trabajo. El número en la esquina del muñeco es su <strong>cola</strong>; las flechas
        en ámbar llevan más de 5 minutos.
      </p>
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

function aliasDe(key: string): string {
  const corte = key.indexOf('/');
  return corte === -1 ? key : key.slice(corte + 1);
}

/**
 * Curva entre dos muñecos, recortada para nacer y morir en el borde del avatar y no debajo de él.
 *
 * `index` desplaza la comba: dos delegaciones simultáneas entre el mismo par —que existen, porque
 * un agente puede mandarle varias entregas a otro— tienen que verse como dos, no como una.
 */
function curva(a: Point, b: Point, index: number): { path: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const largo = Math.hypot(dx, dy) || 1;
  const ux = dx / largo;
  const uy = dy / largo;
  const margen = AVATAR + 10;
  const desde = { x: a.x + ux * margen, y: a.y + uy * margen };
  const hasta = { x: b.x - ux * margen, y: b.y - uy * margen };
  const comba = 26 + (index % 3) * 20;
  const control = {
    x: (desde.x + hasta.x) / 2 - uy * comba,
    y: (desde.y + hasta.y) / 2 + ux * comba,
  };
  const r = (n: number) => Math.round(n * 100) / 100;
  return { path: `M ${r(desde.x)} ${r(desde.y)} Q ${r(control.x)} ${r(control.y)} ${r(hasta.x)} ${r(hasta.y)}` };
}
