import { describe, expect, it } from 'vitest';
import type { TopologySnapshot } from '../../api/types';
import {
  convexHull,
  footprintsOverlap,
  inflateHull,
  layoutHypergraph,
  pointInPolygon,
  type Point,
} from './hypergraph-layout';

/** Topología parecida a la real: 3 tenants, un alias compartido entre dos rooms del mismo tenant. */
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
          // `zeus` está en las dos rooms: es el caso que justifica el hipergrafo.
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
    // Si esto falla, el grafo se reacomoda en cada refresco y deja de poder compararse consigo mismo.
    expect(layoutHypergraph(SNAPSHOT)).toEqual(layoutHypergraph(SNAPSHOT));
  });

  /*
   * Estas dos afirmaciones son el arreglo de "el gráfico de bots es ilegible", escrito como
   * condición y no como impresión. Antes se comprobaba mirando una captura, que es como se dejó
   * pasar `#ops.infra` encima de `zeus` durante toda una revisión.
   */
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
      // Caja generosa de la etiqueta: si con ésta no toca a nadie, con la real tampoco.
      const texto = `#${edge.roomLabel ?? 'UNKNOWN'}`;
      const halfWidth = (texto.length * 8.6) / 2 + 4;
      for (const node of model.nodes) {
        const solapaX = Math.abs(edge.labelAnchor.x - node.x) < halfWidth + footprint.halfWidth;
        const solapaY = edge.labelAnchor.y - 15 < node.y + footprint.bottom
          && node.y + footprint.top < edge.labelAnchor.y + 5;
        if (solapaX && solapaY) encima.push(`${texto} × ${node.alias}`);
      }
      // Y por encima del borde superior de su propia región, que es lo que se pidió.
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
    // 7 alias distintos: zeus aparece en dos rooms y cuenta una sola vez; el miembro sin alias de
    // grp.miguel no genera nodo. Se listan en vez de contar para que un cambio diga QUÉ cambió.
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
    // De las 5 aristas: se dibujan 2. Fuera quedan la de tenant inexistente, el bucle sobre sí
    // mismo y la que no declara origen. Las 5 siguen estando en la tabla de la página.
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
      // Casi colineales: es donde un inflado radial desde el centroide dejaría los extremos fuera.
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
