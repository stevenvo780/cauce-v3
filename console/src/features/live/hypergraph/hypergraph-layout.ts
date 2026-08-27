/**
 * Modelo y disposición del hipergrafo de topología.
 *
 * Por qué un hipergrafo y no un grafo normal: en Cauce una *room* no relaciona pares de agentes,
 * relaciona a **todos sus miembros a la vez**. Dibujar eso con aristas de dos extremos obliga a
 * inventar N·(N-1)/2 líneas que no existen en el modelo — con 15 alias eso es una maraña ilegible
 * que además afirma vínculos que el backend nunca informó. Una hiperarista se dibuja como una sola
 * envolvente que contiene a sus miembros: una room, una forma. Un alias que pertenece a dos rooms
 * se dibuja **una sola vez** y las dos envolventes se solapan sobre él; ese solapamiento *es* el
 * dato interesante (quién es puente entre salas) y aparece solo, sin calcularlo aparte.
 *
 * Todo acá es determinista a propósito: **no se usa `Math.random`**. Un layout que se reacomoda en
 * cada refresco obliga al operador a reorientarse cada 10 segundos y hace imposible comparar dos
 * capturas. Ante la misma entrada, esta función devuelve exactamente la misma salida.
 */

import type { AclEdge, TopologySnapshot } from '../../../api/types';
import {
  NODE_FOOTPRINT,
  centroidOf,
  closedSmoothPath,
  convexHull,
  inflateHull,
  round,
  type NodeFootprint,
  type Point,
} from './layout-geometry';
import { aclCaption, placeLabels } from './layout-labels';
import {
  DEFAULTS,
  SEP,
  anchorEdges,
  arcBetween,
  collect,
  relax,
  separate,
} from './layout-nodes';

export {
  NODE_FOOTPRINT,
  centroidOf,
  closedSmoothPath,
  convexHull,
  footprintsOverlap,
  hashString,
  inflateHull,
  jitter,
  normalize,
  pointInPolygon,
  round,
  type NodeFootprint,
  type Point,
} from './layout-geometry';

export {
  aclCaption,
  placeLabels,
  rectsOverlap,
  type LabelRect,
} from './layout-labels';

export {
  DEFAULTS,
  SEP,
  anchorEdges,
  arcBetween,
  collect,
  edgeKey,
  relax,
  separate,
  type RawEdge,
  type RawNode,
} from './layout-nodes';

/** Un alias. Existe una sola vez aunque pertenezca a varias rooms o tenants. */
export interface HyperNode {
  alias: string;
  /** Etiqueta a mostrar. `null` cuando el backend no informó alias (se muestra como UNKNOWN). */
  label: string | null;
  /** `null` = el backend no lo informó. No se asume habilitado. */
  enabled: boolean | null;
  /** Ids de tenant en los que aparece. Más de uno = el alias cruza tenants. */
  tenants: string[];
  /** Claves de las hiperaristas (rooms) que lo contienen. */
  edges: string[];
  x: number;
  y: number;
}

/** Una room: la hiperarista propiamente dicha. */
export interface HyperEdge {
  key: string;
  tenantId: string;
  tenantLabel: string | null;
  roomLabel: string | null;
  /** Aliases miembros, en el orden estable en que se resolvieron. */
  members: string[];
  /** Miembros que el backend informó sin alias. Se cuentan, no se inventan. */
  unknownMembers: number;
  /** Contorno cerrado ya suavizado y con padding, listo para un `<path d>`. */
  outline: string;
  /**
   * Dónde colgar `#nombre-de-sala`.
   *
   * **No es el centroide**, y esa es toda la diferencia entre un dibujo legible y uno ilegible: el
   * centroide de una región es exactamente el sitio donde están los muñecos, así que la etiqueta
   * caía siempre encima de alguno (`#ops.infra` sobre `zeus`, `#grp.isa` sobre `salva`). Acá se
   * ancla sobre el **borde superior** de la región y después se separa de cualquier nodo y de
   * cualquier otra etiqueta (`placeLabels`), así que el solapamiento no es "poco probable": no
   * ocurre, y hay un test que lo afirma.
   */
  labelAnchor: Point;
  /**
   * Los vértices del contorno antes de suavizar. Se exponen para poder afirmar en los tests que la
   * región **realmente contiene a sus miembros**: una envolvente que deja un nodo afuera dibuja una
   * pertenencia falsa, y eso es un error de datos disfrazado de detalle estético.
   */
  hull: Point[];
  centroid: Point;
  /** Índice estable 0..5 para elegir color sin depender del orden de render. */
  hue: number;
}

