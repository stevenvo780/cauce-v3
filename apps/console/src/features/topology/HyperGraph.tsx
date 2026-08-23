import { useId, useMemo, useState } from 'react';
import type { TopologySnapshot } from '../../api/types';
import { aclCaption, layoutHypergraph, type HyperEdge, type HyperNode } from './hypergraph-layout';

/**
 * Hipergrafo de la topología: tenants, rooms y ACL dibujados como lo que son.
 *
 * Cada *room* es una hiperarista — una región que envuelve a **todos** sus miembros a la vez — y
 * cada alias es un nodo que existe una sola vez aunque pertenezca a varias rooms. Donde dos
 * regiones se solapan hay un alias que hace de puente entre salas; ese cruce se ve solo, sin
 * tener que calcularlo ni etiquetarlo.
 *
 * Lo que este dibujo NO hace: inventar. Un miembro sin alias se cuenta y se declara, no se pinta;
 * una arista ACL hacia un tenant que la topología no describe no se traza (queda en la tabla de
 * abajo); `enabled` ausente se muestra como UNKNOWN y nunca como habilitado. Un gráfico que
 * rellena huecos es más peligroso que una tabla, porque parece completo.
 *
 * El SVG es decorativo a efectos de accesibilidad (`role="img"` con descripción): la fuente
 * verificable siguen siendo las tablas de `TopologyPage`, que quedan debajo y no se tocan.
 */

const HUES = 6;

export function HyperGraph({ snapshot }: { snapshot: TopologySnapshot | undefined }) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [activeEdge, setActiveEdge] = useState<string | null>(null);

  // El layout es caro (relajación de N pasos) y determinista: se recalcula solo cuando cambian
  // los datos, nunca al pasar el mouse. Si se recalculara en cada hover, el grafo "temblaría".
  const model = useMemo(() => layoutHypergraph(snapshot), [snapshot]);

  if (model.edges.length === 0) {
    return (
      <p className="hg-empty">
        Sin rooms informadas por el control plane: no hay hipergrafo que dibujar. La topología no se pudo leer.
      </p>
    );
  }

  const highlightedEdges = new Set<string>();
  const highlightedNodes = new Set<string>();
  if (activeNode) {
    const node = model.nodes.find((candidate) => candidate.alias === activeNode);
    if (node) {
      highlightedNodes.add(node.alias);
      for (const key of node.edges) highlightedEdges.add(key);
    }
  }
  if (activeEdge) {
    highlightedEdges.add(activeEdge);
    const edge = model.edges.find((candidate) => candidate.key === activeEdge);
    for (const alias of edge?.members ?? []) highlightedNodes.add(alias);
  }
  const dimming = highlightedEdges.size > 0 || highlightedNodes.size > 0;

  const bridges = model.nodes.filter((node) => node.edges.length > 1).length;
  const description = `Hipergrafo de topología: ${model.tenants.length} tenants, ${model.edges.length} rooms `
    + `y ${model.nodes.length} alias. ${bridges} alias pertenecen a más de una room. `
    + `${model.arcs.length} aristas ACL dibujadas entre tenants. `
    + 'El detalle verificable está en las tablas siguientes.';

  return (
    <div className={`hg-wrap${dimming ? ' is-focusing' : ''}`}>
      <svg
        className="hg-svg"
        viewBox={`0 0 ${model.width} ${model.height}`}
        role="img"
        aria-label={description}
        preserveAspectRatio="xMidYMid meet"
      >
        <desc>{description}</desc>
        <defs>
          {Array.from({ length: HUES }, (_, hue) => (
            <radialGradient id={`${uid}-fill-${hue}`} key={hue} cx="50%" cy="42%" r="72%">
              <stop offset="0%" stopColor={`var(--hg-${hue})`} stopOpacity="0.30" />
              <stop offset="100%" stopColor={`var(--hg-${hue})`} stopOpacity="0.07" />
            </radialGradient>
          ))}
          <filter id={`${uid}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id={`${uid}-arrow`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* Capa 1 — hiperaristas. Van al fondo para que los nodos siempre queden legibles encima. */}
        <g className="hg-layer hg-edges">
          {model.edges.map((edge) => (
            <EdgeShape
              key={edge.key}
              edge={edge}
              uid={uid}
              active={highlightedEdges.has(edge.key)}
              dimmed={dimming && !highlightedEdges.has(edge.key)}
              onEnter={() => setActiveEdge(edge.key)}
              onLeave={() => setActiveEdge(null)}
            />
          ))}
        </g>

        {/* Capa 2 — ACL entre tenants. Esta sí es binaria y dirigida, por eso es una flecha. */}
        <g className="hg-layer hg-arcs">
          {model.arcs.map((arc) => {
            const tone = arc.enabled === true ? 'ok' : arc.enabled === false ? 'off' : 'unknown';
            return (
              <g className={`hg-arc is-${tone}`} key={arc.key}>
                <path d={arc.path} markerEnd={`url(#${uid}-arrow)`} />
                {arc.enabled === true ? <path className="hg-arc-flow" d={arc.path} /> : null}
                {/* El texto sale de `aclCaption`, el mismo que el layout usó para medir su ancho al
                    repartir las etiquetas. Escribir otro acá reintroduciría los solapamientos. */}
                <text x={arc.labelAnchor.x} y={arc.labelAnchor.y} textAnchor="middle">
                  {aclCaption(arc)}
                </text>
              </g>
            );
          })}
        </g>

        {/* Capa 3 — alias. */}
        <g className="hg-layer hg-nodes">
          {model.nodes.map((node) => (
            <NodeShape
              key={node.alias}
              node={node}
              uid={uid}
              active={highlightedNodes.has(node.alias)}
              dimmed={dimming && !highlightedNodes.has(node.alias)}
              onEnter={() => setActiveNode(node.alias)}
              onLeave={() => setActiveNode(null)}
            />
          ))}
        </g>

        {/* Capa 4 — nombres de tenant, encima de todo pero sin capturar el puntero. */}
        <g className="hg-layer hg-tenant-labels" aria-hidden="true">
          {model.tenants.map((tenant) => (
            <text
              key={tenant.id}
              className={`hg-tenant hg-hue-${tenant.hue}`}
              x={tenant.labelAnchor.x}
              y={tenant.labelAnchor.y}
              textAnchor="middle"
            >
              {tenant.label ?? tenant.id}
            </text>
          ))}
        </g>
      </svg>

      <p className="hg-legend">
        Cada región es una <strong>room</strong>: contiene a todos sus miembros a la vez, no de a pares.
        Un alias dentro de dos regiones es un <strong>puente</strong> entre salas ({bridges} de {model.nodes.length}).
        Las flechas son aristas <strong>ACL</strong> entre tenants; los cruces ausentes siguen denegados por
        default en el backend. Pasá el puntero (o tabulá) por un alias para aislar sus salas.
      </p>
      {model.emptyEdges.length > 0 ? (
        <p className="hg-note">
          {model.emptyEdges.length} room{model.emptyEdges.length === 1 ? '' : 's'} sin miembros informados: se
          dibuja{model.emptyEdges.length === 1 ? '' : 'n'} como región vacía en vez de omitirse, para que no
          parezca{model.emptyEdges.length === 1 ? '' : 'n'} inexistente{model.emptyEdges.length === 1 ? '' : 's'}.
        </p>
      ) : null}
    </div>
  );
}

