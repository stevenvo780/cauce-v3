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

/** Separator for compound keys. Components are escaped with `encodeURIComponent`, which encodes the slash as
 *  `%2F`, so two different pairs cannot produce the same key. It is **visible** on purpose: a control character
 *  in the source makes `grep` classify the file as binary and stop finding it. */
export const SEP = '/';

export function edgeKey(tenantId: string, roomId: string): string {
  return `${encodeURIComponent(tenantId)}${SEP}${encodeURIComponent(roomId)}`;
}

/** Identity of a node: the PAIR (tenant, alias), never the alias alone. Two tenants can name an agent the same
 *  way and they are two different agents; indexing by alias fused them into a single figure hanging from rooms
 *  of both tenants, a membership the backend never reported. */
export function nodeKey(tenantId: string, alias: string): string {
  return `${encodeURIComponent(tenantId)}${SEP}${encodeURIComponent(alias)}`;
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
  /** `nodeKey(tenantId, alias)`. Unique per drawn figure. */
  key: string;
  tenantId: string;
  alias: string;
  label: string | null;
  /** `false` wins over `true`: if some membership declares it disabled, it is shown that way. */
  enabled: boolean | null;
  edges: string[];
}

/**
 * Flattens the snapshot into nodes and hyperedges.
 *
 * Rule of honesty, the same one the rest of the console already follows: **nothing is invented**. A tenant
 * without an id is identified by its position, a member without an alias is counted as `unknownMembers` and
 * does not generate a phantom node, and missing `enabled` stays as `null` (UNKNOWN) instead of being assumed
 * `true`. A pretty drawing that fills gaps is worse than a table: it looks complete.
 */
