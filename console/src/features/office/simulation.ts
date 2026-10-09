import type { LiveState } from '../live/agent-state';
import { behaviourFor, type Behaviour, type BubbleKind, type Pose } from './behaviour';
import { callBus, createBus, type Bus } from './bus';
import { assignSlots } from './capacity';
import { SHARED_IDS } from './interior-shared';
import { CAMPUS, type Activity, type Dir, type Level, type Point, type Spot } from './level';
import { seedOf, seededRandom } from './random';
import { scheduleRoutine, turnOf, type Errand as RoutineErrand, type Place } from './routine';
import type { IconName } from './sprites';
import { legsTo, waypointsTo, type Leg } from './travel';
import { collect, createLine, emit, launch, stepCapsules, waitingFor, type TubeLine } from './tubes';
import type { WorldMap } from './world-map';

export { seedOf, seededRandom } from './random';

/** Walking speed in art pixels per second. */
export const WALK_SPEED = 34;
/** Seconds a newcomer stays on the bus while it pulls in. */
const ARRIVAL_S = 2.4;
/** Seconds between capsules that were already in flight when the campus opened. */
const STAGGER_S = 1.3;
const EMOTE_S = 3;
/** Delivery ids remembered; past this the least recently listed are forgotten. */
export const SEEN_LIMIT = 4096;

export interface Send { to: string; id: string }

export interface ActorInput {
  id: string;
  state: LiveState;
  /** Idle long enough that a nap in the residence is on the cards. */
  sleepy?: boolean;
  /** Level id of the building the agent works in. */
  home: string;
  /** Desk index inside `home`; visitors have none (-1). */
  desk: number;
  /** A declared MCP client: waits at reception instead of taking a desk or a bed. */
  visitor?: boolean;
  wait?: number;
  /** Deliveries this agent handed to others, with their ids, so each one travels once. */
  sends?: readonly Send[];
}

export type Carry = 'paper' | 'box' | 'capsule' | null;
export type Errand = { kind: 'post'; send: Send; toLevel: string } | { kind: 'hand'; send: Send };
type Duty = 'desk' | 'help' | 'repair' | 'visit' | 'routine';

export type Step =
  | { kind: 'goto'; place: Place; carry: Carry }
  | { kind: 'act'; pose: Pose; seconds: number; bubble: BubbleKind; dir?: Dir; bus?: boolean }
  | { kind: 'repeat'; from: number }
  | { kind: 'exit' }
  | { kind: 'post' }
  | { kind: 'hand' }
  | { kind: 'collect' }
  | { kind: 'done'; shift: boolean };

export interface Actor {
  id: string;
  home: string;
  desk: number;
  visitor: boolean;
  leaving: boolean;
  state: LiveState;
  behaviour: Behaviour;
  activity: Activity | null;
  duty: Duty;
  level: string;
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
  legs: Leg[];
  waypoints: Point[];
  steps: Step[];
  stepIndex: number;
  timer: number;
  rest: Spot;
  restLevel: string;
  random: () => number;
  errands: Errand[];
  emote: { icon: IconName; until: number } | null;
  /** World time until which the person still holds a capsule they just collected. */
  holding: number;
}

export interface World {
  map: WorldMap;
  actors: Map<string, Actor>;
  reducedMotion: boolean;
  /** Wall-clock seconds, so the routine is the same on every screen. */
  time: number;
  inputs: readonly ActorInput[];
  nextRoutine: number;
  /** After the first populated sync, arrivals come by bus instead of appearing in place. */
  populated: boolean;
  /** Deliveries already sent on their way, so a resync never sends one twice; most recently listed last. */
  seen: Set<string>;
  line: TubeLine;
  bus: Bus;
  pods: ReadonlyMap<string, number>;
}

export function createWorld(map: WorldMap, reducedMotion = false, now = Date.now() / 1000, seen = new Set<string>()): World {
  const world: World = {
    map, actors: new Map(), reducedMotion, time: now, inputs: [], nextRoutine: now + 1, populated: false,
    seen, line: createLine(), bus: createBus(), pods: new Map(),
  };
  world.line.landed = (capsule) => { fetch(world, capsule.to); };
  return world;
}

