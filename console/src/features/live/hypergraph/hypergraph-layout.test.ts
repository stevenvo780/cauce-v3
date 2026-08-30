import { describe, expect, it } from 'vitest';
import type { TopologySnapshot } from '../../../api/types';
import {
  convexHull,
  footprintsOverlap,
  inflateHull,
  layoutHypergraph,
  pointInPolygon,
  type Point,
} from './hypergraph-layout';

/** Topology close to the real one: 3 tenants, one alias shared between two rooms of the same tenant. */
const SNAPSHOT: TopologySnapshot = {
  observed_at: '2026-08-06T04:00:00Z',
  tenants: [
    {
      id: 'Steven',
      label: 'Steven',
      rooms: [
        {
          id: 'grp.steven',
          label: 'grp.steven',
          members: [
            { alias: 'zeus', enabled: true },
            { alias: 'kant', enabled: true },
            { alias: 'argos', enabled: true },
            { alias: 'jarvis', enabled: true },
          ],
        },
        {
          id: 'grp.ops',
          label: 'grp.ops',
          // `zeus` is in both rooms: this is the case that justifies the hypergraph.
          members: [{ alias: 'zeus', enabled: true }, { alias: 'socrates', enabled: null }],
        },
      ],
    },
    {
      id: 'Miguel',
      label: 'Miguel',
      rooms: [
        {
          id: 'grp.miguel',
          label: 'grp.miguel',
          members: [
            { alias: 'janus', enabled: true },
            { alias: 'atlas', enabled: false },
            { alias: null, enabled: true },
          ],
        },
      ],
    },
    { id: 'Pablo', label: 'Pablo', rooms: [{ id: 'grp.pablo', label: 'grp.pablo', members: [] }] },
  ],
  acl_edges: [
    { from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true, allow_read: true, allow_control: false },
    { from_tenant: 'Miguel', to_tenant: 'Steven', enabled: false, allow_route: false },
    { from_tenant: 'Steven', to_tenant: 'Fantasma', enabled: true },
    { from_tenant: 'Steven', to_tenant: 'Steven', enabled: true },
    { from_tenant: null, to_tenant: 'Miguel', enabled: true },
  ],
};

