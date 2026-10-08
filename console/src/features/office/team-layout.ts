import { SEATS_PER_POD } from './team-seats';

export const POD_W = 4;
export const POD_H = 4;
const PAD = 1;
const TEAM_COLS = 2;

export interface Rect { x: number; y: number; w: number; h: number }
export interface TeamSpec { id: string; label: string; hue: number; pods: number }

/** A team's patch of the work room, in tiles: its rug, the sign above it and the desks it owns. */
export interface TeamZone extends TeamSpec {
  rug: Rect;
  sign: Rect;
  firstDesk: number;
  desks: number;
}

export interface WorkPlan {
  w: number;
  h: number;
  /** Top-left tile of every pod, relative to the work room's left edge and the first floor row. */
  pods: { x: number; y: number }[];
  /** Zones relative to the same origin; empty for the plain office. */
  teams: TeamZone[];
}

export interface WorkParams { pods: number; podCols: number; compact: boolean; teams?: readonly TeamSpec[] }

export const teamCols = (pods: number, podCols: number): number => Math.max(1, Math.min(pods, TEAM_COLS, podCols));

/** Unused pod cells inside the teams' rectangles: the cost the layout search tries to keep small. */
export function teamWaste(teams: readonly TeamSpec[], podCols: number): number {
  return teams.reduce((sum, team) => {
    const cols = teamCols(team.pods, podCols);
    return sum + Math.ceil(team.pods / cols) * cols - team.pods;
  }, 0);
}

function plainPlan(params: WorkParams): WorkPlan {
  const margin = params.compact ? 1 : 2;
  const gap = margin;
  const rows = Math.ceil(params.pods / params.podCols);
  const pods = Array.from({ length: params.pods }, (_, pod) => ({
    x: margin + (pod % params.podCols) * (POD_W + gap),
    y: margin + Math.floor(pod / params.podCols) * (POD_H + gap),
  }));
  return {
    w: margin * 2 + params.podCols * POD_W + (params.podCols - 1) * gap,
    h: margin * 2 + rows * POD_H + (rows - 1) * gap,
    pods,
    teams: [],
  };
}

/**
 * Teams are laid out as blocks, each a sign row over a rug that holds its pods. Blocks sit side by side
 * on a shelf until `podCols` pod columns are used, then the next shelf starts below.
 */
export function planWork(params: WorkParams): WorkPlan {
  if (!params.teams) return plainPlan(params);
  const margin = params.compact ? 1 : 2;
  const gap = margin;
  const spacing = 2 * PAD + (params.compact ? 0 : 1);
  const plan: WorkPlan = { w: 0, h: 0, pods: [], teams: [] };
  let shelfY = margin - 1;
  let x = margin;
  let used = 0;
  let shelfH = 0;
  let desk = 0;
  for (const team of params.teams) {
    const cols = teamCols(team.pods, params.podCols);
    const rows = Math.ceil(team.pods / cols);
    const w = cols * POD_W + (cols - 1) * gap;
    const h = rows * POD_H + (rows - 1) * gap;
    if (used > 0 && used + cols > params.podCols) {
      shelfY += shelfH + gap;
      x = margin;
      used = 0;
      shelfH = 0;
    }
    for (let pod = 0; pod < team.pods; pod += 1) {
      plan.pods.push({ x: x + (pod % cols) * (POD_W + gap), y: shelfY + 2 + Math.floor(pod / cols) * (POD_H + gap) });
    }
    const rug = { x: x - PAD, y: shelfY + 1, w: w + 2 * PAD, h: h + 2 };
    const left = Math.max(rug.x, 1);
    plan.teams.push({
      ...team, rug, sign: { x: left, y: shelfY, w: rug.x + rug.w - left, h: 1 },
      firstDesk: desk, desks: team.pods * SEATS_PER_POD,
    });
    desk += team.pods * SEATS_PER_POD;
    plan.w = Math.max(plan.w, x + w + margin);
    shelfH = Math.max(shelfH, h + 3);
    x += w + spacing;
    used += cols;
  }
  plan.h = shelfY + shelfH + margin;
  return plan;
}

/** The block of a team as a room-like area, so the camera helper for rooms can frame it. */
export function teamArea(team: TeamZone): Rect & { id: 'programadores' } {
  return { id: 'programadores', x: team.rug.x, y: team.sign.y, w: team.rug.w, h: team.rug.h + 1 };
}