const POSE: Readonly<Record<Activity, Pose>> = {
  cook: 'cook', eat: 'eat', coffee: 'coffee', play: 'play', tidy: 'tidy', sweep: 'sweep', water: 'water', read: 'read',
  chat: 'chat', stroll: 'stand', sleep: 'lie',
};

const between = (random: () => number, low: number, high: number) => low + random() * (high - low);
const canWalk = (world: World, actor: Actor) => !world.reducedMotion && !actor.leaving && !actor.visitor && actor.state !== 'down';

function withOffset(steps: Step[], offset: number): Step[] {
  return offset === 0 ? steps : steps.map((step) => (step.kind === 'repeat' ? { ...step, from: step.from + offset } : step));
}

function deskPlace(world: World, home: string, desk: number): Place | null {
  const level = world.map.levels.get(home);
  const slot = level?.desks[desk] ?? level?.desks.at(desk % Math.max(1, level.desks.length));
  return level && slot ? { level: home, spot: slot.seat } : null;
}

/** The errand steps that come before the person's usual plan: post a capsule, hand paper over, collect what arrived. */
function errandSteps(world: World, actor: Actor): Step[] {
  if (!canWalk(world, actor)) return [];
  const goto = (place: Place, carry: Carry = null): Step => ({ kind: 'goto', place, carry });
  const home = world.map.levels.get(actor.home);
  const errand = actor.errands.at(0);
  if (errand?.kind === 'post') {
    if (home?.station) {
      return [goto({ level: actor.home, spot: home.station }, 'capsule'), { kind: 'act', pose: 'handover', seconds: 1.2, bubble: 'paper', dir: 'up' }, { kind: 'post' }, { kind: 'done', shift: true }];
    }
    flush(world, actor);
    return errandSteps(world, actor);
  }
  if (errand?.kind === 'hand') {
    const target = world.actors.get(errand.send.to);
    const slot = target ? world.map.levels.get(target.home)?.desks[target.desk] : undefined;
    if (target && slot && target.home === actor.home) {
      return [goto({ level: target.home, spot: slot.visit }, 'paper'), { kind: 'act', pose: 'handover', seconds: 1.6, bubble: 'paper', dir: slot.visit.dir }, { kind: 'hand' }, { kind: 'done', shift: true }];
    }
    flush(world, actor);
    return errandSteps(world, actor);
  }
  if (home?.station && waitingFor(world.line, actor.id, actor.home)) {
    return [goto({ level: actor.home, spot: home.station }), { kind: 'act', pose: 'handover', seconds: 1.2, bubble: 'mail', dir: 'up' }, { kind: 'collect' }, { kind: 'done', shift: false }];
  }
  return [];
}

/** Errands that can no longer be walked are done on the spot: the capsule leaves from the station by itself. */
function flush(world: World, actor: Actor): void {
  for (const errand of actor.errands) {
    if (errand.kind === 'post') {
      launch(world.line, world.map, { ...errand.send, from: actor.id, fromLevel: actor.home, toLevel: errand.toLevel }, 0, world.reducedMotion, world.time);
    } else {
      emit(world.line, { id: errand.send.id, from: actor.id, to: errand.send.to, kind: 'handed', by: 'hand' });
    }
  }
  actor.errands = [];
}

