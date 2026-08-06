import type { AclEdge, TenantNode, TopologySnapshot } from '../../api/types';

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

export interface Point {
  x: number;
  y: number;
}

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

/**
 * Cuánto espacio ocupa REALMENTE un nodo en pantalla, medido desde su centro.
 *
 * Un nodo no es un punto: es el avatar **más** su nombre debajo **más** el globo de la cola arriba
 * a la derecha. Separar por `nodeSpacing` circular contra el radio del avatar es justamente el
 * error que hacía que `zeus` pisara a `argos`: los avatares no se tocaban, pero sus nombres y sus
 * globos sí. La caja es asimétrica porque el dibujo lo es (el nombre sólo cuelga hacia abajo).
 */
export interface NodeFootprint {
  /** Semiancho: la mitad del nombre más largo esperable, no el radio del avatar. */
  halfWidth: number;
  /** Desplazamiento del borde superior respecto del centro (negativo). */
  top: number;
  /** Desplazamiento del borde inferior respecto del centro (positivo). */
  bottom: number;
}

/** El nodo del hipergrafo estructural: punto de 9 px con su alias debajo. */
const NODE_FOOTPRINT: NodeFootprint = { halfWidth: 32, top: -20, bottom: 36 };

/**
 * ¿Se pisan dos nodos colocados en `a` y `b`?
 *
 * Se exporta porque es la condición que los tests afirman: dos cajas axis-aligned se solapan si y
 * sólo si se solapan en los dos ejes a la vez. Comprobarlo con distancia euclídea contra un radio
 * es más simple y está mal — deja pasar exactamente los casos que se ven feos (dos nodos casi a la
 * misma altura, separados lo justo para que los círculos no se toquen y los nombres sí).
 */
