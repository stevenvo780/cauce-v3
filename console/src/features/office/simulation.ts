import type { LiveState } from '../live/agent-state';
import { behaviourFor, type Behaviour, type BubbleKind, type Pose } from './behaviour';
import { TILE, type Activity, type Dir, type OfficeLayout, type Point, type Spot } from './layout';
import { findPath } from './pathfinding';
import { seedOf, seededRandom } from './random';
import { scheduleRoutine } from './routine';

export { seedOf, seededRandom } from './random';

/** Walking speed in art pixels per second. */
export const WALK_SPEED = 34;

export interface ActorInput {
  id: string;
  state: LiveState;
  /** Idle long enough that a nap in the dormitory is on the cards. */
  sleepy?: boolean;
  desk: number;
  /** Desk index of the agent this one is handing work to, when delegating. */
  delegateDesk?: number | null;
}

export type Carry = 'paper' | 'box' | null;

type Step =
  | { kind: 'goto'; spot: Spot; carry: Carry }
  | { kind: 'act'; pose: Pose; seconds: number; bubble: BubbleKind; dir?: Dir }
  | { kind: 'repeat'; from: number };

export interface Actor {
  id: string;
  desk: number;
  state: LiveState;
  behaviour: Behaviour;
  activity: Activity | null;
  delegateDesk: number | null;
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
  bubble: BubbleKind;
  carry: Carry;
  /** Seconds in the current pose, for animation. */
  clock: number;
  /** Art pixels walked so far, for the walk cycle. */
  walked: number;
  waypoints: Point[];
  steps: Step[];
  stepIndex: number;
  timer: number;
  rest: Spot;
  random: () => number;
}

export interface World {
  layout: OfficeLayout;
  actors: Map<string, Actor>;
  reducedMotion: boolean;
  /** Wall-clock seconds, so the routine is the same on every screen. */
  time: number;
  inputs: readonly ActorInput[];
  nextRoutine: number;
}

export function createWorld(layout: OfficeLayout, reducedMotion = false, now = Date.now() / 1000): World {
  return { layout, actors: new Map(), reducedMotion, time: now, inputs: [], nextRoutine: now + 1 };
}

const tileOf = (x: number, y: number): Point => ({ x: Math.floor(x / TILE), y: Math.floor((y - 1) / TILE) });

function between(random: () => number, low: number, high: number): number {
  return low + random() * (high - low);
}

const POSE: Readonly<Record<Activity, Pose>> = {
  cook: 'cook', eat: 'eat', coffee: 'coffee', play: 'play', tidy: 'tidy', sweep: 'sweep', water: 'water', read: 'read',
  chat: 'chat', stroll: 'stand', sleep: 'lie',
};

/** The script a person follows for their current state, ending in an endless act or a loop. */
export function planFor(actor: Actor, layout: OfficeLayout): Step[] {
  const desk = layout.desks[actor.desk];
  const behaviour = actor.behaviour;
  const goto = (spot: Spot, carry: Carry = null): Step => ({ kind: 'goto', spot, carry });
  const act = (pose: Pose, seconds: number, dir?: Dir, bubble: BubbleKind = null): Step => ({ kind: 'act', pose, seconds, bubble, dir });

  if (behaviour.errand === 'deliver' && actor.delegateDesk !== null && layout.desks[actor.delegateDesk]) {
    const target = layout.desks[actor.delegateDesk].visit;
    return [
      goto(desk.seat),
      act('type', between(actor.random, 2.5, 5), desk.seat.dir),
      goto(target, 'paper'),
      act('handover', 1.6, target.dir, 'paper'),
      goto(desk.seat),
      act('type', between(actor.random, 4, 8), desk.seat.dir),
      { kind: 'repeat', from: 2 },
    ];
  }
  const spot = actor.rest;
  const back = spot.from ?? spot;
  switch (actor.activity) {
    case null:
      return [goto(spot), act(behaviour.pose, Infinity, spot.dir, behaviour.bubble)];
    case 'tidy':
      return [goto(back), act('stand', 1.2, back.dir), goto(spot, 'box'), act('tidy', 1.6, spot.dir), { kind: 'repeat', from: 0 }];
    case 'sweep':
      return [goto(spot), act('sweep', between(actor.random, 4, 7), spot.dir), goto(back), act('sweep', between(actor.random, 4, 7), back.dir), { kind: 'repeat', from: 0 }];
    case 'stroll': {
      const garden = layout.routine.stroll;
      const pick = () => garden[Math.floor(actor.random() * garden.length)] ?? spot;
      return [spot, pick(), pick()].flatMap((stop) => [goto(stop), act('stand', between(actor.random, 1.5, 4), 'down')]).concat({ kind: 'repeat', from: 0 });
    }
    default:
      return [goto(spot), act(POSE[actor.activity], Infinity, spot.dir, actor.activity === 'chat' ? 'chat' : actor.activity === 'sleep' ? 'zzz' : null)];
  }
}

const sameSpot = (a: Spot, b: Spot) => a.px.x === b.px.x && a.px.y === b.px.y;