describe('layoutHypergraph', () => {
  it('es determinista: la misma entrada produce exactamente la misma salida', () => {
    // If this fails, the graph reshuffles on every refresh and can no longer be compared with itself.
    expect(layoutHypergraph(SNAPSHOT)).toEqual(layoutHypergraph(SNAPSHOT));
  });

  /* These two assertions are the fix for "the bots graph is unreadable", written as a condition instead of as a
   * screenshot review: that is how `#ops.infra` sat on top of `zeus` through a whole review. */
  it('ningún par de nodos se pisa: se comprueban las CAJAS reales, no la distancia entre centros', () => {
    const footprint = { halfWidth: 41, top: -38, bottom: 55 };
    const model = layoutHypergraph(SNAPSHOT, { width: 1520, height: 950, padding: 52, footprint, labelBand: 30 });

    const pisados: string[] = [];
    for (let i = 0; i < model.nodes.length; i += 1) {
      for (let j = i + 1; j < model.nodes.length; j += 1) {
        const a = model.nodes[i];
        const b = model.nodes[j];
        if (footprintsOverlap({ x: a.x, y: a.y }, { x: b.x, y: b.y }, footprint)) {
          pisados.push(`${a.alias} × ${b.alias}`);
        }
      }
    }
    expect(pisados, `nodos encimados: ${pisados.join(', ')}`).toEqual([]);
  });

  it('ninguna etiqueta de sala cae sobre un nodo: va al borde de la región, no a su centroide', () => {
    const footprint = { halfWidth: 41, top: -38, bottom: 55 };
    const model = layoutHypergraph(SNAPSHOT, { width: 1520, height: 950, padding: 52, footprint, labelBand: 30 });

    const encima: string[] = [];
    for (const edge of model.edges) {
      // Generous label box: if it does not touch anyone with this one, it will not with the real one either.
      const texto = `#${edge.roomLabel ?? 'UNKNOWN'}`;
      const halfWidth = (texto.length * 8.6) / 2 + 4;
      for (const node of model.nodes) {
        const solapaX = Math.abs(edge.labelAnchor.x - node.x) < halfWidth + footprint.halfWidth;
        const solapaY = edge.labelAnchor.y - 15 < node.y + footprint.bottom
          && node.y + footprint.top < edge.labelAnchor.y + 5;
        if (solapaX && solapaY) encima.push(`${texto} × ${node.alias}`);
      }
      // And above the top edge of its own region, which is what was requested.
      const topeRegion = Math.min(...edge.hull.map((punto) => punto.y));
      expect(edge.labelAnchor.y, `${texto} quedó dentro de su región`).toBeLessThanOrEqual(topeRegion);
    }
    expect(encima, `etiquetas sobre muñecos: ${encima.join(', ')}`).toEqual([]);
  });

  it('un alias presente en dos rooms es UN solo nodo con dos hiperaristas', () => {
    const model = layoutHypergraph(SNAPSHOT);
    const zeus = model.nodes.filter((node) => node.alias === 'zeus');
    expect(zeus).toHaveLength(1);
    expect(zeus[0].edges).toHaveLength(2);
    expect(zeus[0].edges).toEqual(expect.arrayContaining(['Steven/grp.steven', 'Steven/grp.ops']));
  });

  it('el mismo alias en dos tenants son DOS nodos, no uno colgado de las salas de ambos', () => {
    // Fusing by alias drew one figure inside the rooms of both clients, and mixed the two `enabled` into one.
    const model = layoutHypergraph({
      tenants: [
        { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'claude', enabled: true }] }] },
        { id: 'Miguel', rooms: [{ id: 'grp.miguel', members: [{ alias: 'claude', enabled: false }] }] },
      ],
    });

    const claudes = model.nodes.filter((node) => node.alias === 'claude');
    expect(claudes).toHaveLength(2);
    expect(new Set(claudes.map((node) => node.key)).size).toBe(2);
    expect(claudes.map((node) => [node.tenants, node.edges, node.enabled])).toEqual(
      expect.arrayContaining([
        [['Steven'], ['Steven/grp.steven'], true],
        [['Miguel'], ['Miguel/grp.miguel'], false],
      ]),
    );
    expect(claudes[0].x !== claudes[1].x || claudes[0].y !== claudes[1].y).toBe(true);
  });

  it('cada región contiene sólo a los miembros de SU tenant, aunque el alias se repita', () => {
    const footprint = { halfWidth: 41, top: -38, bottom: 55 };
    const model = layoutHypergraph({
      tenants: [
        { id: 'Steven', rooms: [{ id: 'grp.steven', members: [{ alias: 'claude' }, { alias: 'zeus' }] }] },
        { id: 'Miguel', rooms: [{ id: 'grp.miguel', members: [{ alias: 'claude' }, { alias: 'kratos' }] }] },
      ],
    }, { width: 1520, height: 950, padding: 52, footprint, labelBand: 30 });

    for (const edge of model.edges) {
      const own = model.nodes.filter((node) => node.tenants[0] === edge.tenantId);
      const foreign = model.nodes.filter((node) => node.tenants[0] !== edge.tenantId);
      for (const node of own) {
        expect(
          pointInPolygon({ x: node.x, y: node.y }, edge.hull),
          `la sala ${edge.key} deja fuera a su propio miembro ${node.key}`,
        ).toBe(true);
      }
      for (const node of foreign) {
        expect(
          pointInPolygon({ x: node.x, y: node.y }, edge.hull),
          `la sala ${edge.key} se traga a ${node.key}, que es de otro tenant`,
        ).toBe(false);
      }
    }
  });

  it('cada región contiene realmente a todos sus miembros', () => {
    const model = layoutHypergraph(SNAPSHOT);
    const positions = new Map(model.nodes.map((node) => [node.alias, { x: node.x, y: node.y }]));
    for (const edge of model.edges) {
      for (const alias of edge.members) {
        const point = positions.get(alias);
        expect(point, `sin posición para ${alias}`).toBeDefined();
        expect(
          pointInPolygon(point as Point, edge.hull),
          `la room ${edge.key} dibuja a ${alias} fuera de su propia región`,
        ).toBe(true);
      }
    }
  });

  it('no inventa nodos: un miembro sin alias se cuenta, no se dibuja', () => {
    const model = layoutHypergraph(SNAPSHOT);
    const miguel = model.edges.find((edge) => edge.key === 'Miguel/grp.miguel');
    expect(miguel?.unknownMembers).toBe(1);
    expect(miguel?.members).toEqual(['janus', 'atlas']);
    expect(model.nodes.map((node) => node.alias)).not.toContain(null);
    // 7 distinct aliases: zeus appears in two rooms and counts once; the alias-less member of
    // grp.miguel does not generate a node. Listed instead of counted so a change says WHAT changed.
    expect(model.nodes.map((node) => node.alias).sort()).toEqual(
      ['argos', 'atlas', 'janus', 'jarvis', 'kant', 'socrates', 'zeus'],
    );
  });

  it('enabled ausente queda en UNKNOWN, nunca en habilitado', () => {
    const model = layoutHypergraph(SNAPSHOT);
    expect(model.nodes.find((node) => node.alias === 'socrates')?.enabled).toBeNull();
    expect(model.nodes.find((node) => node.alias === 'atlas')?.enabled).toBe(false);
    expect(model.nodes.find((node) => node.alias === 'zeus')?.enabled).toBe(true);
  });

  it('una membresía deshabilitada en cualquier room marca el alias como deshabilitado', () => {
    const model = layoutHypergraph({
      tenants: [{
        id: 't',
        rooms: [
          { id: 'a', members: [{ alias: 'x', enabled: true }] },
          { id: 'b', members: [{ alias: 'x', enabled: false }] },
        ],
      }],
    });
    expect(model.nodes.find((node) => node.alias === 'x')?.enabled).toBe(false);
  });

  it('una room sin miembros se dibuja igual, y se declara aparte', () => {
    const model = layoutHypergraph(SNAPSHOT);
    expect(model.emptyEdges).toEqual(['Pablo/grp.pablo']);
    const pablo = model.edges.find((edge) => edge.key === 'Pablo/grp.pablo');
    expect(pablo?.outline.startsWith('M ')).toBe(true);
  });

  it('descarta aristas ACL que no se pueden dibujar sin inventar un tenant', () => {
    const model = layoutHypergraph(SNAPSHOT);
    // Of the 5 edges: 2 are drawn. Outside remain the one for a non-existent tenant, the self-loop,
    // and the one with no declared origin. All 5 are still on the page table.
    expect(model.arcs).toHaveLength(2);
    expect(model.arcs.map((arc) => `${arc.fromTenant}->${arc.toTenant}`)).toEqual(['Steven->Miguel', 'Miguel->Steven']);
  });

  it('la ida y la vuelta entre dos tenants no se superponen', () => {
    const model = layoutHypergraph(SNAPSHOT);
    const [ida, vuelta] = model.arcs;
    expect(ida.path).not.toEqual(vuelta.path);
    expect(Math.hypot(ida.midpoint.x - vuelta.midpoint.x, ida.midpoint.y - vuelta.midpoint.y)).toBeGreaterThan(20);
  });

  it('ningún nodo se sale del lienzo', () => {
    const model = layoutHypergraph(SNAPSHOT);
    for (const node of model.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(model.width);
      expect(node.y).toBeLessThanOrEqual(model.height);
    }
  });

  it('sin datos no explota: devuelve un modelo vacío', () => {
    for (const input of [undefined, null, {}, { tenants: [] }, { tenants: null }] as const) {
      const model = layoutHypergraph(input as TopologySnapshot);
      expect(model.edges).toHaveLength(0);
      expect(model.nodes).toHaveLength(0);
      expect(model.arcs).toHaveLength(0);
    }
  });

  it('un tenant sin id no colisiona con otro tenant sin id', () => {
    const model = layoutHypergraph({
      tenants: [
        { rooms: [{ members: [{ alias: 'a' }] }] },
        { rooms: [{ members: [{ alias: 'b' }] }] },
      ],
    });
    expect(model.tenants).toHaveLength(2);
    expect(new Set(model.edges.map((edge) => edge.key)).size).toBe(2);
  });
});

describe('geometría', () => {
  it('convexHull descarta los puntos interiores', () => {
    const hull = convexHull([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 5, y: 5 });
  });

  it('inflateHull deja los puntos originales dentro, también en casos degenerados', () => {
    const casos: Point[][] = [
      [{ x: 100, y: 100 }],
      [{ x: 100, y: 100 }, { x: 220, y: 104 }],
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }],
      // Almost collinear: this is where a radial inflate from the centroid would leave the extremes out.
      [{ x: 0, y: 0 }, { x: 100, y: 1 }, { x: 200, y: 0 }],
    ];
    for (const puntos of casos) {
      const inflado = inflateHull(convexHull(puntos), 30);
      for (const punto of puntos) {
        expect(pointInPolygon(punto, inflado), `${JSON.stringify(punto)} quedó fuera`).toBe(true);
      }
    }
  });
});
