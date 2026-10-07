import type { LiveState } from '../live/agent-state';
import { behaviourFor, type Behaviour, type BubbleKind, type Pose } from './behaviour';
import { TILE, type Dir, type OfficeLayout, type Point, type Spot } from './layout';
import { findPath } from './pathfinding';

/** Walking speed in art pixels per second. */
export const WALK_SPEED = 34;

export interface ActorInput {
  id: string;
  state: LiveState;
  desk: number;
  /** Desk index of the agent this one is handing work to, when delegating. */
  delegateDesk?: number | null;
}

type Step =
  | { kind: 'goto'; spot: Spot; carrying: boolean }
  | { kind: 'act'; pose: Pose; seconds: number; bubble: BubbleKind; dir?: Dir }
  | { kind: 'repeat'; from: number };

export interface Actor {
  id: string;
  desk: number;
  state: LiveState;
  behaviour: Behaviour;
  delegateDesk: number | null;
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
  bubble: BubbleKind;
  carrying: boolean;
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
}

export function seedOf(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
  return value >>> 0;
}

/** mulberry32: tiny, seedable, good enough to make each person stroll their own way. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorld(layout: OfficeLayout, reducedMotion = false): World {
  return { layout, actors: new Map(), reducedMotion };
}

const tileOf = (x: number, y: number): Point => ({ x: Math.floor(x / TILE), y: Math.floor((y - 1) / TILE) });

function between(random: () => number, low: number, high: number): number {
  return low + random() * (high - low);
}

function wanderSpot(layout: OfficeLayout, random: () => number): Spot {
  const tile = layout.wander[Math.floor(random() * layout.wander.length)] ?? layout.desks[0].visit.tile;
  return { tile, px: { x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 }, dir: 'down' };
}

/** The script a person follows for their current state, ending in an endless act or a loop. */
export function planFor(actor: Actor, layout: OfficeLayout): Step[] {
  const desk = layout.desks[actor.desk];
  const behaviour = actor.behaviour;
  const forever = (spot: Spot): Step => ({ kind: 'act', pose: behaviour.pose, seconds: Infinity, bubble: behaviour.bubble, dir: spot.dir });
  const goto = (spot: Spot, carrying = false): Step => ({ kind: 'goto', spot, carrying });

  if (behaviour.errand === 'deliver' && actor.delegateDesk !== null && layout.desks[actor.delegateDesk]) {
    const target = layout.desks[actor.delegateDesk].visit;
    return [
      goto(desk.seat),
      { kind: 'act', pose: 'type', seconds: between(actor.random, 2.5, 5), bubble: null, dir: desk.seat.dir },
      goto(target, true),
      { kind: 'act', pose: 'handover', seconds: 1.6, bubble: 'paper', dir: target.dir },
      goto(desk.seat),
      { kind: 'act', pose: 'type', seconds: between(actor.random, 4, 8), bubble: null, dir: desk.seat.dir },
      { kind: 'repeat', from: 2 },
    ];
  }
  if (behaviour.errand === 'wander') {
    return [
      goto(wanderSpot(layout, actor.random)),
      { kind: 'act', pose: 'stand', seconds: between(actor.random, 0.8, 2), bubble: null },
      goto(wanderSpot(layout, actor.random)),
      { kind: 'act', pose: 'stand', seconds: between(actor.random, 0.8, 2), bubble: null },
      goto(actor.rest),
      forever(actor.rest),
    ];
  }
  if (behaviour.errand === 'stretch') {
    return [
      { kind: 'act', pose: 'stretch', seconds: 1.8, bubble: null, dir: 'down' },
      goto(actor.rest),
      forever(actor.rest),
    ];
  }
  return [goto(actor.rest), forever(actor.rest)];
}

/** Where the state finally parks someone; idle people without a free sofa nap at their desk. */
function restSpot(world: World, actor: Pick<Actor, 'desk' | 'behaviour'>, rank: number): Spot {
  const desk = world.layout.desks[actor.desk].seat;
  if (actor.behaviour.rest === 'lounge') return world.layout.lounge[rank] ?? desk;
  if (actor.behaviour.rest === 'coffee') return world.layout.coffee[rank] ?? wanderSpot(world.layout, () => (rank * 0.37) % 1);
  return desk;
}

const sameSpot = (a: Spot, b: Spot) => a.px.x === b.px.x && a.px.y === b.px.y;

function sleepPose(world: World, actor: Actor): Pose {
  if (sameSpot(actor.rest, world.layout.desks[actor.desk].seat)) return 'nap';
  return actor.rest.rest === 'bed' || actor.rest.rest === 'sofa' ? 'lie' : 'sleep';
}

function begin(world: World, actor: Actor, instant: boolean): void {
  actor.steps = planFor(actor, world.layout);
  if (actor.behaviour.rest === 'lounge') {
    const pose = sleepPose(world, actor);
    actor.steps = actor.steps.map((step) => (step.kind === 'act' && step.seconds === Infinity ? { ...step, pose } : step));
  }
  actor.waypoints = [];
  actor.carrying = false;
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
    actor.carrying = false;
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
  actor.carrying = step.carrying;
  actor.clock = 0;
}

function advance(world: World, actor: Actor): void {
  actor.stepIndex += 1;
  enter(world, actor);
}

/** Adds, updates and removes people so the office matches the fleet. Unchanged people keep walking. */
export function syncWorld(world: World, inputs: readonly ActorInput[]): void {
  const seen = new Set<string>();
  const rank = { lounge: 0, coffee: 0, desk: 0 };
  const ordered = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  for (const input of ordered) {
    seen.add(input.id);
    const behaviour = behaviourFor(input.state);
    const rest = restSpot(world, { desk: input.desk, behaviour }, rank[behaviour.rest]);
    rank[behaviour.rest] += 1;
    const delegateDesk = input.delegateDesk ?? null;
    const existing = world.actors.get(input.id);
    if (existing?.state === input.state && existing.desk === input.desk
      && existing.delegateDesk === delegateDesk && sameSpot(existing.rest, rest)) continue;
    if (existing) {
      Object.assign(existing, { state: input.state, behaviour, desk: input.desk, delegateDesk, rest });
      begin(world, existing, false);
      continue;
    }
    const actor: Actor = {
      id: input.id, desk: input.desk, state: input.state, behaviour, delegateDesk,
      x: 0, y: 0, dir: 'down', pose: 'stand', bubble: null, carrying: false,
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
