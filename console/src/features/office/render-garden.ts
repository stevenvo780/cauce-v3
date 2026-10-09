import { TILE, type Furniture, type Point, type Zone } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { seededRandom } from './random';

type GardenPiece = Extract<Furniture, { kind: 'stove' | 'shelf' | 'crates' | 'stool' | 'grill' | 'pond' | 'bench' | 'tree' | 'flowers' | 'lights' }>;
export interface PieceDrawable { sortY: number; draw: (ctx: Ctx, time: number) => void }

export function paintGround(ctx: Ctx, zone: Zone): void {
  for (let ty = 0; ty < zone.h; ty += 1) {
    for (let tx = 0; tx < zone.w; tx += 1) {
      const x = (zone.x + tx) * TILE;
      const y = (zone.y + ty) * TILE;
      if (zone.kind === 'path') {
        rect(ctx, x, y, TILE, TILE, OFFICE.pathLine);
        for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [8, 8]] as const) {
          rect(ctx, x + dx, y + dy, 7, 7, (tx + ty + dx + dy) % 3 === 0 ? OFFICE.pathAlt : OFFICE.path);
        }
        continue;
      }
      rect(ctx, x, y, TILE, TILE, (tx + ty) % 2 === 0 ? OFFICE.grass : OFFICE.grassAlt);
      const random = seededRandom((zone.x + tx) * 73 + (zone.y + ty) * 151);
      for (let i = 0; i < 3; i += 1) rect(ctx, x + Math.floor(random() * 14), y + Math.floor(random() * 13), 1, 2, OFFICE.grassBlade);
    }
  }
}

function tree(ctx: Ctx, x: number, y: number, variant: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  rect(ctx, cx - 9, base - 1, 18, 3, OFFICE.shadow);
  rect(ctx, cx - 3, base - 12, 6, 12, OFFICE.outline);
  rect(ctx, cx - 2, base - 12, 4, 12, OFFICE.bark);
  rect(ctx, cx + 1, base - 12, 1, 12, OFFICE.barkDark);
  const leaf = OFFICE.canopy[variant % OFFICE.canopy.length];
  const blobs = [[-10, -27, 20, 12], [-7, -33, 14, 8], [-12, -22, 24, 9]] as const;
  for (const [dx, dy, w, h] of blobs) rect(ctx, cx + dx - 1, base + dy - 1, w + 2, h + 2, OFFICE.outline);
  for (const [dx, dy, w, h] of blobs) rect(ctx, cx + dx, base + dy, w, h, leaf);
  rect(ctx, cx - 6, base - 30, 5, 3, OFFICE.leafLight);
  rect(ctx, cx + 2, base - 24, 6, 3, OFFICE.leafDark);
  rect(ctx, cx - 8, base - 20, 5, 2, OFFICE.leafDark);
}

function flowers(ctx: Ctx, x: number, y: number, w: number, variant: number): void {
  const left = x * TILE + 1;
  const top = y * TILE + 4;
  const width = w * TILE - 2;
  rect(ctx, left, top, width, 11, OFFICE.outline);
  rect(ctx, left + 1, top + 1, width - 2, 9, OFFICE.coffee);
  const random = seededRandom(variant * 31 + x);
  for (let fx = left + 3; fx < left + width - 3; fx += 5) {
    const fy = top + 2 + Math.floor(random() * 3);
    const petal = OFFICE.petals[Math.floor(random() * OFFICE.petals.length)];
    rect(ctx, fx, fy + 3, 1, 3, OFFICE.leafDark);
    rect(ctx, fx - 1, fy, 3, 3, petal);
    rect(ctx, fx, fy + 1, 1, 1, OFFICE.mail);
  }
}