/** Una arista ACL entre tenants: esa sí es binaria y dirigida. */
export interface AclArc {
  key: string;
  fromTenant: string;
  toTenant: string;
  enabled: boolean | null;
  allowRoute: boolean | null;
  allowRead: boolean | null;
  allowControl: boolean | null;
  /** Curva dirigida entre los centroides de los dos tenants. */
  path: string;
  /** Punto donde colgar la punta de flecha: el medio real de la Bézier. */
  midpoint: Point;
  /**
   * Dónde escribir `route · read · control`.
   *
   * Sale del mismo reparto que las etiquetas de sala y de tenant. Antes se dibujaba en
   * `midpoint.y - 9` a secas, y con seis aristas ACL cruzándose por el centro del dibujo el
   * resultado eran tres textos apilados sobre `argos` y sobre el nombre de un tenant.
   */
  labelAnchor: Point;
  /** Ángulo (grados) de la flecha en `midpoint`. */
  angle: number;
}

export interface TenantBlob {
  id: string;
  label: string | null;
  centroid: Point;
  /** Igual que en `HyperEdge`: sobre el borde de arriba, ya separado de nodos y etiquetas. */
  labelAnchor: Point;
  roomCount: number;
  memberCount: number;
  hue: number;
}

export interface HyperGraphModel {
  nodes: HyperNode[];
  edges: HyperEdge[];
  arcs: AclArc[];
  tenants: TenantBlob[];
  width: number;
  height: number;
  /** Rooms sin ningún miembro informado: se listan aparte porque no se pueden dibujar como área. */
  emptyEdges: string[];
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Cuánto se infla la envolvente alrededor de sus nodos. */
  padding?: number;
  /** Distancia mínima deseada entre dos nodos durante la relajación. */
  nodeSpacing?: number;
  iterations?: number;
  /** Caja real que ocupa cada nodo. La separación final la garantiza contra esto, no contra un radio. */
  footprint?: NodeFootprint;
  /** Altura reservada arriba de todo para que quepan las etiquetas de sala. */
  labelBand?: number;
}

/**
 * Construye el hipergrafo completo a partir del snapshot del control plane.
 *
 * Determinista: la misma entrada produce la misma salida, siempre.
 */
