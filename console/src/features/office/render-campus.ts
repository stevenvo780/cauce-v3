import type { Campus } from './campus';
import { TILE, type Furniture, type Point, type Zone } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { paintText, textWidth } from './pixel-font';
import { gardenDrawable } from './render-garden';
import { paintFloor } from './render-walls';
import { seededRandom } from './random';

function eachTile(zone: Zone, paint: (x: number, y: number, tx: number, ty: number) => void): void {
  for (let ty = zone.y; ty < zone.y + zone.h; ty += 1) for (let tx = zone.x; tx < zone.x + zone.w; tx += 1) paint(tx * TILE, ty * TILE, tx, ty);
}

/** Cobbles laid on absolute tile positions, so crossing streets meet without a seam. */
function street(ctx: Ctx, zone: Zone): void {
  eachTile(zone, (x, y, tx, ty) => {
    rect(ctx, x, y, TILE, TILE, OFFICE.streetLine);
    for (let row = 0; row < 2; row += 1) {
      const shift = (ty * 2 + row) % 2 === 0 ? 0 : 4;
      for (let dx = -shift; dx < TILE; dx += 8) {
        const left = Math.max(0, dx);
        const width = Math.min(TILE, dx + 7) - left;
        if (width > 0) rect(ctx, x + left, y + row * 8, width, 7, (tx + ty + dx + row) % 3 === 0 ? OFFICE.streetAlt : OFFICE.street);
      }
    }
  });
}

function plaza(ctx: Ctx, zone: Zone): void {
  eachTile(zone, (x, y, tx, ty) => {
    rect(ctx, x, y, TILE, TILE, OFFICE.plazaLine);
    rect(ctx, x + 1, y + 1, TILE - 1, TILE - 1, (tx + ty) % 2 === 0 ? OFFICE.plaza : OFFICE.plazaAlt);
  });
  const cx = (zone.x + zone.w / 2) * TILE;
  const cy = (zone.y + zone.h / 2 + 0.5) * TILE;
  for (let r = 3; r >= 1; r -= 1) {
    rect(ctx, cx - r * 14, cy - r * 7, r * 28, r * 14, r % 2 === 0 ? OFFICE.plazaAlt : OFFICE.plaza);
    rect(ctx, cx - r * 14, cy - r * 7, r * 28, 1, OFFICE.plazaLine);
  }
}

function sidewalk(ctx: Ctx, zone: Zone): void {
  eachTile(zone, (x, y) => {
    rect(ctx, x, y, TILE, TILE, OFFICE.sidewalk);
    rect(ctx, x, y, 1, TILE, OFFICE.concreteLine);
    rect(ctx, x + 8, y, 1, TILE, OFFICE.concreteLine);
    rect(ctx, x, y + TILE - 2, TILE, 2, OFFICE.curb);
  });
}

function road(ctx: Ctx, zone: Zone): void {
  const x0 = zone.x * TILE;
  const y0 = zone.y * TILE;
  const w = zone.w * TILE;
  const h = zone.h * TILE;
  rect(ctx, x0, y0, w, h, OFFICE.road);
  rect(ctx, x0, y0, w, 2, OFFICE.roadEdge);
  rect(ctx, x0, y0 + h - 2, w, 2, OFFICE.roadEdge);
  for (let x = x0 + 4; x < x0 + w; x += 16) rect(ctx, x, y0 + Math.floor(h / 2) - 1, 8, 2, OFFICE.roadLine);
  const random = seededRandom(zone.y * 31);
  for (let i = 0; i < w / 6; i += 1) rect(ctx, x0 + Math.floor(random() * w), y0 + 3 + Math.floor(random() * (h - 6)), 1, 1, OFFICE.roadEdge);
}