function EdgeShape({ edge, uid, active, dimmed, onEnter, onLeave }: {
  edge: HyperEdge;
  uid: string;
  active: boolean;
  dimmed: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const label = edge.roomLabel ?? 'sala sin nombre';
  const unknownSuffix = edge.unknownMembers > 0 ? ` · ${edge.unknownMembers} sin alias` : '';
  return (
    <g
      className={`hg-edge hg-hue-${edge.hue}${active ? ' is-active' : ''}${dimmed ? ' is-dim' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <title>{`#${label} — ${edge.members.length} miembro${edge.members.length === 1 ? '' : 's'}${unknownSuffix}`}</title>
      <path className="hg-edge-fill" d={edge.outline} fill={`url(#${uid}-fill-${edge.hue})`} />
      <path className="hg-edge-line" d={edge.outline} />
      {/* Sobre el borde de la región, NO en su centroide: el centroide es exactamente donde están
          los nodos, así que la etiqueta caía siempre encima de alguno. */}
      <text className="hg-edge-label" x={edge.labelAnchor.x} y={edge.labelAnchor.y} textAnchor="middle">
        #{label}
      </text>
    </g>
  );
}

function NodeShape({ node, uid, active, dimmed, onEnter, onLeave }: {
  node: HyperNode;
  uid: string;
  active: boolean;
  dimmed: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const bridge = node.edges.length > 1;
  const state = node.enabled === false ? 'off' : node.enabled === true ? 'on' : 'unknown';
  const label = node.label ?? 'sin nombre';
  const detail = `${label} — ${node.edges.length} room${node.edges.length === 1 ? '' : 's'}`
    + `, tenant${node.tenants.length === 1 ? '' : 's'}: ${node.tenants.join(', ')}`
    + `, estado: ${state === 'on' ? 'habilitado' : state === 'off' ? 'deshabilitado' : 'sin dato'}`;

  return (
    <g
      className={`hg-node is-${state}${bridge ? ' is-bridge' : ''}${active ? ' is-active' : ''}${dimmed ? ' is-dim' : ''}`}
      transform={`translate(${node.x} ${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={detail}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <title>{detail}</title>
      {/* Área de puntero cómoda, invisible: sin esto hay que apuntar a un círculo de 9 px. */}
      <circle className="hg-node-hit" r="22" />
      {node.enabled !== false ? <circle className="hg-node-pulse" r="9" /> : null}
      <circle className="hg-node-dot" r="9" filter={active ? `url(#${uid}-glow)` : undefined} />
      {bridge ? <circle className="hg-node-ring" r="15" /> : null}
      <text className="hg-node-label" y="27" textAnchor="middle">{label}</text>
    </g>
  );
}
