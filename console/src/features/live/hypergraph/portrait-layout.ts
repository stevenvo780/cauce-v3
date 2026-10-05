import type { HyperGraphModel, Point } from './hypergraph-layout';
import { centroidOf, closedSmoothPath, convexHull } from './layout-geometry';
import { arcBetween } from './layout-nodes';
import type { FleetEdge, FleetNode } from './fleet-graph-model';

export const PORTRAIT_NODE = { width: 128, height: 64 } as const;

export function portraitColumns(width: number): number {
  return Math.max(1, Math.floor((width - 24) / (PORTRAIT_NODE.width + 12)));
}

export function fleetGeometryReady(nodes: FleetNode[], lookup: ReadonlyMap<string, Pick<FleetNode, 'position' | 'measured'>>): boolean {
  return nodes.length > 0 && nodes.every((expected) => {
    const current = lookup.get(expected.id);
    return current?.position.x === expected.position.x
      && current.position.y === expected.position.y
      && current.measured !== undefined
      && (current.measured.width ?? 0) > 0
      && (current.measured.height ?? 0) > 0
      && current.measured.width === expected.width
      && current.measured.height === expected.height;
  });
}

function corners(point: Point): Point[] {
  const halfWidth = PORTRAIT_NODE.width / 2 + 4;
  const halfHeight = PORTRAIT_NODE.height / 2 + 4;
  return [
    { x: point.x - halfWidth, y: point.y - halfHeight },
    { x: point.x + halfWidth, y: point.y - halfHeight },
    { x: point.x + halfWidth, y: point.y + halfHeight },
    { x: point.x - halfWidth, y: point.y + halfHeight },
  ];
}

export function portraitGraph(model: HyperGraphModel, nodes: FleetNode[], edges: FleetEdge[], width: number) {
  const columns = portraitColumns(width);
  const stride = (width - 24) / columns;
  const groupedTenants = [...model.tenants].sort((left, right) => right.memberCount - left.memberCount || left.id.localeCompare(right.id));
  const tenantOrder = new Map(groupedTenants.map((tenant, index) => [tenant.id, index]));
  const sorted = [...model.nodes].sort((left, right) =>
    (tenantOrder.get(left.tenants[0]) ?? 0) - (tenantOrder.get(right.tenants[0]) ?? 0)
    || [...left.edges].sort().join('|').localeCompare([...right.edges].sort().join('|'))
    || left.key.localeCompare(right.key));
  const origins = nodes.filter((node) => node.data.kind === 'origin');
  const originRows = Math.ceil(origins.length / columns);
  const top = 110 + originRows * 54;
  const positions = new Map(sorted.map((node, index) => [node.key, {
    x: 12 + stride * (index % columns + .5),
    y: top + Math.floor(index / columns) * 78,
  }]));
  const ownPositions = (tenantId: string) => sorted
    .filter((node) => node.tenants[0] === tenantId)
    .map((node) => positions.get(node.key) ?? node);
  const tenants = model.tenants.map((tenant) => ({ ...tenant, centroid: centroidOf(ownPositions(tenant.id)) }));
  const tenantPositions = new Map(tenants.map((tenant) => [tenant.id, tenant.centroid]));
  const roomNames = new Map(model.edges.map((room) => [room.key, room.roomLabel ?? 'sala sin nombre']));
  const compactModel: HyperGraphModel = {
    ...model, width, height: top + Math.max(0, Math.ceil(sorted.length / columns) - 1) * 78 + 108,
    nodes: model.nodes.map((node) => ({ ...node, ...positions.get(node.key) })),
    tenants,
    edges: model.edges.map((room) => {
      const members = sorted.filter((node) => node.edges.includes(room.key));
      const boxes = members.map((node) => corners(positions.get(node.key) ?? node));
      return {
        ...room, outline: boxes.map(closedSmoothPath).join(' '), hull: convexHull(boxes.flat()),
        labelAnchor: { x: boxes[0]?.[0]?.x ?? 12, y: boxes[0]?.[0]?.y ?? top },
        centroid: centroidOf(members.map((node) => positions.get(node.key) ?? node)),
      };
    }),
    arcs: model.arcs.map((arc, index) => {
      const from = tenantPositions.get(arc.fromTenant);
      const to = tenantPositions.get(arc.toTenant);
      if (!from || !to) return arc;
      const geometry = arcBetween(from, to, 24 + index * 8);
      return { ...arc, ...geometry, labelAnchor: { x: geometry.midpoint.x, y: geometry.midpoint.y - 9 } };
    }),
  };
  const arcById = new Map(compactModel.arcs.map((arc) => [`acl:${encodeURIComponent(arc.fromTenant)}→${encodeURIComponent(arc.toTenant)}`, arc]));
  return {
    model: compactModel,
    nodes: nodes.map((node): FleetNode => {
      if (node.data.kind === 'agent') {
        const original = model.nodes.find((candidate) => candidate.key === node.id);
        return {
          ...node, position: positions.get(node.id) ?? node.position, ...PORTRAIT_NODE,
          data: { ...node.data, compact: true, roomNames: original?.edges.map((key) => roomNames.get(key)).join(' · ') ?? '' },
        };
      }
      if (node.data.kind === 'anchor') return { ...node, position: tenantPositions.get(node.data.tenantId) ?? node.position };
      const index = origins.findIndex((origin) => origin.id === node.id);
      return { ...node, position: { x: 12 + stride * (index % columns + .5), y: 84 + Math.floor(index / columns) * 54 } };
    }),
    edges: edges.map((edge): FleetEdge => {
      if (edge.data?.kind === 'flow') return { ...edge, data: { ...edge.data, width: edge.data.width * .5 } };
      const arc = arcById.get(edge.id);
      return edge.data?.kind === 'acl' && arc
        ? { ...edge, data: { ...edge.data, arcPath: arc.path, label: arc.labelAnchor } }
        : edge;
    }),
  };
}
