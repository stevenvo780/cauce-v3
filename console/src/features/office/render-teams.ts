import { TILE, type Zone } from './level';
import { rect, type Ctx } from './paint';
import { teamTone } from './teams';

/** The team's rug: its hue in two checker shades with a darker border, so the group reads from afar. */
export function paintTeamRug(ctx: Ctx, zone: Zone): void {
  const hue = zone.hue ?? -1;
  const x0 = zone.x * TILE;
  const y0 = zone.y * TILE;
  for (let ty = 0; ty < zone.h; ty += 1) {
    for (let tx = 0; tx < zone.w; tx += 1) {
      rect(ctx, x0 + tx * TILE, y0 + ty * TILE, TILE, TILE, teamTone(hue, 46, (tx + ty) % 2 === 0 ? 68 : 64));
    }
  }
  const w = zone.w * TILE;
  const h = zone.h * TILE;
  const edge = teamTone(hue, 48, 40);
  rect(ctx, x0, y0, w, 2, edge);
  rect(ctx, x0, y0 + h - 2, w, 2, edge);
  rect(ctx, x0, y0, 2, h, edge);
  rect(ctx, x0 + w - 2, y0, 2, h, edge);
}