/** The script a person follows for their state, ending in an endless act or a loop; errands go first. */
export function planFor(actor: Actor, world: World): Step[] {
  const errands = errandSteps(world, actor);
  const place: Place = { level: actor.restLevel, spot: actor.rest };
  const spot = actor.rest;
  const back = spot.from ?? spot;
  const goto = (target: Spot, carry: Carry = null): Step => ({ kind: 'goto', place: { level: actor.restLevel, spot: target }, carry });
  const act = (pose: Pose, seconds: number, dir?: Dir, bubble: BubbleKind = null): Step => ({ kind: 'act', pose, seconds, bubble, dir });
  let base: Step[];
  switch (actor.activity) {
    case null: {
      const pose = actor.duty === 'visit' || actor.duty === 'help' ? (spot.seated ? 'sit' : 'stand') : actor.behaviour.pose;
      const bubble = actor.duty === 'help' ? 'alert' : actor.duty === 'visit' ? null : actor.behaviour.bubble;
      base = [{ kind: 'goto', place, carry: null }, act(pose, Infinity, spot.dir, bubble)];
      break;
    }
    case 'tidy':
      base = [goto(back), act('stand', 1.2, back.dir), goto(spot, 'box'), act('tidy', 1.6, spot.dir), { kind: 'repeat', from: 0 }];
      break;
    case 'sweep':
      base = [goto(spot), act('sweep', between(actor.random, 4, 7), spot.dir), goto(back), act('sweep', between(actor.random, 4, 7), back.dir), { kind: 'repeat', from: 0 }];
      break;
    case 'stroll': {
      const lawn = world.map.pools.spots.stroll.filter((other) => other.level === actor.restLevel);
      const pick = () => lawn[Math.floor(actor.random() * lawn.length)]?.spot ?? spot;
      base = [spot, pick(), pick()].flatMap((stop) => [goto(stop), act('stand', between(actor.random, 1.5, 4), 'down')]);
      base.push({ kind: 'repeat', from: 0 });
      break;
    }
    default:
      base = [goto(spot), act(POSE[actor.activity], Infinity, spot.dir, actor.activity === 'chat' ? 'chat' : actor.activity === 'sleep' ? 'zzz' : null)];
  }
  return [...errands, ...withOffset(base, errands.length)];
}

function enter(world: World, actor: Actor): void {
  const step = actor.steps.at(actor.stepIndex);
  if (!step) return;
  switch (step.kind) {
    case 'repeat':
      actor.stepIndex = step.from;
      enter(world, actor);
      return;
    case 'exit':
      world.actors.delete(actor.id);
      return;
    case 'post': {
      const errand = actor.errands.at(0);
      if (errand?.kind === 'post') launch(world.line, world.map, { ...errand.send, from: actor.id, fromLevel: actor.home, toLevel: errand.toLevel }, 0, false, world.time);
      advance(world, actor);
      return;
    }
    case 'hand': {
      const errand = actor.errands.at(0);
      if (errand?.kind === 'hand') {
        emit(world.line, { id: errand.send.id, from: actor.id, to: errand.send.to, kind: 'handed', by: 'hand' });
        const target = world.actors.get(errand.send.to);
        if (target) target.emote = { icon: 'mail', until: world.time + EMOTE_S };
      }
      advance(world, actor);
      return;
    }
    case 'collect':
      if (collect(world.line, actor.id, actor.home) > 0) actor.holding = world.time + 6;
      advance(world, actor);
      return;
    case 'done':
      if (step.shift) actor.errands.shift();
      begin(world, actor, false);
      return;
    case 'act':
      actor.pose = step.pose;
      actor.bubble = step.bubble;
      actor.timer = step.seconds;
      actor.carry = null;
      actor.clock = 0;
      if (step.dir) actor.dir = step.dir;
      if (step.bus) callBus(world.bus, world.time, step.seconds + 0.6);
      return;
    case 'goto': {
      actor.legs = legsTo(world.map, actor.level, step.place) ?? [];
      actor.carry = step.carry;
      actor.pose = 'walk';
      actor.bubble = null;
      actor.clock = 0;
      if (actor.legs.length === 0) {
        place(actor, step.place);
        advance(world, actor);
        return;
      }
      startLeg(world, actor);
    }
  }
}

function place(actor: Actor, target: Place): void {
  actor.level = target.level;
  actor.x = target.spot.px.x;
  actor.y = target.spot.px.y;
  actor.dir = target.spot.dir;
  actor.waypoints = [];
  actor.legs = [];
}

function startLeg(world: World, actor: Actor): void {
  const leg = actor.legs.at(0);
  const level = leg ? world.map.levels.get(leg.level) : undefined;
  if (!leg || !level) return;
  const lane = (seedOf(actor.id) % 5) - 2;
  actor.waypoints = waypointsTo(level, actor.x, actor.y, leg.to, lane) ?? [{ x: leg.to.px.x, y: leg.to.px.y }];
}

