import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { FloatingTooltip } from '../../components/ui';
import { isContextMenuKey, openContextMenuAt, type AgentRef } from '../../components/agent-actions/agent-actions';
import { AgentActionItems } from '../../components/agent-actions/AgentActionsMenu';
import { MENU_POPUP } from '../../components/kit';
import { cn } from '../../cn';
import { useMediaQuery } from '../../shell/use-media-query';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { arrive, createAvatar, nearbyAgent, stepAvatar, stepTile, tileAt, walkTo, type Avatar } from './avatar';
import {
  NO_INSET, centerOn, clampCamera, doubleTapZoom, ease, fitZoom, follow, originOf, panBy, reveal, screenToWorld, stepZoom, worldToScreen,
  zoomAt, zoomLimits, type Camera, type Inset, type Size, type Vec, type ZoomLimits,
} from './camera';
import {
  DOUBLE_MS, isDoubleTap, isTap, movedPast, pinchOf, pinchZoom, wheelPassesThrough, wheelZoom, type Clipping, type Pinch, type TapMark,
} from './gesture';
import { TILE, WALL_ROWS, buildLayout, chooseLayout, type Dir } from './layout';
import { DirectionPad, OfficeControls, OfficeHint } from './OfficeControls';
import type { TapMarker } from './people';
import { createScene, drawFrame, lookOf, screenBox } from './scene';
import { createWorld, stepWorld, syncWorld, type ActorInput } from './simulation';
import { readingOrder, spatialNext } from './spatial';

export interface OfficeAgent {
  id: string;
  name: string;
  state: LiveState;
  reason: string;
  delegatesTo: readonly string[];
  /** The fleet's chosen look: the hue dresses the character and the glyph rides on its name tag. */
  glyph?: string | null;
  hue?: number | null;
}

interface OfficeCanvasProps {
  agents: readonly OfficeAgent[];
  selectedId: string | null;
  /** Agents outside the active filter are drawn faded; `null` means no filter. */
  highlight: ReadonlySet<string> | null;
  onSelect: (id: string) => void;
  label: string;
}

const HINT_KEY = 'cauce.oficina.ayuda-vista';
const HINT_MS = 12_000;
/** Must match AgentSheet: a 400 px side panel 12 px from the edge from 761 px up, a 55dvh bottom sheet below. */
const SHEET_RESERVE = 412;
const SHEET_BREAKPOINT = 761;
const SHEET_SHARE = 0.55;
const MIN_BAND = 180;
const PAN_SPEED = 620;
const VECTORS: Readonly<Record<string, Vec>> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
};
const DIR_OF: Readonly<Record<string, Dir>> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right',
};
const PAD_VECTOR: Readonly<Record<Dir, Vec>> = { up: VECTORS.w, down: VECTORS.s, left: VECTORS.a, right: VECTORS.d };

/** Office ids are `tenant/alias`; tenants never contain a slash. */
function agentRefOf(id: string): AgentRef | null {
  const cut = id.indexOf('/');
  return cut > 0 ? { tenantId: id.slice(0, cut), alias: id.slice(cut + 1) } : null;
}

/** Where a right click or a long press landed. */
function clientPointOf(event: Event | undefined): Vec | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if ('TouchEvent' in window && event instanceof TouchEvent) {
    const touch = event.touches.item(0) ?? event.changedTouches.item(0);
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

function hintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberHint(): void {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    return;
  }
}

/** Short landscape screens keep a strip of page above and below the canvas to scroll with. */
function availableHeight(): { height: number; roomy: boolean } {
  const roomy = window.matchMedia('(min-width: 640px)').matches;
  const tall = window.innerHeight;
  const height = roomy
    ? Math.min(1180, Math.max(Math.min(460, tall - 96), tall - 168))
    : Math.max(Math.min(340, tall - 96), Math.round(tall * 0.7));
  return { height, roomy };
}

function scrollBand(element: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return { top, bottom };
}

