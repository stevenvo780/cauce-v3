import type { Activity, Level, RoutineActivity, Spot } from './level';
import { seedOf, seededRandom } from './random';

/** A spot inside a given building: where somebody goes, and on which map. */
export interface Place { level: string; spot: Spot }
export interface Idler { id: string; sleepy: boolean }
export interface Errand { activity: Activity; place: Place }

export interface RoutinePools {
  spots: Readonly<Record<RoutineActivity, readonly Place[]>>;
  beds: readonly Place[];
}

const ACTIVITIES: readonly RoutineActivity[] = ['cook', 'eat', 'coffee', 'play', 'tidy', 'sweep', 'water', 'read', 'chat', 'stroll'];
const WEIGHTS: Readonly<Record<Activity, number>> = {
  cook: 2, eat: 2, coffee: 2, play: 3, tidy: 1, sweep: 1, water: 2, read: 2, chat: 3, stroll: 2, sleep: 1,
};
/** At most this share of the people without work may be asleep at once. */
export const SLEEP_SHARE = 0.25;

/** Every routine spot of the shared buildings, grouped by what is done there. */
export function routinePools(levels: Iterable<Level>): RoutinePools {
  const spots = Object.fromEntries(ACTIVITIES.map((activity) => [activity, [] as Place[]])) as Record<RoutineActivity, Place[]>;
  const beds: Place[] = [];
  for (const level of levels) {
    for (const activity of ACTIVITIES) for (const spot of level.routine[activity] ?? []) spots[activity].push({ level: level.id, spot });
    for (const spot of level.beds) beds.push({ level: level.id, spot });
  }
  return { spots, beds };
}

/** Each person's day is cut in turns of their own length and phase, so the campus never switches in unison. */
export function turnOf(id: string, now: number): { index: number; start: number; length: number } {
  const seed = seedOf(id);
  const length = 60 + (seed % 61);
  const phase = (seed >>> 7) % length;
  const index = Math.floor((now + phase) / length);
  return { index, start: index * length - phase, length };
}

/** What someone feels like doing in a turn, best first: a weighted shuffle seeded by person and turn. */
export function preferences(id: string, turn: number, sleepy: boolean): Activity[] {
  const random = seededRandom(seedOf(`${id}#${String(turn)}`));
  return (Object.keys(WEIGHTS) as Activity[])
    .filter((activity) => activity !== 'sleep' || sleepy)
    .map((activity) => ({ activity, key: random() ** (1 / WEIGHTS[activity]) }))
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.activity);
}

/**
 * Who does what right now. Whoever started their turn earlier keeps priority, so a person is only
 * moved when their own turn ends. Single-seat spots go to one person; chat spots only to pairs.
 */
export function scheduleRoutine(pools: RoutinePools, idlers: readonly Idler[], now: number): Map<string, Errand> {
  const plan = new Map<string, Errand>();
  const taken = new Set<Place>();
  const sleepCap = Math.max(1, Math.floor(idlers.length * SLEEP_SHARE));
  let sleeping = 0;
  const ordered = idlers
    .map((idler) => ({ idler, turn: turnOf(idler.id, now) }))
    .sort((a, b) => a.turn.start - b.turn.start || a.idler.id.localeCompare(b.idler.id));

  const take = (idler: Idler, activity: Activity, offset: number): Errand | null => {
    if (activity === 'sleep') {
      if (sleeping >= sleepCap || pools.beds.length === 0) return null;
      const start = seedOf(idler.id) % pools.beds.length;
      const bed = Array.from(pools.beds, (_, index) => pools.beds[(start + index) % pools.beds.length]).find((place) => !taken.has(place));
      if (!bed) return null;
      taken.add(bed);
      sleeping += 1;
      return { activity, place: bed };
    }
    const pool = pools.spots[activity];
    if (pool.length === 0) return null;
    if (activity === 'stroll') return { activity, place: pool[offset % pool.length] };
    const partnered = (place: Place) => pool.some((other) => other !== place && other.level === place.level
      && other.spot.pair === place.spot.pair && taken.has(other));
    const free = activity === 'chat'
      ? pool.find((place) => !taken.has(place) && partnered(place)) ?? pool.find((place) => !taken.has(place) && !partnered(place))
      : Array.from(pool, (_, index) => pool[(offset + index) % pool.length]).find((place) => !taken.has(place));
    if (!free) return null;
    taken.add(free);
    return { activity, place: free };
  };

  const settle = (idler: Idler, wishes: readonly Activity[], offset: number) => {
    for (const activity of wishes) {
      const errand = take(idler, activity, offset);
      if (errand) {
        plan.set(idler.id, errand);
        return;
      }
    }
  };

  const wishes = new Map<string, { list: Activity[]; offset: number }>();
  for (const { idler, turn } of ordered) {
    const list = preferences(idler.id, turn.index, idler.sleepy);
    const offset = seedOf(idler.id) + turn.index * 7;
    wishes.set(idler.id, { list, offset });
    settle(idler, list, offset);
  }
  for (const { idler } of ordered) {
    const errand = plan.get(idler.id);
    const wish = wishes.get(idler.id);
    if (errand?.activity !== 'chat' || !wish) continue;
    const pool = pools.spots.chat;
    if (pool.some((other) => other !== errand.place && other.level === errand.place.level && other.spot.pair === errand.place.spot.pair && taken.has(other))) continue;
    taken.delete(errand.place);
    settle(idler, wish.list.filter((activity) => activity !== 'chat'), wish.offset);
  }
  return plan;
}
