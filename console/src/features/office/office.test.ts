import { describe, expect, it } from 'vitest';
import { LIVE_STATES } from '../live/agent-state';
import { must } from '../../test/must';
import { BEHAVIOUR, behaviourFor } from './behaviour';
import { TILE, buildLayout, chooseLayout, layoutSize, podsFor, type LayoutParams } from './layout';
import { characterPalette, hslHex } from './palette';
import { findPath } from './pathfinding';
import { createWorld, planFor, seededRandom, stepWorld, syncWorld, type Actor, type ActorInput, type World } from './simulation';
import {
  BLANKET, BLANKET_INHALE, BUBBLE, CHAR_H, CHAR_KEYS, CHAR_W, GLYPH_Z, GLYPH_Z_SMALL, ICONS, LIE_H, LIE_W, characterFrame, lyingFrame,
  type Facing, type FrameName,
} from './sprites';

const params = (pods: number, overrides: Partial<LayoutParams> = {}): LayoutParams => ({
  pods, podCols: Math.min(2, pods), side: 'right', compact: false, ...overrides,
});

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
    expect(behaviourFor('delegating')).toMatchObject({ rest: 'desk', errand: 'deliver' });
    expect(behaviourFor('blocked')).toMatchObject({ bubble: 'alert', shake: true, monitor: 'error' });
    expect(behaviourFor('settled')).toMatchObject({ rest: 'coffee', errand: 'stretch' });
    expect(behaviourFor('idle')).toMatchObject({ rest: 'lounge', pose: 'sleep', bubble: 'zzz', errand: 'wander' });
    expect(behaviourFor('down')).toMatchObject({ pose: 'ghost', monitor: 'off', errand: null });
  });
});

