import type { NodeFootprint, Point } from './layout-geometry';
import { round } from './layout-geometry';

export interface LabelRect {
  x: number;
  y: number;
  halfWidth: number;
  top: number;
  bottom: number;
}

export function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
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
export function placeLabels(
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

/**
 * El texto de la etiqueta de una arista ACL.
 *
 * Vive acá y no en el componente porque el layout necesita su **ancho** para poder repartir las
 * etiquetas sin que se pisen. Si el componente escribiera otro texto, el reparto estaría hecho
 * sobre una medida que no corresponde y volverían los solapamientos, esta vez sin que se note por
 * qué.
 */
export function aclCaption(arc: {
  enabled?: boolean | null;
  allowRoute?: boolean | null;
  allowRead?: boolean | null;
  allowControl?: boolean | null;
}): string {
  const caps = [
    arc.allowRoute === true ? 'route' : null,
    arc.allowRead === true ? 'read' : null,
    arc.allowControl === true ? 'control' : null,
  ].filter(Boolean);
  if (caps.length > 0) return caps.join(' · ');
  return arc.enabled === false ? 'denegado' : 'UNKNOWN';
}