function pond(ctx: Ctx, x: number, y: number, time: number): void {
  const left = x * TILE + 1;
  const top = y * TILE + 2;
  const w = 3 * TILE - 2;
  const h = 2 * TILE - 4;
  rect(ctx, left + 2, top - 1, w - 4, h + 2, OFFICE.outline);
  rect(ctx, left, top + 2, w, h - 4, OFFICE.outline);
  rect(ctx, left + 2, top, w - 4, h, OFFICE.stone);
  rect(ctx, left + 1, top + 3, w - 2, h - 6, OFFICE.stone);
  rect(ctx, left + 4, top + 3, w - 8, h - 7, OFFICE.water);
  rect(ctx, left + 4, top + h - 5, w - 8, 2, OFFICE.waterDeep);
  for (let i = 0; i < 3; i += 1) {
    const shift = Math.floor(time * 6 + i * 9) % (w - 16);
    rect(ctx, left + 6 + shift, top + 6 + i * 6, 5, 1, OFFICE.waterLight);
  }
  rect(ctx, left + 8, top + h - 9, 5, 3, OFFICE.leaf);
  rect(ctx, left + 10, top + h - 9, 1, 1, OFFICE.petals[0]);
  const mid = left + Math.floor(w / 2);
  rect(ctx, mid - 3, top + 8, 7, 6, OFFICE.stoneDark);
  rect(ctx, mid - 2, top + 9, 5, 2, OFFICE.waterLight);
  for (let i = 0; i < 4; i += 1) {
    const phase = (time * 1.4 + i / 4) % 1;
    const side = i % 2 === 0 ? -1 : 1;
    rect(ctx, Math.round(mid + side * phase * 7), Math.round(top + 8 - Math.sin(phase * Math.PI) * 9), 1, 2, OFFICE.waterLight);
  }
}

function bench(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const top = y * TILE;
  const w = 2 * TILE - 2;
  rect(ctx, left + 1, top + 14, w - 2, 2, OFFICE.shadow);
  rect(ctx, left, top - 1, w, 8, OFFICE.outline);
  rect(ctx, left + 1, top, w - 2, 2, OFFICE.bench);
  rect(ctx, left + 1, top + 3, w - 2, 2, OFFICE.bench);
  rect(ctx, left, top + 8, w, 5, OFFICE.outline);
  rect(ctx, left + 1, top + 9, w - 2, 2, OFFICE.bench);
  rect(ctx, left + 1, top + 11, w - 2, 1, OFFICE.benchDark);
  for (const lx of [left + 2, left + w - 4]) rect(ctx, lx, top + 12, 2, 4, OFFICE.metal);
}

function grill(ctx: Ctx, x: number, y: number, active: boolean, time: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  rect(ctx, cx - 6, base - 1, 12, 2, OFFICE.shadow);
  rect(ctx, cx - 5, base - 8, 1, 8, OFFICE.metal);
  rect(ctx, cx + 4, base - 8, 1, 8, OFFICE.metal);
  rect(ctx, cx - 8, base - 15, 16, 8, OFFICE.outline);
  rect(ctx, cx - 7, base - 14, 14, 6, OFFICE.pan);
  rect(ctx, cx - 7, base - 15, 14, 1, OFFICE.metalLight);
  if (!active) return;
  rect(ctx, cx - 6, base - 15, 12, 1, OFFICE.ember);
  for (let i = 0; i < 3; i += 1) rect(ctx, cx - 5 + i * 4, base - 17, 3, 2, i === 1 ? OFFICE.food : OFFICE.coffee);
  for (let i = 0; i < 3; i += 1) {
    const phase = (time * 0.6 + i / 3) % 1;
    rect(ctx, Math.round(cx - 3 + i * 3 + Math.sin(phase * 6) * 2), Math.round(base - 20 - phase * 16), 3, 2, 'rgba(220, 220, 220, 0.7)');
  }
}

function lights(ctx: Ctx, x: number, y: number, w: number, time: number): void {
  const left = x * TILE + 2;
  const right = (x + w) * TILE - 3;
  const top = y * TILE - 14;
  rect(ctx, left, top, 1, 14, OFFICE.barkDark);
  rect(ctx, right, top, 1, 14, OFFICE.barkDark);
  for (let px = left; px <= right; px += 1) {
    const u = (px - left) / Math.max(1, right - left);
    const sag = Math.round(Math.sin(u * Math.PI * Math.max(1, Math.round(w / 5))) ** 2 * 5);
    rect(ctx, px, top + sag, 1, 1, OFFICE.outline);
    if ((px - left) % 8 === 4) {
      const lit = Math.floor(time * 1.5 + px / 8) % 4 !== 0;
      rect(ctx, px - 1, top + sag + 1, 3, 3, lit ? OFFICE.bulb[(px >> 3) % OFFICE.bulb.length] : OFFICE.stoneDark);
    }
  }
}