function clippingOf(element: HTMLElement): Clipping {
  const rect = element.getBoundingClientRect();
  const band = scrollBand(element);
  return { above: rect.top < band.top - 1, below: rect.bottom > band.bottom + 1 };
}

function useBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 960, height: 640, dpr: 1, roomy: true });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      if (width <= 0) return;
      const { height, roomy } = availableHeight();
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      setBox((current) => (current.width === width && current.height === height && current.dpr === dpr && current.roomy === roomy
        ? current : { width, height, dpr, roomy }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [ref]);
  return box;
}

interface Press { start: Vec; at: number; type: string; dragging: boolean; last: Vec }

interface Engine {
  avatar: Avatar;
  cam: Camera;
  target: Camera;
  following: boolean;
  keys: Set<string>;
  pad: Set<Dir>;
  presses: Map<number, Press>;
  pinch: { start: Pinch; zoom: number; cam: Camera } | null;
  lastTap: TapMark | null;
  settleAt: number;
  nearby: string | null;
  fresh: boolean;
  inset: Inset;
  pendingWalk: number;
  marker: (Omit<TapMarker, 'age'> & { at: number }) | null;
}

export function OfficeCanvas({ agents, selectedId, highlight, onSelect, label }: OfficeCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLButtonElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const box = useBox(frameRef);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [paseo, setPaseo] = useState(false);
  const [nearby, setNearby] = useState<string | null>(null);
  const [edges, setEdges] = useState({ atMin: true, atMax: false });
  const [hint, setHint] = useState(() => !hintSeen());
  const [grabbing, setGrabbing] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const ordered = useMemo(() => [...agents].sort((a, b) => a.id.localeCompare(b.id)), [agents]);
  const choice = useMemo(() => chooseLayout(ordered.length, box), [ordered.length, box]);
  const layout = useMemo(() => buildLayout(choice.params), [choice.params]);
  const artW = layout.cols * TILE;
  const artH = layout.rows * TILE;
  const worldSize = useMemo<Size>(() => ({ width: artW, height: artH }), [artW, artH]);
  const frameHeight = useMemo(() => {
    if (!box.roomy) return box.height;
    const fit = fitZoom({ width: box.width * box.dpr, height: box.height * box.dpr }, worldSize);
    return Math.min(box.height, Math.ceil((artH * fit) / box.dpr) + 40);
  }, [box, worldSize, artH]);
  const view = useMemo<Size>(() => ({ width: Math.round(box.width * box.dpr), height: Math.round(frameHeight * box.dpr) }), [box, frameHeight]);
  const limits = useMemo<ZoomLimits>(() => zoomLimits(view, worldSize, box.dpr), [view, worldSize, box.dpr]);

  const world = useMemo(() => createWorld(layout, reducedMotion), [layout, reducedMotion]);
  const engine = useMemo<Engine>(() => ({
    avatar: createAvatar(layout.door), cam: { x: 0, y: 0, zoom: 1 }, target: { x: 0, y: 0, zoom: 1 }, following: false,
    keys: new Set(), pad: new Set(), presses: new Map(), pinch: null, lastTap: null, settleAt: 0, nearby: null, fresh: true,
    inset: NO_INSET, pendingWalk: 0, marker: null,
  }), [layout]);

  useEffect(() => {
    const desks = new Map(ordered.map((agent, index) => [agent.id, index]));
    const inputs: ActorInput[] = ordered.map((agent, index) => ({
      id: agent.id,
      state: agent.state,
      desk: index,
      delegateDesk: agent.state === 'delegating'
        ? agent.delegatesTo.map((target) => desks.get(target)).find((desk) => desk !== undefined) ?? null
        : null,
    }));
    syncWorld(world, inputs);
  }, [world, ordered]);

  const live = useRef({ selectedId, hoverId: hoverId ?? cursorId, highlight, names: new Map<string, string>(), paseo, view, limits, onSelect });
  live.current = {
    selectedId, hoverId: hoverId ?? cursorId, highlight, paseo, view, limits, onSelect,
    names: new Map(ordered.map((agent) => [agent.id, agent.glyph ? `${agent.glyph} ${agent.name}` : agent.name])),
  };

  const scene = useMemo(() => (typeof document === 'undefined' ? null : createScene(layout, world, makeCanvas)), [layout, world]);
  const kickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    scene?.sprites.setHues(new Map(ordered.flatMap((agent) => (agent.hue === undefined || agent.hue === null ? [] : [[agent.id, agent.hue]]))));
    kickRef.current();
  }, [scene, ordered]);
  const kick = useCallback(() => { kickRef.current(); }, []);

  const clamp = useCallback((cam: Camera) => clampCamera(cam, live.current.view, worldSize, live.current.limits, engine.inset), [worldSize, engine]);

  const dismissHint = useCallback(() => {
    setHint((shown) => {
      if (shown) rememberHint();
      return false;
    });
  }, []);

  useEffect(() => {
    if (!hint) return undefined;
    const timer = window.setTimeout(dismissHint, HINT_MS);
    return () => { window.clearTimeout(timer); };
  }, [hint, dismissHint]);

  const draw = useCallback((time: number) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !scene || typeof ctx.drawImage !== 'function') return;
    const now = live.current;
    const mark = engine.marker;
    if (mark?.ok && !engine.avatar.moving && engine.avatar.route.length === 0 && time - mark.at > 0.3) engine.marker = null;
    drawFrame(ctx, {
      world, scene, avatar: engine.avatar, cam: engine.cam, view: now.view, dpr: box.dpr, time, still: reducedMotion,
      selected: now.selectedId, hovered: now.hoverId, highlight: now.highlight, nearby: engine.nearby, names: now.names,
      marker: engine.marker ? { ...engine.marker, age: Math.max(0, time - engine.marker.at) } : null,
    });
    const pad = padRef.current;
    if (pad) {
      const gutter = originOf(engine.cam, now.view).x / box.dpr;
      const fits = gutter >= pad.offsetWidth + 8;
      pad.style.left = `${String(Math.round(fits ? (gutter - pad.offsetWidth) / 2 : 8))}px`;
    }
    const prompt = promptRef.current;
    const actor = engine.nearby ? world.actors.get(engine.nearby) : undefined;
    if (prompt && actor) {
      const look = lookOf(actor, engine.avatar, engine.nearby);
      const at = worldToScreen(engine.cam, now.view, { x: look.hit.x + look.hit.w / 2, y: Math.min(look.hit.y, look.labelAbove ? look.labelY : look.hit.y) });
      if (look.labelAbove) at.y -= Math.max(Math.round(10 * box.dpr), Math.min(Math.round(15 * box.dpr), Math.round(engine.cam.zoom * 3.4))) * 1.5 + 2 * box.dpr;
      prompt.style.transform = `translate(${String(Math.round(at.x / box.dpr))}px, ${String(Math.round(at.y / box.dpr))}px) translate(-50%, calc(-100% - 10px))`;
    }
  }, [scene, world, engine, box.dpr, reducedMotion]);

  const tick = useCallback((now: number, dt: number) => {
    const { view: size, limits: bounds, paseo: walking } = live.current;
    stepWorld(world, dt);
    const held = [...engine.keys].flatMap((key) => (key in VECTORS ? [VECTORS[key]] : []));
    const input = [...held, ...[...engine.pad].map((dir) => PAD_VECTOR[dir])].reduce((sum, v) => ({ x: sum.x + v.x, y: sum.y + v.y }), { x: 0, y: 0 });
    if (walking && !reducedMotion) {
      stepAvatar(engine.avatar, layout, input, dt);
      if (input.x !== 0 || input.y !== 0) engine.following = true;
    } else if (!walking && (input.x !== 0 || input.y !== 0)) {
      engine.following = false;
      engine.target = panBy(engine.target, -input.x * PAN_SPEED * box.dpr * Math.min(dt, 0.05), -input.y * PAN_SPEED * box.dpr * Math.min(dt, 0.05));
    }
    if (!walking) stepAvatar(engine.avatar, layout, { x: 0, y: 0 }, reducedMotion ? 0 : dt);
    if (engine.following && engine.avatar.moving) engine.target = follow(engine.target, size, engine.avatar, 0.35);
    const gesturing = engine.pinch !== null || [...engine.presses.values()].some((press) => press.dragging);
    if (!gesturing && now >= engine.settleAt && !Number.isInteger(engine.target.zoom)) {
      engine.target = zoomAt(engine.target, size, { x: size.width / 2, y: size.height / 2 }, Math.round(engine.target.zoom));
    }
    engine.target = clampCamera(engine.target, size, worldSize, bounds, engine.inset);
    engine.cam = gesturing ? { ...engine.target } : ease(engine.cam, engine.target, dt, reducedMotion);
    const near = walking
      ? nearbyAgent(engine.avatar, [...world.actors.values()].map((actor) => ({ id: actor.id, x: actor.x, y: actor.y })))
      : null;
    if (near !== engine.nearby) {
      engine.nearby = near;
      setNearby(near);
    }
    const atMin = engine.target.zoom <= bounds.min + 1e-6;
    const atMax = engine.target.zoom >= bounds.max - 1e-6;
    setEdges((current) => (current.atMin === atMin && current.atMax === atMax ? current : { atMin, atMax }));
    draw(now / 1000);
  }, [world, engine, layout, worldSize, reducedMotion, draw, box.dpr]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = view.width;
    canvas.height = view.height;
    if (engine.fresh) {
      const zoom = Math.min(limits.max, Math.max(limits.min, choice.scale));
      engine.target = { x: worldSize.width / 2, y: Math.min(worldSize.height / 2, view.height / (2 * zoom)), zoom };
      engine.fresh = false;
    }
    engine.target = clampCamera(engine.target, view, worldSize, limits, engine.inset);
    engine.cam = { ...engine.target };
    let visible = true;
    let frame = 0;
    let looping = false;
    let last = performance.now();
    const loop = (now: number) => {
      tick(now, (now - last) / 1000);
      last = now;
      frame = looping ? requestAnimationFrame(loop) : 0;
    };
    const start = () => {
      if (reducedMotion || looping || !visible || document.hidden) return;
      looping = true;
      last = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const stop = () => { looping = false; cancelAnimationFrame(frame); frame = 0; };
    kickRef.current = () => {
      if (looping || frame) return;
      frame = requestAnimationFrame((now) => { frame = 0; last = now; tick(now, 0); });
    };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start(); else stop();
    });
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    tick(performance.now(), 0);
    start();
    return () => {
      stop();
      kickRef.current = () => undefined;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick, engine, view, worldSize, limits, reducedMotion, choice.scale]);

  useEffect(() => { kick(); }, [kick, ordered, selectedId, hoverId, cursorId, highlight, paseo]);

  /** How much of the canvas the agent sheet covers; on phones it first scrolls the canvas up if too little would show. */
  const sheetInset = useCallback((): Inset => {
    const canvas = canvasRef.current;
    if (!canvas) return NO_INSET;
    if (window.innerWidth >= SHEET_BREAKPOINT) {
      const rect = canvas.getBoundingClientRect();
      return { right: Math.max(0, Math.min(rect.width, rect.right - (window.innerWidth - SHEET_RESERVE))) * box.dpr, bottom: 0 };
    }
    const sheetTop = window.innerHeight * (1 - SHEET_SHARE);
    const band = scrollBand(canvas);
    let rect = canvas.getBoundingClientRect();
    if (rect.top < band.top || sheetTop - rect.top < MIN_BAND) {
      canvas.scrollIntoView({ block: 'start', behavior: 'instant' });
      rect = canvas.getBoundingClientRect();
    }
    return { right: 0, bottom: Math.max(0, Math.min(rect.height, rect.bottom - sheetTop)) * box.dpr };
  }, [box.dpr]);

  /** Moves only as far as needed, so an agent already in sight never shakes the room. */
  const focusAgent = useCallback((id: string, roomy: boolean) => {
    const actor = world.actors.get(id);
    if (!actor) return;
    const look = lookOf(actor, null, null);
    const size = live.current.view;
    const free = Math.min(size.width - engine.inset.right, size.height - engine.inset.bottom);
    const margin = roomy ? Math.min(96 * box.dpr, free / 4) : 24 * box.dpr;
    engine.following = false;
    engine.target = clamp(reveal(engine.target, size, look.hit, engine.inset, margin));
    kick();
  }, [world, engine, clamp, kick, box.dpr]);

  useEffect(() => {
    engine.inset = selectedId ? sheetInset() : NO_INSET;
    if (selectedId) focusAgent(selectedId, true);
    else engine.target = clamp(engine.target);
    kick();
  }, [selectedId, focusAgent, sheetInset, engine, clamp, kick, view]);

  const zoomTo = useCallback((zoom: number, at?: Vec) => {
    const size = live.current.view;
    engine.target = clamp(zoomAt(engine.target, size, at ?? { x: size.width / 2, y: size.height / 2 }, zoom));
    engine.settleAt = 0;
    dismissHint();
    kick();
  }, [engine, clamp, dismissHint, kick]);

  const fitAll = useCallback(() => {
    engine.following = false;
    engine.target = clamp({ x: artW / 2, y: artH / 2, zoom: live.current.limits.min });
    kick();
  }, [engine, clamp, artW, artH, kick]);

  const centerMe = useCallback(() => {
    const zoom = Math.max(engine.target.zoom, Math.min(live.current.limits.max, choice.scale + 1));
    engine.target = clamp(centerOn({ ...engine.target, zoom }, { x: engine.avatar.x, y: engine.avatar.y - 10 }, engine.inset));
    engine.following = true;
    kick();
  }, [engine, clamp, choice.scale, kick]);

  const togglePaseo = useCallback((on: boolean) => {
    setPaseo(on);
    engine.keys.clear();
    engine.pad.clear();
    if (on) {
      setCursorId(null);
      setAnchor(null);
      engine.following = true;
      engine.target = clamp(follow(engine.target, live.current.view, engine.avatar, 0.35));
      dismissHint();
    }
    kick();
  }, [engine, clamp, dismissHint, kick]);

  const toScreen = (client: Vec): Vec => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: (client.x - rect.left) * box.dpr, y: (client.y - rect.top) * box.dpr } : { x: 0, y: 0 };
  };

  const pick = useCallback((screen: Vec): string | null => {
    const size = live.current.view;
    const hits = [...world.actors.values()]
      .map((actor) => ({ actor, box: screenBox(lookOf(actor, engine.avatar, engine.nearby), engine.cam, size) }))
      .filter(({ box: hit }) => screen.x >= hit.left && screen.x <= hit.right && screen.y >= hit.top && screen.y <= hit.bottom)
      .sort((a, b) => b.actor.y - a.actor.y);
    if (hits[0]) return hits[0].actor.id;
    const point = screenToWorld(engine.cam, size, screen);
    const desk = layout.desks.findIndex((slot) => point.x >= slot.x * TILE && point.x < slot.x * TILE + 32
      && point.y >= Math.min(slot.deskY, slot.chairY) * TILE && point.y < (Math.max(slot.deskY, slot.chairY) + 1) * TILE);
    return desk >= 0 && desk < ordered.length ? ordered[desk].id : null;
  }, [world, engine, layout, ordered]);

  const boxOf = useCallback((id: string): DOMRect | null => {
    const canvas = canvasRef.current;
    const actor = world.actors.get(id);
    if (!canvas || !actor) return null;
    const rect = canvas.getBoundingClientRect();
    const hit = screenBox(lookOf(actor, engine.avatar, engine.nearby), engine.cam, live.current.view);
    return new DOMRect(rect.left + hit.left / box.dpr, rect.top + hit.top / box.dpr, (hit.right - hit.left) / box.dpr, (hit.bottom - hit.top) / box.dpr);
  }, [world, engine, box.dpr]);

  const walkToPoint = (point: Vec, type: string) => {
    const at = performance.now() / 1000;
    const inside = point.x >= 0 && point.x < artW && point.y < artH && point.y >= (WALL_ROWS - 0.5) * TILE;
    if (!inside || !walkTo(engine.avatar, layout, tileAt(point.x, point.y + 2))) {
      engine.marker = { x: point.x, y: point.y, ok: false, at };
      if ('vibrate' in navigator) navigator.vibrate(12);
      kick();
      return;
    }
    const goal = engine.avatar.route.at(-1);
    engine.marker = goal ? { x: goal.x, y: goal.y, ok: true, at } : null;
    if (reducedMotion) arrive(engine.avatar);
    if (!live.current.paseo) togglePaseo(true);
    engine.following = true;
    if (type !== 'mouse') dismissHint();
    kick();
  };

  /** A floor tap waits out the double-tap window, so tapping twice to zoom never sends the avatar walking. */
  const tap = (screen: Vec, client: Vec, type: string) => {
    const mark = { at: performance.now(), x: client.x, y: client.y };
    if (isDoubleTap(engine.lastTap, mark)) {
      engine.lastTap = null;
      window.clearTimeout(engine.pendingWalk);
      engine.pendingWalk = 0;
      zoomTo(doubleTapZoom(engine.target.zoom, live.current.limits), screen);
      return;
    }
    engine.lastTap = mark;
    const id = pick(screen);
    if (id) {
      onSelect(id);
      return;
    }
    const point = screenToWorld(engine.cam, live.current.view, screen);
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
    if (event.pointerType === 'mouse') listRef.current?.focus({ preventScroll: true });
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
      const id = pick(toScreen({ x: event.clientX, y: event.clientY }));
      if (id !== hoverId) setHoverId(id);
      setAnchor(id ? boxOf(id) : null);
      return;
    }
    const previous = press.last;
    press.last = { x: event.clientX, y: event.clientY };
    if (engine.pinch && engine.presses.size >= 2) {
      const [a, b] = [...engine.presses.values()];
      const now = pinchOf(toScreen(a.last), toScreen(b.last));
      const zoom = pinchZoom(engine.pinch.zoom, engine.pinch.start, now, live.current.limits);
      const zoomed = zoomAt(engine.pinch.cam, live.current.view, engine.pinch.start.mid, zoom);
      engine.target = clamp(panBy(zoomed, now.mid.x - engine.pinch.start.mid.x, now.mid.y - engine.pinch.start.mid.y));
      engine.settleAt = performance.now() + 120;
      dismissHint();
      kick();
      return;
    }
    if (!press.dragging && movedPast(press.start, press.last, press.type)) {
      press.dragging = true;
      engine.following = false;
      setGrabbing(true);
      setAnchor(null);
      dismissHint();
    }
    if (press.dragging) {
      engine.target = clamp(panBy(engine.target, (press.last.x - previous.x) * box.dpr, (press.last.y - previous.y) * box.dpr));
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
    if (engine.presses.size === 0) setGrabbing(false);
    if (!press || cancelled || press.dragging) return;
    const end = { x: event.clientX, y: event.clientY };
    if (isTap(press.start, end, press.type, performance.now() - press.at)) tap(toScreen(end), end, press.type);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      const bounds = live.current.limits;
      const input = { deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey || event.metaKey };
      if (wheelPassesThrough(engine.target.zoom, input, bounds, clippingOf(canvas))) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const at = { x: (event.clientX - rect.left) * box.dpr, y: (event.clientY - rect.top) * box.dpr };
      engine.following = false;
      engine.target = clampCamera(zoomAt(engine.target, live.current.view, at, wheelZoom(engine.target.zoom, input, bounds)), live.current.view, worldSize, bounds, engine.inset);
      engine.settleAt = performance.now() + 180;
      dismissHint();
      kick();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { canvas.removeEventListener('wheel', onWheel); };
  }, [engine, worldSize, box.dpr, dismissHint, kick]);

  const normal = (key: string) => (key.length === 1 ? key.toLowerCase() : key);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (isContextMenuKey(event)) {
      const target = cursorId ?? selectedId;
      const at = target ? boxOf(target) : null;
      if (at && listRef.current) {
        event.preventDefault();
        openContextMenuAt(listRef.current, at.left + at.width / 2, at.top + at.height / 2);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = normal(event.key);
    const bounds = live.current.limits;
    if (key === '+' || key === '=') { event.preventDefault(); zoomTo(stepZoom(engine.target.zoom, 1, bounds)); return; }
    if (key === '-' || key === '_') { event.preventDefault(); zoomTo(stepZoom(engine.target.zoom, -1, bounds)); return; }
    if (key === '0') { event.preventDefault(); fitAll(); return; }
    if (key === 'c') { event.preventDefault(); centerMe(); return; }
    if (key === 'p') { event.preventDefault(); togglePaseo(!paseo); return; }
    if (paseo) {
      if (key in VECTORS) {
        event.preventDefault();
        if (reducedMotion) {
          if (stepTile(engine.avatar, layout, DIR_OF[key])) engine.target = clamp(follow(engine.target, live.current.view, engine.avatar, 0.35));
          kick();
        } else {
          engine.keys.add(key);
        }
      } else if ((key === 'e' || key === 'Enter') && engine.nearby) {
        event.preventDefault();
        onSelect(engine.nearby);
      } else if (key === 'Escape') {
        event.preventDefault();
        togglePaseo(false);
      }
      return;
    }
    if (key in VECTORS && (key.length === 1 || event.shiftKey)) {
      event.preventDefault();
      engine.keys.add(key);
      dismissHint();
      kick();
      return;
    }
    if (ordered.length === 0) return;
    if (key in DIR_OF || key === 'Home' || key === 'End') {
      event.preventDefault();
      const placed = [...world.actors.values()].map((actor) => {
        const hit = lookOf(actor, null, null).hit;
        return { id: actor.id, x: hit.x + hit.w / 2, y: hit.y + hit.h / 2 };
      });
      const order = readingOrder(placed);
      const next = key === 'Home' ? order.at(0)?.id : key === 'End' ? order.at(-1)?.id : spatialNext(placed, cursorId, DIR_OF[key]);
      if (!next) return;
      setCursorId(next);
      focusAgent(next, false);
      setAnchor(boxOf(next));
    } else if ((key === 'Enter' || key === ' ') && cursorId) {
      event.preventDefault();
      onSelect(cursorId);
    } else if (key === 'Escape') {
      setCursorId(null);
    }
  };

  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    engine.keys.delete(normal(event.key));
    if (event.key === 'Shift') for (const key of Object.keys(DIR_OF)) if (key.startsWith('Arrow') && !paseo) engine.keys.delete(key);
  };

  const menuAgent = menuFor ? agentRefOf(menuFor) : null;
  const tipId = hoverId ?? cursorId;
  const tip = tipId ? ordered.find((agent) => agent.id === tipId) : undefined;
  const talkTo = nearby && nearby !== selectedId ? ordered.find((agent) => agent.id === nearby) : undefined;
  const short = frameHeight < (coarse ? 300 : 240);
  const optionId = (id: string) => `office-agent-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <div
      ref={frameRef}
      className="relative w-full overflow-hidden"
      style={{ height: frameHeight }}
    >
      <ContextMenu.Root open={menuFor !== null} onOpenChange={(open, details) => {
        if (!open) { setMenuFor(null); return; }
        const point = clientPointOf(details.event);
        const id = point ? pick(toScreen(point)) : null;
        if (id) setMenuFor(id);
      }}>
      <ContextMenu.Trigger
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-activedescendant={cursorId ? optionId(cursorId) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => { setCursorId(null); setAnchor(null); engine.keys.clear(); }}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            'block size-full touch-none select-none [image-rendering:pixelated]',
            grabbing ? 'cursor-grabbing' : hoverId ? 'cursor-pointer' : 'cursor-grab',
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => { onPointerEnd(event, false); }}
          onPointerCancel={(event) => { onPointerEnd(event, true); }}
          onPointerLeave={() => { setHoverId(null); setAnchor(null); }}
          onContextMenu={(event) => { if (coarse) event.preventDefault(); }}
        />
        {ordered.map((agent) => (
          <div
            key={agent.id}
            id={optionId(agent.id)}
            role="option"
            aria-selected={agent.id === selectedId}
            className="sr-only"
            onClick={() => { onSelect(agent.id); }}
          >
            {agent.name}: {LIVE_STATE_META[agent.state].label}. {agent.reason}
          </div>
        ))}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className={cn(MENU_POPUP, 'menu-pop w-64')}>
            {menuAgent ? <AgentActionItems agent={menuAgent} omit={['office']} /> : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
      </ContextMenu.Root>
      <button
        ref={promptRef}
        type="button"
        onClick={() => { if (talkTo) onSelect(talkTo.id); }}
        tabIndex={talkTo ? 0 : -1}
        aria-hidden={talkTo ? undefined : true}
        className={cn(
          'absolute top-0 left-0 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-1.5 pl-2.5 text-xs font-medium whitespace-nowrap text-fg shadow-pop transition-opacity duration-150 hover:bg-subtle pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-sm',
          talkTo ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {talkTo ? `Hablar con ${talkTo.name}` : ''}
        {coarse ? null : <kbd className="rounded border border-line bg-subtle px-1 font-sans text-[10px] text-muted">E</kbd>}
      </button>
      {hint ? <OfficeHint touch={coarse} top={short} onClose={dismissHint} /> : null}
      <OfficeControls
        canZoomIn={!edges.atMax}
        canZoomOut={!edges.atMin}
        paseo={paseo}
        horizontal={short}
        onZoomIn={() => { zoomTo(stepZoom(engine.target.zoom, 1, limits)); }}
        onZoomOut={() => { zoomTo(stepZoom(engine.target.zoom, -1, limits)); }}
        onFit={fitAll}
        onCenterMe={centerMe}
        onTogglePaseo={() => { togglePaseo(!paseo); }}
      />
      {coarse && paseo ? (
        <DirectionPad padRef={padRef} onHold={(dir, held) => {
          if (held) engine.pad.add(dir); else engine.pad.delete(dir);
          if (held && reducedMotion) {
            stepTile(engine.avatar, layout, dir);
            engine.target = clamp(follow(engine.target, live.current.view, engine.avatar, 0.35));
          }
          engine.following = true;
          kick();
        }}
        />
      ) : null}
      <FloatingTooltip anchor={anchor} open={Boolean(tip && anchor)}>
        {tip ? (
          <>
            <strong>{tip.name}</strong>
            <span className={cn('mt-1 inline-flex items-center gap-1.5 text-xs font-medium', TONE_CLASS[STATE_TONE[tip.state]].ink)}>
              <span className={cn('size-1.5 rounded-full', TONE_CLASS[STATE_TONE[tip.state]].dot)} aria-hidden="true" />
              {LIVE_STATE_META[tip.state].label}
            </span>
            <p>{tip.reason}</p>
          </>
        ) : null}
      </FloatingTooltip>
    </div>
  );
}
