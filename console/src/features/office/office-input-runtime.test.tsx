import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderHarness, NativePath2D } from '../../test/office-render-canvas';
import { tileAt } from './avatar';
import { worldToScreen } from './camera';
import { lotCell } from './campus-lots';
import type { OfficeEngine } from './engine';
import { useFrameSize, useHeight, useMaximized } from './frame';
import { DOUBLE_MS } from './gesture';
import { CAMPUS, TILE } from './level';
import { useOfficeEngine } from './use-office-engine';
import { useOfficeInput } from './use-office-input';
import { buildWorldMap, groupLevelId } from './world-map';

const map = buildWorldMap({ groups: [{ id: 'room', label: 'Room', hue: 30, seats: 4, cell: lotCell(0) }], beds: 4, pods: 2 });
const roomId = groupLevelId('room');
const rect = new DOMRect(20, 30, 960, 640);
const ids = ['tenant/one', 'tenant/two'];

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let fullscreenDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  fullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  vi.stubGlobal('PointerEvent', TestPointerEvent); vi.stubGlobal('Path2D', NativePath2D);
});
afterEach(() => {
  if (fullscreenDescriptor) Object.defineProperty(document, 'fullscreenElement', fullscreenDescriptor);
  else Reflect.deleteProperty(document, 'fullscreenElement');
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function InputHarness({ game, dpr = 1 }: { game: OfficeEngine; dpr?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [site, setSite] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [paseo, setPaseo] = useState(false);
  const [hint, setHint] = useState(true);
  const [talk, setTalk] = useState<string | null>(null);
  const [menu, setMenu] = useState('');
  const [, redraw] = useState(0);
  const input = useOfficeInput({ engine: game, canvasRef, listRef, dpr, paseo, cursorId: cursor, selectedId: selected, agentIds: ids,
    kick: () => { redraw(value => value + 1); }, setCursorId: setCursor,
    setPaseo: on => { game.setPaseo(on); setPaseo(on); },
    setHover: (id, box) => { setHover(id); setAnchor(box); }, setSiteHover: setSite, setGrabbing,
    onSelect: setSelected, onDeselect: () => { setSelected(null); }, onTalk: setTalk,
    onKey: key => { if (key !== '1') return false; setTalk('hotbar'); return true; }, dismissHint: () => { setHint(false); },
  });
  return <>
    <div ref={listRef} role="listbox" tabIndex={0} onKeyDown={input.onKeyDown} onKeyUp={input.onKeyUp}
      onContextMenu={event => { setMenu(`${String(event.clientX)},${String(event.clientY)}`); }}>
      <canvas ref={canvasRef} aria-label="Campus" onPointerDown={input.onPointerDown} onPointerMove={input.onPointerMove}
        onPointerUp={event => { input.onPointerEnd(event, false); }} onPointerCancel={event => { input.onPointerEnd(event, true); }} />
    </div>
    <output aria-label="Selection">{selected ?? 'none'}</output><output aria-label="Cursor">{cursor ?? 'none'}</output>
    <output aria-label="Hover">{hover ?? 'none'}</output><output aria-label="Site">{site ?? 'none'}</output>
    <output aria-label="Anchor">{anchor ? `${String(anchor.left)},${String(anchor.top)}` : 'none'}</output>
    <output aria-label="Gesture">{grabbing ? 'grabbing' : 'idle'}</output><output aria-label="Walk">{paseo ? 'on' : 'off'}</output>
    <output aria-label="Hint">{hint ? 'visible' : 'dismissed'}</output><output aria-label="Talk">{talk ?? 'none'}</output>
    <output aria-label="Menu">{menu}</output>
  </>;
}

function mountInput({ reducedMotion = true, dpr = 1, interior = true } = {}) {
  const { game, render: paint } = createRenderHarness({ map, reducedMotion, dpr, view: { width: 960 * dpr, height: 640 * dpr } });
  game.sync(ids.map((id, desk) => ({ id, state: 'thinking', home: roomId, desk })));
  if (interior) game.go(roomId);
  if (!reducedMotion && interior) { game.tick(performance.now() + 700, 0.7); }
  paint();
  const mounted = render(<InputHarness game={game} dpr={dpr} />);
  const canvas = screen.getByLabelText<HTMLCanvasElement>('Campus');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect);
  const point = (x: number, y: number) => ({ clientX: rect.left + x / dpr, clientY: rect.top + y / dpr, pointerId: 1, pointerType: 'mouse' });
  const actorPoint = (id: string) => {
    const box = game.boxOf(id);
    if (!box) throw new Error('Agent has no hit box');
    return point((box.left + box.right) / 2, (box.top + box.bottom) / 2);
  };
  const tap = (at: PointerEventInit) => { fireEvent.pointerDown(canvas, at); fireEvent.pointerUp(canvas, at); };
  return { ...mounted, game, canvas, list: screen.getByRole('listbox'), point, actorPoint, tap };
}

describe('office DOM input with the real engine', () => {
  it('picks the visible agent using CSS coordinates at DPR 2 and gives it a reaction', () => {
    const { game, canvas, list, actorPoint, tap } = mountInput({ dpr: 2 });
    const at = actorPoint(ids[0]);
    fireEvent.pointerMove(canvas, at);
    expect(screen.getByLabelText('Hover')).toHaveTextContent(ids[0]);
    const box = game.boxOf(ids[0]);
    if (!box) throw new Error('Missing rendered agent');
    expect(screen.getByLabelText('Anchor')).toHaveTextContent(`${String(rect.left + box.left / 2)},${String(rect.top + box.top / 2)}`);
    tap(at);
    expect(list).toHaveFocus();
    expect(screen.getByLabelText('Selection')).toHaveTextContent(ids[0]);
    expect(game.world.actors.get(ids[0])?.emote?.icon).toBe('idea');
    tap({ ...actorPoint(ids[1]), button: 2 });
    expect(screen.getByLabelText('Selection')).toHaveTextContent(ids[0]);
    expect(game.presses.size).toBe(0);
  });

  it('pans on drag, suppresses tap selection and clears a cancelled pointer', () => {
    const { game, canvas, point } = mountInput();
    game.zoomTo(game.target.zoom + 1);
    const before = { ...game.target };
    const at = point(500, 350);
    fireEvent.pointerDown(canvas, at);
    fireEvent.pointerMove(canvas, { ...at, clientX: at.clientX + 80, clientY: at.clientY - 50 });
    expect(screen.getByLabelText('Gesture')).toHaveTextContent('grabbing');
    expect(screen.getByLabelText('Hint')).toHaveTextContent('dismissed');
    expect(game.target).not.toEqual(before);
    fireEvent.pointerCancel(canvas, at);
    expect(screen.getByLabelText('Gesture')).toHaveTextContent('idle');
    expect(screen.getByLabelText('Selection')).toHaveTextContent('none');
    expect(game.presses.size).toBe(0);
    expect(game.pendingWalk).toBe(0);
  });

  it('zooms with two fingers and never walks or selects when they lift', () => {
    const { game, canvas, point } = mountInput();
    const before = game.target.zoom;
    const a = { ...point(400, 320), pointerId: 1, pointerType: 'touch' };
    const b = { ...point(560, 320), pointerId: 2, pointerType: 'touch' };
    fireEvent.pointerDown(canvas, a); fireEvent.pointerDown(canvas, b);
    fireEvent.pointerMove(canvas, { ...b, clientX: b.clientX + 110 });
    expect(game.target.zoom).toBeGreaterThan(before);
    expect(screen.getByLabelText('Hint')).toHaveTextContent('dismissed');
    fireEvent.pointerUp(canvas, b); fireEvent.pointerUp(canvas, a);
    expect(game.pinch).toBeNull();
    expect(game.presses.size).toBe(0);
    expect(game.pendingWalk).toBe(0);
    expect(screen.getByLabelText('Selection')).toHaveTextContent('none');
  });

  it('lets wheel scroll the page at limits and clipping, but consumes a trackpad pinch', () => {
    const { game, canvas, list, point } = mountInput();
    const zoom = game.target.zoom;
    expect(fireEvent.wheel(canvas, { ...point(480, 320), deltaY: 100, cancelable: true })).toBe(true);
    expect(game.target.zoom).toBe(zoom);
    expect(fireEvent.wheel(canvas, { ...point(480, 320), deltaY: -100, cancelable: true })).toBe(false);
    expect(game.target.zoom).toBeGreaterThan(zoom);
    const beforeClip = game.target.zoom;
    list.style.overflowY = 'auto';
    Object.defineProperties(list, { scrollHeight: { value: 800 }, clientHeight: { value: 300 } });
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 300));
    expect(fireEvent.wheel(canvas, { deltaY: 100, cancelable: true })).toBe(true);
    expect(game.target.zoom).toBe(beforeClip);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, -100, 960, 640));
    expect(fireEvent.wheel(canvas, { deltaY: -100, cancelable: true })).toBe(true);
    expect(game.target.zoom).toBe(beforeClip);
    expect(fireEvent.wheel(canvas, { deltaY: -3, ctrlKey: true, clientX: 500, clientY: 300, cancelable: true })).toBe(false);
    expect(game.target.zoom).toBeGreaterThan(beforeClip);
  });

  it('double taps zoom instead of walking and discards a pending walk on unmount', () => {
    vi.useFakeTimers();
    const { game, tap, point, unmount } = mountInput();
    const level = game.levelOf(roomId);
    if (!level) throw new Error('Missing room');
    const walkable = level.walkable.findIndex(Boolean);
    const at = worldToScreen(game.cam, game.view, { x: (walkable % level.cols + 0.5) * TILE, y: (Math.floor(walkable / level.cols) + 0.5) * TILE - 2 });
    const before = { ...game.avatar };
    tap(point(at.x, at.y));
    expect(game.pendingWalk).not.toBe(0);
    const zoom = game.target.zoom;
    act(() => { vi.advanceTimersByTime(20); });
    tap(point(at.x, at.y));
    expect(game.target.zoom).toBeGreaterThan(zoom);
    expect(game.pendingWalk).toBe(0);
    act(() => { vi.advanceTimersByTime(DOUBLE_MS + 10); });
    expect(game.avatar.x).toBe(before.x); expect(game.avatar.y).toBe(before.y);
    game.lastTap = null;
    tap(point(-500, -500));
    unmount();
    act(() => { vi.advanceTimersByTime(DOUBLE_MS + 10); });
    expect(game.marker).toBeNull();
  });

  it('walks after a single floor tap and marks an unreachable destination', () => {
    vi.useFakeTimers();
    const { game, tap, point } = mountInput();
    const level = game.levelOf(roomId);
    if (!level) throw new Error('Missing room');
    const walkable = level.walkable.findIndex(Boolean);
    const dest = { x: (walkable % level.cols + 0.5) * TILE, y: (Math.floor(walkable / level.cols) + 0.5) * TILE };
    const at = worldToScreen(game.cam, game.view, { ...dest, y: dest.y - 2 });
    tap(point(at.x, at.y));
    act(() => { vi.advanceTimersByTime(DOUBLE_MS + 1); });
    expect(game.marker?.ok).toBe(true);
    expect(screen.getByLabelText('Walk')).toHaveTextContent('on');
    expect(game.avatar.route).toHaveLength(0);
    game.lastTap = null;
    tap(point(-500, -500));
    act(() => { vi.advanceTimersByTime(DOUBLE_MS + 1); });
    expect(game.marker?.ok).toBe(false);
  });

  it('uses arrows to choose agents, opens the keyboard menu and clears selection in stages', () => {
    const { game, list } = mountInput();
    fireEvent.keyDown(list, { key: 'Home' });
    const first = screen.getByLabelText('Cursor').textContent;
    expect(ids).toContain(first);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(screen.getByLabelText('Selection')).toHaveTextContent(first);
    fireEvent.keyDown(list, { key: 'ContextMenu' });
    expect(screen.getByLabelText('Menu')).not.toHaveTextContent(/^$/u);
    fireEvent.keyDown(list, { key: 'End' });
    expect(screen.getByLabelText('Cursor').textContent).not.toBe(first);
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(ids).toContain(screen.getByLabelText('Cursor').textContent);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByLabelText('Cursor')).toHaveTextContent('none');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByLabelText('Selection')).toHaveTextContent('none');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(game.level).toBe(CAMPUS);
  });

  it('handles view keys and walk conversation without treating modifiers as movement', () => {
    const { game, list } = mountInput({ reducedMotion: false });
    const zoom = game.target.zoom;
    fireEvent.keyDown(list, { key: '+', ctrlKey: true });
    expect(game.target.zoom).toBe(zoom);
    fireEvent.keyDown(list, { key: '+' });
    expect(game.target.zoom).toBeGreaterThan(zoom);
    fireEvent.keyDown(list, { key: '-' });
    fireEvent.keyDown(list, { key: '0' });
    expect(game.target.zoom).toBe(game.limits.min);
    fireEvent.keyDown(list, { key: '1' });
    expect(screen.getByLabelText('Talk')).toHaveTextContent('hotbar');
    fireEvent.keyDown(list, { key: 'W' }); expect(game.keys.has('w')).toBe(true);
    fireEvent.keyUp(list, { key: 'W' }); expect(game.keys.has('w')).toBe(false);
    fireEvent.keyDown(list, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyUp(list, { key: 'Shift' }); expect(game.keys.has('ArrowUp')).toBe(false);
    fireEvent.keyDown(list, { key: 'p' });
    game.nearby = ids[1];
    fireEvent.keyDown(list, { key: 'e' });
    expect(screen.getByLabelText('Talk')).toHaveTextContent(ids[1]);
    fireEvent.keyDown(list, { key: 'ArrowDown' }); expect(game.keys.has('ArrowDown')).toBe(true);
    fireEvent.keyUp(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByLabelText('Walk')).toHaveTextContent('off');
    fireEvent.keyDown(list, { key: 'c' }); expect(game.following).toBe(true);
  });

  it('hovers and enters a campus building, then exits through its door by tapping', () => {
    const { game, canvas, point, tap } = mountInput({ interior: false });
    const site = map.campus.siteOf.get(roomId);
    if (!site) throw new Error('Missing campus building');
    const at = worldToScreen(game.cam, game.view, { x: (site.x + site.w / 2) * TILE, y: (site.y + 1) * TILE });
    fireEvent.pointerMove(canvas, point(at.x, at.y));
    expect(screen.getByLabelText('Site')).toHaveTextContent(roomId);
    expect(screen.getByLabelText('Hover')).toHaveTextContent('none');
    fireEvent.pointerMove(canvas, { ...point(-500, -500), pointerType: 'touch' });
    expect(screen.getByLabelText('Site')).toHaveTextContent(roomId);
    tap(point(at.x, at.y));
    expect(game.level).toBe(roomId);
    expect(screen.getByLabelText('Hint')).toHaveTextContent('dismissed');
    const level = game.levelOf(roomId);
    if (!level) throw new Error('Missing interior');
    const door = worldToScreen(game.cam, game.view, { x: (level.door.tile.x + 0.5) * TILE, y: (level.rows - 0.5) * TILE });
    game.lastTap = null;
    tap(point(door.x, door.y));
    expect(game.level).toBe(CAMPUS);
    expect(game.pendingWalk).toBe(0);
  });

  it('moves one tile per arrow in reduced motion and leaves scrolling free after unmount', () => {
    const { game, list, canvas, unmount } = mountInput();
    fireEvent.keyDown(list, { key: 'p' });
    const before = tileAt(game.avatar.x, game.avatar.y);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(tileAt(game.avatar.x, game.avatar.y)).toEqual({ x: before.x, y: before.y - 1 });
    expect(game.keys.size).toBe(0);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByLabelText('Walk')).toHaveTextContent('off');
    const zoom = game.target.zoom;
    unmount();
    expect(fireEvent.wheel(canvas, { deltaY: -100, cancelable: true })).toBe(true);
    expect(game.target.zoom).toBe(zoom);
  });
});