function stove(ctx: Ctx, x: number, y: number, active: boolean, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  rect(ctx, left, top - 5, TILE, 21, OFFICE.outline);
  rect(ctx, left + 1, top - 4, TILE - 2, 5, OFFICE.metal);
  rect(ctx, left + 1, top + 2, TILE - 2, 13, OFFICE.stove);
  rect(ctx, left + 3, top + 5, TILE - 6, 6, OFFICE.outline);
  rect(ctx, left + 4, top + 6, TILE - 8, 4, active ? OFFICE.ember : OFFICE.machineDark);
  rect(ctx, left + 3, top + 3, TILE - 6, 1, OFFICE.metalLight);
  rect(ctx, left + 3, top - 8, 9, 4, OFFICE.outline);
  rect(ctx, left + 4, top - 7, 7, 2, OFFICE.pan);
  rect(ctx, left + 12, top - 7, 4, 1, OFFICE.outline);
  if (!active) return;
  rect(ctx, left + 5, top - 8, 5, 1, Math.floor(time * 5) % 2 === 0 ? OFFICE.food : OFFICE.ledWarn);
  for (let i = 0; i < 3; i += 1) {
    const phase = (time * 0.7 + i / 3) % 1;
    rect(ctx, Math.round(left + 5 + i * 2 + Math.sin(phase * 7 + i) * 2), Math.round(top - 11 - phase * 14), 2, 2, OFFICE.steam);
  }
}

function shelf(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 12;
  rect(ctx, left - 1, top - 1, 16, 29, OFFICE.outline);
  rect(ctx, left, top, 14, 27, OFFICE.deskFront);
  for (const row of [top + 8, top + 17, top + 26]) rect(ctx, left, row, 14, 1, OFFICE.deskDark);
  rect(ctx, left + 2, top + 3, 5, 5, OFFICE.box);
  rect(ctx, left + 8, top + 4, 3, 4, OFFICE.ink[1]);
  rect(ctx, left + 2, top + 12, 3, 5, OFFICE.mug);
  rect(ctx, left + 6, top + 11, 6, 6, OFFICE.box);
  rect(ctx, left + 6, top + 13, 6, 1, OFFICE.boxDark);
  rect(ctx, left + 3, top + 21, 8, 5, OFFICE.box);
}

function crates(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const base = y * TILE + 15;
  rect(ctx, left, base - 1, 14, 2, OFFICE.shadow);
  for (const [dx, dy, s] of [[0, -9, 9], [6, -8, 8], [2, -17, 8]] as const) {
    rect(ctx, left + dx - 1, base + dy - 1, s + 2, s + 1, OFFICE.outline);
    rect(ctx, left + dx, base + dy, s, s - 1, OFFICE.box);
    rect(ctx, left + dx, base + dy + 2, s, 1, OFFICE.boxDark);
  }
}

function stool(ctx: Ctx, x: number, y: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  rect(ctx, cx - 4, base - 1, 8, 2, OFFICE.shadow);
  rect(ctx, cx - 1, base - 6, 2, 6, OFFICE.metal);
  rect(ctx, cx - 5, base - 9, 10, 4, OFFICE.outline);
  rect(ctx, cx - 4, base - 8, 8, 2, OFFICE.chairLight);
}