function begin(world: World, actor: Actor, instant: boolean): void {
  actor.steps = planFor(actor, world.layout);
  actor.waypoints = [];
  actor.carry = null;
  if (instant || world.reducedMotion || actor.state === 'down') {
    const endless = actor.steps.findIndex((step) => step.kind === 'act' && step.seconds === Infinity);
    const start = endless >= 0 ? endless : actor.steps.findIndex((step) => step.kind === 'act');
    const spot = [...actor.steps.slice(0, start)].reverse().find((step): step is Extract<Step, { kind: 'goto' }> => step.kind === 'goto');
    const parked = spot ? spot.spot : actor.rest;
    actor.x = parked.px.x;
    actor.y = parked.px.y;
    actor.dir = parked.dir;
    actor.stepIndex = world.reducedMotion ? Math.max(endless, 0) : start;
    if (world.reducedMotion && endless < 0) {
      actor.steps = [{ kind: 'act', pose: actor.behaviour.pose, seconds: Infinity, bubble: actor.behaviour.errand === 'deliver' ? 'paper' : actor.behaviour.bubble, dir: parked.dir }];
      actor.stepIndex = 0;
    }
  } else {
    actor.stepIndex = 0;
  }
  enter(world, actor);
}

function enter(world: World, actor: Actor): void {
  const step = actor.steps.at(actor.stepIndex);
  if (!step) return;
  if (step.kind === 'repeat') {
    actor.stepIndex = step.from;
    enter(world, actor);
    return;
  }
  if (step.kind === 'act') {
    actor.pose = step.pose;
    actor.bubble = step.bubble;
    actor.timer = step.seconds;
    actor.carry = null;
    actor.clock = 0;
    if (step.dir) actor.dir = step.dir;
    return;
  }
  const { layout } = world;
  const route = findPath(layout.walkable, layout.cols, tileOf(actor.x, actor.y), step.spot.tile);
  const lane = (seedOf(actor.id) % 5) - 2;
  actor.waypoints = [
    ...(route ?? []).slice(1, -1).map((tile) => ({ x: tile.x * TILE + TILE / 2 + lane, y: tile.y * TILE + TILE - 3 + lane })),
    ...(route && route.length > 1 ? [{ x: route[route.length - 1].x * TILE + TILE / 2, y: route[route.length - 1].y * TILE + TILE - 3 }] : []),
    step.spot.px,
  ];
  if (!route) actor.waypoints = [];
  if (!route) {
    actor.x = step.spot.px.x;
    actor.y = step.spot.px.y;
  }
  actor.pose = 'walk';
  actor.bubble = null;
  actor.carry = step.carry;
  actor.clock = 0;
}

function advance(world: World, actor: Actor): void {
  actor.stepIndex += 1;
  enter(world, actor);
}

/** Adds, updates and removes people so the office matches the fleet. Unchanged people keep walking. */
export function syncWorld(world: World, inputs: readonly ActorInput[]): void {
  world.inputs = inputs;
  const seen = new Set<string>();
  const ordered = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  const idlers = ordered.filter((input) => behaviourFor(input.state).rest === 'routine')
    .map((input) => ({ id: input.id, desk: input.desk, sleepy: input.sleepy === true }));
  const routine = scheduleRoutine(world.layout, idlers, world.time);
  for (const input of ordered) {
    seen.add(input.id);
    const behaviour = behaviourFor(input.state);
    const errand = routine.get(input.id);
    const rest = errand?.spot ?? world.layout.desks[input.desk].seat;
    const activity = errand?.activity ?? null;
    const delegateDesk = input.delegateDesk ?? null;
    const existing = world.actors.get(input.id);
    if (existing?.state === input.state && existing.behaviour === behaviour && existing.desk === input.desk
      && existing.delegateDesk === delegateDesk && existing.activity === activity && sameSpot(existing.rest, rest)) continue;
    if (existing) {
      Object.assign(existing, { state: input.state, behaviour, desk: input.desk, delegateDesk, rest, activity });
      begin(world, existing, false);
      continue;
    }
    const actor: Actor = {
      id: input.id, desk: input.desk, state: input.state, behaviour, delegateDesk, activity,
      x: 0, y: 0, dir: 'down', pose: 'stand', bubble: null, carry: null,
      clock: 0, walked: 0, waypoints: [], steps: [], stepIndex: 0, timer: 0, rest,
      random: seededRandom(seedOf(input.id)),
    };
    world.actors.set(input.id, actor);
    begin(world, actor, true);
  }
  for (const id of [...world.actors.keys()]) if (!seen.has(id)) world.actors.delete(id);
}

export function stepWorld(world: World, dt: number): void {
  const delta = Math.min(dt, 0.1);
  world.time += dt;
  if (!world.reducedMotion && world.time >= world.nextRoutine) {
    world.nextRoutine = world.time + 1;
    syncWorld(world, world.inputs);
  }
  for (const actor of world.actors.values()) {
    actor.clock += delta;
    if (world.reducedMotion) continue;
    const step = actor.steps.at(actor.stepIndex);
    if (!step) continue;
    if (step.kind === 'act') {
      actor.timer -= delta;
      if (actor.timer <= 0) advance(world, actor);
      continue;
    }
    if (step.kind !== 'goto') continue;
    let budget = WALK_SPEED * delta;
    while (budget > 0 && actor.waypoints.length > 0) {
      const next = actor.waypoints[0];
      const dx = next.x - actor.x;
      const dy = next.y - actor.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.01) actor.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (distance <= budget) {
        actor.x = next.x;
        actor.y = next.y;
        budget -= distance;
        actor.walked += distance;
        actor.waypoints.shift();
      } else {
        actor.x += (dx / distance) * budget;
        actor.y += (dy / distance) * budget;
        actor.walked += budget;
        budget = 0;
      }
    }
    if (actor.waypoints.length === 0) {
      actor.dir = step.spot.dir;
      advance(world, actor);
    }
  }
}
