import type { Vec } from './camera';
import type { Dir } from './level';

export const VECTORS: Readonly<Record<string, Vec>> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
};
export const DIR_OF: Readonly<Record<string, Dir>> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right',
};
export const PAD_VECTOR: Readonly<Record<Dir, Vec>> = { up: VECTORS.w, down: VECTORS.s, left: VECTORS.a, right: VECTORS.d };
