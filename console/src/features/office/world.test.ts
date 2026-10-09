import { describe, expect, it } from 'vitest';
import { busPhase } from './bus';
import { lotCell } from './campus-lots';
import { SHARED_IDS } from './interior-shared';
import { CAMPUS } from './level';
import { createWorld, emote, setMap, stepWorld, syncWorld, type Actor, type ActorInput, type World } from './simulation';
import type { TubeEvent } from './tubes';
import { buildWorldMap, groupLevelId } from './world-map';

const plan = (count: number) => ({
  groups: Array.from({ length: count }, (_, index) => ({ id: `grp.${String(index)}`, label: `g${String(index)}`, hue: index * 50, seats: 4, cell: lotCell(index) })),
  beds: 4,
  pods: 3,
});
const map = buildWorldMap(plan(2));
const A = groupLevelId('grp.0');
const B = groupLevelId('grp.1');
const worker = (id: string, home: string, desk: number, state: ActorInput['state'] = 'thinking', extra: Partial<ActorInput> = {}): ActorInput => ({ id, state, home, desk, ...extra });
const must = (world: World, id: string): Actor => {
  const actor = world.actors.get(id);
  if (!actor) throw new Error(`no actor ${id}`);
  return actor;
};
const run = (world: World, seconds: number, each?: () => void) => {
  for (let t = 0; t < seconds; t += 0.05) {
    stepWorld(world, 0.05);
    each?.();
  }
};
const levelsVisited = (world: World, id: string, seconds: number): string[] => {
  const seen: string[] = [must(world, id).level];
  run(world, seconds, () => {
    const level = world.actors.get(id)?.level;
    if (level && level !== seen.at(-1)) seen.push(level);
  });
  return seen;
};
const deskOf = (level: string, desk: number) => {
  const slot = map.levels.get(level)?.desks[desk];
  if (!slot) throw new Error('no desk');
  return slot.seat.px;
};

describe('where everyone is', () => {
  it('places the fleet straight where it belongs on the first sync: desks, routine, workshop, reception', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [
      worker('t/a', A, 0), worker('t/b', A, 1, 'idle'), worker('t/c', B, 0, 'down'),
      { id: 'v/dots', state: 'idle', home: SHARED_IDS.lobby, desk: -1, visitor: true, wait: 0 },
    ]);
    const a = must(world, 't/a');
    expect([a.level, a.x, a.y, a.pose]).toEqual([A, deskOf(A, 0).x, deskOf(A, 0).y, 'type']);
    const b = must(world, 't/b');
    expect(b.activity).not.toBeNull();
    expect([SHARED_IDS.cafe, SHARED_IDS.park, SHARED_IDS.dorm]).toContain(b.level);
    const c = must(world, 't/c');
    expect([c.level, c.pose, c.rest.rest]).toEqual([SHARED_IDS.shop, 'lie', 'pod']);
    const dots = must(world, 'v/dots');
    expect(dots.level).toBe(SHARED_IDS.lobby);
    expect(dots.rest).toBe(map.levels.get(SHARED_IDS.lobby)?.waiting[0]);
  });

  it('only lets the long idle sleep, in the residence, a few at a time', () => {
    const many = Array.from({ length: 12 }, (_, index) => worker(`t/z${String(index).padStart(2, '0')}`, A, index % 4, 'idle', { sleepy: true }));
    for (const now of [0, 400, 9_000, 77_777]) {
      const world = createWorld(map, true, now);
      syncWorld(world, many);
      const sleepers = [...world.actors.values()].filter((actor) => actor.pose === 'lie');
      expect(sleepers.length).toBeLessThanOrEqual(3);
      for (const sleeper of sleepers) expect([sleeper.level, sleeper.rest.rest]).toEqual([SHARED_IDS.dorm, 'bed']);
    }
  });
});