describe('layout', () => {
  it('gives one desk per seat, four per pod, for any fleet size from 1 to 40', () => {
    for (const count of [1, 3, 4, 5, 15, 40]) {
      const layout = buildLayout(params(podsFor(count)));
      expect(layout.desks.length).toBe(podsFor(count) * 4);
      expect(layout.desks.length).toBeGreaterThanOrEqual(count);
      expect(new Set(layout.desks.map((desk) => `${String(desk.seat.px.x)},${String(desk.seat.px.y)}`)).size).toBe(layout.desks.length);
    }
  });

  it('every seat, visit spot, nap spot and coffee spot is reachable from every desk', () => {
    for (const side of ['right', 'bottom'] as const) for (const compact of [false, true]) {
      const layout = buildLayout(params(4, { side, compact }));
      const start = layout.desks[0].seat.tile;
      const spots = [
        ...layout.desks.flatMap((desk) => [desk.seat.tile, desk.visit.tile]),
        ...layout.lounge.map((spot) => spot.tile),
        ...layout.coffee.map((spot) => spot.tile),
      ];
      for (const spot of spots) expect(findPath(layout.walkable, layout.cols, start, spot), `${side} ${String(compact)}`).not.toBeNull();
    }
  });

  it('sleeps people in beds first, then on the sofa, then in beanbags, all reachable', () => {
    for (const side of ['right', 'bottom'] as const) {
      const layout = buildLayout(params(4, { side }));
      expect(layout.lounge.map((spot) => spot.rest)).toEqual(['bed', 'bed', 'bed', 'sofa', 'beanbag', 'beanbag']);
      const beds = layout.furniture.filter((piece) => piece.kind === 'bed');
      expect(beds).toHaveLength(3);
      for (const [index, bed] of beds.entries()) {
        const spot = layout.lounge[index];
        expect(spot.px.x).toBeGreaterThan(bed.x * TILE);
        expect(spot.px.x).toBeLessThan((bed.x + 2) * TILE);
        expect(Math.floor(spot.px.y / TILE)).toBe(bed.y);
        expect(layout.walkable[spot.tile.y * layout.cols + spot.tile.x]).toBe(true);
      }
    }
  });

  it('opens a door in the back wall over a walkable corridor, clear of windows', () => {
    for (const side of ['right', 'bottom'] as const) for (const compact of [false, true]) for (const pods of [1, 4]) {
      const layout = buildLayout(params(pods, { side, compact, podCols: Math.min(2, pods) }));
      const door = must(layout.wall.find((item) => item.kind === 'door'), 'door');
      expect(layout.walkable[layout.door.tile.y * layout.cols + layout.door.tile.x]).toBe(true);
      expect(layout.door.tile.y).toBe(3);
      for (const item of layout.wall.filter((other) => other !== door && other.kind !== 'clock')) {
        expect(item.x + item.w <= door.x || item.x >= door.x + door.w).toBe(true);
      }
      expect(findPath(layout.walkable, layout.cols, layout.door.tile, layout.lounge[0].tile)).not.toBeNull();
    }
  });

  it('keeps furniture inside the room and off the back wall', () => {
    const layout = buildLayout(params(3));
    for (const piece of layout.furniture) {
      expect(piece.x).toBeGreaterThanOrEqual(0);
      expect(piece.x).toBeLessThan(layout.cols);
      expect(piece.y).toBeGreaterThanOrEqual(3);
      expect(piece.y).toBeLessThan(layout.rows);
    }
  });

  it('picks an integer scale that fits the box, and lets the height go on phones', () => {
    const desk = chooseLayout(15, { width: 1100, height: 760, dpr: 1 });
    const size = layoutSize(desk.params);
    expect(Number.isInteger(desk.scale)).toBe(true);
    expect(size.cols * TILE * desk.scale).toBeLessThanOrEqual(1100);
    expect(size.rows * TILE * desk.scale).toBeLessThanOrEqual(760);
    expect(desk.scale).toBeGreaterThanOrEqual(3);

    const phone = chooseLayout(15, { width: 358, height: 700, dpr: 3 });
    const phoneSize = layoutSize(phone.params);
    expect(phoneSize.cols * TILE * phone.scale).toBeLessThanOrEqual(358 * 3);
    expect(phone.scale / 3).toBeGreaterThanOrEqual(1.6);
    expect(phone.params.side).toBe('bottom');
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

  it('may start on a blocked tile but never end on one', () => {
    const grid = open(3, 1);
    grid[0] = false;
    expect(findPath(grid, 3, { x: 0, y: 0 }, { x: 2, y: 0 })).toHaveLength(3);
    expect(findPath(grid, 3, { x: 2, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('simulation', () => {
  const layout = buildLayout(params(1));
  const actorOf = (world: World, id: string): Actor => must(world.actors.get(id), `actor ${id}`);
  const inputs = (overrides: Partial<Record<string, ActorInput>> = {}): ActorInput[] => [
    { id: 'a', state: 'thinking', desk: 0 },
    { id: 'b', state: 'idle', desk: 1 },
    { id: 'c', state: 'down', desk: 2 },
    { id: 'd', state: 'delegating', desk: 3, delegateDesk: 0 },
  ].map((input) => ({ ...input, ...overrides[input.id] }) as ActorInput);

  it('is seeded: the same id strolls the same way', () => {
    const one = seededRandom(42);
    const two = seededRandom(42);
    expect([one(), one(), one()]).toEqual([two(), two(), two()]);
  });

  it('places newcomers straight at their resting pose instead of walking in', () => {
    const world = createWorld(layout);
    syncWorld(world, inputs());
    const a = actorOf(world, 'a');
    expect([a.x, a.y]).toEqual([layout.desks[0].seat.px.x, layout.desks[0].seat.px.y]);
    expect(a.pose).toBe('type');
    expect(actorOf(world, 'b').pose).toBe('lie');
    expect(actorOf(world, 'b').rest.rest).toBe('bed');
    expect([actorOf(world, 'b').x, actorOf(world, 'b').y]).toEqual([layout.lounge[0].px.x, layout.lounge[0].px.y]);
    expect(actorOf(world, 'c').pose).toBe('ghost');
  });

  it('a delegator carries paper to the delegate and comes back', () => {
    const world = createWorld(layout);
    syncWorld(world, inputs());
    const d = actorOf(world, 'd');
    const plan = planFor(d, layout);
    expect(plan.some((step) => step.kind === 'goto' && step.carrying && step.spot === layout.desks[0].visit)).toBe(true);
    let carried = false;
    let handedOver = false;
    for (let t = 0; t < 40; t += 0.05) {
      stepWorld(world, 0.05);
      carried ||= d.carrying;
      handedOver ||= d.pose === 'handover';
    }
    expect(carried).toBe(true);
    expect(handedOver).toBe(true);
  });

  it('changing state replans from where the person stands, and leaving removes them', () => {
    const world = createWorld(layout);
    syncWorld(world, inputs());
    const a = actorOf(world, 'a');
    syncWorld(world, inputs({ a: { id: 'a', state: 'idle', desk: 0 } }));
    expect(a.pose).toBe('walk');
    expect([a.x, a.y]).toEqual([layout.desks[0].seat.px.x, layout.desks[0].seat.px.y]);
    for (let t = 0; t < 60; t += 0.05) stepWorld(world, 0.05);
    expect(['lie', 'sleep', 'nap']).toContain(a.pose);

    syncWorld(world, inputs().filter((input) => input.id !== 'c'));
    expect(world.actors.has('c')).toBe(false);
  });

  it('without motion everyone holds a still pose and nobody walks', () => {
    const world = createWorld(layout, true);
    syncWorld(world, inputs());
    const before = [...world.actors.values()].map((actor) => [actor.x, actor.y, actor.pose]);
    for (let t = 0; t < 10; t += 0.1) stepWorld(world, 0.1);
    expect([...world.actors.values()].map((actor) => [actor.x, actor.y, actor.pose])).toEqual(before);
    expect(actorOf(world, 'd').bubble).toBe('paper');
    expect([...world.actors.values()].some((actor) => actor.pose === 'walk')).toBe(false);
  });

  it('idle people lie in beds and on the sofa, slump in beanbags, and beyond that nap at their own desk', () => {
    const big = buildLayout(params(4));
    const world = createWorld(big);
    const many: ActorInput[] = Array.from({ length: 12 }, (_, index) => ({ id: `idle-${String(index).padStart(2, '0')}`, state: 'idle', desk: index }));
    syncWorld(world, many);
    const poses = [...world.actors.values()].map((actor) => actor.pose);
    expect(poses.filter((pose) => pose === 'lie')).toHaveLength(big.lounge.filter((spot) => spot.rest !== 'beanbag').length);
    expect(poses.filter((pose) => pose === 'sleep')).toHaveLength(big.lounge.filter((spot) => spot.rest === 'beanbag').length);
    expect(poses.filter((pose) => pose === 'nap')).toHaveLength(12 - big.lounge.length);
  });
});