export function footprintsOverlap(a: Point, b: Point, box: NodeFootprint = NODE_FOOTPRINT): boolean {
  const width = box.halfWidth * 2;
  const height = box.bottom - box.top;
  return Math.abs(b.x - a.x) < width && Math.abs(b.y - a.y) < height;
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

const DEFAULTS = {
  width: 1000,
  height: 680,
  padding: 34,
  nodeSpacing: 74,
  iterations: 220,
  labelBand: 34,
} as const;

/**
 * Separador de claves compuestas.
 *
 * Los componentes se escapan con `encodeURIComponent`, que codifica la barra como `%2F`: así dos
 * pares distintos no pueden producir la misma clave (tenant `a` + room `b/c` no colisiona con
 * tenant `a/b` + room `c`). Se elige un separador **visible** a propósito: un carácter de control
 * dentro del fuente hace que `grep` clasifique el archivo como binario y deja de encontrarlo.
 */
const SEP = '/';

function edgeKey(tenantId: string, roomId: string): string {
  return `${encodeURIComponent(tenantId)}${SEP}${encodeURIComponent(roomId)}`;
}

/**
 * Hash determinista (FNV-1a de 32 bits) sobre una cadena.
 *
 * Se usa para desempatar posiciones iniciales sin recurrir a un generador aleatorio: la misma
 * cadena produce siempre el mismo desplazamiento, así que el dibujo es reproducible entre
 * refrescos, entre sesiones y entre máquinas.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Pseudo-aleatorio determinista en [0, 1) derivado de una cadena y un canal. */
function jitter(seed: string, channel: number): number {
  return (hashString(`${seed}::${channel}`) % 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------------

/** Envolvente convexa (monotone chain de Andrew). Devuelve los vértices en sentido horario. */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points.slice();
  const sorted = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : sorted;
}

function normalize(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

/**
 * Infla un polígono convexo empujando cada vértice a lo largo de su bisectriz exterior.
 *
 * Para un polígono convexo, `(v - anterior) + (v - siguiente)` apunta hacia afuera, así que sirve
 * de dirección de inflado sin necesidad de calcular normales por arista. Se prefiere a empujar
 * desde el centroide porque en envolventes alargadas (dos o tres nodos casi alineados) el empuje
 * radial deja los extremos sin padding y el contorno acaba cortando los nodos que debería contener.
 */
export function inflateHull(hull: Point[], padding: number): Point[] {
  const count = hull.length;
  if (count === 0) return [];
  if (count === 1) {
    // Un solo miembro: círculo. Se aproxima con 8 puntos para que el suavizado lo cierre redondo.
    const [center] = hull;
    return Array.from({ length: 8 }, (_, index) => {
      const angle = (index / 8) * Math.PI * 2;
      return { x: center.x + Math.cos(angle) * padding, y: center.y + Math.sin(angle) * padding };
    });
  }
  if (count === 2) {
    // Dos miembros: cápsula. Se extiende `padding` a lo largo del eje y `padding` en perpendicular.
    const [a, b] = hull;
    const axis = normalize({ x: b.x - a.x, y: b.y - a.y });
    const perpendicular = { x: -axis.y, y: axis.x };
    const extend = (point: Point, sign: number): Point => ({
      x: point.x + axis.x * padding * sign,
      y: point.y + axis.y * padding * sign,
    });
    const shift = (point: Point, sign: number): Point => ({
      x: point.x + perpendicular.x * padding * sign,
      y: point.y + perpendicular.y * padding * sign,
    });
    const tailA = extend(a, -1);
    const tailB = extend(b, 1);
    return [shift(tailA, 1), shift(tailB, 1), shift(tailB, -1), shift(tailA, -1)];
  }

  return hull.map((vertex, index) => {
    const previous = hull[(index - 1 + count) % count];
    const next = hull[(index + 1) % count];
    const outward = normalize({
      x: normalize({ x: vertex.x - previous.x, y: vertex.y - previous.y }).x
        + normalize({ x: vertex.x - next.x, y: vertex.y - next.y }).x,
      y: normalize({ x: vertex.x - previous.x, y: vertex.y - previous.y }).y
        + normalize({ x: vertex.x - next.x, y: vertex.y - next.y }).y,
    });
    return { x: vertex.x + outward.x * padding, y: vertex.y + outward.y * padding };
  });
}

/**
 * Convierte un polígono cerrado en un `path` suave (Catmull-Rom → Bézier cúbica).
 *
 * El suavizado es lo que hace que una hiperarista se lea como "una región que contiene cosas" y no
 * como un polígono técnico. Es puramente visual: no mueve los nodos ni cambia quién está adentro.
 */
export function closedSmoothPath(points: Point[]): string {
  const count = points.length;
  if (count === 0) return '';
  if (count === 1) return `M ${round(points[0].x)} ${round(points[0].y)}`;

  const segments: string[] = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let index = 0; index < count; index += 1) {
    const p0 = points[(index - 1 + count) % count];
    const p1 = points[index];
    const p2 = points[(index + 1) % count];
    const p3 = points[(index + 2) % count];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push(`C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(p2.x)} ${round(p2.y)}`);
  }
  segments.push('Z');
  return segments.join(' ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function centroidOf(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Punto dentro de polígono (ray casting). Se usa en los tests: el contorno debe contener a sus miembros. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Construcción del modelo
// ---------------------------------------------------------------------------

interface RawEdge {
  key: string;
  tenantId: string;
  tenantLabel: string | null;
  roomLabel: string | null;
  members: string[];
  unknownMembers: number;
}

interface RawNode {
  alias: string;
  label: string | null;
  /** `false` gana sobre `true`: si alguna membresía lo declara deshabilitado, se muestra así. */
  enabled: boolean | null;
  tenants: Set<string>;
  edges: string[];
}

/**
 * Aplana el snapshot a nodos y hiperaristas.
 *
 * Regla de honestidad, la misma que ya sigue el resto de la consola: **nada se inventa**. Un tenant
 * sin id se identifica por su posición, un miembro sin alias se cuenta como `unknownMembers` y no
 * genera un nodo fantasma, y `enabled` ausente queda en `null` (UNKNOWN) en vez de asumirse `true`.
 * Un dibujo bonito que rellena huecos es peor que una tabla: parece completo.
 */
function collect(tenants: TenantNode[]): { nodes: Map<string, RawNode>; edges: RawEdge[] } {
  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];

  tenants.forEach((tenant, tenantIndex) => {
    const tenantId = tenant.id ?? `tenant#${tenantIndex}`;
    (tenant.rooms ?? []).forEach((room, roomIndex) => {
      const roomId = room.id ?? `room#${roomIndex}`;
      const key = edgeKey(tenantId, roomId);
      const members: string[] = [];
      let unknownMembers = 0;

      (room.members ?? []).forEach((member) => {
        const alias = member.alias ?? null;
        if (alias === null || alias === '') {
          unknownMembers += 1;
          return;
        }
        if (!members.includes(alias)) members.push(alias);
        const existing = nodes.get(alias);
        if (existing) {
          existing.tenants.add(tenantId);
          if (!existing.edges.includes(key)) existing.edges.push(key);
          // Una membresía deshabilitada en cualquier room basta para marcarlo: es la lectura segura.
          if (member.enabled === false) existing.enabled = false;
          else if (existing.enabled === null && member.enabled === true) existing.enabled = true;
        } else {
          nodes.set(alias, {
            alias,
            label: alias,
            enabled: member.enabled ?? null,
            tenants: new Set([tenantId]),
            edges: [key],
          });
        }
      });

      edges.push({
        key,
        tenantId,
        tenantLabel: tenant.label ?? tenant.id ?? null,
        roomLabel: room.label ?? room.id ?? null,
        members,
        unknownMembers,
      });
    });
  });

  return { nodes, edges };
}

/**
 * Relajación determinista: cada nodo es atraído por las hiperaristas que lo contienen y repelido
 * por los nodos que se le acercan demasiado.
 *
 * No es un force-directed con temperatura ni con aleatoriedad; es un descenso fijo de `iterations`
 * pasos que, con las mismas entradas, converge siempre al mismo lugar. El efecto buscado es que un
 * alias compartido por dos rooms quede naturalmente entre las dos (y por lo tanto en el solapamiento
 * de ambas envolventes), sin tener que caso-especializar ese escenario.
 */
function relax(
  nodes: RawNode[],
  edges: RawEdge[],
  anchors: Map<string, Point>,
  options: Required<LayoutOptions>,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const edgeById = new Map(edges.map((edge) => [edge.key, edge]));

  for (const node of nodes) {
    const incident = node.edges.map((key) => anchors.get(key)).filter((point): point is Point => Boolean(point));
    const base = incident.length > 0 ? centroidOf(incident) : { x: options.width / 2, y: options.height / 2 };
    // El desplazamiento inicial evita que dos alias con las mismas membresías nazcan superpuestos
    // (la repulsión sola no puede separarlos si arrancan en el mismo punto exacto).
    const angle = jitter(node.alias, 1) * Math.PI * 2;
    const radius = 6 + jitter(node.alias, 2) * 26;
    positions.set(node.alias, { x: base.x + Math.cos(angle) * radius, y: base.y + Math.sin(angle) * radius });
  }

  const minimum = options.nodeSpacing;
  for (let step = 0; step < options.iterations; step += 1) {
    const cooling = 1 - step / options.iterations;

    // Atracción hacia el ancla de cada hiperarista incidente.
    for (const node of nodes) {
      const position = positions.get(node.alias);
      if (!position) continue;
      const targets = node.edges
        .map((key) => anchors.get(key))
        .filter((point): point is Point => Boolean(point));
      if (targets.length === 0) continue;
      const target = centroidOf(targets);
      position.x += (target.x - position.x) * 0.06 * cooling;
      position.y += (target.y - position.y) * 0.06 * cooling;
    }

    // Repulsión entre nodos demasiado próximos.
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions.get(nodes[i].alias);
        const b = positions.get(nodes[j].alias);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-6) {
          // Empate exacto: se separa por una dirección derivada de los alias, no al azar.
          const angle = jitter(`${nodes[i].alias}|${nodes[j].alias}`, 3) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1e-6;
        }
        if (distance >= minimum) continue;
        const push = ((minimum - distance) / minimum) * 0.5;
        const ux = dx / distance;
        const uy = dy / distance;
        a.x -= ux * push * minimum * 0.5;
        a.y -= uy * push * minimum * 0.5;
        b.x += ux * push * minimum * 0.5;
        b.y += uy * push * minimum * 0.5;
      }
    }

    // Contención: nadie se sale del lienzo. Se recorta en vez de rebotar para no introducir
    // oscilación. El margen sale de la caja real del nodo y de la banda reservada arriba para las
    // etiquetas de sala: un nodo pegado al borde superior no dejaría dónde escribir `#sala`.
    const box = options.footprint;
    for (const node of nodes) {
      const position = positions.get(node.alias);
      if (!position) continue;
      position.x = Math.min(options.width - options.padding - box.halfWidth, Math.max(options.padding + box.halfWidth, position.x));
      position.y = Math.min(options.height - options.padding - box.bottom, Math.max(options.padding + options.labelBand - box.top, position.y));
    }
  }

  // Redondeo final: mantiene el SVG legible y hace que dos corridas idénticas sean idénticas byte a byte.
  const result = new Map<string, Point>();
  for (const node of nodes) {
    const position = positions.get(node.alias);
    if (position) result.set(node.alias, { x: round(position.x), y: round(position.y) });
  }
  void edgeById;
  return result;
}

