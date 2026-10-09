import { capsuleRoute, routeLength } from './campus';
import type { Point } from './level';
import type { WorldMap } from './world-map';

/** Art px per second a capsule flies through the tubes. */
export const CAPSULE_SPEED = 190;
/** Past this many uncollected capsules the oldest leaves the tray, and the feed closes it as collected. */
const TRAY_LIMIT = 48;

export interface Capsule {
  id: string;
  from: string;
  to: string;
  fromLevel: string;
  toLevel: string;
  route: readonly Point[];
  length: number;
  /** Distance flown, in art px; negative while it still waits in the sender's station. */
  at: number;
  phase: 'flying' | 'waiting';
  arrivedAt: number;
}

export type TubeEventKind = 'sent' | 'arrived' | 'collected' | 'handed';

export interface TubeEvent {
  /** Delivery id. */
  id: string;
  from: string;
  to: string;
  kind: TubeEventKind;
  /** Wall clock, ms. */
  at: number;
  /** A capsule through the tubes, or paper carried by hand to a desk in the same building. */
  by: 'tube' | 'hand';
}

export interface TubeLine {
  capsules: Capsule[];
  /** When each building's station last rang, by level id. */
  dings: Map<string, number>;
  listener: ((event: TubeEvent) => void) | null;
  /** Called for each capsule as it reaches its tray. */
  landed: ((capsule: Capsule) => void) | null;
}

export const createLine = (): TubeLine => ({ capsules: [], dings: new Map(), listener: null, landed: null });

export function emit(line: TubeLine, event: Omit<TubeEvent, 'at'>): void {
  line.listener?.({ ...event, at: Date.now() });
}

/**
 * Puts a capsule in the sender's station. Without a tube between the two buildings, or without
 * motion, it lands in the receiver's tray at once.
 */
export function launch(line: TubeLine, map: WorldMap, input: { id: string; from: string; to: string; fromLevel: string; toLevel: string }, delay: number, instant: boolean, now: number): Capsule {
  const route = instant ? null : capsuleRoute(map.campus, input.fromLevel, input.toLevel);
  const capsule: Capsule = {
    ...input, route: route ?? [], length: route ? routeLength(route) : 0,
    at: route ? -delay * CAPSULE_SPEED : 0, phase: route ? 'flying' : 'waiting', arrivedAt: route ? 0 : now,
  };
  line.capsules.push(capsule);
  emit(line, { id: input.id, from: input.from, to: input.to, kind: 'sent', by: 'tube' });
  if (!route) arrive(line, capsule, now);
  const waiting = line.capsules.filter((item) => item.phase === 'waiting');
  if (waiting.length > TRAY_LIMIT) {
    const dropped = waiting[0];
    line.capsules = line.capsules.filter((item) => item !== dropped);
    emit(line, { id: dropped.id, from: dropped.from, to: dropped.to, kind: 'collected', by: 'tube' });
  }
  return capsule;
}

function arrive(line: TubeLine, capsule: Capsule, now: number): void {
  capsule.phase = 'waiting';
  capsule.arrivedAt = now;
  line.dings.set(capsule.toLevel, now);
  emit(line, { id: capsule.id, from: capsule.from, to: capsule.to, kind: 'arrived', by: 'tube' });
}

/** Flies every capsule on; the line's `landed` hears of each one that reached its tray in this step. */
export function stepCapsules(line: TubeLine, dt: number, now: number): void {
  for (const capsule of line.capsules) {
    if (capsule.phase !== 'flying') continue;
    capsule.at += CAPSULE_SPEED * dt;
    if (capsule.at < capsule.length) continue;
    arrive(line, capsule, now);
    line.landed?.(capsule);
  }
}

export function waitingFor(line: TubeLine, actorId: string, level: string): boolean {
  return line.capsules.some((capsule) => capsule.phase === 'waiting' && capsule.to === actorId && capsule.toLevel === level);
}

/** Takes every capsule waiting for `actorId` out of the tray at `level`; returns how many. */
export function collect(line: TubeLine, actorId: string, level: string): number {
  let taken = 0;
  line.capsules = line.capsules.filter((capsule) => {
    if (capsule.phase !== 'waiting' || capsule.to !== actorId || capsule.toLevel !== level) return true;
    taken += 1;
    emit(line, { id: capsule.id, from: capsule.from, to: capsule.to, kind: 'collected', by: 'tube' });
    return false;
  });
  return taken;
}

export function trayCount(line: TubeLine, level: string): number {
  let count = 0;
  for (const capsule of line.capsules) if (capsule.phase === 'waiting' && capsule.toLevel === level) count += 1;
  return count;
}
