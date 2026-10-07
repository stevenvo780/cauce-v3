import { describe, expect, it } from 'vitest';
import { must } from '../../test/must';
import {
  AVATAR_SPEED, arrive, createAvatar, feetFree, nearbyAgent, nearestFloor, stepAvatar, stepTile, tileAt, walkTo, walkableAt,
} from './avatar';
import {
  EDGE_SLACK, centerOn, clampCamera, reveal, doubleTapZoom, ease, fitZoom, follow, originOf, panBy, screenToWorld, stepZoom, worldToScreen,
  zoomAt, zoomLimits, type Camera,
} from './camera';
import { isDoubleTap, isTap, movedPast, pinchOf, pinchZoom, wheelPassesThrough, wheelZoom } from './gesture';
import { TILE, WALL_ROWS, buildLayout } from './layout';

const view = { width: 1200, height: 800 };
const world = { width: 400, height: 300 };
const limits = zoomLimits(view, world, 1);

describe('camera', () => {
  it('fits the whole room on a whole zoom step and allows zooming well past it', () => {
    expect(fitZoom(view, world)).toBe(2);
    expect(fitZoom({ width: 100, height: 100 }, world)).toBe(1);
    expect(limits).toEqual({ min: 2, max: 8 });
    expect(zoomLimits(view, world, 3).max).toBe(24);
  });

  it('screen and world coordinates round-trip and the origin lands on whole device pixels', () => {
    const cam: Camera = { x: 133.3, y: 71.7, zoom: 3 };
    const origin = originOf(cam, view);
    expect(Number.isInteger(origin.x) && Number.isInteger(origin.y)).toBe(true);
    const point = { x: 210, y: 95 };
    const back = screenToWorld(cam, view, worldToScreen(cam, view, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
  });

  it('zooming at a point keeps the world under that point still', () => {
    const cam: Camera = { x: 200, y: 150, zoom: 2 };
    const screen = { x: 900, y: 200 };
    const before = screenToWorld(cam, view, screen);
    const after = screenToWorld(zoomAt(cam, view, screen, 5), view, screen);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  it('centres a room smaller than the view and stops a larger one a little past its edges', () => {
    expect(clampCamera({ x: 0, y: 999, zoom: 2 }, view, world, limits)).toEqual({ x: 200, y: 150, zoom: 2 });
    const zoomed = clampCamera({ x: -500, y: 9999, zoom: 6 }, view, world, limits);
    expect(zoomed.x).toBe(view.width / 12 - EDGE_SLACK);
    expect(zoomed.y).toBe(world.height - view.height / 12 + EDGE_SLACK);
    expect(clampCamera({ x: 0, y: 0, zoom: 99 }, view, world, limits).zoom).toBe(8);
  });

  it('a room that fits never wiggles, and a covering panel lets it slide out from under the panel', () => {
    const fits = { width: 590, height: 390 };
    expect(clampCamera({ x: 290, y: 190, zoom: 2 }, view, fits, limits)).toEqual({ x: 295, y: 195, zoom: 2 });
    const covered = clampCamera({ x: 9999, y: 195, zoom: 2 }, view, fits, limits, { right: 400, bottom: 0 });
    expect(covered.x).toBe(fits.width - (view.width - 400) / 4 + EDGE_SLACK + 400 / 4);
    expect(clampCamera(covered, view, fits, limits).x).toBe(fits.width / 2);
  });

  it('reveals a box only when it is out of the uncovered view', () => {
    const cam: Camera = { x: 200, y: 150, zoom: 2 };
    const inside = { x: 150, y: 120, w: 14, h: 24 };
    expect(reveal(cam, view, inside, { right: 0, bottom: 0 }, 20)).toEqual(cam);
    const hidden = { x: 420, y: 120, w: 14, h: 24 };
    const moved = reveal(cam, view, hidden, { right: 400, bottom: 0 }, 20);
    const right = worldToScreen(moved, view, { x: hidden.x + hidden.w, y: 0 }).x;
    expect(right).toBeCloseTo(view.width - 400 - 20, 0);
    expect(moved.y).toBe(cam.y);
  });

  it('steps zoom by whole levels and a double tap jumps in, or back out at the top', () => {
    expect(stepZoom(3, 1, limits)).toBe(4);
    expect(stepZoom(3.4, 1, limits)).toBe(4);
    expect(stepZoom(3.4, -1, limits)).toBe(3);
    expect(stepZoom(2, -1, limits)).toBe(2);
    expect(doubleTapZoom(2, limits)).toBe(4);
    expect(doubleTapZoom(4, limits)).toBe(7);
    expect(doubleTapZoom(8, limits)).toBe(2);
  });

  it('dragging moves the room with the finger', () => {
    const cam: Camera = { x: 200, y: 150, zoom: 4 };
    const point = { x: 220, y: 160 };
    const before = worldToScreen(cam, view, point);
    const after = worldToScreen(panBy(cam, 40, -20), view, point);
    expect(after.x - before.x).toBeCloseTo(40, 0);
    expect(after.y - before.y).toBeCloseTo(-20, 0);
  });

  it('centres beside a side panel and follows only once the target leaves the dead zone', () => {
    const cam: Camera = { x: 100, y: 100, zoom: 4 };
    expect(centerOn(cam, { x: 50, y: 60 }, { right: 400, bottom: 0 })).toEqual({ x: 100, y: 60, zoom: 4 });
    expect(centerOn(cam, { x: 50, y: 60 }, { right: 0, bottom: 320 })).toEqual({ x: 50, y: 100, zoom: 4 });
    expect(follow(cam, view, { x: 120, y: 110 }, 0.5)).toEqual(cam);
    const moved = follow(cam, view, { x: 300, y: 100 }, 0.5);
    expect(moved.x).toBeCloseTo(300 - (view.width / 4 / 2) * 0.5);
  });

  it('eases towards the target and snaps without motion', () => {
    const from: Camera = { x: 0, y: 0, zoom: 2 };
    const to: Camera = { x: 100, y: 50, zoom: 4 };
    const step = ease(from, to, 0.016, false);
    expect(step.x).toBeGreaterThan(0);
    expect(step.x).toBeLessThan(100);
    expect(ease(from, to, 0.016, true)).toEqual(to);
    let cam = from;
    for (let i = 0; i < 200; i += 1) cam = ease(cam, to, 0.016, false);
    expect(cam).toEqual(to);
  });
});

describe('gestures', () => {
  it('tells a tap from a drag with a slop that is larger for fingers', () => {
    expect(isTap({ x: 0, y: 0 }, { x: 3, y: 2 }, 'mouse', 120)).toBe(true);
    expect(isTap({ x: 0, y: 0 }, { x: 6, y: 0 }, 'mouse', 120)).toBe(false);
    expect(isTap({ x: 0, y: 0 }, { x: 8, y: 0 }, 'touch', 120)).toBe(true);
    expect(isTap({ x: 0, y: 0 }, { x: 1, y: 0 }, 'touch', 2000)).toBe(false);
    expect(movedPast({ x: 0, y: 0 }, { x: 0, y: 11 }, 'touch')).toBe(true);
  });

  it('recognises a double tap only when quick and close', () => {
    expect(isDoubleTap({ at: 0, x: 10, y: 10 }, { at: 250, x: 20, y: 18 })).toBe(true);
    expect(isDoubleTap({ at: 0, x: 10, y: 10 }, { at: 500, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap({ at: 0, x: 10, y: 10 }, { at: 100, x: 90, y: 10 })).toBe(false);
    expect(isDoubleTap(null, { at: 100, x: 0, y: 0 })).toBe(false);
  });

  it('pinching scales with the finger distance, clamped', () => {
    const start = pinchOf({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(start.mid).toEqual({ x: 50, y: 0 });
    expect(pinchZoom(3, start, pinchOf({ x: 0, y: 0 }, { x: 200, y: 0 }), limits)).toBe(6);
    expect(pinchZoom(3, start, pinchOf({ x: 0, y: 0 }, { x: 10, y: 0 }), limits)).toBe(2);
  });

  it('a mouse notch is one whole step, a trackpad pinch is smooth, and the limits hand the wheel back to the page', () => {
    expect(wheelZoom(3, { deltaY: -100, deltaMode: 0, ctrlKey: false }, limits)).toBe(4);
    expect(wheelZoom(3, { deltaY: 3, deltaMode: 1, ctrlKey: false }, limits)).toBe(2);
    const smooth = wheelZoom(3, { deltaY: -10, deltaMode: 0, ctrlKey: true }, limits);
    expect(smooth).toBeGreaterThan(3);
    expect(smooth).toBeLessThan(4);
    expect(wheelPassesThrough(2, { deltaY: 100, deltaMode: 0, ctrlKey: false }, limits)).toBe(true);
    expect(wheelPassesThrough(2, { deltaY: -100, deltaMode: 0, ctrlKey: false }, limits)).toBe(false);
    expect(wheelPassesThrough(8, { deltaY: -100, deltaMode: 0, ctrlKey: false }, limits)).toBe(true);
    expect(wheelPassesThrough(2, { deltaY: 100, deltaMode: 0, ctrlKey: true }, limits)).toBe(false);
    const clippedAbove = { above: true, below: false };
    expect(wheelPassesThrough(2, { deltaY: -100, deltaMode: 0, ctrlKey: false }, limits, clippedAbove)).toBe(true);
    expect(wheelPassesThrough(4, { deltaY: 100, deltaMode: 0, ctrlKey: false }, limits, clippedAbove)).toBe(false);
    expect(wheelPassesThrough(4, { deltaY: 100, deltaMode: 0, ctrlKey: false }, limits, { above: false, below: true })).toBe(true);
  });
});

describe('operator avatar', () => {
  const layout = buildLayout({ pods: 2, podCols: 2, side: 'right', compact: false });

  it('walks in through the door, onto floor', () => {
    const avatar = createAvatar(layout.door);
    expect(walkableAt(layout, tileAt(avatar.x, avatar.y))).toBe(true);
    expect(feetFree(layout, avatar.x, avatar.y)).toBe(true);
  });

  it('never enters the wall or furniture when steered by keys, and slides along obstacles', () => {
    const avatar = createAvatar(layout.door);
    for (let i = 0; i < 200; i += 1) stepAvatar(avatar, layout, { x: 0, y: -1 }, 0.05);
    expect(avatar.y).toBeGreaterThan(WALL_ROWS * TILE);
    expect(feetFree(layout, avatar.x, avatar.y)).toBe(true);
    for (let i = 0; i < 400; i += 1) {
      stepAvatar(avatar, layout, { x: Math.sin(i / 7), y: Math.cos(i / 11) }, 0.05);
      expect(feetFree(layout, avatar.x, avatar.y)).toBe(true);
    }
  });

  it('walks a tapped route at its own pace and stops there; a tap on furniture walks to the nearest floor', () => {
    const avatar = createAvatar(layout.door);
    const desk = layout.desks[0];
    expect(walkTo(avatar, layout, { x: desk.x, y: desk.deskY })).toBe(true);
    const goal = must(avatar.route.at(-1), 'goal');
    expect(walkableAt(layout, tileAt(goal.x, goal.y))).toBe(true);
    stepAvatar(avatar, layout, { x: 0, y: 0 }, 0.05);
    expect(avatar.moving).toBe(true);
    for (let i = 0; i < 400 && avatar.moving; i += 1) stepAvatar(avatar, layout, { x: 0, y: 0 }, 0.05);
    expect([avatar.x, avatar.y]).toEqual([goal.x, goal.y]);
    expect(AVATAR_SPEED).toBeGreaterThan(0);
  });

  it('keys take over from a planned walk', () => {
    const avatar = createAvatar(layout.door);
    walkTo(avatar, layout, layout.lounge[0].tile);
    stepAvatar(avatar, layout, { x: 1, y: 0 }, 0.05);
    expect(avatar.route).toEqual([]);
  });

  it('jumps straight to the end without motion and steps whole tiles', () => {
    const avatar = createAvatar(layout.door);
    walkTo(avatar, layout, layout.lounge[0].tile);
    const goal = must(avatar.route.at(-1), 'goal');
    arrive(avatar);
    expect([avatar.x, avatar.y]).toEqual([goal.x, goal.y]);
    const start = tileAt(avatar.x, avatar.y);
    const moved = stepTile(avatar, layout, 'up');
    const now = tileAt(avatar.x, avatar.y);
    expect(moved ? now.y === start.y - 1 : now.y === start.y).toBe(true);
  });

  it('keeps the feet inside the bottom row so the art never cuts them', () => {
    const avatar = createAvatar(layout.door);
    for (let i = 0; i < 400; i += 1) stepAvatar(avatar, layout, { x: 0.3, y: 1 }, 0.05);
    expect(avatar.y).toBeLessThanOrEqual(layout.rows * TILE - 3);
    expect(feetFree(layout, avatar.x, layout.rows * TILE - 1)).toBe(false);
  });

  it('finds the nearest floor and the closest agent within reach', () => {
    expect(nearestFloor(layout, { x: 0, y: 0 })?.y).toBeGreaterThanOrEqual(WALL_ROWS);
    const here = { x: 100, y: 100 };
    expect(nearbyAgent(here, [{ id: 'far', x: 200, y: 100 }, { id: 'near', x: 115, y: 104 }, { id: 'nearer', x: 108, y: 100 }])).toBe('nearer');
    expect(nearbyAgent(here, [{ id: 'far', x: 200, y: 100 }])).toBeNull();
  });
});