/**
 * Pasada final: separa a empujones **cualquier** par de nodos cuyas cajas se toquen.
 *
 * La relajación de arriba es un compromiso entre atracción y repulsión, así que *tiende* a separar
 * pero no lo garantiza: con muchos alias en la misma sala converge con nodos encimados, y eso es
 * exactamente lo que se veía. Esto no negocia — empuja por el eje de menor penetración hasta que no
 * queda ningún solapamiento, y devuelve si lo consiguió para poder afirmarlo en un test en vez de
 * mirarlo a ojo.
 *
 * Se empuja por un solo eje (el que menos hay que mover) en vez de radialmente porque conserva
 * mucho mejor la agrupación por sala: dos nodos apilados en vertical se separan en vertical y
 * siguen dentro de su región, mientras que un empuje radial los manda a la diagonal y termina
 * sacando a uno de la envolvente a la que pertenece.
 */
function separate(
  order: string[],
  positions: Map<string, Point>,
  box: NodeFootprint,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  passes = 240,
): boolean {
  const width = box.halfWidth * 2;
  const height = box.bottom - box.top;

  for (let pass = 0; pass < passes; pass += 1) {
    let touched = false;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const a = positions.get(order[i]);
        const b = positions.get(order[j]);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (Math.abs(dx) >= width || Math.abs(dy) >= height) continue;
        touched = true;
        // Empate exacto: se desempata por hash de los alias, nunca al azar — el layout tiene que
        // ser reproducible entre refrescos o el operador pierde de vista al agente que seguía.
        if (dx === 0 && dy === 0) {
          const angle = jitter(`${order[i]}|${order[j]}`, 7) * Math.PI * 2;
          dx = Math.cos(angle) * 0.5;
          dy = Math.sin(angle) * 0.5;
        }
        const needX = width - Math.abs(dx);
        const needY = height - Math.abs(dy);
        if (needX <= needY) {
          const push = (needX / 2 + 0.5) * (dx >= 0 ? 1 : -1);
          a.x -= push;
          b.x += push;
        } else {
          const push = (needY / 2 + 0.5) * (dy >= 0 ? 1 : -1);
          a.y -= push;
          b.y += push;
        }
      }
    }
    // Contención después de cada pasada: si un empujón sacó a alguien del lienzo, vuelve adentro y
    // la pasada siguiente reparte la diferencia hacia el otro lado.
    for (const alias of order) {
      const point = positions.get(alias);
      if (!point) continue;
      point.x = Math.min(bounds.maxX, Math.max(bounds.minX, point.x));
      point.y = Math.min(bounds.maxY, Math.max(bounds.minY, point.y));
    }
    if (!touched) return true;
  }

  return !order.some((alias, i) => order.slice(i + 1).some((other) => {
    const a = positions.get(alias);
    const b = positions.get(other);
    return a && b ? footprintsOverlap(a, b, box) : false;
  }));
}

