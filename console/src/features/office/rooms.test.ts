import { describe, expect, it } from 'vitest';
import { TILE, buildLayout, podsFor, type LayoutParams } from './layout';
import { findPath } from './pathfinding';
import { ROOM_NAMES, roomAt, roomCamera, roomCounts, sameCounts } from './rooms';
import { createWorld, syncWorld } from './simulation';
import { wrapSpeech } from './speech';

const params = (count: number, side: LayoutParams['side'] = 'right', compact = false): LayoutParams => ({
  pods: podsFor(count), podCols: Math.min(2, podsFor(count)), side, compact, beds: count,
});

describe('rooms', () => {
  it('builds five named rooms that never overlap, each reachable from the entrance', () => {
    for (const side of ['right', 'bottom'] as const) for (const count of [1, 6, 15, 40]) {
      const layout = buildLayout(params(count, side));
      expect(layout.rooms.map((room) => room.id)).toEqual(['programadores', 'cocina', 'patio', 'jardin', 'dormitorio']);
      const owner = new Map<string, string>();
      for (const room of layout.rooms) for (let y = room.y; y < room.y + room.h; y += 1) for (let x = room.x; x < room.x + room.w; x += 1) {
        expect(owner.get(`${String(x)},${String(y)}`), `${side} ${String(count)}`).toBeUndefined();
        owner.set(`${String(x)},${String(y)}`, room.id);
      }
      for (const spot of [...layout.beds, ...Object.values(layout.routine).flat()]) {
        expect(findPath(layout.walkable, layout.cols, layout.door.tile, spot.tile), `${side} ${String(count)}`).not.toBeNull();
      }
    }
  });

  it('puts beds in the bedroom, games in the playground and the coffee in the kitchen', () => {
    for (const side of ['right', 'bottom'] as const) {
      const layout = buildLayout(params(12, side));
      for (const bed of layout.beds) expect(roomAt(layout, bed.px)?.id).toBe('dormitorio');
      for (const game of layout.play) expect(roomAt(layout, game.px)?.id).toBe('patio');
      for (const cup of [...layout.coffee, ...layout.routine.eat, ...layout.routine.tidy]) expect(roomAt(layout, cup.px)?.id).toBe('cocina');
      for (const spot of [...layout.routine.read, ...layout.routine.chat, ...layout.routine.stroll]) expect(roomAt(layout, spot.px)?.id).toBe('jardin');
      expect(layout.routine.cook.map((spot) => roomAt(layout, spot.px)?.id)).toEqual(['cocina', 'jardin']);
      for (const desk of layout.desks) expect(roomAt(layout, desk.seat.px)?.id).toBe('programadores');
      expect(roomAt(layout, { x: 0, y: 0 })).toBeNull();
    }
  });

  it('names rooms in Spanish and counts people by the room they are headed to', () => {
    expect(ROOM_NAMES.patio).toBe('Patio de juegos');
    expect(ROOM_NAMES.jardin).toBe('Jardín');
    const layout = buildLayout(params(4));
    const counts = roomCounts(layout, [{ rest: layout.desks[0].seat }, { rest: layout.beds[1] }, { rest: layout.routine.read[0] }, { rest: layout.routine.read[1] }]);
    expect(counts).toEqual({ programadores: 1, dormitorio: 1, jardin: 2 });
    expect(sameCounts(counts, { jardin: 2, dormitorio: 1, programadores: 1 })).toBe(true);
    expect(sameCounts(counts, { jardin: 2, dormitorio: 1 })).toBe(false);
  });

  it('flies to a room at least one zoom step closer than the whole building', () => {
    const layout = buildLayout(params(8));
    const view = { width: 1100, height: 520 };
    const limits = { min: 2, max: 8 };
    for (const room of layout.rooms) {
      const cam = roomCamera(room, view, limits, { right: 0, bottom: 0 });
      expect(cam.zoom).toBeGreaterThanOrEqual(3);
      expect(Number.isInteger(cam.zoom)).toBe(true);
      expect(roomAt(layout, cam)?.id).toBe(room.id);
    }
  });
});

describe('who goes where', () => {
  const layout = buildLayout(params(12));

  it('acts it out: workers type, the offline stay grey at the desk, the free follow their routine', () => {
    const world = createWorld(layout, true, 1_000);
    syncWorld(world, [
      { id: 't/free', state: 'idle', desk: 0 },
      { id: 't/coder', state: 'thinking', desk: 1 },
      { id: 't/gone', state: 'down', desk: 2 },
    ]);
    const free = world.actors.get('t/free');
    expect(free?.activity).not.toBeNull();
    expect(roomAt(layout, free?.rest.px ?? { x: 0, y: 0 })?.id).not.toBe('programadores');
    expect(world.actors.get('t/coder')?.pose).toBe('type');
    expect(world.actors.get('t/gone')?.pose).toBe('ghost');
    expect([world.actors.get('t/gone')?.x, world.actors.get('t/gone')?.y]).toEqual([layout.desks[2].seat.px.x, layout.desks[2].seat.px.y]);
  });
});

describe('speech bubbles', () => {
  const measure = (text: string) => text.length * 10;

  it('wraps into at most two lines and marks a cut with an ellipsis', () => {
    expect(wrapSpeech('hola', 100, 2, measure)).toEqual(['hola']);
    const lines = wrapSpeech('uno dos tres cuatro cinco seis siete ocho', 100, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(100);
  });

  it('shortens a single word that is too long', () => {
    const [line] = wrapSpeech('supercalifragilístico', 60, 2, measure);
    expect(line.endsWith('…')).toBe(true);
    expect(measure(line)).toBeLessThanOrEqual(60);
  });
});

describe('beds scale with the fleet', () => {
  it('lays exactly one bed per agent on both arrangements', () => {
    for (const side of ['right', 'bottom'] as const) for (const count of [3, 13, 33]) {
      const layout = buildLayout(params(count, side, true));
      expect(layout.beds).toHaveLength(count);
      for (const bed of layout.beds) expect(bed.px.y % TILE).toBe(9);
    }
  });
});