function FrameHarness({ blocked = false }: { blocked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const block = useRef(blocked); block.current = blocked;
  const box = useFrameSize(ref);
  const height = useHeight(ref);
  const [maximized, toggle] = useMaximized(ref, block);
  return <div ref={ref} data-testid="frame"><button onClick={toggle}>Maximize</button>
    <output aria-label="Size">{`${String(box.width)}×${String(box.height)}@${String(box.dpr)}`}</output>
    <output aria-label="Height">{height}</output><output aria-label="Maximized">{String(maximized)}</output></div>;
}

describe('office browser lifecycle with controlled observer APIs', () => {
  it('measures resize, clamps DPR and removes observers and window listeners', () => {
    const notifications: ResizeObserverCallback[] = [];
    const observed = new Set<Element>();
    class Observer {
      constructor(callback: ResizeObserverCallback) { notifications.push(callback); }
      observe(element: Element) { observed.add(element); }
      disconnect() { observed.clear(); }
      unobserve(element: Element) { observed.delete(element); }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    const { unmount } = render(<FrameHarness />);
    const frame = screen.getByTestId('frame');
    Object.defineProperties(frame, { clientWidth: { configurable: true, value: 503.9 }, clientHeight: { configurable: true, value: 310.8 } });
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 503.9, 47.6));
    vi.stubGlobal('devicePixelRatio', 4);
    act(() => { for (const notify of notifications) notify([], {} as ResizeObserver); });
    expect(screen.getByLabelText('Size')).toHaveTextContent('503×310@3');
    expect(screen.getByLabelText('Height')).toHaveTextContent('48');
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 0 });
    fireEvent.resize(window);
    expect(screen.getByLabelText('Size')).toHaveTextContent('503×310@3');
    const remove = vi.spyOn(window, 'removeEventListener');
    unmount();
    expect(observed.size).toBe(0);
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('keeps maximize open when Escape is blocked and follows native fullscreen exit', async () => {
    const { rerender, unmount } = render(<FrameHarness blocked />);
    const frame = screen.getByTestId('frame');
    Object.defineProperty(frame, 'requestFullscreen', { value: () => Promise.reject(new Error('Unsupported')) });
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Maximized')).toHaveTextContent('true');
    rerender(<FrameHarness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Maximized')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: frame });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Maximized')).toHaveTextContent('true');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByLabelText('Maximized')).toHaveTextContent('false');
    await act(async () => { await Promise.resolve(); });
    unmount();
  });

  it('suspends the animation when hidden or offscreen and cancels it on unmount', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    let visible: IntersectionObserverCallback | undefined;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { visible = callback; }
      observe(element: Element) { observed.add(element); }
      disconnect() { observed.clear(); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    function EngineHarness() {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      const engine = useOfficeEngine({ canvasRef, map, inputs: [], reducedMotion: false, night: false,
        props: { selected: null, hovered: null, highlight: null, names: new Map(), stats: new Map(), talkId: null } });
      return <canvas ref={canvasRef} aria-label={engine.level} />;
    }
    const { unmount } = render(<EngineHarness />);
    expect(frames.size).toBe(1);
    hidden.mockReturnValue(true); fireEvent(document, new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange'));
    expect(frames.size).toBe(1);
    act(() => { visible?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(frames.size).toBe(0);
    act(() => { visible?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0); expect(observed.size).toBe(0);
    fireEvent(document, new Event('visibilitychange'));
    expect(frames.size).toBe(0);
  });
});
