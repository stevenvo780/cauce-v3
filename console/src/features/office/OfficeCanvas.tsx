import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { FloatingTooltip } from '../../components/ui';
import { cn } from '../../cn';
import { useMediaQuery } from '../../shell/use-media-query';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { buildLayout, chooseLayout, TILE } from './layout';
import { SpriteCache, actorLook, drawActor, drawActorOverlay, drawLabel, furnitureDrawables, paintRoom, type DeskState, type Drawable } from './render';
import { createWorld, stepWorld, syncWorld, type ActorInput, type World } from './simulation';

export interface OfficeAgent {
  id: string;
  name: string;
  state: LiveState;
  reason: string;
  delegatesTo: readonly string[];
}

interface OfficeCanvasProps {
  agents: readonly OfficeAgent[];
  selectedId: string | null;
  /** Agents outside the active filter are drawn faded; `null` means no filter. */
  highlight: ReadonlySet<string> | null;
  onSelect: (id: string) => void;
  label: string;
}

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

function useBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 960, height: 640, dpr: 1 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      if (width <= 0) return;
      const height = Math.max(380, Math.min(window.innerHeight - 140, 1300));
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      setBox((current) => (current.width === width && current.height === height && current.dpr === dpr ? current : { width, height, dpr }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [ref]);
  return box;
}

