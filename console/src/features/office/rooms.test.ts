import { describe, expect, it } from 'vitest';
import type { LiveState } from '../live/agent-state';
import { TILE, buildLayout, podsFor, type LayoutParams } from './layout';
import { findPath } from './pathfinding';
import { ROOM_NAMES, assignRest, roomAt, roomCamera, roomForState, type Resting } from './rooms';
import { createWorld, syncWorld } from './simulation';
import { wrapSpeech } from './speech';

const params = (count: number, side: LayoutParams['side'] = 'right', compact = false): LayoutParams => ({
  pods: podsFor(count), podCols: Math.min(2, podsFor(count)), side, compact, beds: count,
});

const people = (states: readonly LiveState[], awake: readonly boolean[] = []): Resting[] =>
  states.map((state, index) => ({ id: `t/a${String(index).padStart(2, '0')}`, desk: index, state, awake: awake[index] }));

describe('rooms', () => {
  it('builds four named rooms that never overlap, each reachable from the entrance', () => {
    for (const side of ['right', 'bottom'] as const) for (const count of [1, 6, 15, 40]) {
      const layout = buildLayout(params(count, side));
      expect(layout.rooms.map((room) => room.id)).toEqual(['programadores', 'cocina', 'patio', 'dormitorio']);
      const owner = new Map<string, string>();
      for (const room of layout.rooms) for (let y = room.y; y < room.y + room.h; y += 1) for (let x = room.x; x < room.x + room.w; x += 1) {
        expect(owner.get(`${String(x)},${String(y)}`), `${side} ${String(count)}`).toBeUndefined();
        owner.set(`${String(x)},${String(y)}`, room.id);
      }
      for (const spot of [...layout.beds, ...layout.play, ...layout.coffee]) {
        expect(findPath(layout.walkable, layout.cols, layout.door.tile, spot.tile), `${side} ${String(count)}`).not.toBeNull();
      }
    }
  });

  it('puts beds in the bedroom, games in the playground and the coffee in the kitchen', () => {
    for (const side of ['right', 'bottom'] as const) {
      const layout = buildLayout(params(12, side));
      for (const bed of layout.beds) expect(roomAt(layout, bed.px)?.id).toBe('dormitorio');
      for (const game of [...layout.play, ...layout.watch]) expect(roomAt(layout, game.px)?.id).toBe('patio');
      for (const cup of layout.coffee) expect(roomAt(layout, cup.px)?.id).toBe('cocina');
      for (const desk of layout.desks) expect(roomAt(layout, desk.seat.px)?.id).toBe('programadores');
      expect(roomAt(layout, { x: 0, y: 0 })).toBeNull();
    }
  });

  it('names rooms in Spanish and sends each state to its room', () => {
    expect(ROOM_NAMES.patio).toBe('Patio de juegos');
    expect(roomForState('idle')).toBe('dormitorio');
    expect(roomForState('idle', true)).toBe('patio');
    expect(roomForState('settled')).toBe('patio');
    for (const state of ['thinking', 'receiving', 'delegating', 'blocked', 'down'] as const) expect(roomForState(state)).toBe('programadores');
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

  it('gives every sleeper their own bed, and the bed of their desk when it is free', () => {
    const spots = assignRest(layout, people(Array<LiveState>(12).fill('idle')));
    const beds = [...spots.values()];
    expect(beds.every((spot) => spot.rest === 'bed')).toBe(true);
    expect(new Set(beds).size).toBe(12);
    expect(spots.get('t/a03')).toBe(layout.beds[3]);
  });

  it('moves a sleeper whose own bed is missing into any free bed, never onto a chair', () => {
    const spots = assignRest(layout, [{ id: 't/late', desk: 40, state: 'idle' }, ...people(['idle', 'thinking'])]);
    expect(spots.get('t/late')?.rest).toBe('bed');
    expect(spots.get('t/late')).not.toBe(spots.get('t/a00'));
  });

  it('keeps workers and the offline at their desk and sends the awake idle to the games, then around them', () => {
    const states: LiveState[] = ['thinking', 'down', 'blocked', ...Array<LiveState>(14).fill('settled')];
    const spots = assignRest(layout, people(states, states.map(() => true)));
    expect(spots.get('t/a00')).toBe(layout.desks[0].seat);
    expect(spots.get('t/a01')).toBe(layout.desks[1].seat);
    expect(spots.get('t/a02')).toBe(layout.desks[2].seat);
    const players = [...spots.entries()].filter(([id]) => Number(id.slice(3)) >= 3).map(([, spot]) => spot);
    expect(players.filter((spot) => spot.game)).toHaveLength(layout.play.length);
    expect(new Set(players).size).toBe(players.length);
    for (const spot of players) expect(roomAt(layout, spot.px)?.id).toBe('patio');
  });

  it('acts it out: sleepers lie in bed, the awake idle play, the offline stay grey at the desk', () => {
    const world = createWorld(layout, true);
    syncWorld(world, [
      { id: 't/sleepy', state: 'idle', desk: 0 },
      { id: 't/player', state: 'idle', awake: true, desk: 1 },
      { id: 't/gone', state: 'down', desk: 2 },
    ]);
    expect(world.actors.get('t/sleepy')?.pose).toBe('lie');
    expect(world.actors.get('t/player')?.pose).toBe('play');
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
