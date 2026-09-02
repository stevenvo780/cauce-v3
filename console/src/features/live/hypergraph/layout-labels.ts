import type { NodeFootprint, Point } from './layout-geometry';
import { round } from './layout-geometry';

interface LabelRect {
  x: number;
  y: number;
  halfWidth: number;
  top: number;
  bottom: number;
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth
    && a.y + a.top < b.y + b.bottom
    && b.y + b.top < a.y + a.bottom;
}

/**
 * Places the labels (rooms and tenants) on the top edge of their region and shifts them upward
 * until they no longer overlap a node or another label.
 *
 * Deterministic: the placement order is fixed (top to bottom, tie-broken by key), so two runs
 * with the same topology place the same labels at the same pixels.
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

    // Candidates: first step upward along the edge; then slide sideways —each time further—
    // at those same heights. Never downward: the region is below, and that is exactly where the
    // figures sit, which the label must not overlap.
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

    // `obstacles` accumulates BOTH the nodes and the already-placed labels: that is how a label
    // cannot land on another without carrying two separate lists.
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
 * The text of an ACL edge label.
 *
 * It lives here and not in the component because the layout needs its **width** to spread the
 * labels without overlap. If the component wrote different text, the spread would run on a
 * measurement that does not match, and the overlaps would return — this time without anyone
 * noticing why.
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
