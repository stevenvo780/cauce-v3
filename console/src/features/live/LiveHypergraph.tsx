import { useEffect, useMemo, useRef } from 'react';
import {
  ControlButton,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FleetActivityThresholds, TopologySnapshot } from '../../api/types';
import {
  aggregateEdges,
  type DelegationEdge,
  type HumanOrigin,
  type LiveAgentView,
} from './agent-state';
import { layoutHypergraph, type HyperGraphModel } from './hypergraph/hypergraph-layout';
import type { FleetDelegationEdge } from '../../api/types';
import { FleetGraphEdge } from './hypergraph/FleetGraphEdge';
import { FleetGraphNode } from './hypergraph/FleetGraphNode';
import {
  buildFleetGraph,
  topologySignature,
  type FleetGraphLayer,
  type FleetNode,
  type FleetEdge,
} from './hypergraph/fleet-graph-model';

const FOOTPRINT = { halfWidth: 92, top: -54, bottom: 68 } as const;
const NODE_TYPES = { fleet: FleetGraphNode, anchor: FleetGraphNode };
const EDGE_TYPES = { fleet: FleetGraphEdge };
const ARIA_LABEL_CONFIG = {
  'controls.ariaLabel': 'Controles del mapa de la flota',
  'controls.zoomIn.ariaLabel': 'Acercar mapa',
  'controls.zoomOut.ariaLabel': 'Alejar mapa',
  'controls.fitView.ariaLabel': 'Encuadrar todos los elementos',
  'node.a11yDescription.default': 'Pulsa Enter o espacio para activar; usa Escape para limpiar el foco.',
  'edge.a11yDescription.default': 'Arista del mapa de la flota.',
  'edge.a11yDescription.connection': 'Conexión del mapa de la flota.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) =>
    `Nodo seleccionado; ${direction} ${String(x)}, ${String(y)}.`,
} as const;

export type HypergraphLayer = FleetGraphLayer;

interface LiveHypergraphProps {
  topology: TopologySnapshot | undefined;
  views: readonly LiveAgentView[];
  edges: readonly DelegationEdge[];
  serverEdges?: readonly FleetDelegationEdge[] | null;
  thresholds?: FleetActivityThresholds | null;
  origins?: readonly HumanOrigin[];
  layer?: HypergraphLayer;
  focusKey?: string | null;
  spotlight?: Set<string> | null;
  loadingTopology?: boolean;
  topologyError?: Error | null;
  onRetryTopology?: () => void;
  onFocus?: (key: string | null) => void;
  onOpen?: (view: LiveAgentView) => void;
  onHover?: (key: string | null, anchor: DOMRect | null, view: LiveAgentView | null, alias: string) => void;
}

function canvasFor(nodeCount: number): { width: number; height: number } {
  const width = Math.min(1760, 1240 + Math.max(0, nodeCount - 8) * 40);
  return { width, height: Math.round(width / 1.6 / 10) * 10 };
}

function countAliases(topology: TopologySnapshot | undefined): number {
  const seen = new Set<string>();
  for (const tenant of topology?.tenants ?? []) {
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) if (member.alias) seen.add(`${tenant.id ?? ''}/${member.alias}`);
    }
  }
  return seen.size;
}

function FleetGraphControls() {
  const flow = useReactFlow<FleetNode, FleetEdge>();
  return (
    <Panel position="bottom-right" className="lhg-controls" aria-label="Controles del mapa">
      <ControlButton aria-label="Acercar mapa" title="Acercar mapa" onClick={() => { void flow.zoomIn({ duration: 160 }); }}>+</ControlButton>
      <ControlButton aria-label="Alejar mapa" title="Alejar mapa" onClick={() => { void flow.zoomOut({ duration: 160 }); }}>−</ControlButton>
      <ControlButton aria-label="Encuadrar todos los elementos" title="Encuadrar todos los elementos" onClick={() => { void flow.fitView({ duration: 220, padding: .12 }); }}>⌗</ControlButton>
    </Panel>
  );
}

