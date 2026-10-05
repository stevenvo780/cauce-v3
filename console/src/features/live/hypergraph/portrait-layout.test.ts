import { describe, expect, it } from 'vitest';
import { topology } from '../../../mocks/data';
import { buildFleetGraph, type FleetNode } from './fleet-graph-model';
import { layoutHypergraph } from './hypergraph-layout';
import { fleetGeometryReady, portraitColumns, portraitGraph, PORTRAIT_NODE } from './portrait-layout';

const model = layoutHypergraph(topology);
const graph = buildFleetGraph({ model, views: [], edges: [], layer: 'permisos' });

describe('fleetGeometryReady', () => {
  it('espera posiciones y medidas actuales al volver de móvil a escritorio', () => {
    const compact = portraitGraph(model, graph.nodes, graph.edges, 270);
    const lookup = new Map<string, Pick<FleetNode, 'position' | 'measured'>>(compact.nodes.map((node) => [node.id, { ...node, measured: { width: node.width, height: node.height } }]));
    expect(fleetGeometryReady(compact.nodes, lookup)).toBe(true);
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(false);
    for (const node of graph.nodes) lookup.set(node.id, { ...node, measured: lookup.get(node.id)?.measured });
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(false);
    for (const node of graph.nodes) lookup.set(node.id, { ...node, measured: { width: node.width, height: node.height } });
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(true);
  });

  it('rechaza medidas ausentes, nodos ausentes y posiciones antiguas aunque width ya cambió', () => {
    const lookup = new Map<string, Pick<FleetNode, 'position' | 'measured'>>(graph.nodes.map((node) => [node.id, { ...node, measured: { width: node.width, height: node.height } }]));
    const node = graph.nodes[0];
    lookup.delete(node.id);
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(false);
    lookup.set(node.id, { ...node, measured: undefined });
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(false);
    lookup.set(node.id, { ...node, position: { x: node.position.x + 1, y: node.position.y }, measured: { width: node.width, height: node.height } });
    expect(fleetGeometryReady(graph.nodes, lookup)).toBe(false);
    expect(fleetGeometryReady([], lookup)).toBe(false);
  });
});

describe('portraitGraph', () => {
  it.each([270, 310, 704])('preserva identidad, membresía y ACL con tarjetas legibles en %ipx', (width) => {
    const compact = portraitGraph(model, graph.nodes, graph.edges, width);
    expect(compact.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
    expect(compact.edges.map((edge) => [edge.id, edge.source, edge.target])).toEqual(graph.edges.map((edge) => [edge.id, edge.source, edge.target]));
    expect(compact.model.edges.map((room) => [room.key, room.members, room.unknownMembers])).toEqual(model.edges.map((room) => [room.key, room.members, room.unknownMembers]));
    for (const node of compact.nodes.filter((node) => node.data.kind === 'agent')) {
      expect(node.width).toBe(PORTRAIT_NODE.width);
      expect(node.height).toBeGreaterThanOrEqual(44);
      expect(node.position.x - PORTRAIT_NODE.width / 2).toBeGreaterThanOrEqual(0);
      expect(node.position.x + PORTRAIT_NODE.width / 2).toBeLessThanOrEqual(width);
      expect(node.position.y + PORTRAIT_NODE.height / 2).toBeLessThan(compact.model.height - 60);
    }
    expect(new Set(compact.model.nodes.map((node) => node.x)).size).toBe(width === 270 ? 1 : width === 310 ? 2 : 4);
    expect(portraitColumns(width)).toBe(width === 270 ? 1 : width === 310 ? 2 : 4);
    for (const left of compact.model.nodes) for (const right of compact.model.nodes) {
      if (left.key !== right.key && left.y === right.y) expect(Math.abs(left.x - right.x) - PORTRAIT_NODE.width).toBeGreaterThanOrEqual(12);
    }
    expect(compact.edges.every((edge) => edge.data?.kind !== 'acl' || edge.data.arcPath !== graph.edges.find((original) => original.id === edge.id)?.data?.arcPath)).toBe(true);
  });

  it('reserva altura documental para veinte agentes y sus controles al final', () => {
    const many = layoutHypergraph({ tenants: [{ id: 'tenant', rooms: [{ id: 'room', members: Array.from({ length: 20 }, (_, index) => ({ alias: `agent-${String(index)}` })) }] }] });
    const graph = buildFleetGraph({ model: many, views: [], edges: [], layer: 'ahora' });
    const compact = portraitGraph(many, graph.nodes, graph.edges, 310);
    expect(compact.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
    expect(compact.model.height).toBeGreaterThan(780);
    expect(Math.max(...compact.nodes.map((node) => node.position.y + PORTRAIT_NODE.height / 2))).toBeLessThan(compact.model.height - 60);
  });

  it('es estable al cambiar el orden de entrada y no atribuye otras salas a una tarjeta', () => {
    const compact = portraitGraph(model, graph.nodes, graph.edges, 310);
    const reversed = portraitGraph({ ...model, nodes: [...model.nodes].reverse() }, graph.nodes, graph.edges, 310);
    expect(new Map(compact.model.nodes.map((node) => [node.key, [node.x, node.y]]))).toEqual(new Map(reversed.model.nodes.map((node) => [node.key, [node.x, node.y]])));
    for (const room of compact.model.edges) {
      expect((room.outline.match(/M/gu) ?? []).length).toBe(room.members.length);
    }
    const zeus = compact.nodes.find((node) => node.data.kind === 'agent' && node.data.alias === 'zeus');
    expect(zeus?.data.roomNames).toContain('grp.steven');
    expect(zeus?.data.roomNames).toContain('ops.infra');
    expect(zeus?.data.roomNames).not.toContain('grp.miguel');
    expect(compact.model.nodes.map((node) => node.tenants)).toEqual(model.nodes.map((node) => node.tenants));
  });

  it('mantiene orígenes y actividad reales con sus extremos, antes del primer agente', () => {
    const activity = buildFleetGraph({ model, views: [], edges: [{ from: 'Steven/kant', to: 'Steven/zeus' }], layer: 'ahora', origins: [{ agentKey: 'Steven/kant', adapter: 'console', count: 1 }] });
    const compact = portraitGraph(model, activity.nodes, activity.edges, 310);
    expect(compact.edges.map((edge) => [edge.id, edge.source, edge.target, edge.data])).toEqual(activity.edges.map((edge) => [edge.id, edge.source, edge.target, edge.data?.kind === 'flow' ? { ...edge.data, width: edge.data.width * .5 } : edge.data]));
    const origin = compact.nodes.find((node) => node.data.kind === 'origin');
    expect(origin?.data).toEqual(activity.nodes.find((node) => node.data.kind === 'origin')?.data);
    expect(origin?.position.y).toBeLessThan(Math.min(...compact.model.nodes.map((node) => node.y)));
  });
});
