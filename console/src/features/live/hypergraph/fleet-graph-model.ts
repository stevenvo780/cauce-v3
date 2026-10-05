import type { Edge, Node } from '@xyflow/react';
import type { HyperGraphModel, Point } from './hypergraph-layout';
import type { DelegationEdge, EdgeAggregate, HumanOrigin, LiveAgentView } from '../agent-state';
import { aggregateEdges, edgePairKey } from '../agent-state';
import { aclCaption } from './hypergraph-layout';

export type FleetGraphLayer = 'ahora' | 'permisos';

export interface AgentNodeData extends Record<string, unknown> {
  kind: 'agent';
  agentKey: string;
  tenantId: string;
  alias: string;
  state: LiveAgentView['state'] | 'unknown';
  view: LiveAgentView | null;
  dim: boolean;
  selected: boolean;
  onFocus?: (key: string | null) => void;
  onOpen?: (view: LiveAgentView) => void;
  onHover?: (key: string | null, anchor: DOMRect | null, view: LiveAgentView | null, alias: string) => void;
}

export interface AnchorNodeData extends Record<string, unknown> {
  kind: 'anchor';
  tenantId: string;
}

export interface OriginNodeData extends Record<string, unknown> {
  kind: 'origin';
  agentKey: string;
  adapter: string;
  count: number;
}

export type FleetNodeData = AgentNodeData | AnchorNodeData | OriginNodeData;
export type FleetNode = Node<FleetNodeData>;

export interface FlowEdgeData extends Record<string, unknown> {
  kind: 'flow';
  aggregate: EdgeAggregate;
  width: number;
  slow: boolean;
  dim: boolean;
}

export interface AclEdgeData extends Record<string, unknown> {
  kind: 'acl';
  caption: string;
  enabled: boolean | null;
  arcPath: string;
  label: Point;
}

export interface OriginEdgeData extends Record<string, unknown> {
  kind: 'origin';
}

export type FleetEdgeData = FlowEdgeData | AclEdgeData | OriginEdgeData;
export type FleetEdge = Edge<FleetEdgeData>;

export interface FleetGraphInput {
  model: HyperGraphModel;
  views: readonly LiveAgentView[];
  edges: readonly DelegationEdge[];
  serverEdges?: Parameters<typeof aggregateEdges>[1];
  origins?: readonly HumanOrigin[];
  layer: FleetGraphLayer;
  focusKey?: string | null;
  spotlight?: Set<string> | null;
  stallAfterSeconds?: number | null;
  onFocus?: AgentNodeData['onFocus'];
  onOpen?: AgentNodeData['onOpen'];
  onHover?: AgentNodeData['onHover'];
}

export interface FleetGraph {
  nodes: FleetNode[];
  edges: FleetEdge[];
}

function pairKey(tenantId: string, alias: string): string {
  return `${tenantId}/${alias}`;
}

function widthFor(total: number, maximum: number): number {
  if (maximum <= 1) return 2.6;
  return Math.round((2.2 + Math.sqrt(total / maximum) * 3.4) * 10) / 10;
}

