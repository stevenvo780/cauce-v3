import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pixelIconPath } from '../../components/pixel-icons/pixel-icon-cache';
import {
  NativePath2D, canvasContext, countColor, createRenderHarness, imageDigest, pixel, pixels, rgba,
} from '../../test/office-render-canvas';
import { worldToScreen } from './camera';
import { BUS_IN, callBus } from './bus';
import { lotCell } from './campus-lots';
import { SHARED_IDS } from './interior-shared';
import { CAMPUS, TILE } from './level';
import { OFFICE } from './palette';
import { SELECT } from './people';
import { teamTone } from './teams';
import { launch, stepCapsules, trayCount } from './tubes';
import { buildWorldMap, groupLevelId } from './world-map';

const roomId = groupLevelId('One/general');
const secondRoom = groupLevelId('Two/general');
const plan = {
  groups: [
    { id: 'One/general', label: 'One · General', hue: 30, seats: 4, cell: lotCell(0) },
    { id: 'Two/general', label: 'Two · General', hue: 220, seats: 12, cell: lotCell(1) },
  ],
  beds: 8,
  pods: 3,
};
const map = buildWorldMap(plan);
const worker = 'One/worker';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing render fixture');
  return value;
}

const room = required(map.levels.get(roomId));
const frontDesk = required(room.desks.find(desk => desk.facing === 'up'));

beforeAll(() => { vi.stubGlobal('Path2D', NativePath2D); });
afterAll(() => { vi.unstubAllGlobals(); });

