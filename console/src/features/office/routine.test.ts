import { describe, expect, it } from 'vitest';
import { buildPark } from './interior-park';
import { buildCafe, buildDorm } from './interior-shared';
import { SLEEP_SHARE, preferences, routinePools, scheduleRoutine, turnOf, type Idler, type Place } from './routine';

const pools = routinePools([buildCafe(), buildPark(), buildDorm(6)]);
const idlers = (count: number, sleepy = true): Idler[] =>
  Array.from({ length: count }, (_, index) => ({ id: `t/a${String(index).padStart(2, '0')}`, sleepy }));
const key = (place: Place) => `${place.level}:${String(place.spot.px.x)},${String(place.spot.px.y)}`;

describe('routine turns', () => {
  it('cuts each person’s day in their own turns, so nobody switches in unison', () => {
    const turns = idlers(12).map((idler) => turnOf(idler.id, 50_000));
    expect(new Set(turns.map((turn) => turn.start)).size).toBeGreaterThan(8);
    for (const turn of turns) {
      expect(turn.length).toBeGreaterThanOrEqual(60);
      expect(turn.length).toBeLessThanOrEqual(120);
      expect(turn.start).toBeLessThanOrEqual(50_000);
      expect(turn.start + turn.length).toBeGreaterThan(50_000);
    }
    expect(turnOf('t/a00', 50_000)).toEqual(turnOf('t/a00', 50_000));
  });

  it('prefers activities by a seeded shuffle that only offers a nap to the sleepy', () => {
    expect(preferences('t/a', 7, true)).toEqual(preferences('t/a', 7, true));
    expect(preferences('t/a', 7, false)).not.toContain('sleep');
    expect(preferences('t/a', 7, true)).toContain('sleep');
    const favourites = new Set(Array.from({ length: 40 }, (_, turn) => preferences('t/a', turn, false)[0]));
    expect(favourites.size).toBeGreaterThanOrEqual(6);
  });
});

describe('scheduleRoutine across the shared buildings', () => {
  it('gives everyone something to do and never two people one seat', () => {
    for (const count of [1, 5, 12, 40]) {
      for (let now = 0; now < 3_000; now += 37) {
        const plan = scheduleRoutine(pools, idlers(count), now);
        expect(plan.size).toBe(count);
        const seats = [...plan.values()].filter((errand) => errand.activity !== 'stroll').map((errand) => key(errand.place));
        expect(new Set(seats).size, `${String(count)} at ${String(now)}`).toBe(seats.length);
      }
    }
  });

  it('only seats chatters in pairs facing each other', () => {
    for (let now = 0; now < 3_000; now += 53) {
      const chatters = [...scheduleRoutine(pools, idlers(12), now).values()].filter((errand) => errand.activity === 'chat');
      for (const errand of chatters) {
        const partner = chatters.find((other) => other !== errand && other.place.spot.pair === errand.place.spot.pair);
        expect(partner).toBeDefined();
        expect(partner?.place.spot.dir).not.toBe(errand.place.spot.dir);
      }
    }
  });

  it('keeps sleep rare and in the residence: a small share at a time, never for the recently active', () => {
    let naps = 0;
    let samples = 0;
    for (let now = 0; now < 20_000; now += 97) {
      const sleepers = [...scheduleRoutine(pools, idlers(12), now).values()].filter((errand) => errand.activity === 'sleep');
      expect(sleepers.length).toBeLessThanOrEqual(Math.max(1, Math.floor(12 * SLEEP_SHARE)));
      for (const errand of sleepers) expect([errand.place.level, errand.place.spot.rest]).toEqual(['residencia', 'bed']);
      naps += sleepers.length;
      samples += 12;
      expect([...scheduleRoutine(pools, idlers(12, false), now).values()].some((errand) => errand.activity === 'sleep')).toBe(false);
    }
    expect(naps).toBeGreaterThan(0);
    expect(naps / samples).toBeLessThan(0.15);
  });

  it('is the same on every screen and fills a day with many activities in both the café and the park', () => {
    expect(scheduleRoutine(pools, idlers(6), 12_345)).toEqual(scheduleRoutine(pools, idlers(6), 12_345));
    const done = new Set<string>();
    const places = new Set<string>();
    for (let now = 0; now < 86_400; now += 600) {
      const errand = scheduleRoutine(pools, idlers(6), now).get('t/a03');
      if (errand) {
        done.add(errand.activity);
        places.add(errand.place.level);
      }
    }
    expect(done.size).toBeGreaterThanOrEqual(8);
    expect([...places].sort()).toEqual(['cafeteria', 'parque', 'residencia']);
  });
});
