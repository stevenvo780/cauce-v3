import type { Activity, OfficeLayout, Spot } from './layout';
import { seedOf, seededRandom } from './random';

export interface Idler { id: string; desk: number; sleepy: boolean }
export interface Errand { activity: Activity; spot: Spot }

const WEIGHTS: Readonly<Record<Activity, number>> = {
  cook: 2, eat: 2, coffee: 2, play: 3, tidy: 1, sweep: 1, water: 2, read: 2, chat: 3, stroll: 2, sleep: 1,
};
/** At most this share of the people without work may be asleep at once. */
export const SLEEP_SHARE = 0.25;

/** Each person's day is cut in turns of their own length and phase, so the office never switches in unison. */
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
export function scheduleRoutine(layout: OfficeLayout, idlers: readonly Idler[], now: number): Map<string, Errand> {
  const plan = new Map<string, Errand>();
  const taken = new Set<Spot>();
  const beds = new Set<number>();
  const sleepCap = Math.max(1, Math.floor(idlers.length * SLEEP_SHARE));
  const ordered = idlers
    .map((idler) => ({ idler, turn: turnOf(idler.id, now) }))
    .sort((a, b) => a.turn.start - b.turn.start || a.idler.id.localeCompare(b.idler.id));

  const take = (idler: Idler, activity: Activity, offset: number): Errand | null => {
    if (activity === 'sleep') {
      if (beds.size >= sleepCap) return null;
      const bed = layout.beds[idler.desk] && !beds.has(idler.desk) ? idler.desk : layout.beds.findIndex((_, index) => !beds.has(index));
      if (bed < 0) return null;
      beds.add(bed);
      return { activity, spot: layout.beds[bed] };
    }
    const pool = layout.routine[activity];
    if (pool.length === 0) return null;
    if (activity === 'stroll') return { activity, spot: pool[offset % pool.length] };
    const partnered = (spot: Spot) => pool.some((other) => other !== spot && other.pair === spot.pair && taken.has(other));
    const free = activity === 'chat'
      ? pool.find((spot) => !taken.has(spot) && partnered(spot)) ?? pool.find((spot) => !taken.has(spot) && !partnered(spot))
      : Array.from(pool, (_, index) => pool[(offset + index) % pool.length]).find((spot) => !taken.has(spot));
    if (!free) return null;
    taken.add(free);
    return { activity, spot: free };
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
    const pool = layout.routine.chat;
    if (pool.some((other) => other !== errand.spot && other.pair === errand.spot.pair && taken.has(other))) continue;
    taken.delete(errand.spot);
    settle(idler, wish.list.filter((activity) => activity !== 'chat'), wish.offset);
  }
  return plan;
}