describe('moving between buildings', () => {
  it('walks out through the door, across the campus and into the café or the park when the work ends', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    syncWorld(world, [worker('t/a', A, 0, 'idle')]);
    const visited = levelsVisited(world, 't/a', 120);
    expect(visited.slice(0, 2)).toEqual([A, CAMPUS]);
    expect([SHARED_IDS.cafe, SHARED_IDS.park, SHARED_IDS.dorm]).toContain(visited[2]);
  });

  it('walks to the new group house when the agent changes group, and sits at its new desk', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    syncWorld(world, [worker('t/a', B, 2)]);
    expect(levelsVisited(world, 't/a', 120)).toEqual([A, CAMPUS, B]);
    const a = must(world, 't/a');
    expect([a.x, a.y, a.pose]).toEqual([deskOf(B, 2).x, deskOf(B, 2).y, 'type']);
  });

  it('sends the down to the workshop and walks them back once they recover', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    syncWorld(world, [worker('t/a', A, 0, 'down')]);
    expect(levelsVisited(world, 't/a', 120)).toEqual([A, CAMPUS, SHARED_IDS.shop]);
    expect(must(world, 't/a').pose).toBe('lie');
    syncWorld(world, [worker('t/a', A, 0)]);
    expect(levelsVisited(world, 't/a', 120)).toEqual([SHARED_IDS.shop, CAMPUS, A]);
    expect(must(world, 't/a').pose).toBe('type');
  });

  it('brings newcomers by bus and sends leavers off on it', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    syncWorld(world, [worker('t/a', A, 0), worker('t/n', B, 1)]);
    const newcomer = must(world, 't/n');
    expect([newcomer.level, newcomer.pose]).toEqual([CAMPUS, 'hidden']);
    expect(busPhase(world.bus, world.time)).not.toBeNull();
    run(world, 3);
    expect(newcomer.pose).toBe('walk');
    run(world, 120);
    expect([newcomer.level, newcomer.pose]).toEqual([B, 'type']);

    syncWorld(world, [worker('t/a', A, 0)]);
    expect(must(world, 't/n').leaving).toBe(true);
    run(world, 150);
    expect(world.actors.has('t/n')).toBe(false);
    expect(world.actors.has('t/a')).toBe(true);
  });
});

