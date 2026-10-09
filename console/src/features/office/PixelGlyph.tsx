import type { LevelKind } from './level';
import { ICONS, type IconName } from './sprites';

type Glyph = readonly string[];

/** 10×10 maps; `a` takes the accent colour, `k` the outline, `w` white, `y` gold, `g` green, `r` red. */
const GLYPHS: Readonly<Record<LevelKind | 'tube', Glyph>> = {
  campus: [
    'kkkkkkkkkk',
    'kggwggggyk',
    'kggwgkkgyk',
    'kwwwwkkwwk',
    'kggwggggwk',
    'kakwgyygwk',
    'kakwgyygwk',
    'kwwwwwwwwk',
    'kgggwgggak',
    'kkkkkkkkkk',
  ],
  group: [
    '....kk....',
    '...kaak...',
    '..kaaaak..',
    '.kaaaaaak.',
    'kaaaaaaaak',
    '.kwwwwwwk.',
    '.kwykkywk.',
    '.kwykkywk.',
    '.kwwkkwwk.',
    '.kkkkkkkk.',
  ],
  cafe: [
    '..w..w....',
    '...w..w...',
    '..w..w....',
    'kkkkkkkk..',
    'kwwwwwwkkk',
    'kwaaaawk.k',
    'kwaaaawkkk',
    'kwwwwwwk..',
    '.kkkkkk...',
    'kkkkkkkkk.',
  ],
  park: [
    '...kkkk...',
    '..kggggk..',
    '.kggggggk.',
    'kggggggggk',
    'kgggaggggk',
    '.kggggggk.',
    '..kkkkkk..',
    '....kk....',
    '....kk....',
    '.gggkkggg.',
  ],
  shop: [
    '.kk....kk.',
    'kwwk..kwwk',
    'kwwkkkkwwk',
    '.kwwwwwwk.',
    '..kwaawk..',
    '..kwaawk..',
    '..kwwwwk..',
    '..kwwwwk..',
    '..kwwwwk..',
    '...kkkk...',
  ],
  dorm: [
    '.......yy.',
    '......y..y',
    '.......yy.',
    'k.........',
    'kwwkkkkkkk',
    'kwwaaaaaak',
    'kkkaaaaaak',
    'kkkkkkkkkk',
    'k........k',
    'k........k',
  ],
  lobby: [
    '....kk....',
    '....yy....',
    '..kyyyyk..',
    '.kyyyyyyk.',
    '.kyyyyyyk.',
    'kyyyyyyyyk',
    'kkkkkkkkkk',
    '.kwwwwwwk.',
    '.kkkkkkkk.',
    '..........',
  ],
  tube: [
    '...kkkk...',
    '..kwwwwk..',
    '..kwaawk..',
    '..kwaawk..',
    '..kwaawk..',
    '..kwaawk..',
    '..kwaawk..',
    '..kwwwwk..',
    '...kkkk...',
    '..........',
  ],
};

const COLORS: Readonly<Record<string, string>> = { k: '#0e0f17', w: '#f4f4f4', y: '#ffcd75', g: '#38b764', r: '#b13e53' };

/** A tiny pixel-art icon drawn as crisp SVG rectangles, merged per row run. */
export function PixelGlyph({ kind, accent = '#41a6f6', size = 20 }: { kind: LevelKind | 'tube'; accent?: string; size?: number }) {
  const rows = GLYPHS[kind];
  const rects: { x: number; y: number; w: number; fill: string }[] = [];
  rows.forEach((row, y) => {
    let start = 0;
    for (let x = 1; x <= row.length; x += 1) {
      if (x < row.length && row[x] === row[start]) continue;
      const key = row[start];
      const fill = key === 'a' ? accent : COLORS[key];
      if (key !== '.' && fill) rects.push({ x: start, y, w: x - start, fill });
      start = x;
    }
  });
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 10 10" shapeRendering="crispEdges" className="shrink-0">
      {rects.map((cell) => <rect key={`${String(cell.x)}-${String(cell.y)}`} x={cell.x} y={cell.y} width={cell.w} height={1} fill={cell.fill} />)}
    </svg>
  );
}

const BUBBLE_COLORS: Readonly<Record<string, string>> = { k: '#0e0f17', w: '#ffffff', y: '#f6d77a', r: '#e5484d', g: '#4a7fd6' };

/** The same icons the characters show in their speech bubbles, for the HUD buttons that trigger them. */
export function BubbleIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  const rows = ICONS[name];
  const rects: { x: number; y: number; w: number; fill: string }[] = [];
  rows.forEach((row, y) => {
    let start = 0;
    for (let x = 1; x <= row.length; x += 1) {
      if (x < row.length && row[x] === row[start]) continue;
      const fill = BUBBLE_COLORS[row[start]];
      if (fill) rects.push({ x: start, y, w: x - start, fill });
      start = x;
    }
  });
  return (
    <svg aria-hidden="true" width={size} height={Math.round((size * 7) / 9)} viewBox="-1 -1 9 7" shapeRendering="crispEdges" className="shrink-0">
      <rect x={-1} y={-1} width={9} height={7} fill="#ffffff" />
      {rects.map((cell) => <rect key={`${String(cell.x)}-${String(cell.y)}`} x={cell.x} y={cell.y} width={cell.w} height={1} fill={cell.fill} />)}
    </svg>
  );
}