function advance(world: World, actor: Actor): void {
  actor.stepIndex += 1;
  enter(world, actor);
}

/** Replans from where the person stands; `instant` puts them straight at the end of the plan. */
function begin(world: World, actor: Actor, instant: boolean): void {
  if (actor.errands.length > 0 && (instant || !canWalk(world, actor))) flush(world, actor);
  actor.steps = planFor(actor, world);
  actor.waypoints = [];
  actor.legs = [];
  actor.carry = null;
  if (instant || world.reducedMotion) {
    const endless = actor.steps.findIndex((step) => step.kind === 'act' && step.seconds === Infinity);
    const start = endless >= 0 ? endless : actor.steps.findIndex((step) => step.kind === 'act');
    const target = actor.steps.slice(0, start).reverse().find((step): step is Extract<Step, { kind: 'goto' }> => step.kind === 'goto');
    place(actor, target ? target.place : { level: actor.restLevel, spot: actor.rest });
    actor.stepIndex = world.reducedMotion ? Math.max(endless, 0) : Math.max(start, 0);
    if (world.reducedMotion && endless < 0) {
      actor.steps = [{ kind: 'act', pose: actor.activity ? POSE[actor.activity] : actor.behaviour.pose, seconds: Infinity, bubble: actor.behaviour.bubble, dir: actor.rest.dir }];
      actor.stepIndex = 0;
    }
  } else {
    actor.stepIndex = 0;
  }
  enter(world, actor);
}

interface Rest { place: Place; activity: Activity | null; duty: Duty }

function restOf(world: World, input: ActorInput, behaviour: Behaviour, routine: ReadonlyMap<string, RoutineErrand>, help: ReadonlyMap<string, Place>): Rest {
  const { levels, campus } = world.map;
  const fallback: Place = { level: CAMPUS, spot: campus.door };
  if (input.visitor) {
    const lobby = levels.get(SHARED_IDS.lobby);
    const spot = lobby?.waiting[(input.wait ?? 0) % Math.max(1, lobby.waiting.length)];
    return { place: lobby && spot ? { level: lobby.id, spot } : fallback, activity: null, duty: 'visit' };
  }
  if (behaviour.rest === 'shop') {
    const shop = levels.get(SHARED_IDS.shop);
    const pod = shop?.repair[(world.pods.get(input.id) ?? 0) % Math.max(1, shop.repair.length)];
    return { place: shop && pod ? { level: shop.id, spot: pod } : fallback, activity: null, duty: 'repair' };
  }
  const helped = help.get(input.id);
  if (helped) return { place: helped, activity: null, duty: 'help' };
  if (behaviour.rest === 'routine') {
    const errand = routine.get(input.id);
    if (errand) return { place: errand.place, activity: errand.activity, duty: 'routine' };
  }
  return { place: deskPlace(world, input.home, input.desk) ?? fallback, activity: null, duty: 'desk' };
}

/** A third of their turns, the blocked go and wait at the help desk while it has room. */
function helpDesk(world: World, blocked: readonly string[]): Map<string, Place> {
  const shop = world.map.levels.get(SHARED_IDS.shop);
  const out = new Map<string, Place>();
  if (!shop) return out;
  const ordered = blocked.map((id) => ({ id, turn: turnOf(`${id}#ayuda`, world.time) })).sort((a, b) => a.turn.start - b.turn.start || a.id.localeCompare(b.id));
  for (const { id, turn } of ordered) {
    if (turn.index % 3 !== 2 || out.size >= shop.help.length) continue;
    out.set(id, { level: shop.id, spot: shop.help[out.size] });
  }
  return out;
}

function leave(world: World, actor: Actor): void {
  if (world.reducedMotion || actor.state === 'down') {
    world.actors.delete(actor.id);
    return;
  }
  Object.assign(actor, { leaving: true, errands: [], activity: null });
  const stop: Place = { level: CAMPUS, spot: world.map.campus.stop };
  actor.steps = [{ kind: 'goto', place: stop, carry: null }, { kind: 'act', pose: 'stand', seconds: 2.4, bubble: null, dir: 'left', bus: true }, { kind: 'exit' }];
  actor.stepIndex = 0;
  enter(world, actor);
}

