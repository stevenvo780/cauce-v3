import type { CharKey } from './palette';

/** Character cell, in art pixels. */
export const CHAR_W = 16;
export const CHAR_H = 24;

type Rows = readonly string[];

const HEAD_FRONT: Rows = [
  '................',
  '.....oooooo.....',
  '....ohhhhhho....',
  '...ohhhhhhhho...',
  '...ohhhhhhhho...',
  '...ohhsssshho...',
  '...ohssssssho...',
  '...ohsessesho...',
  '...oscsSSscso...',
  '....osssssso....',
  '.....ooSSoo.....',
];

const HEAD_ASLEEP: Rows = HEAD_FRONT.map((row, index) => (index === 7 ? '...oheesseeho...' : row));

const HEAD_BACK: Rows = [
  '................',
  '.....oooooo.....',
  '....ohhhhhho....',
  '...ohhhhhhhho...',
  '...ohhhhhhhho...',
  '...ohhhhhhhho...',
  '...ohhhhhhhho...',
  '...ohHhhhhHho...',
  '...oHHhhhhHHo...',
  '....oHHHHHHo....',
  '.....ooSSoo.....',
];

const HEAD_SIDE: Rows = [
  '................',
  '.....oooooo.....',
  '....ohhhhhho....',
  '...ohhhhhhhho...',
  '...ohhhhhhhho...',
  '...ohhhhhhsso...',
  '...ohhhhsssso...',
  '...ohhhsssseo...',
  '...oHhhssssso...',
  '....oHhsssso....',
  '.....ooSSoo.....',
];

const BODY_FRONT: Rows = [
  '...oottSSttoo...',
  '..otttttttttto..',
  '..otTttttttTto..',
  '..otTttttttTto..',
  '..osTttttttTso..',
  '...oppppppppo...',
  '...oppppppppo...',
];

const BODY_BACK: Rows = [
  '...oottttttoo...',
  '..otttttttttto..',
  '..otTttttttTto..',
  '..otTttttttTto..',
  '..osTttttttTso..',
  '...oppppppppo...',
  '...oppppppppo...',
];

const BODY_ARMS_UP: Rows = [
  '...oottSSttoo...',
  '...otttttttto...',
  '...otTttttTto...',
  '...otTttttTto...',
  '...otTttttTto...',
  '...oppppppppo...',
  '...oppppppppo...',
];

const BODY_SIDE: Rows = [
  '....oottttoo....',
  '...otttttttto...',
  '...ottTTtttto...',
  '...ottTTtttto...',
  '...ottTTtttto...',
  '...ottsstttto...',
  '...oppppppppo...',
];

const LEGS_FRONT: Rows = [
  '...opppoopppo...',
  '...opppoopppo...',
  '...oPPPooPPPo...',
  '...obbboobbbo...',
  '...oooo..oooo...',
];

const LEGS_FRONT_STEP: Rows = [
  '...opppoopppo...',
  '...oPPPoopppo...',
  '...obbbooPPPo...',
  '...oooooobbbo...',
  '........ooooo...',
];

const LEGS_SIDE: Rows = [
  '....opppppo.....',
  '....oPpppPo.....',
  '.....oPPPo......',
  '.....obbbbo.....',
  '.....oooooo.....',
];

const LEGS_SIDE_STEP: Rows = [
  '....opppppo.....',
  '...oppo.oppo....',
  '..oPPo...oPPo...',
  '..obbo...obbbo..',
  '..oooo...ooooo..',
];

/** Raised forearms and fists that sit on top of a body for the stretch pose. */
const ARMS_UP_OVERLAY: Rows = [
  '................',
  '................',
  '................',
  '.os..........so.',
  '.os..........so.',
  '.ot..........to.',
  '.ot..........to.',
  '..ot........to..',
  '..ot........to..',
  '...ot......to...',
  '...ot......to...',
];

const BLANK = '................';

const NAP_ARMS: Rows = [
  '.oo..........oo.',
  'osso........osso',
  'otto........otto',
  'oTto........otTo',
  '.oTto......otTo.',
  '.oTto......otTo.',
  '..oTto....otTo..',
  '..oTTo....oTTo..',
  '..otTo....oTto..',
  '..ottooooootto..',
];

const mirror = (rows: Rows): Rows => rows.map((row) => Array.from(row).reverse().join(''));

export type Facing = 'down' | 'up' | 'left' | 'right';

export type FrameName =
  | 'stand' | 'walk' | 'sit' | 'sleep' | 'stretch' | 'napUp' | 'napDown';

const shiftDown = (rows: Rows, by: number): Rows => [...Array.from({ length: by }, () => BLANK), ...rows.slice(0, rows.length - by)];
const shiftRight = (rows: Rows, by: number): Rows => rows.map((row) => '.'.repeat(by) + row.slice(0, row.length - by));

function overlay(base: Rows, top: Rows): Rows {
  return base.map((row, y) => {
    const over = top[y];
    if (!over) return row;
    return Array.from(row).map((char, x) => (over[x] && over[x] !== '.' ? over[x] : char)).join('');
  });
}

/**
 * One character frame as 24 rows of 16 palette keys. `step` alternates the walk cycle:
 * 0 and 2 are the contact pose, 1 lifts one foot, 3 the other.
 */
