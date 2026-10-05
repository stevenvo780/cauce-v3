import { describe, expect, it } from 'vitest';
import { mockActivity, topology } from '../../../mocks/data';
import { buildLiveViews } from '../agent-state';
import { layoutHypergraph } from './hypergraph-layout';
import { buildFleetGraph, topologySignature } from './fleet-graph-model';

describe('buildFleetGraph', () => {
  const model = layoutHypergraph(topology, { width: 1520, height: 950 });

  it('mantiene cada nodo por tenant/alias y una sola instancia para memberships compartidas', () => {
    const snapshot = {
      ...topology,
      tenants: (topology.tenants ?? []).map((tenant) => tenant.id === 'Miguel'
        ? { ...tenant, rooms: (tenant.rooms ?? []).map((room, index) => index === 0
          ? { ...room, members: [...(room.members ?? []), { alias: 'zeus', enabled: true }] }
          : room) }
        : tenant),
    };
    const graphModel = layoutHypergraph(snapshot);
    const graph = buildFleetGraph({ model: graphModel, views: [], edges: [], layer: 'ahora' });
    const zeus = graph.nodes.filter((node) => node.data.kind === 'agent' && node.data.alias === 'zeus');

    expect(zeus).toHaveLength(2);
    expect(new Set(zeus.map((node) => node.id)).size).toBe(2);
    expect(new Set(graphModel.nodes.filter((node) => node.alias === 'zeus').map((node) => node.key)).size).toBe(2);
    expect(graph.nodes.filter((node) => node.data.kind === 'agent')).toHaveLength(graphModel.nodes.length);
  });

  it('dibuja solo pares con entregas ahora, nunca la ventana histórica ni una ACL como actividad', () => {
    const snapshot = mockActivity();
    const views = buildLiveViews(snapshot, {}, Date.now()).views;
    const graph = buildFleetGraph({
      model,
      views,
      edges: [{ from: 'Steven/kant', to: 'Steven/zeus' }],
      serverEdges: [{ from_tenant: 'Steven', from_alias: 'argos', to_tenant: 'Steven', to_alias: 'zeus', in_flight: 0, total_window: 17 }],
      layer: 'ahora',
    });

    expect(graph.edges.map((edge) => edge.data?.kind)).toEqual(['flow']);
    expect(graph.edges[0]?.id).toContain(encodeURIComponent('Steven/kant'));
    expect(graph.edges[0]?.source).toBe(graph.nodes.find((node) => node.data.kind === 'agent' && node.data.agentKey === 'Steven/kant')?.id);
    expect(graph.edges[0]?.target).toBe(graph.nodes.find((node) => node.data.kind === 'agent' && node.data.agentKey === 'Steven/zeus')?.id);
    expect((graph.edges[0]?.data as { aggregate: { inFlight: number } }).aggregate.inFlight).toBe(1);
  });

  it('acepta el contador explícito en vuelo del servidor, pero no inventa lentitud si falta el umbral', () => {
    const graph = buildFleetGraph({
      model, views: [], edges: [], layer: 'ahora',
      serverEdges: [{ from_tenant: 'Steven', from_alias: 'kant', to_tenant: 'Steven', to_alias: 'zeus', in_flight: 2, total_window: 9 }],
    });
    const flow = graph.edges[0];

    expect(flow?.data?.kind).toBe('flow');
    expect((flow?.data as { aggregate: { inFlight: number } }).aggregate.inFlight).toBe(2);
    expect((flow?.data as { slow: boolean }).slow).toBe(false);
  });

  it('representa ACLs solo en permisos con anclas de tenant que no se cuentan como agentes', () => {
    const graph = buildFleetGraph({ model, views: [], edges: [], layer: 'permisos' });
    const agents = graph.nodes.filter((node) => node.data.kind === 'agent');
    const anchors = graph.nodes.filter((node) => node.data.kind === 'anchor');

    expect(agents).toHaveLength(model.nodes.length);
    expect(anchors).toHaveLength(model.tenants.length);
    expect(graph.edges).toHaveLength(model.arcs.length);
    expect(graph.edges.every((edge) => edge.id.startsWith('acl:') && edge.data?.kind === 'acl')).toBe(true);
    expect(graph.edges.some((edge) => edge.id === 'acl:Steven→Miguel')).toBe(true);
    expect(graph.edges.some((edge) => edge.id.startsWith('activity:'))).toBe(false);
  });

  it('conecta los orígenes humanos fuera de las salas sin convertirlos en agentes', () => {
    const graph = buildFleetGraph({
      model,
      views: [],
      edges: [],
      origins: [{ agentKey: 'Steven/kant', adapter: 'telegram', count: 2 }],
      layer: 'ahora',
    });
    const origin = graph.nodes.find((node) => node.data.kind === 'origin');

    expect(origin?.position.x).toBeLessThan(0);
    expect(origin?.ariaLabel).toContain('telegram');
    expect(graph.nodes.filter((node) => node.data.kind === 'agent')).toHaveLength(model.nodes.length);
    expect(graph.edges.some((edge) => edge.data?.kind === 'origin')).toBe(true);
  });

  it('distingue cambios de membresía aunque sigan iguales los IDs de agentes y salas', () => {
    const before = layoutHypergraph(topology);
    const changed = layoutHypergraph({
      ...topology,
      tenants: (topology.tenants ?? []).map((tenant) => tenant.id === 'Steven'
        ? { ...tenant, rooms: (tenant.rooms ?? []).map((room) => room.id === 'grp.steven'
          ? { ...room, members: (room.members ?? []).filter((member) => member.alias !== 'zeus') }
          : room) }
        : tenant),
    });

    expect(topologySignature(before)).not.toBe(topologySignature(changed));
  });
});