const samePlace = (a: Actor, rest: Rest) => a.restLevel === rest.place.level && a.rest.px.x === rest.place.spot.px.x && a.rest.px.y === rest.place.spot.px.y;

/** Adds, updates and removes people so the campus matches the fleet. Unchanged people keep walking. */
export function syncWorld(world: World, inputs: readonly ActorInput[]): void {
  world.inputs = inputs;
  const ordered = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  const idlers = ordered.filter((input) => !input.visitor && behaviourFor(input.state).rest === 'routine')
    .map((input) => ({ id: input.id, sleepy: input.sleepy === true }));
  const routine = scheduleRoutine(world.map.pools, idlers, world.time);
  const help = helpDesk(world, ordered.filter((input) => !input.visitor && input.state === 'blocked').map((input) => input.id));
  const shop = world.map.levels.get(SHARED_IDS.shop);
  world.pods = assignSlots(world.pods, ordered.filter((input) => !input.visitor && input.state === 'down').map((input) => input.id), shop?.repair.length);
  const arriving = world.populated && !world.reducedMotion;
  const seen = new Set<string>();
  for (const input of ordered) {
    seen.add(input.id);
    const visitor = input.visitor === true;
    const behaviour = behaviourFor(visitor && input.state !== 'down' ? 'idle' : input.state);
    const rest = restOf(world, input, behaviour, routine, help);
    const existing = world.actors.get(input.id);
    if (existing && !existing.leaving && existing.state === input.state && existing.behaviour === behaviour && existing.home === input.home
      && existing.desk === input.desk && existing.activity === rest.activity && existing.duty === rest.duty && samePlace(existing, rest)) continue;
    const fields = {
      state: input.state, behaviour, home: input.home, desk: input.desk, visitor, leaving: false,
      rest: rest.place.spot, restLevel: rest.place.level, activity: rest.activity, duty: rest.duty,
    };
    if (existing) {
      Object.assign(existing, fields);
      begin(world, existing, false);
      continue;
    }
    const actor: Actor = {
      id: input.id, ...fields, level: CAMPUS, x: 0, y: 0, dir: 'down', pose: 'stand', bubble: null, carry: null,
      clock: 0, walked: 0, legs: [], waypoints: [], steps: [], stepIndex: 0, timer: 0,
      random: seededRandom(seedOf(input.id)), errands: [], emote: null, holding: 0,
    };
    world.actors.set(input.id, actor);
    if (arriving) {
      place(actor, { level: CAMPUS, spot: world.map.campus.stop });
      actor.steps = [{ kind: 'act', pose: 'hidden', seconds: ARRIVAL_S, bubble: null, bus: true }, ...withOffset(planFor(actor, world), 1)];
      actor.stepIndex = 0;
      enter(world, actor);
    } else {
      begin(world, actor, true);
    }
  }
  for (const actor of [...world.actors.values()]) if (!seen.has(actor.id) && !actor.leaving) leave(world, actor);
  dispatch(world, ordered);
  if (inputs.length > 0) world.populated = true;
}

/**
 * Marks a delivery as listed now; true the first time. Ids still listed move to the back, so the
 * bound only forgets deliveries the fleet stopped reporting.
 */
export function remember(seen: Set<string>, id: string): boolean {
  const known = seen.delete(id);
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  return !known;
}

