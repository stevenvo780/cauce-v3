import type { LevelKind } from './level';

/** A lot on the campus grid: `c` grows east, `r` grows north from the row with the gate. */
export interface Cell { c: number; r: number }

/** Tiles per lot, its street on the left and at the bottom included. */
export const LOT_W = 12;
export const LOT_H = 10;
export const STREET = 2;
/** Lot area inside the streets, in tiles. */
export const YARD_W = LOT_W - STREET;
export const YARD_H = LOT_H - STREET;

export type CoreKind = Exclude<LevelKind, 'campus' | 'group'> | 'plaza';

/** The shared buildings sit around the plaza, the plaza right over the gate. */
export const CORE: Readonly<Record<CoreKind, Cell>> = {
  cafe: { c: -1, r: 0 },
  plaza: { c: 0, r: 0 },
  lobby: { c: 1, r: 0 },
  dorm: { c: -1, r: 1 },
  park: { c: 0, r: 1 },
  shop: { c: 1, r: 1 },
};

const isCore = (cell: Cell) => cell.r <= 1 && Math.abs(cell.c) <= 1;
const ringOf = (cell: Cell) => Math.max(Math.abs(cell.c) - 1, cell.r - 1);

const ORDER: Cell[] = [];
let rings = 0;

function extend(): void {
  rings += 1;
  const ring: Cell[] = [];
  for (let r = 0; r <= rings + 1; r += 1) {
    for (let c = -(rings + 1); c <= rings + 1; c += 1) {
      const cell = { c, r };
      if (!isCore(cell) && ringOf(cell) === rings) ring.push(cell);
    }
  }
  const distance = (cell: Cell) => Math.hypot(cell.c, cell.r - 0.5);
  ring.sort((a, b) => distance(a) - distance(b) || a.r - b.r || a.c - b.c);
  ORDER.push(...ring);
}

/**
 * The lot of the `index`-th group building. Lots fill ring by ring around the core, nearest first,
 * and an index always maps to the same lot, so a new group never moves an existing building.
 */
export function lotCell(index: number): Cell {
  while (ORDER.length <= index) extend();
  return ORDER[index];
}

export const sameCell = (a: Cell, b: Cell) => a.c === b.c && a.r === b.r;