export function characterFrame(name: FrameName, facing: Facing, step = 0): Rows {
  if (name === 'napUp') {
    return [BLANK, ...overlay(NAP_ARMS, HEAD_BACK.slice(1)), BODY_BACK[1], BODY_BACK[1], ...BODY_BACK.slice(1), ...LEGS_FRONT];
  }
  if (name === 'napDown') {
    return shiftDown([BLANK, ...HEAD_BACK.map(() => BLANK), ...BODY_BACK, ...LEGS_FRONT], 3);
  }
  const side = facing === 'left' || facing === 'right';
  const lifted = step % 2 === 1;
  let rows: Rows;
  if (side) {
    rows = [...HEAD_SIDE, ...BODY_SIDE, ...(name === 'walk' && lifted ? LEGS_SIDE_STEP : LEGS_SIDE)];
  } else if (name === 'sleep') {
    rows = overlay([...HEAD_FRONT.map(() => BLANK), ...BODY_FRONT, ...LEGS_FRONT.map(() => BLANK)], [...shiftRight(shiftDown(HEAD_ASLEEP, 1), 1)]);
  } else {
    const head = facing === 'up' ? HEAD_BACK : HEAD_FRONT;
    const body = name === 'stretch' ? BODY_ARMS_UP : facing === 'up' ? BODY_BACK : BODY_FRONT;
    let legs = LEGS_FRONT;
    if (name === 'walk' && lifted) legs = step % 4 === 1 ? LEGS_FRONT_STEP : mirror(LEGS_FRONT_STEP);
    rows = [...head, ...body, ...legs];
    if (name === 'stretch') rows = overlay(rows, ARMS_UP_OVERLAY);
  }
  rows = [BLANK, ...rows];
  return facing === 'left' ? mirror(rows) : rows;
}

export const LIE_W = 30;
export const LIE_H = 15;

export function lyingFrame(): Rows {
  return HEAD_ASLEEP.slice(1).map((row) => `${row.slice(2, 14)}${'.'.repeat(LIE_W - 12)}`);
}

/** Small icons drawn inside speech bubbles. Keys: k ink, w white, y mail, r alert, g paper line. */
export const ICONS = {
  mail: [
    'kkkkkkk',
    'kykkkyk',
    'kyykyyk',
    'kyyyyyk',
    'kkkkkkk',
  ],
  alert: [
    '...rr..',
    '...rr..',
    '...rr..',
    '.......',
    '...rr..',
  ],
  paper: [
    '.kkkkk.',
    '.kwwwk.',
    '.kgggk.',
    '.kwwwk.',
    '.kkkkk.',
  ],
  coffee: [
    '.kkkk..',
    '.kwwkk.',
    '.kwwk.k',
    '.kwwkk.',
    '..kk...',
  ],
  heart: [
    '.rr.rr.',
    'rrrrrrr',
    '.rrrrr.',
    '..rrr..',
    '...r...',
  ],
  idea: [
    '..yyy..',
    '.yyyyy.',
    '.yyyyy.',
    '..kkk..',
    '..kkk..',
  ],
  note: [
    '..kkkk.',
    '..k..k.',
    '..k..k.',
    'kkk.kkk',
    'kkk.kkk',
  ],
  wave: [
    'k.k.k..',
    'kykykk.',
    'kyyyyk.',
    '.kyyyk.',
    '..kkk..',
  ],
  star: [
    '...y...',
    '.yyyyy.',
    '..yyy..',
    '.yy.yy.',
    '.y...y.',
  ],
  wrench: [
    'kk...kk',
    '.kk.kk.',
    '..kkk..',
    '...g...',
    '...g...',
  ],
  question: [
    '.ggg...',
    'g...g..',
    '...g...',
    '.......',
    '...g...',
  ],
  sleep: [
    'gggg...',
    '..g....',
    '.g..ggg',
    'gggg.g.',
    '....ggg',
  ],
} as const satisfies Record<string, Rows>;

export type IconName = keyof typeof ICONS;

/** Sleep trail letters, then the blanket pulled up to the chin: o outline, w sheet fold, b blanket, l light, d dark. */
export const GLYPH_Z_SMALL: Rows = ['kkkk', '..k.', '.k..', 'kkkk'];
export const GLYPH_Z: Rows = ['kkkkk', '...k.', '..k..', '.k...', 'kkkkk'];

export const BLANKET_X = 10;
export const BLANKET_Y = 2;
const HUMP = 10;

/** A blanket `width` px wide whose chest end rises one row; inhaling lifts the chest one more. */
export function blanketRows(width: number, bodyRows: number, inhale: boolean): Rows {
  const tail = width - HUMP;
  const rows: Rows = [
    `${'o'.repeat(HUMP)}${'.'.repeat(tail)}`,
    `oww${'l'.repeat(HUMP - 3)}${'o'.repeat(tail)}`,
    `oww${'b'.repeat(HUMP - 2)}${'l'.repeat(tail - 2)}o`,
    ...Array.from({ length: bodyRows }, () => `oww${'b'.repeat(width - 4)}o`),
    `oww${'d'.repeat(width - 4)}o`,
    'o'.repeat(width),
  ];
  return inhale ? [rows[0], `oww${'l'.repeat(HUMP - 3)}oo${'.'.repeat(tail - 2)}`, ...rows.slice(1)] : rows;
}

export const BLANKET: Rows = blanketRows(17, 6, false);
export const BLANKET_INHALE: Rows = blanketRows(17, 6, true);

export const BUBBLE: Rows = [
  '.ooooooooo.',
  'owwwwwwwwwo',
  'owwwwwwwwwo',
  'owwwwwwwwwo',
  'owwwwwwwwwo',
  'owwwwwwwwwo',
  'owwwwwwwwwo',
  '.oooowoooo.',
  '....owo....',
  '.....o.....',
];

export const CHAR_KEYS: readonly CharKey[] = ['o', 's', 'S', 'c', 'h', 'H', 't', 'T', 'p', 'P', 'b', 'e'];
