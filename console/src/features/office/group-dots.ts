import type { ScreenRect } from './people';
import { MAX_DOTS, teamHue, teamTone } from './teams';

export interface GroupDots { hues: readonly number[]; more: number }

/** The secondary groups of an agent as coloured dots: at most three, then «+N». */
export function dotsOf(groups: readonly string[], hues: ReadonlyMap<string, number> = new Map()): GroupDots | null {
  if (groups.length === 0) return null;
  return { hues: groups.slice(0, MAX_DOTS).map((id) => hues.get(id) ?? teamHue(id)), more: Math.max(0, groups.length - MAX_DOTS) };
}

/** Draws the dots in a small pill hugging the right end of a name tag, in device px. */
export function drawGroupDots(ctx: CanvasRenderingContext2D, box: ScreenRect, dots: GroupDots, fontPx: number, dim: boolean): void {
  const height = box.bottom - box.top;
  const size = Math.max(4, Math.round(fontPx * 0.55));
  const gap = Math.max(2, Math.round(size / 3));
  const pad = Math.round(size * 0.6);
  ctx.font = `600 ${String(Math.round(fontPx * 0.8))}px "Inter Variable", Inter, system-ui, sans-serif`;
  const extra = dots.more > 0 ? Math.ceil(ctx.measureText(`+${String(dots.more)}`).width) + gap : 0;
  const width = pad * 2 + dots.hues.length * size + (dots.hues.length - 1) * gap + extra;
  const left = box.right + gap;
  ctx.globalAlpha = dim ? 0.4 : 1;
  ctx.fillStyle = 'rgba(37, 28, 24, 0.78)';
  ctx.beginPath();
  ctx.roundRect(left, box.top, width, height, height / 2);
  ctx.fill();
  const middle = box.top + height / 2;
  dots.hues.forEach((hue, index) => {
    const x = left + pad + index * (size + gap) + size / 2;
    ctx.beginPath();
    ctx.arc(x, middle, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = teamTone(hue, 70, 62);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
  });
  if (dots.more > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`+${String(dots.more)}`, left + width - pad - extra + gap, middle + 0.5);
  }
  ctx.globalAlpha = 1;
}

export function dotsByAgent(agents: readonly { id: string; groups?: readonly string[] }[], hues?: ReadonlyMap<string, number>): Map<string, GroupDots> {
  const dots = new Map<string, GroupDots>();
  for (const agent of agents) {
    const entry = dotsOf(agent.groups ?? [], hues);
    if (entry) dots.set(agent.id, entry);
  }
  return dots;
}