export function OfficeCanvas({ agents, selectedId, highlight, onSelect, label }: OfficeCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const box = useBox(frameRef);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const ordered = useMemo(() => [...agents].sort((a, b) => a.id.localeCompare(b.id)), [agents]);
  const choice = useMemo(() => chooseLayout(ordered.length, box), [ordered.length, box]);
  const layout = useMemo(() => buildLayout(choice.params), [choice.params]);
  const scale = choice.scale;
  const artW = layout.cols * TILE;
  const artH = layout.rows * TILE;

  const worldRef = useRef<World | null>(null);
  const world = useMemo(() => createWorld(layout, reducedMotion), [layout, reducedMotion]);
  worldRef.current = world;

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

  const live = useRef({ selectedId, hoverId: hoverId ?? cursorId, highlight, names: new Map<string, string>() });
  live.current = { selectedId, hoverId: hoverId ?? cursorId, highlight, names: new Map(ordered.map((agent) => [agent.id, agent.name])) };

  const scene = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const sprites = new SpriteCache(makeCanvas);
    const room = makeCanvas(artW, artH);
    const art = makeCanvas(artW, artH);
    const roomCtx = room.getContext('2d');
    if (!roomCtx || typeof roomCtx.drawImage !== 'function') return null;
    paintRoom(roomCtx, layout);
    const deskState = (slot: number): DeskState => {
      const owner = [...world.actors.values()].find((actor) => actor.desk === slot);
      if (!owner) return { monitor: 'off', typing: false, offline: false };
      const seat = layout.desks[slot].seat.px;
      const atDesk = Math.abs(owner.x - seat.x) < 1 && Math.abs(owner.y - seat.y) < 1;
      return {
        monitor: owner.behaviour.monitor,
        typing: atDesk && owner.pose === 'type',
        hands: sprites.palette(owner.id, false).s,
        offline: owner.state === 'down',
      };
    };
    return { sprites, room, art, furniture: furnitureDrawables(layout, deskState) };
  }, [layout, world, artW, artH]);

  const draw = useCallback((time: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const artCtx = scene?.art.getContext('2d');
    if (!canvas || !ctx || !scene || !artCtx || typeof ctx.drawImage !== 'function') return;
    const { selectedId: selected, hoverId: hovered, highlight: only, names } = live.current;
    artCtx.imageSmoothingEnabled = false;
    artCtx.drawImage(scene.room, 0, 0);
    const actors = [...world.actors.values()].map((actor) => ({ actor, look: actorLook(actor) }));
    const drawables: (Drawable & { alpha?: number })[] = [...scene.furniture];
    for (const { actor, look } of actors) {
      drawables.push({
        sortY: actor.y + (look.seated ? 0.5 : 0),
        alpha: only && !only.has(actor.id) ? 0.3 : 1,
        draw: (c, t) => { drawActor(c, scene.sprites, actor, look, t); },
      });
    }
    drawables.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawables) {
      artCtx.globalAlpha = item.alpha ?? 1;
      item.draw(artCtx, time);
    }
    artCtx.globalAlpha = 1;
    for (const { actor, look } of actors) {
      if (only && !only.has(actor.id)) continue;
      drawActorOverlay(artCtx, actor, look, time, actor.id === selected, actor.id === hovered);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(scene.art, 0, 0, canvas.width, canvas.height);
    const dpr = box.dpr;
    const fontPx = Math.max(Math.round(10 * dpr), Math.min(Math.round(15 * dpr), Math.round(scale * 3.4)));
    const byDepth = [...actors].sort((a, b) => Number(a.actor.id === selected) - Number(b.actor.id === selected) || a.actor.y - b.actor.y);
    for (const { actor, look } of byDepth) {
      if ((actor.pose === 'walk' || actor.pose === 'handover') && actor.id !== selected && actor.id !== hovered) continue;
      const name = names.get(actor.id) ?? actor.id;
      const y = look.labelAbove ? (look.y + 1) * scale - 2 * dpr : (Math.round(actor.y) + 4) * scale;
      drawLabel(ctx, name, (look.x + 8) * scale, y, look.labelAbove, fontPx, actor.id === selected, Boolean(only && !only.has(actor.id)));
    }
  }, [scene, world, scale, box.dpr]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = artW * scale;
    canvas.height = artH * scale;
    canvas.style.width = `${String((artW * scale) / box.dpr)}px`;
    canvas.style.height = `${String((artH * scale) / box.dpr)}px`;
    if (reducedMotion) {
      draw(0);
      return undefined;
    }
    let visible = true;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      stepWorld(world, (now - last) / 1000);
      last = now;
      draw(now / 1000);
      frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame || !visible || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start(); else stop();
    });
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    draw(performance.now() / 1000);
    start();
    return () => { stop(); observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [draw, world, artW, artH, scale, box.dpr, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) draw(0);
  }, [reducedMotion, draw, ordered, selectedId, hoverId, cursorId, highlight]);

  const boxOf = useCallback((id: string): DOMRect | null => {
    const canvas = canvasRef.current;
    const actor = world.actors.get(id);
    if (!canvas || !actor) return null;
    const rect = canvas.getBoundingClientRect();
    const ratio = rect.width / artW;
    const look = actorLook(actor);
    return new DOMRect(rect.left + (look.x + 2) * ratio, rect.top + (look.y + 2) * ratio, 12 * ratio, 20 * ratio);
  }, [world, artW]);

  const pick = useCallback((event: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>): string | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * artW;
    const y = ((event.clientY - rect.top) / rect.height) * artH;
    const hits = [...world.actors.values()]
      .map((actor) => ({ actor, look: actorLook(actor) }))
      .filter(({ look }) => x >= look.x + 1 && x <= look.x + 15 && y >= look.y + 1 && y <= look.y + 24)
      .sort((a, b) => b.actor.y - a.actor.y);
    if (hits[0]) return hits[0].actor.id;
    const desk = layout.desks.findIndex((slot) => x >= slot.x * TILE && x < slot.x * TILE + 32
      && y >= Math.min(slot.deskY, slot.chairY) * TILE && y < (Math.max(slot.deskY, slot.chairY) + 1) * TILE);
    return desk >= 0 && desk < ordered.length ? ordered[desk].id : null;
  }, [world, layout, ordered, artW, artH]);

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const id = pick(event);
    if (id !== hoverId) setHoverId(id);
    setAnchor(id ? boxOf(id) : null);
  };

  const index = cursorId ? ordered.findIndex((agent) => agent.id === cursorId) : -1;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (ordered.length === 0) return;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (event.key in moves) {
      event.preventDefault();
      const step = moves[event.key];
      const next = step === -Infinity ? 0 : step === Infinity ? ordered.length - 1
        : (Math.max(index, step > 0 ? -1 : 0) + step + ordered.length) % ordered.length;
      setCursorId(ordered[next].id);
      setAnchor(boxOf(ordered[next].id));
    } else if ((event.key === 'Enter' || event.key === ' ') && cursorId) {
      event.preventDefault();
      onSelect(cursorId);
    } else if (event.key === 'Escape') {
      setCursorId(null);
    }
  };

  const tipId = hoverId ?? cursorId;
  const tip = tipId ? ordered.find((agent) => agent.id === tipId) : undefined;
  const optionId = (id: string) => `office-agent-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <div ref={frameRef} className="w-full">
      <div
        role="listbox"
        aria-label={label}
        aria-activedescendant={cursorId ? optionId(cursorId) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => { setCursorId(null); setAnchor(null); }}
        className="relative mx-auto w-fit rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn('block rounded-lg [image-rendering:pixelated]', hoverId ? 'cursor-pointer' : 'cursor-default')}
          onPointerMove={onPointerMove}
          onPointerLeave={() => { setHoverId(null); setAnchor(null); }}
          onClick={(event) => { const id = pick(event); if (id) onSelect(id); }}
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
      </div>
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