/** `busy` tells whether someone is cooking at the stove or grill, so the fire only burns while they do. */
export function gardenDrawable(piece: GardenPiece, busy: () => boolean): PieceDrawable {
  const base = piece.y * TILE;
  switch (piece.kind) {
    case 'stove': return { sortY: base + 14, draw: (ctx, time) => { stove(ctx, piece.x, piece.y, busy(), time); } };
    case 'grill': return { sortY: base + 15, draw: (ctx, time) => { grill(ctx, piece.x, piece.y, busy(), time); } };
    case 'shelf': return { sortY: base + 15, draw: (ctx) => { shelf(ctx, piece.x, piece.y); } };
    case 'crates': return { sortY: base + 15, draw: (ctx) => { crates(ctx, piece.x, piece.y); } };
    case 'stool': return { sortY: base + 6, draw: (ctx) => { stool(ctx, piece.x, piece.y); } };
    case 'pond': return { sortY: base + 1, draw: (ctx, time) => { pond(ctx, piece.x, piece.y, time); } };
    case 'bench': return { sortY: base + 2, draw: (ctx) => { bench(ctx, piece.x, piece.y); } };
    case 'tree': return { sortY: base + 15, draw: (ctx) => { tree(ctx, piece.x, piece.y, piece.variant); } };
    case 'flowers': return { sortY: base + 4, draw: (ctx) => { flowers(ctx, piece.x, piece.y, piece.w, piece.variant); } };
    case 'lights': return { sortY: base - 1, draw: (ctx, time) => { lights(ctx, piece.x, piece.y, piece.w, time); } };
  }
}

/** Where the garden cat is along its round: it walks for a while, then sits and looks around. */
export function petAt(round: readonly Point[], time: number): { x: number; y: number; left: boolean; sitting: boolean } {
  const cycle = time % 24;
  const sitting = cycle > 17;
  const walked = (Math.floor(time / 24) * 17 + Math.min(cycle, 17)) * 9;
  const legs = round.map((point, index) => {
    const next = round[(index + 1) % round.length];
    return { from: point, to: next, length: Math.hypot(next.x - point.x, next.y - point.y) };
  });
  const total = legs.reduce((sum, leg) => sum + leg.length, 0);
  let left = total > 0 ? walked % total : 0;
  for (const leg of legs) {
    if (left <= leg.length && leg.length > 0) {
      const u = left / leg.length;
      return { x: leg.from.x + (leg.to.x - leg.from.x) * u, y: leg.from.y + (leg.to.y - leg.from.y) * u, left: leg.to.x < leg.from.x, sitting };
    }
    left -= leg.length;
  }
  return { x: round[0]?.x ?? 0, y: round[0]?.y ?? 0, left: false, sitting };
}

export function drawPet(ctx: Ctx, pet: ReturnType<typeof petAt>, time: number): void {
  const x = Math.round(pet.x) - 5;
  const y = Math.round(pet.y) - 7;
  const flip = (dx: number, w: number) => (pet.left ? x + 10 - dx - w : x + dx);
  const step = pet.sitting ? 0 : Math.floor(time * 8) % 2;
  rect(ctx, x + 1, y + 7, 9, 2, OFFICE.shadow);
  rect(ctx, flip(1, 7), y + (pet.sitting ? 2 : 3), 7, pet.sitting ? 6 : 4, OFFICE.outline);
  rect(ctx, flip(2, 5), y + (pet.sitting ? 3 : 4), 5, pet.sitting ? 4 : 2, OFFICE.cat);
  rect(ctx, flip(6, 5), y, 5, 5, OFFICE.outline);
  rect(ctx, flip(7, 3), y + 1, 3, 3, OFFICE.cat);
  rect(ctx, flip(6, 1), y - 1, 1, 1, OFFICE.outline);
  rect(ctx, flip(10, 1), y - 1, 1, 1, OFFICE.outline);
  rect(ctx, flip(9, 1), y + 2, 1, 1, OFFICE.outline);
  if (!pet.sitting) for (const leg of [2, 6]) rect(ctx, flip(leg + (step && leg === 2 ? 1 : 0), 1), y + 7, 1, 1, OFFICE.catDark);
  const wag = Math.round(Math.sin(time * 3) * 1.5);
  rect(ctx, flip(0, 1), y + 1 + wag, 1, 3, OFFICE.catDark);
}
