export interface Point {
  x: number;
  y: number;
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
export const NODE_FOOTPRINT: NodeFootprint = { halfWidth: 32, top: -20, bottom: 36 };

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
export function jitter(seed: string, channel: number): number {
  return (hashString(`${seed}::${channel}`) % 10_000) / 10_000;
}

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

export function normalize(vector: Point): Point {
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

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function centroidOf(points: Point[]): Point {
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
