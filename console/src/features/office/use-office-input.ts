import { useEffect, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { isContextMenuKey, openContextMenuAt } from '../../components/agent-actions/agent-actions';
import { arrive, stepTile, tileAt, walkTo } from './avatar';
import { doubleTapZoom, follow, panBy, screenToWorld, stepZoom, zoomAt, type Vec } from './camera';
import { DIR_OF, VECTORS } from './canvas-input';
import type { OfficeEngine } from './engine';
import { clippingOf } from './frame';
import { DOUBLE_MS, isDoubleTap, isTap, movedPast, pinchOf, pinchZoom, wheelPassesThrough, wheelZoom } from './gesture';
import { CAMPUS, TILE } from './level';
import { actorLook } from './people';
import { readingOrder, spatialNext, type Placed } from './spatial';
import type { IconName } from './sprites';

export interface InputContext {
  engine: OfficeEngine;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  listRef: RefObject<HTMLElement | null>;
  kick: () => void;
  dpr: number;
  paseo: boolean;
  setPaseo: (on: boolean) => void;
  cursorId: string | null;
  setCursorId: (id: string | null) => void;
  setHover: (id: string | null, anchor: DOMRect | null) => void;
  setSiteHover: (id: string | null, anchor: DOMRect | null) => void;
  setGrabbing: (on: boolean) => void;
  selectedId: string | null;
  agentIds: readonly string[];
  onSelect: (id: string) => void;
  onDeselect: () => void;
  onTalk?: (id: string) => void;
  onKey: (key: string) => boolean;
  dismissHint: () => void;
}

/** The reaction an agent shows when clicked: what they are up to, at a glance. */
export function reactionOf(state: string, asleep: boolean): IconName {
  if (asleep) return 'sleep';
  switch (state) {
    case 'thinking': return 'idea';
    case 'receiving': return 'mail';
    case 'delegating': return 'paper';
    case 'blocked': return 'question';
    case 'down': return 'wrench';
    case 'settled': return 'star';
    default: return 'wave';
  }
}

const normal = (key: string) => (key.length === 1 ? key.toLowerCase() : key);

/** Pointer, wheel and keyboard for the campus canvas: taps pick people and houses, drags pan, pinches zoom. */
export function useOfficeInput(context: InputContext) {
  const { engine, canvasRef, kick, dpr, dismissHint } = context;

  const toScreen = (client: Vec): Vec => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: (client.x - rect.left) * dpr, y: (client.y - rect.top) * dpr } : { x: 0, y: 0 };
  };

  const domBox = (box: { left: number; top: number; right: number; bottom: number } | null): DOMRect | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !box) return null;
    return new DOMRect(rect.left + box.left / dpr, rect.top + box.top / dpr, (box.right - box.left) / dpr, (box.bottom - box.top) / dpr);
  };

  const zoomTo = (zoom: number, at?: Vec) => {
    engine.zoomTo(zoom, at);
    context.dismissHint();
    kick();
  };

  const select = (id: string) => {
    const actor = engine.world.actors.get(id);
    if (actor) engine.emote(id, reactionOf(actor.state, actor.pose === 'lie'));
    context.onSelect(id);
    kick();
  };

  const walkToPoint = (point: Vec, type: string) => {
    const at = performance.now() / 1000;
    const level = engine.levelOf(engine.level);
    if (!level) return;
    if (engine.avatarLevel !== engine.level) engine.centerMe();
    const inside = point.x >= 0 && point.y >= 0 && point.x < level.cols * TILE && point.y < level.rows * TILE;
    if (!inside || !walkTo(engine.avatar, level, tileAt(point.x, point.y + 2))) {
      engine.marker = { x: point.x, y: point.y, ok: false, at, age: 0, level: engine.level };
      if ('vibrate' in navigator) navigator.vibrate(12);
      kick();
      return;
    }
    const goal = engine.avatar.route.at(-1);
    engine.marker = goal ? { x: goal.x, y: goal.y, ok: true, at, age: 0, level: engine.level } : null;
    if (engine.reducedMotion) arrive(engine.avatar);
    if (!context.paseo) context.setPaseo(true);
    engine.following = true;
    if (type !== 'mouse') context.dismissHint();
    kick();
  };

  /** A floor tap waits out the double-tap window, so tapping twice to zoom never sends the operator walking. */
  const tap = (screen: Vec, client: Vec, type: string) => {
    const mark = { at: performance.now(), x: client.x, y: client.y };
    if (isDoubleTap(engine.lastTap, mark)) {
      engine.lastTap = null;
      window.clearTimeout(engine.pendingWalk);
      engine.pendingWalk = 0;
      zoomTo(doubleTapZoom(engine.target.zoom, engine.limits), screen);
      return;
    }
    engine.lastTap = mark;
    const id = engine.pick(screen);
    if (id) {
      select(id);
      return;
    }
    const site = engine.siteAt(screen);
    if (site) {
      engine.go(site.id);
      context.dismissHint();
      kick();
      return;
    }
    if (engine.onExit(screen)) {
      engine.go(CAMPUS);
      kick();
      return;
    }
    const point = screenToWorld(engine.cam, engine.view, screen);
    window.clearTimeout(engine.pendingWalk);
    engine.pendingWalk = window.setTimeout(() => {
      engine.pendingWalk = 0;
      walkToPoint(point, type);
    }, DOUBLE_MS);
  };

  useEffect(() => () => { window.clearTimeout(engine.pendingWalk); }, [engine]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    if (event.pointerType === 'mouse') context.listRef.current?.focus({ preventScroll: true });
    const at = { x: event.clientX, y: event.clientY };
    engine.presses.set(event.pointerId, { start: at, last: at, at: performance.now(), type: event.pointerType, dragging: false });
    if (engine.presses.size === 2) {
      const [a, b] = [...engine.presses.values()];
      a.dragging = true;
      b.dragging = true;
      engine.pinch = { start: pinchOf(toScreen(a.last), toScreen(b.last)), zoom: engine.target.zoom, cam: { ...engine.target } };
      engine.following = false;
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const press = engine.presses.get(event.pointerId);
    if (!press) {
      if (event.pointerType !== 'mouse') return;
      const screen = toScreen({ x: event.clientX, y: event.clientY });
      const id = engine.pick(screen);
      context.setHover(id, id ? domBox(engine.boxOf(id)) : null);
      const site = id ? null : engine.siteAt(screen);
      engine.hoveredSite = site?.id ?? null;
      const rect = canvasRef.current?.getBoundingClientRect();
      context.setSiteHover(site?.id ?? null, site && rect ? new DOMRect(event.clientX, event.clientY, 1, 1) : null);
      kick();
      return;
    }
    const previous = press.last;
    press.last = { x: event.clientX, y: event.clientY };
    if (engine.pinch && engine.presses.size >= 2) {
      const [a, b] = [...engine.presses.values()];
      const now = pinchOf(toScreen(a.last), toScreen(b.last));
      const zoom = pinchZoom(engine.pinch.zoom, engine.pinch.start, now, engine.limits);
      const zoomed = zoomAt(engine.pinch.cam, engine.view, engine.pinch.start.mid, zoom);
      engine.untouched = false;
      engine.target = engine.clamp(panBy(zoomed, now.mid.x - engine.pinch.start.mid.x, now.mid.y - engine.pinch.start.mid.y));
      engine.settleAt = performance.now() + 120;
      context.dismissHint();
      kick();
      return;
    }
    if (!press.dragging && movedPast(press.start, press.last, press.type)) {
      press.dragging = true;
      engine.following = false;
      context.setGrabbing(true);
      context.setHover(null, null);
      context.dismissHint();
    }
    if (press.dragging) {
      engine.untouched = false;
      engine.target = engine.clamp(panBy(engine.target, (press.last.x - previous.x) * dpr, (press.last.y - previous.y) * dpr));
      kick();
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const press = engine.presses.get(event.pointerId);
    engine.presses.delete(event.pointerId);
    if (engine.pinch) {
      if (engine.presses.size < 2) {
        engine.pinch = null;
        engine.settleAt = performance.now() + 60;
        kick();
      }
      return;
    }
    if (engine.presses.size === 0) context.setGrabbing(false);
    if (!press || cancelled || press.dragging) return;
    const end = { x: event.clientX, y: event.clientY };
    if (isTap(press.start, end, press.type, performance.now() - press.at)) tap(toScreen(end), end, press.type);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      const input = { deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey || event.metaKey };
      if (wheelPassesThrough(engine.target.zoom, input, engine.limits, clippingOf(canvas))) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const at = { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
      engine.following = false;
      engine.untouched = false;
      engine.target = engine.clamp(zoomAt(engine.target, engine.view, at, wheelZoom(engine.target.zoom, input, engine.limits)));
      engine.settleAt = performance.now() + 180;
      dismissHint();
      kick();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { canvas.removeEventListener('wheel', onWheel); };
  }, [canvasRef, engine, dpr, kick, dismissHint]);

  /** Where each agent counts for arrow keys: on its spot when on this map, at its building's door from the campus. */
  const placed = (): Placed[] => {
    const out: Placed[] = [];
    const campus = engine.world.map.campus;
    let spread = 0;
    for (const id of context.agentIds) {
      const actor = engine.world.actors.get(id);
      if (!actor) continue;
      if (actor.level === engine.level && actor.pose !== 'hidden') {
        const hit = actorLook(actor).hit;
        out.push({ id, x: hit.x + hit.w / 2, y: hit.y + hit.h / 2 });
      } else if (engine.level === CAMPUS) {
        const site = campus.siteOf.get(actor.level);
        if (site) out.push({ id, x: site.door.px.x + ((spread % 5) - 2) * 3, y: site.door.px.y - 8 - Math.floor(spread / 5) * 3 });
        spread += 1;
      }
    }
    return out;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (isContextMenuKey(event)) {
      const target = context.cursorId ?? context.selectedId;
      const at = target ? domBox(engine.boxOf(target)) : null;
      if (at && context.listRef.current) {
        event.preventDefault();
        openContextMenuAt(context.listRef.current, at.left + at.width / 2, at.top + at.height / 2);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = normal(event.key);
    if (key === '+' || key === '=') { event.preventDefault(); zoomTo(stepZoom(engine.target.zoom, 1, engine.limits)); return; }
    if (key === '-' || key === '_') { event.preventDefault(); zoomTo(stepZoom(engine.target.zoom, -1, engine.limits)); return; }
    if (key === '0') { event.preventDefault(); engine.fit(); kick(); return; }
    if (key === 'c') { event.preventDefault(); engine.centerMe(); kick(); return; }
    if (key === 'p') { event.preventDefault(); context.setPaseo(!context.paseo); return; }
    if (context.onKey(key)) { event.preventDefault(); return; }
    if (context.paseo) {
      if (key in VECTORS) {
        event.preventDefault();
        if (engine.reducedMotion) {
          const level = engine.levelOf(engine.level);
          if (level && stepTile(engine.avatar, level, DIR_OF[key])) engine.target = engine.clamp(follow(engine.target, engine.view, engine.avatar, 0.35));
        } else {
          engine.keys.add(key);
        }
        kick();
      } else if ((key === 'e' || key === 'Enter') && engine.nearby) {
        event.preventDefault();
        (context.onTalk ?? context.onSelect)(engine.nearby);
      } else if (key === 'Escape') {
        event.preventDefault();
        context.setPaseo(false);
      }
      return;
    }
    if (key in VECTORS && (key.length === 1 || event.shiftKey)) {
      event.preventDefault();
      engine.keys.add(key);
      context.dismissHint();
      kick();
      return;
    }
    if (key in DIR_OF || key === 'Home' || key === 'End') {
      const points = placed();
      if (points.length === 0) return;
      event.preventDefault();
      const order = readingOrder(points);
      const next = key === 'Home' ? order.at(0)?.id : key === 'End' ? order.at(-1)?.id : spatialNext(points, context.cursorId, DIR_OF[key]);
      if (!next) return;
      context.setCursorId(next);
      if (engine.world.actors.get(next)?.level === engine.level) engine.focusActor(next, false);
      context.setHover(next, domBox(engine.boxOf(next)));
      kick();
    } else if ((key === 'Enter' || key === ' ') && context.cursorId) {
      event.preventDefault();
      select(context.cursorId);
    } else if (key === 'Escape') {
      event.preventDefault();
      if (context.cursorId) context.setCursorId(null);
      else if (context.selectedId) context.onDeselect();
      else if (engine.level !== CAMPUS) {
        engine.go(CAMPUS);
        kick();
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    engine.keys.delete(normal(event.key));
    if (event.key === 'Shift') for (const key of Object.keys(DIR_OF)) if (key.startsWith('Arrow') && !context.paseo) engine.keys.delete(key);
  };

  return { onPointerDown, onPointerMove, onPointerEnd, onKeyDown, onKeyUp, toScreen, select, zoomTo };
}