export function collect(tenants: TenantNode[]): { nodes: Map<string, RawNode>; edges: RawEdge[] } {
  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];

  tenants.forEach((tenant, tenantIndex) => {
    const tenantId = tenant.id ?? `tenant#${String(tenantIndex)}`;
    (tenant.rooms ?? []).forEach((room, roomIndex) => {
      const roomId = room.id ?? `room#${String(roomIndex)}`;
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
        const identity = nodeKey(tenantId, alias);
        const existing = nodes.get(identity);
        if (existing) {
          if (!existing.edges.includes(key)) existing.edges.push(key);
          // A disabled membership in any room is enough to mark it: that is the safe reading.
          if (member.enabled === false) existing.enabled = false;
          else if (existing.enabled === null && member.enabled === true) existing.enabled = true;
        } else {
          nodes.set(identity, {
            key: identity,
            tenantId,
            alias,
            label: alias,
            enabled: member.enabled ?? null,
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
 * Deterministic relaxation: each node is pulled by the hyperedges that contain it and pushed back by the nodes
 * that get too close.
 *
 * It is not a force-directed with temperature or randomness; it is a fixed descent of `iterations` steps that,
 * with the same inputs, always converges to the same place. The intended effect is that an alias shared by two
 * rooms naturally sits between the two (and therefore inside the overlap of both envelopes), without having to
 * special-case that scenario.
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
    // The initial offset prevents two nodes with the same memberships from being born overlapped
    // (repulsion alone cannot separate them if they start at the exact same point).
    const angle = jitter(node.key, 1) * Math.PI * 2;
    const radius = 6 + jitter(node.key, 2) * 26;
    positions.set(node.key, { x: base.x + Math.cos(angle) * radius, y: base.y + Math.sin(angle) * radius });
  }

  const minimum = options.nodeSpacing;
  for (let step = 0; step < options.iterations; step += 1) {
    const cooling = 1 - step / options.iterations;

    // Attraction towards the anchor of each incident hyperedge.
    for (const node of nodes) {
      const position = positions.get(node.key);
      if (!position) continue;
      const targets = node.edges
        .map((key) => anchors.get(key))
        .filter((point): point is Point => Boolean(point));
      if (targets.length === 0) continue;
      const target = centroidOf(targets);
      position.x += (target.x - position.x) * 0.06 * cooling;
      position.y += (target.y - position.y) * 0.06 * cooling;
    }

    // Repulsion between too-close nodes.
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions.get(nodes[i].key);
        const b = positions.get(nodes[j].key);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-6) {
          // Exact tie: they are separated by a direction derived from the aliases, not at random.
          const angle = jitter(`${nodes[i].key}|${nodes[j].key}`, 3) * Math.PI * 2;
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

    // Containment: nobody leaves the canvas. They are clipped instead of bouncing to avoid introducing
    // oscillation. The margin comes from the node's real box and from the band reserved above for the
    // room labels: a node stuck to the top edge would leave no room to write `#room`.
    const box = options.footprint;
    for (const node of nodes) {
      const position = positions.get(node.key);
      if (!position) continue;
      position.x = Math.min(options.width - options.padding - box.halfWidth, Math.max(options.padding + box.halfWidth, position.x));
      position.y = Math.min(options.height - options.padding - box.bottom, Math.max(options.padding + options.labelBand - box.top, position.y));
    }
  }

  // Final rounding: keeps the SVG readable and makes two identical runs identical byte for byte.
  const result = new Map<string, Point>();
  for (const node of nodes) {
    const position = positions.get(node.key);
    if (position) result.set(node.key, { x: round(position.x), y: round(position.y) });
  }
  void edgeById;
  return result;
}

/**
 * Final pass: brute-force separates **any** pair of nodes whose boxes touch.
 *
 * The relaxation above is a compromise between attraction and repulsion, so it *tends* to separate but does
 * not guarantee it: with many aliases in the same room it converges with stacked nodes, which is exactly what
 * was being seen. This one does not negotiate — it pushes along the axis of least penetration until no overlap
 * remains, and returns whether it managed so this can be asserted in a test instead of being eyeballed.
 *
 * It pushes along a single axis (the one that moves least) instead of radially because it preserves the
 * grouping by room much better: two vertically stacked nodes separate vertically and stay inside their region,
 * while a radial push sends them to the diagonal and ends up taking one out of the envelope it belongs to.
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
        // Exact tie: broken by a hash of the node keys, never at random — the layout must be reproducible
        // across refreshes or the operator loses sight of the agent they were tracking.
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
    // Containment after each pass: if a push took someone out of the canvas, they go back in and the next
    // pass distributes the difference towards the other side.
    for (const key of order) {
      const point = positions.get(key);
      if (!point) continue;
      point.x = Math.min(bounds.maxX, Math.max(bounds.minX, point.x));
      point.y = Math.min(bounds.maxY, Math.max(bounds.minY, point.y));
    }
    if (!touched) return true;
  }

  return !order.some((key, i) => order.slice(i + 1).some((other) => {
    const a = positions.get(key);
    const b = positions.get(other);
    return a && b ? footprintsOverlap(a, b, box) : false;
  }));
}

/** Anchor for each hyperedge: tenants spread on an ellipse, rooms on an inner orbit. */
export function anchorEdges(edges: RawEdge[], options: Required<LayoutOptions>): Map<string, Point> {
  const tenantIds: string[] = [];
  for (const edge of edges) if (!tenantIds.includes(edge.tenantId)) tenantIds.push(edge.tenantId);

  const anchors = new Map<string, Point>();
  const cx = options.width / 2;
  const cy = options.height / 2;
  const rx = options.width * 0.29;
  const ry = options.height * 0.29;

  tenantIds.forEach((tenantId, tenantIndex) => {
    // When there is only one tenant it is centered; spreading it on a one-point ellipse would offset it.
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

/** Directed curve between two centroids, curved so A→B and B→A do not collide. */
export function arcBetween(from: Point, to: Point, bend: number): { path: string; midpoint: Point; angle: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / distance, y: dx / distance };
  const control = {
    x: (from.x + to.x) / 2 + normal.x * bend,
    y: (from.y + to.y) / 2 + normal.y * bend,
  };
  // Real midpoint of the quadratic Bézier at t=0.5, not the average of the endpoints: otherwise the
  // label and the arrow float outside the curve precisely when it curves the most.
  const midpoint = {
    x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y,
  };
  const tangent = { x: control.x - from.x + (to.x - control.x), y: control.y - from.y + (to.y - control.y) };
  return {
    path: `M ${String(round(from.x))} ${String(round(from.y))} Q ${String(round(control.x))} ${String(round(control.y))} ${String(round(to.x))} ${String(round(to.y))}`,
    midpoint: { x: round(midpoint.x), y: round(midpoint.y) },
    angle: round((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI),
  };
}