function FleetGraphRegions({ model }: { model: HyperGraphModel }) {
  return (
    <ViewportPortal>
      <svg
        className="lhg-svg lhg-regions"
        width={model.width}
        height={model.height}
        viewBox={`0 0 ${String(model.width)} ${String(model.height)}`}
        aria-hidden="true"
      >
        <g className="lhg-rooms">
          {model.edges.map((room) => (
            <g className={`lhg-room lhg-hue-${String(room.hue)}`} key={room.key}>
              <path className="lhg-room-fill" d={room.outline} />
              <path className="lhg-room-line" d={room.outline} />
              <text className="lhg-room-label" x={room.labelAnchor.x} y={room.labelAnchor.y} textAnchor="middle">
                #{room.roomLabel ?? 'sala sin nombre'}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </ViewportPortal>
  );
}

function FleetGraphMap({ model, nodes, edges, signature, onRetryTopology }: {
  model: HyperGraphModel;
  nodes: FleetNode[];
  edges: FleetEdge[];
  signature: string;
  onRetryTopology?: () => void;
}) {
  const flow = useReactFlow<FleetNode, FleetEdge>();
  const flowWidth = useStore((state) => state.width);
  const flowHeight = useStore((state) => state.height);
  const viewportReady = useStore((state) => state.panZoom !== null);
  const fittedSignature = useRef<string | null>(null);
  useEffect(() => {
    const nodes = flow.getNodes();
    const knownDimensions = nodes.length > 0 && nodes.every((node) =>
      (node.measured?.width ?? node.width ?? 0) > 0 && (node.measured?.height ?? node.height ?? 0) > 0);
    if (!viewportReady || flowWidth <= 0 || flowHeight <= 0 || !knownDimensions || signature === fittedSignature.current) return;
    const firstAgent = flowWidth <= 760 ? nodes.find((node) => node.data.kind === 'agent') : undefined;
    const initialView = firstAgent
      ? flow.setCenter(firstAgent.position.x, firstAgent.position.y, { duration: 0, zoom: 1 })
      : flow.fitView({ duration: 0, padding: .12 });
    void initialView.then((fitted) => {
      if (fitted) fittedSignature.current = signature;
    });
  }, [flow, flowHeight, flowWidth, signature, viewportReady]);

  return (
    <div className="lhg-viewport" aria-label="Mapa interactivo de agentes y salas">
      <ReactFlow<FleetNode, FleetEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodeOrigin={[.5, .5]}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        selectionOnDrag={false}
        panOnDrag
        zoomOnPinch
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={.1}
        maxZoom={2}
        fitView={false}
        ariaLabelConfig={ARIA_LABEL_CONFIG}
        className="lhg-flow-canvas"
        aria-label="Mapa interactivo de salas, agentes y conexiones"
        proOptions={{ hideAttribution: true }}
      >
        <FleetGraphRegions model={model} />
        <FleetGraphControls />
        <Panel position="top-left" className="lhg-layer-badge" aria-live="polite">
          <span>{edges.some((edge) => edge.data?.kind === 'acl') ? 'Permisos entre tenants' : 'Actividad en vuelo'}</span>
          {flowWidth > 0 && flowWidth <= 760 ? <span className="lhg-mobile-hint">Vista ampliada · arrastra para explorar</span> : null}
        </Panel>
      </ReactFlow>
      {onRetryTopology ? <button type="button" className="lhg-retry" onClick={onRetryTopology}>Reintentar topología</button> : null}
    </div>
  );
}

export function LiveHypergraph({
  topology, views, edges, serverEdges, thresholds, origins, layer = 'ahora',
  focusKey, spotlight, loadingTopology, topologyError, onRetryTopology, onFocus, onOpen, onHover,
}: LiveHypergraphProps) {
  const model = useMemo(() => {
    const canvas = canvasFor(countAliases(topology));
    return layoutHypergraph(topology, {
      ...canvas, padding: 52, nodeSpacing: Math.hypot(FOOTPRINT.halfWidth * 2, FOOTPRINT.bottom - FOOTPRINT.top),
      footprint: FOOTPRINT, labelBand: 30,
    });
  }, [topology]);
  const graph = useMemo(() => buildFleetGraph({
    model, views, edges, serverEdges, origins, layer, focusKey, spotlight,
    stallAfterSeconds: thresholds?.stall_after_seconds,
    onFocus, onOpen, onHover,
  }), [model, views, edges, serverEdges, origins, layer, focusKey, spotlight,
    thresholds?.stall_after_seconds, onFocus, onOpen, onHover]);
  const signature = useMemo(() => topologySignature(model), [model]);

  const sinSala = useMemo(() => {
    const visible = new Set(model.nodes.map((node) => `${node.tenants[0] ?? ''}/${node.alias}`));
    return views.filter((view) => !visible.has(view.key)).map((view) => view.alias);
  }, [model, views]);
  const counts = useMemo(() => ({
    activity: [...aggregateEdges(edges, serverEdges).values()].filter((edge) => edge.inFlight > 0).length,
    acl: model.arcs.length,
    agents: model.nodes.length,
    rooms: model.edges.length,
  }), [edges, serverEdges, model]);

  if (model.edges.length === 0) {
    return (
      <div className="lhg lhg-empty-area" data-layer={layer}>
        {topologyError ? (
          <div className="lhg-empty" role="status">
            <p><strong>No se pudo leer la topología</strong> ({topologyError.message}). No se sabe qué salas hay.</p>
            {onRetryTopology ? <button type="button" className="button small secondary" onClick={onRetryTopology}>Reintentar la topología</button> : null}
          </div>
        ) : loadingTopology ? (
          <p className="lhg-empty" role="status">Leyendo las salas de la topología…</p>
        ) : (
          <p className="lhg-empty" role="status">El control plane informó cero salas. No hay regiones que mostrar; los agentes quedan en la lista.</p>
        )}
      </div>
    );
  }

  return (
    <div className="lhg" data-layer={layer}>
      <ReactFlowProvider>
        <FleetGraphMap model={model} nodes={graph.nodes} edges={graph.edges} signature={signature} />
      </ReactFlowProvider>
      <p className="lhg-summary">
        {String(counts.agents)} agentes · {String(counts.rooms)} salas · {layer === 'permisos'
          ? `${String(counts.acl)} relaciones ACL`
          : `${String(counts.activity)} conexiones activas`}
      </p>
      <p className="sr-only">
        {layer === 'permisos'
          ? 'La capa Permisos muestra aristas ACL entre tenants; no representa actividad y deniega por defecto los cruces no declarados.'
          : 'La capa Ahora muestra delegaciones con entregas reales en vuelo. Cada región representa una sala; un agente en varias regiones es un puente.'}
        {' '}Arrastra el fondo para desplazar. Pellizca en móvil para acercar. Usa Acercar mapa, Alejar mapa o Encuadrar todos los elementos.
        {sinSala.length > 0 ? ` ${sinSala.length} agentes sin sala declarada aparecen en la lista inferior.` : ''}
      </p>
    </div>
  );
}