describe('office render runtime', () => {
  it('renders the campus buildings and ground through a complete native frame', () => {
    const { game, canvas, render } = createRenderHarness({ map });
    render();
    expect(game.entries.some(entry => entry.site?.id === roomId)).toBe(true);
    expect(new Set(game.entries.flatMap(entry => entry.site ? [entry.site.id] : []))).toEqual(new Set(map.campus.siteOf.keys()));
    const scene = game.scenes.campus(map.campus, false);
    expect(countColor(scene.bg, OFFICE.grass)).toBeGreaterThan(100);
    expect(countColor(scene.art, OFFICE.roofEdge)).toBeGreaterThan(100);
    expect(pixel(canvas, 0, 0)[3]).toBe(255);
    expect(pixels(canvas).filter((_, index) => index % 4 === 3).every(alpha => alpha === 255)).toBe(true);
    const still = imageDigest(canvas);
    expect(imageDigest(render(30))).toBe(still);
  });

  it.each([
    [roomId, OFFICE.deskTop], [secondRoom, OFFICE.deskTop], [SHARED_IDS.cafe, OFFICE.counterFront],
    [SHARED_IDS.dorm, OFFICE.bedFrame], [SHARED_IDS.lobby, OFFICE.beanbag[1]],
    [SHARED_IDS.shop, OFFICE.podFrame], [SHARED_IDS.park, OFFICE.bench],
  ])('paints %s with its furniture, doorway and night lighting', (id, furnitureColor) => {
    const { game, canvas, render } = createRenderHarness({ map });
    game.go(id);
    render();
    const level = required(map.levels.get(id));
    const day = game.scenes.level(level, false);
    expect([day.art.width, day.art.height]).toEqual([level.cols * TILE, level.rows * TILE]);
    expect(countColor(day.art, furnitureColor)).toBeGreaterThan(0);
    expect(imageDigest(day.art)).not.toBe(imageDigest(day.bg));
    if (!level.outdoor) {
      const exitX = level.door.tile.x * TILE + 11;
      const exitY = (level.rows - 1) * TILE + 7;
      expect(pixel(day.bg, exitX, exitY)).toEqual(rgba(OFFICE.exit));
      expect(game.onExit(worldToScreen(game.cam, game.view, level.door.px))).toBe(true);
    } else {
      expect(countColor(day.art, OFFICE.water)).toBeGreaterThan(0);
      expect(game.extras.pet.visible).toBe(true);
    }
    const daylight = imageDigest(canvas);
    game.night = true;
    render();
    const night = game.scenes.level(level, true);
    expect(night).not.toBe(day);
    expect(imageDigest(canvas)).not.toBe(daylight);
    expect(game.scenes.level(level, true)).toBe(night);
    expect(game.scenes.glow).not.toBeNull();
  });

  it.each([
    ['thinking', '#1f2a3d'], ['receiving', '#1f2a3d'], ['delegating', '#1f2a3d'],
    ['blocked', OFFICE.screenAlert], ['idle', OFFICE.screenDim], ['down', OFFICE.screenOff],
  ] as const)('shows the %s owner and the corresponding desk screen', (state, screenColor) => {
    const { game, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state, home: roomId, desk: frontDesk.index }]);
    game.go(roomId);
    render();
    const scene = game.scenes.level(room, false);
    expect(scene.owners[frontDesk.index]?.id).toBe(worker);
    expect(pixel(scene.art, frontDesk.x * TILE + 14, frontDesk.deskY * TILE - 8)).toEqual(rgba(screenColor));
    if (state === 'down') expect(game.world.actors.get(worker)?.level).toBe(SHARED_IDS.shop);
    game.go(required(game.world.actors.get(worker)).level);
    render();
    expect(game.entries.some(entry => entry.actor?.id === worker)).toBe(true);
  });

  it('keeps actor picking and selection aligned with the pixels while zooming', () => {
    const { game, canvas, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: frontDesk.index }]);
    game.go(roomId);
    render();
    const initial = required(game.boxOf(worker));
    expect(game.pick({ x: (initial.left + initial.right) / 2, y: (initial.top + initial.bottom) / 2 })).toBe(worker);
    const neutral = imageDigest(canvas);
    game.props = { ...game.props, selected: worker, names: new Map([[worker, 'Worker']]) };
    render();
    expect(countColor(canvas, SELECT)).toBeGreaterThan(0);
    expect(imageDigest(canvas)).not.toBe(neutral);
    game.zoomTo(game.limits.max);
    game.tick(performance.now(), 0);
    render();
    const zoomed = required(game.boxOf(worker));
    expect(zoomed.right - zoomed.left).toBeGreaterThan(initial.right - initial.left);
    expect(game.pick({ x: (zoomed.left + zoomed.right) / 2, y: (zoomed.top + zoomed.bottom) / 2 })).toBe(worker);
    game.fit();
    game.tick(performance.now(), 0);
    render();
    expect(game.cam.zoom).toBe(game.limits.min);
    const fitted = required(game.boxOf(worker));
    expect(fitted.right - fitted.left).toBe(initial.right - initial.left);
  });

  it('draws the map switch behind a complete dither, then reveals the entered room', () => {
    const { game, canvas, events, render } = createRenderHarness({ map, reducedMotion: false });
    render();
    game.go(roomId);
    const start = required(game.switching).start * 1000;
    game.tick(start + 80, 0);
    render(0.08);
    expect(game.level).toBe(CAMPUS);
    expect(countColor(canvas, '#0e0f17')).toBeGreaterThan(canvas.width * canvas.height / 4);
    game.tick(start + 170, 0);
    render(0.17);
    expect(game.level).toBe(roomId);
    expect(countColor(canvas, '#0e0f17')).toBe(canvas.width * canvas.height);
    expect(events.level).toHaveBeenLastCalledWith(roomId);
    game.tick(start + 450, 0);
    render(0.45);
    expect(game.switching).toBeNull();
    expect(countColor(canvas, '#0e0f17')).toBeLessThan(canvas.width * canvas.height / 10);
  });

  it('opens a campus doorway only while an actor passes it', () => {
    const { game, render } = createRenderHarness({ map });
    const site = required(map.campus.siteOf.get(roomId));
    const x = site.door.tile.x * TILE + 4;
    const y = (site.y + site.h) * TILE - 10;
    render();
    const scene = game.scenes.campus(map.campus, false);
    const closed = pixel(scene.art, x, y);
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: 0 }]);
    const actor = required(game.world.actors.get(worker));
    Object.assign(actor, { level: CAMPUS, x: site.door.px.x + 9, y: site.door.px.y + 9, pose: 'stand' });
    render();
    expect(pixel(scene.art, x, y)).toEqual(rgba(OFFICE.slate));
    actor.x += TILE * 4;
    render();
    expect(pixel(scene.art, x, y)).toEqual(closed);
  });

  it('reuses unchanged scenes and sprites, then repaints only the changed room and facade', () => {
    const { game, render } = createRenderHarness({ map });
    render();
    const before = game.scenes.campus(map.campus, false);
    const changedSprite = game.scenes.site(before, required(map.campus.siteOf.get(roomId)));
    const keptSprite = game.scenes.site(before, required(map.campus.siteOf.get(secondRoom)));
    const keptRoom = game.scenes.level(required(map.levels.get(secondRoom)), false);
    const previousRoom = game.scenes.level(room, false);
    expect(game.scenes.campus(map.campus, false)).toBe(before);
    const updated = buildWorldMap({ ...plan, groups: [{ ...plan.groups[0], label: 'Renamed', hue: 130, seats: 16 }, plan.groups[1]] }, map);
    game.setMap(updated);
    render();
    const after = game.scenes.campus(updated.campus, false);
    const replacement = game.scenes.site(after, required(updated.campus.siteOf.get(roomId)));
    expect(after.bg).toBe(before.bg);
    expect(replacement).not.toBe(changedSprite);
    expect(imageDigest(replacement)).not.toBe(imageDigest(changedSprite));
    expect(game.scenes.site(after, required(updated.campus.siteOf.get(secondRoom)))).toBe(keptSprite);
    expect(game.scenes.level(required(updated.levels.get(secondRoom)), false)).toBe(keptRoom);
    const newRoom = game.scenes.level(required(updated.levels.get(roomId)), false);
    expect(newRoom).not.toBe(previousRoom);
    expect(newRoom.level.desks).toHaveLength(16);
    game.scenes.forget(roomId);
    const refreshed = game.scenes.level(required(updated.levels.get(roomId)), false);
    expect(refreshed).not.toBe(newRoom);
    expect(imageDigest(refreshed.bg)).toBe(imageDigest(newRoom.bg));
    game.go(roomId);
    game.setMap(buildWorldMap({ groups: [], beds: 8, pods: 3 }, updated));
    render();
    expect([game.level, game.avatarLevel]).toEqual([CAMPUS, CAMPUS]);
    expect(game.entries.some(entry => entry.site?.id === roomId)).toBe(false);
  });

  it('refreshes an agent appearance after a real lazy pixel icon arrives', async () => {
    expect(pixelIconPath('robot')).toBeUndefined();
    const { game, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: frontDesk.index }]);
    game.go(roomId);
    game.scenes.sprites.setLooks(new Map([[worker, { hue: 180, style: 'aurora', icon: 'robot' }]]));
    render();
    const scene = game.scenes.level(room, false);
    const monitor = { x: frontDesk.x * TILE + 14, y: frontDesk.deskY * TILE - 8, width: 12, height: 8 };
    const withoutIcon = imageDigest(scene.art, monitor);
    expect(game.scenes.sprites.screenMark(worker)).toBeNull();
    await vi.waitFor(() => { expect(pixelIconPath('robot')).toEqual(expect.any(String)); });
    render();
    expect(imageDigest(scene.art, monitor)).not.toBe(withoutIcon);
    const icon = required(game.scenes.sprites.screenMark(worker));
    expect([icon.width, icon.height]).toEqual([6, 6]);
    expect(pixels(icon).some((alpha, index) => index % 4 === 3 && alpha > 0)).toBe(true);
    expect(game.scenes.sprites.screenMark(worker)).toBe(icon);
  });

  it('draws an in-flight tube capsule and rings the destination tray after arrival', () => {
    const { game, events, render } = createRenderHarness({ map });
    render();
    const scene = game.scenes.campus(map.campus, false);
    const empty = imageDigest(scene.art);
    const capsule = launch(game.world.line, map, { id: 'delivery-1', from: worker, to: 'Two/worker', fromLevel: roomId, toLevel: secondRoom }, 0, false, game.world.time);
    stepCapsules(game.world.line, capsule.length / 380, game.world.time);
    render();
    expect(capsule.phase).toBe('flying');
    expect(imageDigest(scene.art)).not.toBe(empty);
    expect(events.tube).toHaveBeenCalledWith(expect.objectContaining({ id: 'delivery-1', kind: 'sent' }));
    stepCapsules(game.world.line, capsule.length / 190, game.world.time);
    expect(trayCount(game.world.line, secondRoom)).toBe(1);
    expect(events.tube).toHaveBeenCalledWith(expect.objectContaining({ id: 'delivery-1', kind: 'arrived' }));
    game.go(secondRoom);
    render();
    const destination = game.scenes.level(required(map.levels.get(secondRoom)), false);
    expect(countColor(destination.art, OFFICE.spark)).toBeGreaterThan(0);
    expect(canvasContext(destination.art).globalCompositeOperation).toBe('source-over');
  });

  it('renders speech and secondary-group dots above the selected actor', () => {
    const { game, canvas, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: frontDesk.index }]);
    game.go(roomId);
    game.props = { ...game.props, selected: worker, names: new Map([[worker, 'Worker']]) };
    render();
    const plain = imageDigest(canvas);
    game.props = { ...game.props, groups: new Map([[worker, { hues: [20, 140, 260], more: 2 }]]) };
    render();
    expect(imageDigest(canvas)).not.toBe(plain);
    for (const hue of [20, 140, 260]) expect(countColor(canvas, teamTone(hue, 70, 62))).toBeGreaterThan(0);
    const dots = imageDigest(canvas);
    const white = countColor(canvas, OFFICE.bubble);
    game.props = { ...game.props, speech: new Map([[worker, { kind: 'thinking' }]]) };
    render();
    expect(imageDigest(canvas)).not.toBe(dots);
    expect(countColor(canvas, OFFICE.bubble)).toBeGreaterThan(white);
    const waiting = imageDigest(canvas);
    game.props = { ...game.props, speech: new Map([[worker, { kind: 'say', text: 'This real reply wraps into a short bubble and ends with an ellipsis when it exceeds the available space '.repeat(4) }]]) };
    render();
    expect(imageDigest(canvas)).not.toBe(waiting);
    expect(countColor(canvas, OFFICE.bubble)).toBeGreaterThan(white);
    expect(canvasContext(canvas).globalAlpha).toBe(1);
  });

  it('shows scaffolding during construction and removes the facade progressively during demolition', () => {
    const now = Date.now() / 1000;
    const building = buildWorldMap({ ...plan, groups: [{ ...plan.groups[0], phase: { kind: 'build', since: now - 2 } }, plan.groups[1]] });
    const { game, render } = createRenderHarness({ map: building });
    render();
    let scene = game.scenes.campus(building.campus, false);
    expect(countColor(scene.art, OFFICE.scaffold)).toBeGreaterThan(0);
    const stable = buildWorldMap(plan, building);
    game.setMap(stable);
    render();
    scene = game.scenes.campus(stable.campus, false);
    expect(countColor(scene.art, OFFICE.scaffold)).toBe(0);
    const site = required(stable.campus.siteOf.get(roomId));
    const region = { x: site.x * TILE - 4, y: site.y * TILE - 14, width: site.w * TILE + 8, height: site.h * TILE + 17 };
    const complete = imageDigest(scene.art, region);
    const demolishing = buildWorldMap({ ...plan, groups: [{ ...plan.groups[0], phase: { kind: 'demolish', since: now - 2 } }, plan.groups[1]] }, stable);
    game.setMap(demolishing);
    render();
    expect(imageDigest(game.scenes.campus(demolishing.campus, false).art, region)).not.toBe(complete);
    expect(canvasContext(scene.art).globalAlpha).toBe(1);
  });

  it('lights occupied campus windows at night and brings the bus to its visible stop', () => {
    const { game, render } = createRenderHarness({ map });
    game.sync((['thinking', 'receiving', 'blocked', 'down'] as const).map((state, desk) => ({
      id: `One/worker${String(desk)}`, state, home: roomId, desk,
    })));
    render();
    const day = game.scenes.campus(map.campus, false);
    expect(countColor(day.art, OFFICE.windowLit)).toBeGreaterThan(0);
    expect(countColor(day.art, OFFICE.windowWarm)).toBeGreaterThan(0);
    expect(countColor(day.art, OFFICE.windowAlert)).toBeGreaterThan(0);
    const daylight = imageDigest(day.art);
    game.night = true;
    render();
    const night = game.scenes.campus(map.campus, true);
    expect(imageDigest(night.art)).not.toBe(daylight);
    expect(canvasContext(night.art).globalCompositeOperation).toBe('source-over');
    game.night = false;
    callBus(game.world.bus, game.world.time, 5);
    game.world.time += BUS_IN;
    render();
    const bus = game.scenes.campus(map.campus, false);
    expect(countColor(bus.art, OFFICE.bus)).toBeGreaterThan(countColor(bus.bg, OFFICE.bus));
    const stop = { x: (map.campus.stop.tile.x + 1) * TILE + TILE - 3, y: map.campus.roadY * TILE + 6 };
    expect(pixel(bus.art, stop.x, stop.y)).toEqual(rgba(OFFICE.slate));
  });

  it.each([
    ['tidy', SHARED_IDS.cafe, OFFICE.box], ['sweep', SHARED_IDS.cafe, OFFICE.straw],
    ['water', SHARED_IDS.park, OFFICE.can], ['read', SHARED_IDS.park, OFFICE.paper],
    ['eat', SHARED_IDS.cafe, OFFICE.food], ['coffee', SHARED_IDS.cafe, OFFICE.mug],
    ['cook', SHARED_IDS.park, OFFICE.ember], ['play', SHARED_IDS.park, OFFICE.paddle],
  ] as const)('shows the %s activity and its hand prop at a real routine spot', (pose, id, propColor) => {
    const { game, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: 0 }]);
    const level = required(map.levels.get(id));
    const spots = required(level.routine[pose]);
    const spot = pose === 'play' ? required(spots.find(value => value.game === 'pingpong')) : spots[0];
    const actor = required(game.world.actors.get(worker));
    Object.assign(actor, { level: id, x: spot.px.x, y: spot.px.y, dir: spot.dir, pose: 'stand', rest: spot, clock: 3 });
    game.go(id);
    render();
    const scene = game.scenes.level(level, false);
    const region = { x: Math.round(actor.x - 20), y: Math.round(actor.y - 42), width: 42, height: 46 };
    const standing = imageDigest(scene.art, region);
    const absent = countColor(scene.art, propColor, region);
    actor.pose = pose;
    render();
    expect(imageDigest(scene.art, region)).not.toBe(standing);
    expect(countColor(scene.art, propColor, region)).toBeGreaterThan(absent);
  });

  it('shows sleep letters above a bed and hides them when the sleeper is filtered out', () => {
    const { game, canvas, render } = createRenderHarness({ map });
    game.sync([{ id: worker, state: 'thinking', home: roomId, desk: 0 }]);
    const bed = required(map.levels.get(SHARED_IDS.dorm)).beds[0];
    Object.assign(required(game.world.actors.get(worker)), { level: SHARED_IDS.dorm, x: bed.px.x, y: bed.px.y, dir: bed.dir, rest: bed, pose: 'lie', bubble: 'zzz' });
    game.go(SHARED_IDS.dorm);
    render();
    expect(countColor(canvas, OFFICE.zzz)).toBeGreaterThan(0);
    game.props = { ...game.props, highlight: new Set() };
    render();
    expect(countColor(canvas, OFFICE.zzz)).toBe(0);
    expect(canvasContext(canvas).globalAlpha).toBe(1);
  });
});