function fence(ctx: Ctx, campus: Campus): void {
  const y = campus.fenceY * TILE;
  const gate = campus.gateX * TILE;
  for (let x = TILE; x < (campus.cols - 1) * TILE; x += 1) {
    if (x >= gate - 3 && x < gate + 2 * TILE + 3) continue;
    if (x % 8 === 0) {
      rect(ctx, x, y + 2, 2, 12, OFFICE.outline);
      rect(ctx, x, y + 2, 1, 11, OFFICE.fence);
    }
  }
  for (const [from, to] of [[TILE, gate - 3], [gate + 2 * TILE + 3, (campus.cols - 1) * TILE]] as const) {
    rect(ctx, from, y + 5, to - from, 2, OFFICE.fenceDark);
    rect(ctx, from, y + 10, to - from, 2, OFFICE.fenceDark);
  }
  for (const px of [gate - 6, gate + 2 * TILE]) {
    rect(ctx, px, y - 6, 6, 21, OFFICE.outline);
    rect(ctx, px + 1, y - 5, 4, 19, OFFICE.stone);
    rect(ctx, px + 1, y - 5, 4, 2, OFFICE.paper);
  }
}

function shelterBase(ctx: Ctx, campus: Campus): void {
  const x = (campus.stop.tile.x + 1) * TILE;
  const y = campus.stop.tile.y * TILE;
  rect(ctx, x, y - 10, 2 * TILE, 12, OFFICE.outline);
  rect(ctx, x + 1, y - 9, 2 * TILE - 2, 10, OFFICE.glass);
  rect(ctx, x + 3, y + 4, 2 * TILE - 6, 4, OFFICE.bench);
  rect(ctx, x + 3, y + 8, 2, 4, OFFICE.metal);
  rect(ctx, x + 2 * TILE - 5, y + 8, 2, 4, OFFICE.metal);
  const post = campus.stop.tile.x * TILE + 3;
  rect(ctx, post, y - 14, 2, 26, OFFICE.metal);
  rect(ctx, post - 4, y - 21, 10, 9, OFFICE.outline);
  rect(ctx, post - 3, y - 20, 8, 7, OFFICE.ledInfo);
  paintText(ctx, 'B', post - 1, y - 19, 1, OFFICE.paper);
}

/** The tube hub on the plaza: a brass tower with a glass dome where every line meets. */
function hub(ctx: Ctx, campus: Campus): void {
  const cx = campus.hub.x;
  const base = campus.hub.y + TILE - 2;
  rect(ctx, cx - 15, base - 2, 30, 4, OFFICE.shadow);
  rect(ctx, cx - 14, base - 22, 28, 22, OFFICE.outline);
  rect(ctx, cx - 13, base - 21, 26, 20, OFFICE.brass);
  rect(ctx, cx - 13, base - 21, 26, 3, OFFICE.brassLight);
  rect(ctx, cx - 13, base - 5, 26, 4, OFFICE.brassDark);
  for (const dx of [-9, 0, 9]) rect(ctx, cx + dx - 2, base - 16, 4, 9, OFFICE.brassDark);
  rect(ctx, cx - 11, base - 36, 22, 15, OFFICE.outline);
  rect(ctx, cx - 10, base - 35, 20, 14, OFFICE.glass);
  rect(ctx, cx - 7, base - 39, 14, 4, OFFICE.outline);
  rect(ctx, cx - 6, base - 38, 12, 3, OFFICE.glass);
  rect(ctx, cx - 1, base - 44, 2, 6, OFFICE.outline);
  rect(ctx, cx - 8, base - 33, 3, 9, OFFICE.glassLine);
  const label = 'TUBOS';
  rect(ctx, cx - textWidth(label, 1) / 2 - 3, base - 14, textWidth(label, 1) + 6, 8, OFFICE.outline);
  paintText(ctx, label, cx - textWidth(label, 1) / 2, base - 13, 1, OFFICE.mail);
}