/** Sends every delivery not seen before: by hand inside a building, by tube between buildings. */
function dispatch(world: World, inputs: readonly ActorInput[]): void {
  const animated = world.populated && !world.reducedMotion;
  let stagger = 0;
  for (const input of inputs) {
    for (const send of input.sends ?? []) {
      if (!remember(world.seen, send.id)) continue;
      const sender = world.actors.get(input.id);
      const receiver = world.actors.get(send.to);
      if (!sender || !receiver || receiver.visitor || sender.visitor) continue;
      if (receiver.home === sender.home) {
        if (animated && canWalk(world, sender)) queue(world, sender, { kind: 'hand', send });
        else emit(world.line, { id: send.id, from: sender.id, to: receiver.id, kind: 'handed', by: 'hand' });
      } else if (animated && canWalk(world, sender)) {
        queue(world, sender, { kind: 'post', send, toLevel: receiver.home });
      } else {
        launch(world.line, world.map, { ...send, from: sender.id, fromLevel: sender.home, toLevel: receiver.home }, stagger, world.reducedMotion, world.time);
        stagger += STAGGER_S;
        if (world.reducedMotion) collect(world.line, receiver.id, receiver.home);
      }
    }
  }
}

function queue(world: World, actor: Actor, errand: Errand): void {
  const busy = actor.errands.length > 0;
  actor.errands.push(errand);
  if (!busy) begin(world, actor, false);
}

/** Sends whoever just got a capsule to fetch it, unless they are already on their way. */
function fetch(world: World, recipient: string): void {
  const actor = world.actors.get(recipient);
  if (!actor || !canWalk(world, actor)) return;
  if (actor.steps.slice(actor.stepIndex).some((step) => step.kind === 'collect' || step.kind === 'post' || step.kind === 'hand')) return;
  begin(world, actor, false);
}

export function stepWorld(world: World, dt: number): void {
  const delta = Math.min(dt, 0.1);
  world.time += dt;
  if (!world.reducedMotion && world.time >= world.nextRoutine) {
    world.nextRoutine = world.time + 1;
    syncWorld(world, world.inputs);
  }
  stepCapsules(world.line, delta, world.time);
  for (const actor of world.actors.values()) {
    actor.clock += delta;
    if (actor.emote && actor.emote.until < world.time) actor.emote = null;
    if (world.reducedMotion) continue;
    const step = actor.steps.at(actor.stepIndex);
    if (!step) continue;
    if (step.kind === 'act') {
      actor.timer -= delta;
      if (actor.timer <= 0) advance(world, actor);
      continue;
    }
    if (step.kind !== 'goto') continue;
    walk(actor, delta);
    if (actor.waypoints.length > 0) continue;
    const leg = actor.legs.shift();
    if (leg?.hop) {
      actor.level = leg.hop.level;
      actor.x = leg.hop.at.px.x;
      actor.y = leg.hop.at.px.y;
      actor.dir = leg.hop.at.dir;
      if (actor.legs.length > 0) {
        startLeg(world, actor);
        continue;
      }
    }
    actor.dir = step.place.spot.dir;
    advance(world, actor);
  }
}

function walk(actor: Actor, delta: number): void {
  let budget = WALK_SPEED * (actor.state === 'down' ? 0.7 : 1) * delta;
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
}

/** A new map: people on the campus slide with it, everyone else replans from where they stand. */
export function setMap(world: World, map: WorldMap): void {
  const before = world.map;
  if (before === map) return;
  const dx = (map.campus.plaza.x - before.campus.plaza.x) * 16;
  const dy = (map.campus.plaza.y - before.campus.plaza.y) * 16;
  world.map = map;
  for (const capsule of world.line.capsules) capsule.route = capsule.route.map((point) => ({ x: point.x + dx, y: point.y + dy }));
  for (const actor of world.actors.values()) {
    if (actor.level === CAMPUS) {
      actor.x += dx;
      actor.y += dy;
    } else if (!map.levels.has(actor.level)) {
      place(actor, { level: CAMPUS, spot: map.campus.siteOf.get(actor.level)?.door ?? map.campus.door });
    }
  }
  syncWorld(world, world.inputs);
  for (const actor of world.actors.values()) {
    const level: Level | undefined = map.levels.get(actor.level);
    if (!actor.leaving && level !== before.levels.get(actor.level)) begin(world, actor, false);
  }
}

/** Someone reacts with an icon over their head for a moment: a wave back, a coffee, a little heart. */
export function emote(world: World, id: string, icon: IconName): void {
  const actor = world.actors.get(id);
  if (actor) actor.emote = { icon, until: world.time + EMOTE_S };
}