interface LabelRect { x: number; y: number; halfWidth: number; top: number; bottom: number }

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth
    && a.y + a.top < b.y + b.bottom
    && b.y + b.top < a.y + a.bottom;
}

/**
 * Coloca las etiquetas (salas y tenants) sobre el borde de arriba de su región y las corre hacia
 * arriba hasta que dejan de pisar un nodo o a otra etiqueta.
 *
 * Determinista: el orden de colocación es fijo (de arriba abajo, desempatando por clave), así que
 * dos corridas con la misma topología colocan las mismas etiquetas en los mismos píxeles.
 */
function placeLabels(
  requests: { key: string; text: string; anchor: Point; charWidth: number; lineHeight: number }[],
  nodes: Point[],
  box: NodeFootprint,
  limitTop: number,
): Map<string, Point> {
  const obstacles: LabelRect[] = nodes.map((point) => ({
    x: point.x,
    y: point.y,
    halfWidth: box.halfWidth,
    top: box.top,
    bottom: box.bottom,
  }));

  const placed = new Map<string, Point>();
  const ordered = [...requests].sort((a, b) => (a.anchor.y === b.anchor.y ? a.key.localeCompare(b.key) : a.anchor.y - b.anchor.y));

  for (const request of ordered) {
    const halfWidth = Math.max(18, (request.text.length * request.charWidth) / 2 + 4);
    const top = -request.lineHeight * 0.82;
    const bottom = request.lineHeight * 0.28;
    let best: Point = { ...request.anchor };
    let bestScore = Number.POSITIVE_INFINITY;

    // Candidatos: primero subir en escalones sobre el borde; después, correrse a los lados —cada
    // vez más lejos— a esas mismas alturas. Nunca hacia abajo: abajo está la región, y ahí es
    // justamente donde están los muñecos que la etiqueta no puede pisar.
    const paso = request.lineHeight + 3;
    const candidates: Point[] = [];
    for (let step = 0; step <= 9; step += 1) candidates.push({ x: request.anchor.x, y: request.anchor.y - step * paso });
    for (let lado = 1; lado <= 3; lado += 1) {
      for (const dx of [-1, 1]) {
        for (let step = 0; step <= 6; step += 1) {
          candidates.push({
            x: request.anchor.x + dx * (halfWidth + box.halfWidth + 4) * lado,
            y: request.anchor.y - step * paso,
          });
        }
      }
    }

    // `obstacles` acumula los nodos Y las etiquetas ya colocadas: por eso una etiqueta no puede
    // caer sobre otra, sin llevar dos listas separadas.
    for (const candidate of candidates) {
      const y = Math.max(limitTop, candidate.y);
      const rect: LabelRect = { x: candidate.x, y, halfWidth, top, bottom };
      let score = 0;
      for (const obstacle of obstacles) if (rectsOverlap(rect, obstacle)) score += 1;
      if (score < bestScore) {
        bestScore = score;
        best = { x: round(candidate.x), y: round(y) };
      }
      if (score === 0) break;
    }

    placed.set(request.key, best);
    obstacles.push({ x: best.x, y: best.y, halfWidth, top, bottom });
  }

  return placed;
}

