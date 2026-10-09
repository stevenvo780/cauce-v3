import { describe, expect, it } from 'vitest';
import { LIVE_STATES } from '../live/agent-state';
import { BEHAVIOUR, behaviourFor } from './behaviour';
import { characterPalette, hslHex } from './palette';
import { findCheapestPath, findPath } from './pathfinding';
import { seededRandom } from './simulation';
import {
  BLANKET, BLANKET_INHALE, BUBBLE, CHAR_H, CHAR_KEYS, CHAR_W, GLYPH_Z, GLYPH_Z_SMALL, ICONS, LIE_H, LIE_W, characterFrame, lyingFrame,
  type Facing, type FrameName,
} from './sprites';

describe('sprites', () => {
  const frames: FrameName[] = ['stand', 'walk', 'sit', 'sleep', 'stretch', 'napUp', 'napDown'];
  const facings: Facing[] = ['down', 'up', 'left', 'right'];

  it('every frame is a full 16×24 grid of known palette keys', () => {
    const allowed = new Set(['.', ...CHAR_KEYS]);
    for (const frame of frames) for (const facing of facings) for (const step of [0, 1, 2, 3]) {
      const rows = characterFrame(frame, facing, step);
      expect(rows).toHaveLength(CHAR_H);
      for (const row of rows) {
        expect(row).toHaveLength(CHAR_W);
        expect(Array.from(row).every((key) => allowed.has(key))).toBe(true);
      }
    }
  });

  it('left is the mirror of right, and the walk cycle actually moves the feet', () => {
    const right = characterFrame('walk', 'right', 1);
    expect(characterFrame('walk', 'left', 1)).toEqual(right.map((row) => Array.from(row).reverse().join('')));
    expect(characterFrame('walk', 'down', 1)).not.toEqual(characterFrame('walk', 'down', 0));
    expect(characterFrame('walk', 'down', 1)).not.toEqual(characterFrame('walk', 'down', 3));
  });

  it('icons, the bubble, the blanket and the sleep letters are rectangular maps', () => {
    for (const map of [...Object.values(ICONS), BUBBLE, BLANKET, BLANKET_INHALE, GLYPH_Z, GLYPH_Z_SMALL]) {
      expect(new Set(map.map((row) => row.length)).size).toBe(1);
    }
    expect(BLANKET_INHALE).toHaveLength(BLANKET.length + 1);
  });

  it('the sleeping head fits its sprite, eyes shut, and the desk naps hide the face', () => {
    const lying = lyingFrame();
    expect(lying.length).toBeLessThanOrEqual(LIE_H);
    for (const row of lying) expect(row).toHaveLength(LIE_W);
    expect(lying.join('')).not.toMatch(/[^.oshHcSe]/);
    expect(characterFrame('sleep', 'down').join('\n')).toMatch(/ee..ee/);
    for (const frame of ['napUp', 'napDown'] as const) expect(characterFrame(frame, 'down').join('')).not.toContain('e');
  });
});

describe('palette', () => {
  it('converts hsl to hex', () => {
    expect(hslHex(0, 100, 50)).toBe('#ff0000');
    expect(hslHex(120, 100, 25)).toBe('#008000');
    expect(hslHex(0, 0, 100)).toBe('#ffffff');
  });

  it('is stable per agent, differs between agents and greys out ghosts', () => {
    expect(characterPalette('Steven/kant')).toEqual(characterPalette('Steven/kant'));
    expect(characterPalette('Steven/kant').t).not.toBe(characterPalette('Steven/zeus').t);
    const ghost = characterPalette('Steven/kant', true);
    for (const color of Object.values(ghost)) {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(16);
    }
  });
});

describe('behaviour', () => {
  it('maps every live state to how it is acted out', () => {
    for (const state of LIVE_STATES) expect(behaviourFor(state)).toBe(BEHAVIOUR[state]);
    expect(behaviourFor('thinking')).toMatchObject({ rest: 'desk', pose: 'type', monitor: 'code' });
    expect(behaviourFor('receiving')).toMatchObject({ rest: 'desk', bubble: 'mail' });
    expect(behaviourFor('delegating')).toMatchObject({ rest: 'desk', pose: 'type' });
    expect(behaviourFor('blocked')).toMatchObject({ bubble: 'alert', shake: true, monitor: 'alert' });
    expect(behaviourFor('settled')).toMatchObject({ rest: 'routine' });
    expect(behaviourFor('idle')).toMatchObject({ rest: 'routine', bubble: null });
    expect(behaviourFor('down')).toMatchObject({ rest: 'shop', pose: 'lie', monitor: 'error' });
  });
});

describe('pathfinding', () => {
  const open = (cols: number, rows: number) => new Array<boolean>(cols * rows).fill(true);

  it('finds the shortest 4-connected route', () => {
    const path = findPath(open(5, 5), 5, { x: 0, y: 0 }, { x: 3, y: 2 });
    expect(path).toHaveLength(6);
    expect(path?.[0]).toEqual({ x: 0, y: 0 });
    expect(path?.at(-1)).toEqual({ x: 3, y: 2 });
  });

  it('walks around obstacles and gives up when walled in', () => {
    const grid = open(5, 3);
    for (const y of [0, 1]) grid[y * 5 + 2] = false;
    const path = findPath(grid, 5, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path?.some((tile) => tile.y === 2)).toBe(true);
    grid[2 * 5 + 2] = false;
    expect(findPath(grid, 5, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });

  it('prefers cheap tiles: a road around beats a lawn across when the detour is short', () => {
    const grid = open(5, 3);
    const cost = new Uint8Array(15).fill(4);
    for (let x = 0; x < 5; x += 1) cost[2 * 5 + x] = 1;
    cost[0] = 1;
    cost[5] = 1;
    cost[4] = 1;
    cost[9] = 1;
    const path = findCheapestPath(grid, cost, 5, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path?.some((tile) => tile.y === 2)).toBe(true);
    expect(findCheapestPath(grid, cost, 5, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([{ x: 0, y: 0 }]);
    grid[2] = false;
    grid[7] = false;
    grid[12] = false;
    expect(findCheapestPath(grid, cost, 5, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });

  it('may start on a blocked tile but never end on one', () => {
    const grid = open(3, 1);
    grid[0] = false;
    expect(findPath(grid, 3, { x: 0, y: 0 }, { x: 2, y: 0 })).toHaveLength(3);
    expect(findPath(grid, 3, { x: 2, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('seeded randomness', () => {
  it('is seeded: the same id strolls the same way', () => {
    const one = seededRandom(42);
    const two = seededRandom(42);
    expect([one(), one(), one()]).toEqual([two(), two(), two()]);
    expect(seededRandom(43)()).not.toBe(seededRandom(42)());
  });
});
