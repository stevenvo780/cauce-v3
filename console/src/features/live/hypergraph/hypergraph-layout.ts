/**
 * Topology hypergraph model and layout.
 *
 * Why a hypergraph and not a regular graph: in Cauce a *room* does not relate pairs of agents, it relates **all of
 * its members at once**. Drawing that with two-ended edges forces inventing N·(N-1)/2 lines that do not exist in the
 * model —with 15 aliases that is an unreadable tangle that also claims links the backend never reported. A hyperedge
 * is drawn as a single envelope containing its members: one room, one shape. An alias that belongs to two rooms is
 * drawn **only once** and the two envelopes overlap on it; that overlap *is* the interesting data (who bridges rooms)
 * and appears on its own, without computing it separately.
 *
 * Everything here is deterministic on purpose: **`Math.random` is not used**. A layout that reshuffles on every
 * refresh forces the operator to reorient themselves every 10 seconds and makes it impossible to compare two
 * captures. Given the same input, this function returns exactly the same output.
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
  nodeKey,
  relax,
  separate,
} from './layout-nodes';

export {
  convexHull,
  footprintsOverlap,
  inflateHull,
  pointInPolygon,
  type Point,
} from './layout-geometry';

export { aclCaption } from './layout-labels';

/**
 * An agent: the pair (tenant, alias). Exists only once even if it belongs to several rooms of its tenant.
 *
 * The same alias under two tenants gives TWO nodes, because they are two agents: fusing them drew one figure
 * hanging from rooms of both tenants and mixed their `enabled`.
 */
interface HyperNode {
  /** `nodeKey(tenantId, alias)`: the identity, unique across the whole drawing. */
  key: string;
  alias: string;
  /** Label to display. `null` when the backend did not report an alias (shown as UNKNOWN). */
  label: string | null;
  /** `null` = the backend did not report it. It is not assumed enabled. */
  enabled: boolean | null;
  /** The single tenant this node belongs to, as a list: an alias never crosses tenants any more. */
  tenants: string[];
  /** Keys of the hyperedges (rooms) that contain it. */
  edges: string[];
  x: number;
  y: number;
}

/** A room: the hyperedge itself. */
interface HyperEdge {
  key: string;
  tenantId: string;
  tenantLabel: string | null;
  roomLabel: string | null;
  /** Member aliases, in the stable order they were resolved. */
  members: string[];
  /** Members the backend reported without an alias. They are counted, not invented. */
  unknownMembers: number;
  /** Closed outline already smoothed and padded, ready for a `<path d>`. */
  outline: string;
  /**
   * Where to hang `#room-name`.
   *
   * **It is not the centroid**, and that is the whole difference between a legible drawing and an illegible one:
   * the centroid of a region is exactly where the figures are, so the label always fell on top of one (`#ops.infra`
   * over `zeus`, `#grp.isa` over `salva`). Here it is anchored to the **top edge** of the region and then separated
   * from any node and any other label (`placeLabels`), so the overlap is not "unlikely": it does not happen, and
   * there is a test that asserts it.
   */
  labelAnchor: Point;
  /**
   * The outline vertices before smoothing. They are exposed so tests can assert that the region **actually contains
   * its members**: an envelope that leaves a node outside draws a false membership, and that is a data error disguised
   * as an aesthetic detail.
   */
  hull: Point[];
  centroid: Point;
  /** Stable index 0..5 to pick a color without depending on render order. */
  hue: number;
}

/** An ACL edge between tenants: this one IS binary and directed. */
interface AclArc {
  key: string;
  fromTenant: string;
  toTenant: string;
  enabled: boolean | null;
  allowRoute: boolean | null;
  allowRead: boolean | null;
  allowControl: boolean | null;
  /** Directed curve between the centroids of the two tenants. */
  path: string;
  /** Point where to hang the arrow tip: the actual middle of the Bézier. */
  midpoint: Point;
  /**
   * Where to write `route · read · control`.
   *
   * It comes from the same layout pass as the room and tenant labels. Before it was drawn at `midpoint.y - 9`
   * plainly, and with six ACL edges crossing through the center of the drawing the result was three stacked texts over
   * `argos` and over a tenant name.
   */
  labelAnchor: Point;
  /** Angle (degrees) of the arrow at `midpoint`. */
  angle: number;
}