/** Ancla de cada hiperarista: tenants repartidos en una elipse, rooms en una órbita interna. */
function anchorEdges(edges: RawEdge[], options: Required<LayoutOptions>): Map<string, Point> {
  const tenantIds: string[] = [];
  for (const edge of edges) if (!tenantIds.includes(edge.tenantId)) tenantIds.push(edge.tenantId);

  const anchors = new Map<string, Point>();
  const cx = options.width / 2;
  const cy = options.height / 2;
  const rx = options.width * 0.29;
  const ry = options.height * 0.29;

  tenantIds.forEach((tenantId, tenantIndex) => {
    // Cuando hay un solo tenant se centra; repartirlo en una elipse de un punto lo dejaría descentrado.
    const tenantAngle = tenantIds.length === 1
      ? -Math.PI / 2
      : (tenantIndex / tenantIds.length) * Math.PI * 2 - Math.PI / 2;
    const tenantCenter = tenantIds.length === 1
      ? { x: cx, y: cy }
      : { x: cx + Math.cos(tenantAngle) * rx, y: cy + Math.sin(tenantAngle) * ry };

    const rooms = edges.filter((edge) => edge.tenantId === tenantId);
    rooms.forEach((room, roomIndex) => {
      const orbit = rooms.length === 1 ? 0 : 58 + rooms.length * 7;
      const roomAngle = (roomIndex / Math.max(1, rooms.length)) * Math.PI * 2 + jitter(tenantId, 4) * Math.PI;
      anchors.set(room.key, {
        x: tenantCenter.x + Math.cos(roomAngle) * orbit,
        y: tenantCenter.y + Math.sin(roomAngle) * orbit,
      });
    });
  });

  return anchors;
}

/** Curva dirigida entre dos centroides, curvada para que A→B y B→A no se pisen. */
function arcBetween(from: Point, to: Point, bend: number): { path: string; midpoint: Point; angle: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / distance, y: dx / distance };
  const control = {
    x: (from.x + to.x) / 2 + normal.x * bend,
    y: (from.y + to.y) / 2 + normal.y * bend,
  };
  // Punto medio real de la Bézier cuadrática en t=0.5, no el promedio de extremos: si no, la
  // etiqueta y la flecha quedan flotando fuera de la curva justamente cuando más se curva.
  const midpoint = {
    x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y,
  };
  const tangent = { x: control.x - from.x + (to.x - control.x), y: control.y - from.y + (to.y - control.y) };
  return {
    path: `M ${round(from.x)} ${round(from.y)} Q ${round(control.x)} ${round(control.y)} ${round(to.x)} ${round(to.y)}`,
    midpoint: { x: round(midpoint.x), y: round(midpoint.y) },
    angle: round((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI),
  };
}


/**
 * El texto de la etiqueta de una arista ACL.
 *
 * Vive acá y no en el componente porque el layout necesita su **ancho** para poder repartir las
 * etiquetas sin que se pisen. Si el componente escribiera otro texto, el reparto estaría hecho
 * sobre una medida que no corresponde y volverían los solapamientos, esta vez sin que se note por
 * qué.
 */
export function aclCaption(arc: Pick<AclArc, 'enabled' | 'allowRoute' | 'allowRead' | 'allowControl'>): string {
  const caps = [
    arc.allowRoute === true ? 'route' : null,
    arc.allowRead === true ? 'read' : null,
    arc.allowControl === true ? 'control' : null,
  ].filter(Boolean);
  if (caps.length > 0) return caps.join(' · ');
  return arc.enabled === false ? 'denegado' : 'UNKNOWN';
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
