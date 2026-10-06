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

const HEAD_ASLEEP: Rows = HEAD_FRONT.map((row, index) => (index === 7 ? '...ohsSssSsho...' : row));

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

const mirror = (rows: Rows): Rows => rows.map((row) => [...row].reverse().join(''));

export type Facing = 'down' | 'up' | 'left' | 'right';

export type FrameName =
  | 'stand' | 'walk' | 'sit' | 'sleep' | 'stretch';

function overlay(base: Rows, top: Rows): Rows {
  return base.map((row, y) => {
    const over = top[y];
    if (!over) return row;
    return [...row].map((char, x) => (over[x] && over[x] !== '.' ? over[x] : char)).join('');
  });
}

/**
 * One character frame as 24 rows of 16 palette keys. `step` alternates the walk cycle:
 * 0 and 2 are the contact pose, 1 lifts one foot, 3 the other.
 */
export function characterFrame(name: FrameName, facing: Facing, step = 0): Rows {
  const side = facing === 'left' || facing === 'right';
  const lifted = step % 2 === 1;
  let rows: Rows;
  if (side) {
    rows = [...HEAD_SIDE, ...BODY_SIDE, ...(name === 'walk' && lifted ? LEGS_SIDE_STEP : LEGS_SIDE)];
  } else {
    const head = name === 'sleep' ? HEAD_ASLEEP : facing === 'up' ? HEAD_BACK : HEAD_FRONT;
    const body = name === 'stretch' ? BODY_ARMS_UP : facing === 'up' ? BODY_BACK : BODY_FRONT;
    let legs = LEGS_FRONT;
    if (name === 'walk' && lifted) legs = step % 4 === 1 ? LEGS_FRONT_STEP : mirror(LEGS_FRONT_STEP);
    rows = [...head, ...body, ...legs];
    if (name === 'stretch') rows = overlay(rows, ARMS_UP_OVERLAY);
  }
  rows = [BLANK, ...rows];
  return facing === 'left' ? mirror(rows) : rows;
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
} as const satisfies Record<string, Rows>;

export type IconName = keyof typeof ICONS;

/** Pixel `Z` for the sleep trail. */
export const GLYPH_Z: Rows = ['kkkk', '..k.', '.k..', 'kkkk'];

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
