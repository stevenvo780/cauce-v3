import { describe, expect, it } from 'vitest';
import { assignSlots, capacityFor, nextCapacity } from './capacity';
import { TILE, buildLayout, chooseLayout, type LayoutParams } from './layout';
import { createWorld, stepWorld, syncWorld, type ActorInput } from './simulation';

const box = { width: 1440, height: 900, dpr: 1 };
const params = (capacity: number): LayoutParams => chooseLayout(capacity, box).params;
const worker = (id: string, desk: number): ActorInput => ({ id, state: 'thinking', desk });
const walk = (world: ReturnType<typeof createWorld>, seconds: number) => {
  for (let t = 0; t < seconds * 10; t += 1) stepWorld(world, 0.1);
};

describe('stable desks', () => {
  it('keeps everyone in place, gives newcomers the lowest free desk and frees leavers', () => {
    const first = assignSlots(new Map(), ['b', 'c', 'd']);
    expect([...first]).toEqual([['b', 0], ['c', 1], ['d', 2]]);
    const joined = assignSlots(first, ['a', 'b', 'c', 'd']);
    expect(joined.get('a')).toBe(3);
    for (const id of ['b', 'c', 'd']) expect(joined.get(id)).toBe(first.get(id));
    const left = assignSlots(joined, ['a', 'c', 'd']);
    expect(left.get('c')).toBe(1);
    expect(left.get('a')).toBe(3);
    expect(assignSlots(left, ['a', 'c', 'd', 'e']).get('e')).toBe(0);
  });

  it('moves only those past the limit when the map shrinks, without clashes', () => {
    const shrunk = assignSlots(new Map([['a', 0], ['b', 9], ['c', 5]]), ['a', 'b', 'c'], 8);
    expect(shrunk.get('a')).toBe(0);
    expect(shrunk.get('c')).toBe(5);
    expect(new Set(shrunk.values()).size).toBe(3);
    expect(Math.max(...shrunk.values())).toBeLessThan(8);
  });
});

describe('capacity headroom', () => {
  it('rounds up to whole pods with spare seats', () => {
    expect(capacityFor(0)).toBe(8);
    expect(capacityFor(6)).toBe(8);
    expect(capacityFor(7)).toBe(12);
    expect(capacityFor(15)).toBe(20);
  });

  it('ordinary adds and removes keep the layout params, so the world is not rebuilt', () => {
    let capacity = nextCapacity(4);
    const base = params(capacity);
    for (const count of [5, 6, 4, 3, 6]) {
      capacity = nextCapacity(count, capacity);
      expect(params(capacity)).toEqual(base);
    }
  });

  it('grows when the fleet no longer fits and shrinks only when far too big', () => {
    expect(nextCapacity(9, 8)).toBe(12);
    expect(nextCapacity(1, 20)).toBe(8);
    expect(nextCapacity(10, 20)).toBe(20);
    expect(nextCapacity(14, 20)).toBe(20);
  });

  it('builds a desk and a bed for every unit of capacity', () => {
    const layout = buildLayout(params(12));
    expect(layout.desks.length).toBeGreaterThanOrEqual(12);
    expect(layout.beds).toHaveLength(12);
  });
});

describe('entrances and exits', () => {
  const layout = buildLayout(params(8));
  const door = layout.door.px;

  it('places the first sync directly and walks later arrivals in from the door', () => {
    const world = createWorld(layout, false, 1_000);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1)]);
    const seat = layout.desks[0].seat.px;
    expect([world.actors.get('t/a')?.x, world.actors.get('t/a')?.y]).toEqual([seat.x, seat.y]);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1), worker('t/c', 2)]);
    const late = world.actors.get('t/c');
    expect([late?.x, late?.y]).toEqual([door.x, door.y]);
    expect(late?.pose).toBe('walk');
    expect(world.actors.get('t/a')?.x).toBe(seat.x);
    walk(world, 90);
    const target = layout.desks[2].seat.px;
    expect([world.actors.get('t/c')?.x, world.actors.get('t/c')?.y]).toEqual([target.x, target.y]);
  });

  it('sends leavers to the door and removes them on arrival', () => {
    const world = createWorld(layout, false, 1_000);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1)]);
    syncWorld(world, [worker('t/a', 0)]);
    const leaver = world.actors.get('t/b');
    expect(leaver).toBeDefined();
    expect(leaver?.leaving).toBe(true);
    expect(leaver?.desk).toBe(-1);
    syncWorld(world, [worker('t/a', 0)]);
    expect(world.actors.has('t/b')).toBe(true);
    walk(world, 90);
    expect(world.actors.has('t/b')).toBe(false);
    expect(world.actors.has('t/a')).toBe(true);
  });

  it('lets a returning agent cancel its exit', () => {
    const world = createWorld(layout, false, 1_000);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1)]);
    syncWorld(world, [worker('t/a', 0)]);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1)]);
    expect(world.actors.get('t/b')?.leaving).toBe(false);
    walk(world, 90);
    expect(world.actors.has('t/b')).toBe(true);
  });

  it('removes instantly under reduced motion', () => {
    const world = createWorld(layout, true, 1_000);
    syncWorld(world, [worker('t/a', 0), worker('t/b', 1)]);
    syncWorld(world, [worker('t/a', 0)]);
    expect(world.actors.has('t/b')).toBe(false);
  });
});

describe('visitors', () => {
  const layout = buildLayout(params(8));

  it('wait in the garden, never at a desk or in a bed', () => {
    expect(layout.waiting.length).toBeGreaterThan(1);
    const garden = layout.rooms.find((room) => room.id === 'jardin');
    if (!garden) throw new Error('no garden');
    for (const spot of layout.waiting) {
      expect(layout.walkable[spot.tile.y * layout.cols + spot.tile.x]).toBe(true);
      expect(spot.tile.y).toBeGreaterThanOrEqual(garden.y);
      expect(spot.tile.y).toBeLessThan(garden.y + garden.h);
    }
    const world = createWorld(layout, false, 1_000);
    const guest = (id: string, wait: number): ActorInput => ({ id, state: 'thinking', desk: -1, visitor: true, wait });
    syncWorld(world, [worker('t/a', 0), { id: 't/z', state: 'idle', desk: 1, sleepy: true }, guest('v/dots', 0), guest('v/gpt', 1)]);
    const dots = world.actors.get('v/dots');
    expect(dots?.rest).toBe(layout.waiting[0]);
    expect(dots?.activity).toBeNull();
    expect(dots?.pose).toBe('stand');
    expect([dots?.x, dots?.y]).toEqual([layout.waiting[0].px.x, layout.waiting[0].px.y]);
    expect(world.actors.get('v/gpt')?.rest).toBe(layout.waiting[1]);
    for (const actor of world.actors.values()) if (actor.visitor) expect(actor.rest.rest).toBeUndefined();
    expect(layout.waiting[0].px.x % TILE).toBe(TILE / 2);
  });

  it('leave a desk free when they connect', () => {
    const world = createWorld(layout, true, 1_000);
    syncWorld(world, [{ id: 'v/dots', state: 'idle', desk: -1, visitor: true, wait: 0 }, worker('t/a', 0)]);
    expect(world.actors.get('t/a')?.rest).toBe(layout.desks[0].seat);
  });
});