export function buildFleetGraph(input: FleetGraphInput): FleetGraph {
  const { model, layer } = input;
  const views = new Map(input.views.map((view) => [view.key, view]));
  const modelNodeByAgent = new Map(model.nodes.map((node) => [pairKey(node.tenants[0] ?? '', node.alias), node]));
  const activeSpotlight = input.spotlight ?? null;
  const neighborKeys = new Set<string>();
  const aggregates = aggregateEdges(input.edges, input.serverEdges);
  for (const server of input.serverEdges ?? []) {
    if (typeof server.in_flight !== 'number' || server.in_flight <= 0
        || !server.from_tenant || !server.from_alias || !server.to_tenant || !server.to_alias) continue;
    const from = pairKey(server.from_tenant, server.from_alias);
    const to = pairKey(server.to_tenant, server.to_alias);
    const id = edgePairKey(from, to);
    const current = aggregates.get(id);
    if (current) {
      current.inFlight = Math.max(current.inFlight, server.in_flight);
      current.total = Math.max(current.total, current.inFlight);
    } else {
      const total = typeof server.total_window === 'number' ? server.total_window : server.in_flight;
      aggregates.set(id, {
        from, to, inFlight: server.in_flight, total: Math.max(total, server.in_flight),
        oldestSeconds: null, totalFromServer: typeof server.total_window === 'number',
      });
    }
  }
  if (input.focusKey) {
    neighborKeys.add(input.focusKey);
    for (const edge of aggregates.values()) {
      if (edge.from === input.focusKey) neighborKeys.add(edge.to);
      if (edge.to === input.focusKey) neighborKeys.add(edge.from);
    }
  }
  const filterActive = activeSpotlight !== null || Boolean(input.focusKey);
  const nodes: FleetNode[] = model.nodes.map((node) => {
    const tenantId = node.tenants[0] ?? '';
    const key = pairKey(tenantId, node.alias);
    const view = views.get(key) ?? null;
    return {
      id: node.key,
      type: 'fleet',
      position: { x: node.x, y: node.y },
      origin: [0.5, 0.5],
      draggable: false,
      connectable: false,
      selectable: false,
      deletable: false,
      focusable: false,
      ariaRole: 'group',
      ariaLabel: view
        ? `${node.alias}, ${view.state}: ${view.reason}`
        : `${node.alias}, sin reportar; el estado es desconocido`,
      data: {
        kind: 'agent', agentKey: key, tenantId, alias: node.alias,
        state: view?.state ?? 'unknown', view,
        dim: filterActive && !(activeSpotlight?.has(key) ?? false) && !neighborKeys.has(key),
        selected: input.focusKey === key,
        onFocus: input.onFocus, onOpen: input.onOpen, onHover: input.onHover,
      },
      width: 178,
      height: 118,
    };
  });

  if (layer === 'permisos') {
    for (const tenant of model.tenants) {
      nodes.push({
        id: `tenant-anchor:${encodeURIComponent(tenant.id)}`,
        type: 'anchor',
        position: tenant.centroid,
        origin: [0.5, 0.5],
        draggable: false, connectable: false, selectable: false, deletable: false, focusable: false,
        ariaRole: 'presentation', ariaLabel: '',
        data: { kind: 'anchor', tenantId: tenant.id },
        width: 1, height: 1,
      });
    }
    const edges: FleetEdge[] = model.arcs.map((arc) => ({
      id: `acl:${encodeURIComponent(arc.fromTenant)}→${encodeURIComponent(arc.toTenant)}`,
      source: `tenant-anchor:${encodeURIComponent(arc.fromTenant)}`,
      target: `tenant-anchor:${encodeURIComponent(arc.toTenant)}`,
      type: 'fleet',
      selectable: false, deletable: false, reconnectable: false, focusable: false,
      markerEnd: { type: 'arrowclosed', color: 'var(--violet)' },
      data: { kind: 'acl', caption: aclCaption(arc), enabled: arc.enabled, arcPath: arc.path, label: arc.labelAnchor },
      ariaLabel: `${arc.fromTenant} a ${arc.toTenant}, permisos ${aclCaption(arc)}`,
    }));
    return { nodes, edges };
  }

  const visible = [...aggregates.values()].filter((edge) => edge.inFlight > 0
    && modelNodeByAgent.has(edge.from) && modelNodeByAgent.has(edge.to));
  const maximum = Math.max(1, ...visible.map((edge) => edge.total));
  const stallAfter = input.stallAfterSeconds;
  const edges: FleetEdge[] = visible.map((aggregate) => {
    const source = modelNodeByAgent.get(aggregate.from);
    const target = modelNodeByAgent.get(aggregate.to);
    if (!source || !target) throw new Error('visible activity edge is missing a topology endpoint');
    const focusNeighbor = neighborKeys.has(aggregate.from) && neighborKeys.has(aggregate.to);
    const spotlightNeighbor = activeSpotlight?.has(aggregate.from) && activeSpotlight.has(aggregate.to);
    return {
      id: `activity:${encodeURIComponent(aggregate.from)}→${encodeURIComponent(aggregate.to)}`,
      source: source.key,
      target: target.key,
      type: 'fleet',
      selectable: false, deletable: false, reconnectable: false, focusable: false,
      markerEnd: { type: 'arrowclosed', color: typeof stallAfter === 'number' && (aggregate.oldestSeconds ?? 0) > stallAfter ? 'var(--amber)' : 'var(--blue)' },
      data: {
        kind: 'flow', aggregate, width: widthFor(aggregate.total, maximum),
        slow: typeof stallAfter === 'number' && aggregate.oldestSeconds !== null && aggregate.oldestSeconds > stallAfter,
        dim: filterActive && !focusNeighbor && !spotlightNeighbor,
      },
      ariaLabel: `${aggregate.from} a ${aggregate.to}, ${String(aggregate.inFlight)} en vuelo${aggregate.totalFromServer ? `, ${String(aggregate.total)} en la ventana` : ''}`,
    };
  });

  const position = new Map(model.nodes.map((node) => [pairKey(node.tenants[0] ?? '', node.alias), node]));
  const people = (input.origins ?? [])
    .filter((origin) => position.has(origin.agentKey))
    .map((origin) => ({ ...origin, y: position.get(origin.agentKey)?.y ?? 0 }))
    .sort((left, right) => left.y - right.y || left.agentKey.localeCompare(right.agentKey));
  let lastY = -Infinity;
  for (const person of people) {
    person.y = Math.max(person.y, lastY + 62);
    lastY = person.y;
    const [tenantId, ...aliasParts] = person.agentKey.split('/');
    const targetAlias = aliasParts.join('/');
    const target = modelNodeByAgent.get(pairKey(tenantId, targetAlias));
    if (!target) continue;
    const id = `origin:${encodeURIComponent(person.agentKey)}:${encodeURIComponent(person.adapter)}`;
    nodes.push({
      id, type: 'fleet', position: { x: -66, y: person.y }, origin: [0.5, 0.5],
      draggable: false, connectable: false, selectable: false, deletable: false, focusable: false,
      ariaRole: 'img', ariaLabel: `Persona por ${person.adapter}, ${String(person.count)} encargos en vuelo hacia ${targetAlias}`,
      data: { kind: 'origin', agentKey: person.agentKey, adapter: person.adapter, count: person.count },
      width: 74, height: 56,
    });
    edges.push({
      id: `${id}:to:${target.key}`, source: id, target: target.key, type: 'fleet',
      selectable: false, deletable: false, reconnectable: false, focusable: false,
      data: { kind: 'origin' }, ariaLabel: `Origen ${person.adapter} a ${person.agentKey}`,
    });
  }
  return { nodes, edges };
}

export function topologySignature(model: HyperGraphModel): string {
  const nodes = model.nodes.map((node) => node.key).sort().join('|');
  const rooms = model.edges.map((edge) => `${edge.key}:${[...edge.members].sort().join(',')}`).sort().join('|');
  return `${nodes}::${rooms}`;
}