describe('pneumatic tubes', () => {
  it('carries a delegation to another building in a capsule that the receiver gets up to fetch', () => {
    const world = createWorld(map, false, 5_000);
    const events: TubeEvent[] = [];
    world.line.listener = (event) => { events.push(event); };
    syncWorld(world, [worker('t/a', A, 0), worker('t/b', B, 1)]);
    syncWorld(world, [worker('t/a', A, 0, 'delegating', { sends: [{ to: 't/b', id: 'd1' }] }), worker('t/b', B, 1)]);
    const a = must(world, 't/a');
    const b = must(world, 't/b');
    const station = (level: string) => map.levels.get(level)?.station?.px;
    let posted = false;
    let flying = false;
    let fetched = false;
    run(world, 90, () => {
      posted ||= a.level === A && a.pose === 'handover' && a.x === station(A)?.x && a.y === station(A)?.y;
      flying ||= world.line.capsules.some((capsule) => capsule.phase === 'flying' && capsule.at > 0 && capsule.fromLevel === A && capsule.toLevel === B);
      fetched ||= b.level === B && b.pose === 'handover' && b.bubble === 'mail' && b.x === station(B)?.x;
    });
    expect(posted).toBe(true);
    expect(flying).toBe(true);
    expect(fetched).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['sent', 'arrived', 'collected']);
    expect(events.every((event) => event.id === 'd1' && event.by === 'tube')).toBe(true);
    expect(world.line.dings.has(B)).toBe(true);
    expect(world.line.capsules).toHaveLength(0);
    expect([b.x, b.y, b.pose]).toEqual([deskOf(B, 1).x, deskOf(B, 1).y, 'type']);
    expect([a.x, a.y]).toEqual([deskOf(A, 0).x, deskOf(A, 0).y]);
  });

  it('never sends the same delivery twice, and hands it over on paper inside one building', () => {
    const world = createWorld(map, false, 5_000);
    const events: TubeEvent[] = [];
    world.line.listener = (event) => { events.push(event); };
    syncWorld(world, [worker('t/a', A, 0), worker('t/c', A, 3)]);
    const inputs = [worker('t/a', A, 0, 'delegating', { sends: [{ to: 't/c', id: 'p1' }] }), worker('t/c', A, 3)];
    syncWorld(world, inputs);
    syncWorld(world, inputs);
    const a = must(world, 't/a');
    let carried = false;
    run(world, 40, () => { carried ||= a.carry === 'paper'; });
    expect(carried).toBe(true);
    expect(events).toEqual([expect.objectContaining({ id: 'p1', kind: 'handed', by: 'hand' })]);
    expect(world.line.capsules).toHaveLength(0);
  });

  it('keeps the capsule in the tray while the receiver is down, and they fetch it when back', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0), worker('t/b', B, 1, 'down')]);
    syncWorld(world, [worker('t/a', A, 0, 'delegating', { sends: [{ to: 't/b', id: 'd2' }] }), worker('t/b', B, 1, 'down')]);
    run(world, 60);
    expect(world.line.capsules.map((capsule) => capsule.phase)).toEqual(['waiting']);
    syncWorld(world, [worker('t/a', A, 0), worker('t/b', B, 1)]);
    run(world, 150);
    expect(world.line.capsules).toHaveLength(0);
  });

  it('without motion nobody walks and every delivery lands and is collected at once', () => {
    const world = createWorld(map, true, 5_000);
    const events: TubeEvent[] = [];
    world.line.listener = (event) => { events.push(event); };
    syncWorld(world, [worker('t/a', A, 0, 'delegating', { sends: [{ to: 't/b', id: 'd3' }] }), worker('t/b', B, 1)]);
    const before = [...world.actors.values()].map((actor) => [actor.level, actor.x, actor.y, actor.pose]);
    run(world, 10);
    expect([...world.actors.values()].map((actor) => [actor.level, actor.x, actor.y, actor.pose])).toEqual(before);
    expect(events.map((event) => event.kind)).toEqual(['sent', 'arrived', 'collected']);
  });
});

describe('small reactions and a growing campus', () => {
  it('shows an emote over the head for a moment', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    emote(world, 't/a', 'wave');
    expect(must(world, 't/a').emote?.icon).toBe('wave');
    run(world, 4);
    expect(must(world, 't/a').emote).toBeNull();
  });

  it('slides the people outside along with the campus when it grows, and keeps those inside where they are', () => {
    const world = createWorld(map, false, 5_000);
    syncWorld(world, [worker('t/a', A, 0)]);
    syncWorld(world, [worker('t/a', B, 0)]);
    run(world, 200, () => undefined);
    syncWorld(world, [worker('t/a', A, 1)]);
    const a = must(world, 't/a');
    for (let t = 0; t < 600 && a.level !== CAMPUS; t += 1) stepWorld(world, 0.05);
    run(world, 1);
    expect(a.level).toBe(CAMPUS);
    const relative = { x: a.x - map.campus.plaza.x * 16, y: a.y - map.campus.plaza.y * 16 };
    const bigger = buildWorldMap(plan(14), map);
    setMap(world, bigger);
    expect(a.x - bigger.campus.plaza.x * 16).toBeCloseTo(relative.x, 6);
    expect(a.y - bigger.campus.plaza.y * 16).toBeCloseTo(relative.y, 6);
    expect(bigger.levels.get(A)).toBe(map.levels.get(A));
    run(world, 200);
    expect([a.level, a.x, a.y]).toEqual([A, deskOf(A, 1).x, deskOf(A, 1).y]);
  });
});