function vacantSign(ctx: Ctx, at: Point): void {
  const x = at.x * TILE;
  const y = at.y * TILE;
  rect(ctx, x + 7, y, 2, 14, OFFICE.bark);
  rect(ctx, x - 6, y - 9, 28, 11, OFFICE.outline);
  rect(ctx, x - 5, y - 8, 26, 9, OFFICE.paper);
  paintText(ctx, 'LIBRE', x - 3, y - 6, 1, OFFICE.ink[0]);
  const random = seededRandom(at.x * 17 + at.y);
  for (let i = 0; i < 12; i += 1) rect(ctx, x - 20 + Math.floor(random() * 56), y - 12 + Math.floor(random() * 40), 1, 3, OFFICE.grassBlade);
}

export function streetLamp(ctx: Ctx, x: number, y: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  rect(ctx, cx - 3, base - 2, 6, 3, OFFICE.shadow);
  rect(ctx, cx - 1, base - 30, 2, 29, OFFICE.metal);
  rect(ctx, cx - 4, base - 36, 8, 7, OFFICE.outline);
  rect(ctx, cx - 3, base - 35, 6, 5, OFFICE.lampShade);
  rect(ctx, cx - 5, base - 37, 10, 2, OFFICE.metal);
}

function staticPiece(ctx: Ctx, piece: Furniture): void {
  if (piece.kind === 'lamp') {
    streetLamp(ctx, piece.x, piece.y);
    return;
  }
  if (piece.kind === 'tree' || piece.kind === 'bench' || piece.kind === 'flowers') gardenDrawable(piece, () => false).draw(ctx, 0);
}

/** Everything on the campus that never moves: lawns, streets, plaza, fence, trees and the hub. */
export function paintCampusGround(ctx: Ctx, campus: Campus): void {
  rect(ctx, 0, 0, campus.cols * TILE, campus.rows * TILE, OFFICE.grass);
  paintFloor(ctx, campus.zones.filter((zone) => zone.kind === 'grass' || zone.kind === 'hedge'));
  for (const zone of campus.zones) {
    if (zone.kind === 'street') street(ctx, zone);
    else if (zone.kind === 'plaza') plaza(ctx, zone);
    else if (zone.kind === 'sidewalk') sidewalk(ctx, zone);
    else if (zone.kind === 'road') road(ctx, zone);
  }
  paintFloor(ctx, campus.zones.filter((zone) => zone.kind === 'path'));
  fence(ctx, campus);
  shelterBase(ctx, campus);
  for (const at of campus.vacant) vacantSign(ctx, at);
  const pieces = [...campus.furniture].sort((a, b) => a.y - b.y);
  for (const piece of pieces) staticPiece(ctx, piece);
  hub(ctx, campus);
}

function pipe(ctx: Ctx, a: Point, b: Point): void {
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  const horizontal = Math.abs(a.y - b.y) < 0.5;
  const length = Math.round(horizontal ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y));
  if (length <= 0) return;
  if (horizontal) {
    for (let px = Math.ceil(x / 32) * 32; px < x + length; px += 32) {
      rect(ctx, px, y + 2, 2, 7, OFFICE.metal);
      rect(ctx, px - 1, y + 9, 4, 1, OFFICE.shadow);
    }
    rect(ctx, x - 2, y - 2, length + 4, 5, OFFICE.tubeEdge);
    rect(ctx, x - 1, y - 1, length + 2, 3, OFFICE.tube);
    rect(ctx, x - 1, y - 1, length + 2, 1, OFFICE.tubeShine);
    for (let px = Math.ceil(x / 20) * 20; px < x + length; px += 20) rect(ctx, px, y - 3, 2, 7, OFFICE.brassDark);
  } else {
    rect(ctx, x - 2, y - 2, 5, length + 4, OFFICE.tubeEdge);
    rect(ctx, x - 1, y - 1, 3, length + 2, OFFICE.tube);
    rect(ctx, x - 1, y - 1, 1, length + 2, OFFICE.tubeShine);
    for (let py = Math.ceil(y / 20) * 20; py < y + length; py += 20) rect(ctx, x - 3, py, 7, 2, OFFICE.brassDark);
  }
}

