import type { TenantNode } from '../../../api/types';
import {
  centroidOf,
  footprintsOverlap,
  jitter,
  round,
  type NodeFootprint,
  type Point,
} from './layout-geometry';
import type { LayoutOptions } from './hypergraph-layout';

export const DEFAULTS = {
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
export const SEP = '/';

export function edgeKey(tenantId: string, roomId: string): string {
  return `${encodeURIComponent(tenantId)}${SEP}${encodeURIComponent(roomId)}`;
}

export interface RawEdge {
  key: string;
  tenantId: string;
  tenantLabel: string | null;
  roomLabel: string | null;
  members: string[];
  unknownMembers: number;
}

export interface RawNode {
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
export function collect(tenants: TenantNode[]): { nodes: Map<string, RawNode>; edges: RawEdge[] } {
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
export function relax(
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
export function separate(
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

/** Ancla de cada hiperarista: tenants repartidos en una elipse, rooms en una órbita interna. */
export function anchorEdges(edges: RawEdge[], options: Required<LayoutOptions>): Map<string, Point> {
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
export function arcBetween(from: Point, to: Point, bend: number): { path: string; midpoint: Point; angle: number } {
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
