import { orbHues } from '../../orb-hues';

/** The room is a warm, lit interior in both themes; only the card around it follows the theme. */
export const OFFICE = {
  outline: '#3b2a22',
  shadow: 'rgba(59, 42, 34, 0.18)',
  wallTop: '#cbb89c',
  wall: '#f1e6d3',
  wallShade: '#e4d5bd',
  trim: '#a47d58',
  trimDark: '#7f5e41',
  frame: '#8a6f57',
  glassTop: '#9fd2ee',
  glassBottom: '#c9e9f8',
  glassShine: '#effafe',
  skyline: '#86b6d3',
  skylineFar: '#a9cfe5',
  carpet: '#c3cbd6',
  carpetAlt: '#b9c2ce',
  carpetLine: '#adb7c4',
  wood: '#ddb27f',
  woodAlt: '#d3a671',
  woodLine: '#bf8f5b',
  tile: '#ece7df',
  tileAlt: '#e0d9ce',
  rug: '#e7c99c',
  rugBorder: '#c99e68',
  rugInner: '#efd8b4',
  deskTop: '#c58b57',
  deskLight: '#d9a26d',
  deskFront: '#9c6439',
  deskDark: '#6f4526',
  divider: '#8fae9b',
  dividerLight: '#a9c6b3',
  monitor: '#2f3542',
  monitorLight: '#4a5263',
  screenOff: '#3d4556',
  screenOn: '#7fd8ff',
  screenGlow: 'rgba(127, 216, 255, 0.28)',
  screenError: '#ff7b7b',
  screenSleep: '#3f5b8c',
  code: ['#ffd166', '#ef6f8f', '#3fe0b0', '#2c7fb8', '#ffffff'] as const,
  keyboard: '#e7e2da',
  chair: '#4b5872',
  chairDark: '#36405a',
  chairLight: '#64739a',
  sofa: '#cf6650',
  sofaDark: '#a84b3b',
  sofaLight: '#e58670',
  sofaAlt: '#4f9d93',
  sofaAltDark: '#3a7a72',
  sofaAltLight: '#6fbdb2',
  beanbag: ['#e8ac3e', '#8f70c9'] as const,
  beanbagDark: ['#bd8628', '#6c51a3'] as const,
  beanbagLight: ['#f5c867', '#ab90de'] as const,
  table: '#a8754a',
  tableLight: '#c28c5d',
  leaf: '#4fae55',
  leafDark: '#2f7d3a',
  leafLight: '#86d07a',
  pot: '#c96d40',
  potDark: '#9d4f2a',
  counter: '#f1ece4',
  counterFront: '#bba98f',
  counterLine: '#9d8b72',
  machine: '#4b505c',
  machineDark: '#2f333b',
  machineLight: '#6e7584',
  led: '#ef4444',
  ledOk: '#34d399',
  ledWarn: '#fbbf24',
  ledInfo: '#60a5fa',
  fridge: '#e8eaee',
  fridgeShade: '#c8cdd5',
  rack: '#2b303b',
  rackDark: '#1d2028',
  board: '#fbfaf6',
  boardFrame: '#a5abb4',
  ink: ['#e45858', '#4a7fd6', '#3a9d6a'] as const,
  paper: '#ffffff',
  mug: '#f4f1ec',
  coffee: '#6b3f22',
  bubble: '#ffffff',
  alert: '#e5484d',
  mail: '#f6d77a',
  sweat: '#7cc8f4',
  zzz: '#5b7fd1',
  offSign: '#e5484d',
} as const;

/** Keys a character pixel map may use; `.` is transparent. */
export type CharKey = 'o' | 's' | 'S' | 'c' | 'h' | 'H' | 't' | 'T' | 'p' | 'P' | 'b' | 'e';
export type CharPalette = Record<CharKey, string>;

const SKINS = [
  ['#f6d2b4', '#e2b391'],
  ['#ebb98f', '#d39a70'],
  ['#c98f64', '#ad754d'],
  ['#8f5d3d', '#74472c'],
] as const;

function seedHash(seed: string): number {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  return value >>> 0;
}

/** `hsl()` to `#rrggbb`: canvas and tests both want a plain hex string. */
export function hslHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Shirt from the orb's first hue and hair from its second, so a character and its orb read as one. */
export function characterPalette(seed: string, ghost = false): CharPalette {
  if (ghost) {
    return {
      o: '#5b5f68', s: '#c9ccd2', S: '#b2b6bd', c: '#c9ccd2', h: '#8e939c', H: '#7a7f88',
      t: '#a3a8b0', T: '#8d929b', p: '#7d828b', P: '#6c7179', b: '#5b5f68', e: '#5b5f68',
    };
  }
  const [shirt, hair, pants] = orbHues(seed);
  const [skin, skinShade] = SKINS[seedHash(seed) % SKINS.length];
  return {
    o: OFFICE.outline,
    s: skin,
    S: skinShade,
    c: '#f09a8a',
    h: hslHex(hair, 48, 34),
    H: hslHex(hair, 50, 24),
    t: hslHex(shirt, 62, 56),
    T: hslHex(shirt, 55, 43),
    p: hslHex(pants, 22, 32),
    P: hslHex(pants, 24, 24),
    b: '#3a2a26',
    e: '#2a1e1c',
  };
}