interface TenantBlob {
  id: string;
  label: string | null;
  centroid: Point;
  /** Same as in `HyperEdge`: on the top edge, already separated from nodes and labels. */
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
  /** Rooms with no reported members: listed separately because they cannot be drawn as an area. */
  emptyEdges: string[];
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** How much the envelope is inflated around its nodes. */
  padding?: number;
  /** Desired minimum distance between two nodes during relaxation. */
  nodeSpacing?: number;
  iterations?: number;
  /** Actual box occupied by each node. The final separation is guaranteed against this, not against a radius. */
  footprint?: NodeFootprint;
  /** Height reserved at the very top so that room labels fit. */
  labelBand?: number;
}

/**
 * Builds the full hypergraph from the control plane snapshot.
 *
 * Deterministic: the same input produces the same output, always.
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
  const positions = relax(nodeList, anchors, settings);

  // Relaxation leaves a *tendency* to not overlap; this guarantees it. It runs before computing the envelopes so regions are drawn on the final positions and still contain their members.
  const box = settings.footprint;
  separate(
    nodeList.map((node) => node.key),
    positions,
    box,
    {
      minX: settings.padding + box.halfWidth,
      maxX: settings.width - settings.padding - box.halfWidth,
      minY: settings.padding + settings.labelBand - box.top,
      maxY: settings.height - settings.padding - box.bottom,
    },
  );

  for (const [key, point] of positions) positions.set(key, { x: round(point.x), y: round(point.y) });

  const tenantOrder: string[] = [];
  for (const edge of rawEdges) if (!tenantOrder.includes(edge.tenantId)) tenantOrder.push(edge.tenantId);

  const nodes: HyperNode[] = nodeList.map((node) => {
    const position = positions.get(node.key) ?? { x: settings.width / 2, y: settings.height / 2 };
    return {
      key: node.key,
      alias: node.alias,
      label: node.label,
      enabled: node.enabled,
      tenants: [node.tenantId],
      edges: node.edges,
      x: position.x,
      y: position.y,
    };
  });

  const emptyEdges: string[] = [];
  const edges: HyperEdge[] = rawEdges.map((edge) => {
    // A member is resolved within its OWN tenant: the same alias in another tenant is another node, in
    // another region, and looking it up by alias alone dragged that stranger into this envelope.
    const memberPoints = edge.members
      .map((alias) => positions.get(nodeKey(edge.tenantId, alias)))
      .filter((point): point is Point => Boolean(point));

    if (memberPoints.length === 0) emptyEdges.push(edge.key);

    // A room with no drawable members is anchored in its orbit: you can see it exists and is empty, instead of disappearing from the drawing as if it were not configured.
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
      // Provisional anchor: above the top edge of the region, horizontally centered but without going outside it.
      // `placeLabels` corrects it afterwards if it still overlaps something.
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
    const source = tenantNodes.find((tenant, tenantIndex) => (tenant.id ?? `tenant#${String(tenantIndex)}`) === tenantId);
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
      // An ACL edge towards a tenant that the topology does not describe is not drawn: there is nowhere to put it without inventing a node. It still appears in the edges table below.
      if (!a || !b) return null;
      if (from === to) return null;

      const pairKey = [from, to].sort().map(encodeURIComponent).join(SEP);
      const seen = seenPairs.get(pairKey) ?? 0;
      seenPairs.set(pairKey, seen + 1);
      // The curve's normal is already inverted by travel direction, so the outbound and the return fall on opposite
      // sides on their own: there is **no** need to invert again by lexicographic order (doing so cancels the effect and
      // leaves them almost on top of each other). `seen` is all that's needed, and it also serves to separate two
      // repeated edges of the same pair and same direction.
      const bend = 46 + seen * 26;

      const geometry = arcBetween(a, b, bend);
      return {
        key: `${encodeURIComponent(from)}${SEP}${encodeURIComponent(to)}${SEP}${String(index)}`,
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

  // Relocation of ALL labels in a single pass, with the ACL arcs already built.
  //
  // Rooms, tenants and ACL capabilities compete for the same free space: resolving each family on its own leaves
  // one on top of another, which is exactly what was happening (`#marcas.pablo` over `PABLO` over `DENEGADO`). They
  // are placed top to bottom and each already-placed label becomes an obstacle for the next ones, just like the nodes.
  const nodePoints = nodes.map((node) => ({ x: node.x, y: node.y }));
  const anchored = placeLabels(
    [
// `charWidth`/`lineHeight` are estimates of text width, not measurements: the layout runs before any DOM exists to
      // measure in. They are chosen generously on purpose —overestimating separates too much (ugly but legible),
      // underestimating leaves a line on top of a figure, which is the defect this came to fix.
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