export function layoutHypergraph(
  snapshot: TopologySnapshot | undefined | null,
  options: LayoutOptions = {},
): HyperGraphModel {
  const settings: Required<LayoutOptions> = {
    width: options.width ?? DEFAULTS.width,
    height: options.height ?? DEFAULTS.height,
    padding: options.padding ?? DEFAULTS.padding,
    nodeSpacing: options.nodeSpacing ?? DEFAULTS.nodeSpacing,
    iterations: options.iterations ?? DEFAULTS.iterations,
    footprint: options.footprint ?? NODE_FOOTPRINT,
    labelBand: options.labelBand ?? DEFAULTS.labelBand,
  };

  const tenantNodes = snapshot?.tenants ?? [];
  const { nodes: rawNodes, edges: rawEdges } = collect(tenantNodes);

  const empty: HyperGraphModel = {
    nodes: [],
    edges: [],
    arcs: [],
    tenants: [],
    width: settings.width,
    height: settings.height,
    emptyEdges: [],
  };
  if (rawEdges.length === 0) return empty;

  const anchors = anchorEdges(rawEdges, settings);
  const nodeList = [...rawNodes.values()];
  const positions = relax(nodeList, rawEdges, anchors, settings);

  // La relajación deja *tendencia* a no encimarse; esto lo garantiza. Se hace antes de calcular las
  // envolventes para que las regiones se dibujen sobre las posiciones definitivas y sigan
  // conteniendo a sus miembros.
  const box = settings.footprint;
  separate(
    nodeList.map((node) => node.alias),
    positions,
    box,
    {
      minX: settings.padding + box.halfWidth,
      maxX: settings.width - settings.padding - box.halfWidth,
      minY: settings.padding + settings.labelBand - box.top,
      maxY: settings.height - settings.padding - box.bottom,
    },
  );

  for (const [alias, point] of positions) positions.set(alias, { x: round(point.x), y: round(point.y) });

  const tenantOrder: string[] = [];
  for (const edge of rawEdges) if (!tenantOrder.includes(edge.tenantId)) tenantOrder.push(edge.tenantId);

  const nodes: HyperNode[] = nodeList.map((node) => {
    const position = positions.get(node.alias) ?? { x: settings.width / 2, y: settings.height / 2 };
    return {
      alias: node.alias,
      label: node.label,
      enabled: node.enabled,
      tenants: [...node.tenants],
      edges: node.edges,
      x: position.x,
      y: position.y,
    };
  });

  const emptyEdges: string[] = [];
  const edges: HyperEdge[] = rawEdges.map((edge) => {
    const memberPoints = edge.members
      .map((alias) => positions.get(alias))
      .filter((point): point is Point => Boolean(point));

    if (memberPoints.length === 0) emptyEdges.push(edge.key);

    // Una room sin miembros dibujables se ancla en su órbita: se ve que existe y que está vacía,
    // en vez de desaparecer del dibujo como si no estuviera configurada.
    const basis = memberPoints.length > 0
      ? memberPoints
      : [anchors.get(edge.key) ?? { x: settings.width / 2, y: settings.height / 2 }];

    const hull = inflateHull(convexHull(basis), settings.padding);
    const centroid = centroidOf(basis);
    const topY = Math.min(...hull.map((point) => point.y));
    const minX = Math.min(...hull.map((point) => point.x));
    const maxX = Math.max(...hull.map((point) => point.x));
    return {
      key: edge.key,
      tenantId: edge.tenantId,
      tenantLabel: edge.tenantLabel,
      roomLabel: edge.roomLabel,
      members: edge.members,
      unknownMembers: edge.unknownMembers,
      outline: closedSmoothPath(hull),
      hull,
      centroid: { x: round(centroid.x), y: round(centroid.y) },
      // Ancla provisional: encima del borde superior de la región, horizontalmente centrada pero
      // sin salirse de ella. `placeLabels` la corrige después si aun así pisara algo.
      labelAnchor: {
        x: round(Math.min(maxX - 8, Math.max(minX + 8, centroid.x))),
        y: round(topY - 8),
      },
      hue: tenantOrder.indexOf(edge.tenantId) % 6,
    };
  });

  const tenants: TenantBlob[] = tenantOrder.map((tenantId, index) => {
    const own = edges.filter((edge) => edge.tenantId === tenantId);
    const members = new Set<string>();
    for (const edge of own) for (const alias of edge.members) members.add(alias);
    const centroid = centroidOf(own.map((edge) => edge.centroid));
    const source = tenantNodes.find((tenant, tenantIndex) => (tenant.id ?? `tenant#${tenantIndex}`) === tenantId);
    const topY = Math.min(...own.flatMap((edge) => edge.hull.map((point) => point.y)));
    return {
      id: tenantId,
      label: source?.label ?? source?.id ?? null,
      centroid: { x: round(centroid.x), y: round(centroid.y) },
      labelAnchor: { x: round(centroid.x), y: round(topY - 26) },
      roomCount: own.length,
      memberCount: members.size,
      hue: index % 6,
    };
  });

  const tenantCentroid = new Map(tenants.map((tenant) => [tenant.id, tenant.centroid]));
  const seenPairs = new Map<string, number>();
  const arcs: AclArc[] = (snapshot?.acl_edges ?? [])
    .map((edge: AclEdge, index): AclArc | null => {
      const from = edge.from_tenant ?? null;
      const to = edge.to_tenant ?? null;
      if (from === null || to === null) return null;
      const a = tenantCentroid.get(from);
      const b = tenantCentroid.get(to);
      // Una arista ACL hacia un tenant que la topología no describe no se dibuja: no hay dónde
      // ponerla sin inventar un nodo. Sigue apareciendo en la tabla de aristas de abajo.
      if (!a || !b) return null;
      if (from === to) return null;

      const pairKey = [from, to].sort().map(encodeURIComponent).join(SEP);
      const seen = seenPairs.get(pairKey) ?? 0;
      seenPairs.set(pairKey, seen + 1);
      // La normal de la curva ya se invierte con el sentido de recorrido, así que la ida y la
      // vuelta caen solas a lados opuestos: **no** hay que volver a invertir por orden lexicográfico
      // (hacerlo cancela el efecto y las deja casi superpuestas). `seen` es lo único que hace falta,
      // y sirve además para separar dos aristas repetidas del mismo par y mismo sentido.
      const bend = 46 + seen * 26;

      const geometry = arcBetween(a, b, bend);
      return {
        key: `${encodeURIComponent(from)}${SEP}${encodeURIComponent(to)}${SEP}${index}`,
        fromTenant: from,
        toTenant: to,
        enabled: edge.enabled ?? null,
        allowRoute: edge.allow_route ?? null,
        allowRead: edge.allow_read ?? null,
        allowControl: edge.allow_control ?? null,
        path: geometry.path,
        midpoint: geometry.midpoint,
        labelAnchor: { x: geometry.midpoint.x, y: round(geometry.midpoint.y - 9) },
        angle: geometry.angle,
      };
    })
    .filter((arc): arc is AclArc => arc !== null);

  // Reubicación de TODAS las etiquetas en una sola pasada, ya con los arcos ACL construidos.
  //
  // Salas, tenants y capacidades ACL compiten por el mismo espacio libre: resolver cada familia
  // por su cuenta deja una encima de la otra, que es exactamente lo que pasaba (`#marcas.pablo`
  // sobre `PABLO` sobre `DENEGADO`). Se colocan de arriba hacia abajo y cada etiqueta ya ubicada
  // pasa a ser obstáculo de las siguientes, igual que los nodos.
  const nodePoints = nodes.map((node) => ({ x: node.x, y: node.y }));
  const anchored = placeLabels(
    [
      // `charWidth`/`lineHeight` son estimaciones del ancho del texto, no medidas: el layout corre
      // antes de que exista un DOM donde medir. Se eligen por ARRIBA a propósito — sobrestimar
      // separa de más (feo pero legible), subestimar deja una etiqueta encima de un muñeco, que es
      // el defecto que esto vino a arreglar.
      ...tenants.map((tenant) => ({
        key: `tenant:${tenant.id}`,
        text: tenant.label ?? tenant.id,
        anchor: tenant.labelAnchor,
        charWidth: 9.6,
        lineHeight: 20,
      })),
      ...edges.map((edge) => ({
        key: `room:${edge.key}`,
        text: `#${edge.roomLabel ?? 'UNKNOWN'}`,
        anchor: edge.labelAnchor,
        charWidth: 8.6,
        lineHeight: 18,
      })),
      ...arcs.map((arc) => ({
        key: `acl:${arc.key}`,
        text: aclCaption(arc),
        anchor: arc.labelAnchor,
        charWidth: 7.4,
        lineHeight: 15,
      })),
    ],
    nodePoints,
    box,
    12,
  );
  for (const tenant of tenants) tenant.labelAnchor = anchored.get(`tenant:${tenant.id}`) ?? tenant.labelAnchor;
  for (const edge of edges) edge.labelAnchor = anchored.get(`room:${edge.key}`) ?? edge.labelAnchor;
  for (const arc of arcs) arc.labelAnchor = anchored.get(`acl:${arc.key}`) ?? arc.labelAnchor;

  return { nodes, edges, arcs, tenants, width: settings.width, height: settings.height, emptyEdges };
}
