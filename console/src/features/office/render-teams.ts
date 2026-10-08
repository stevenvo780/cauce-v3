import { TILE, type Zone } from './layout';
import { rect, type Ctx } from './paint';
import { fitText, paintText, textWidth, TEXT_HEIGHT } from './pixel-font';
import { teamTone } from './teams';

const SIGN_INK = '#ffffff';
const MAX_SCALE = 2;

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

/** A flat sign on the floor above the rug, the group label set in the 3x5 pixel font. */
export function paintTeamSign(ctx: Ctx, zone: Zone): void {
  const hue = zone.hue ?? -1;
  const x0 = zone.x * TILE;
  const y0 = zone.y * TILE;
  const w = zone.w * TILE;
  rect(ctx, x0, y0 + 1, w, TILE - 2, teamTone(hue, 50, 22));
  rect(ctx, x0 + 1, y0 + 2, w - 2, TILE - 4, teamTone(hue, 52, 34));
  rect(ctx, x0 + 1, y0 + 2, w - 2, 1, teamTone(hue, 52, 46));
  const { text, scale } = fitText(zone.label ?? '', w - 8, MAX_SCALE);
  const left = x0 + Math.floor((w - textWidth(text, scale)) / 2);
  const top = y0 + Math.floor((TILE - TEXT_HEIGHT(scale)) / 2);
  paintText(ctx, text, left, top, scale, SIGN_INK);
}