/** What sits above the walkers: the tube network on its posts, the gate arch and the bus shelter roof. */
export function paintCampusOver(ctx: Ctx, campus: Campus): void {
  for (const route of campus.tubes.values()) {
    for (let index = 1; index < route.length; index += 1) pipe(ctx, route[index - 1], route[index]);
    const outlet = route[0];
    rect(ctx, Math.round(outlet.x) - 4, Math.round(outlet.y) - 4, 8, 8, OFFICE.outline);
    rect(ctx, Math.round(outlet.x) - 3, Math.round(outlet.y) - 3, 6, 6, OFFICE.brass);
  }
  const gate = campus.gateX * TILE;
  const y = campus.fenceY * TILE;
  rect(ctx, gate - 6, y - 16, 2 * TILE + 12, 11, OFFICE.outline);
  rect(ctx, gate - 5, y - 15, 2 * TILE + 10, 9, OFFICE.fence);
  const label = campus.label.toUpperCase();
  paintText(ctx, label, gate + TILE - Math.round(textWidth(label, 1) / 2), y - 13, 1, OFFICE.outline);
  const x = (campus.stop.tile.x + 1) * TILE;
  const sy = campus.stop.tile.y * TILE;
  rect(ctx, x - 2, sy - 14, 2 * TILE + 4, 5, OFFICE.outline);
  rect(ctx, x - 1, sy - 13, 2 * TILE + 2, 3, OFFICE.ledInfo);
}

/** The campus bus at `phase`: -1 entering from the left, 0 at the stop, 1 gone to the right. */
export function drawBus(ctx: Ctx, campus: Campus, phase: number, time: number): void {
  const stopX = (campus.stop.tile.x + 1) * TILE + TILE;
  const width = campus.cols * TILE;
  const x = Math.round(phase <= 0 ? stopX + phase * (stopX + 60) : stopX + phase * (width - stopX + 60));
  const y = campus.roadY * TILE + 2;
  const left = x - 26;
  rect(ctx, left + 2, y + 21, 52, 3, OFFICE.shadow);
  rect(ctx, left, y, 52, 21, OFFICE.outline);
  rect(ctx, left + 1, y + 1, 50, 18, OFFICE.bus);
  rect(ctx, left + 1, y + 13, 50, 3, OFFICE.busDark);
  for (let wx = left + 4; wx < left + 44; wx += 9) rect(ctx, wx, y + 3, 7, 7, OFFICE.busWindow);
  rect(ctx, left + 44, y + 3, 6, 9, OFFICE.busWindow);
  rect(ctx, left + 22, y + 3, 6, 15, phase === 0 ? OFFICE.slate : OFFICE.busDark);
  const roll = Math.floor(time * 10) % 2;
  for (const wx of [left + 8, left + 38]) {
    rect(ctx, wx, y + 17, 8, 5, OFFICE.outline);
    rect(ctx, wx + 2 + roll, y + 18, 2, 2, OFFICE.metalLight);
  }
  rect(ctx, left + 49, y + 15, 2, 2, OFFICE.lampShade);
}

/** A capsule in the tubes: a brass pellet with a stripe of the sender's colour and a little trail. */
export function drawCapsule(ctx: Ctx, at: Point, trail: Point, stripe: string): void {
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  ctx.fillStyle = 'rgba(255, 220, 120, 0.35)';
  ctx.fillRect(x - 6, y - 6, 13, 13);
  ctx.fillStyle = 'rgba(255, 240, 180, 0.7)';
  ctx.fillRect(Math.round((x + trail.x) / 2) - 2, Math.round((y + trail.y) / 2) - 2, 4, 4);
  rect(ctx, x - 3, y - 3, 7, 7, OFFICE.outline);
  rect(ctx, x - 2, y - 2, 5, 5, OFFICE.brass);
  rect(ctx, x - 2, y, 5, 1, stripe);
  rect(ctx, x - 2, y - 2, 2, 1, OFFICE.brassLight);
}
