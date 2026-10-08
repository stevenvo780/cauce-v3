import { CHAR_H } from './sprites';
import type { Facing } from './sprites';

export type Accessory = 'scarf' | 'headphones' | 'cap';

type Rows = readonly string[];
/** Rows keyed by their index in a 24-row character frame, which starts with a blank row. */
type Sparse = Readonly<Record<number, string>>;

const BLANK = '................';

/** Keys: a accent, A accent shade, D dark trim. The neck sits on frame row 12, the head spans rows 1 to 11. */
const FRONT: Readonly<Record<Accessory, Sparse>> = {
  cap: {
    2: '.....aaaaaa.....',
    3: '....aaaaaaaa....',
    4: '..AAAAAAAAAAAA..',
  },
  scarf: {
    12: '..aaaaaaaaaaaa..',
    13: '..AAaaaaaaaaAA..',
  },
  headphones: {
    2: '....aaaaaaaa....',
    3: '...a........a...',
    4: '..aa........aa..',
    5: '.DDa........aDD.',
    6: '.DDa........aDD.',
    7: 'DDDa........aDDD',
    8: 'DDDa........aDDD',
    9: '.DDa........aDD.',
  },
};

const SIDE: Readonly<Record<Accessory, Sparse>> = {
  cap: FRONT.cap,
  scarf: {
    12: '...aaaaaaaaaa...',
    13: '...AAaaaaaaAA...',
  },
  headphones: {
    2: '....aaaaaaaa....',
    3: '...a............',
    4: '...a............',
    5: '...aDDD.........',
    6: '...aDDDD........',
    7: '....DDDD........',
    8: '....DDD.........',
  },
};

const mirror = (rows: Rows): Rows => rows.map((row) => Array.from(row).reverse().join(''));

/** The accessory as a full 24-row map for a facing, mirrored for the left like the body it sits on. */
export function accessoryRows(accessory: Accessory, facing: Facing): Rows {
  const table = facing === 'left' || facing === 'right' ? SIDE[accessory] : FRONT[accessory];
  const rows = Array.from({ length: CHAR_H }, (_, index) => table[index] ?? BLANK);
  return facing === 'left' ? mirror(rows) : rows;
}
