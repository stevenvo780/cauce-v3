import { useEffect, useState, type RefObject } from 'react';
import type { AgentRef } from '../../components/agent-actions/agent-actions';
import type { Vec } from './camera';
import type { Clipping } from './gesture';

let hintRemembered = false;

/** Office ids are `tenant/alias`; tenants never contain a slash. */
export function agentRefOf(id: string): AgentRef | null {
  const cut = id.indexOf('/');
  return cut > 0 ? { tenantId: id.slice(0, cut), alias: id.slice(cut + 1) } : null;
}

/** Where a right click or a long press landed. */
export function clientPointOf(event: Event | undefined): Vec | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if ('TouchEvent' in window && event instanceof TouchEvent) {
    const touch = event.touches.item(0) ?? event.changedTouches.item(0);
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

export const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

export function hintSeen(): boolean {
  return hintRemembered;
}

export function rememberHint(): void {
  hintRemembered = true;
}

export function scrollBand(element: HTMLElement): { top: number; bottom: number } {
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

export function clippingOf(element: HTMLElement): Clipping {
  const rect = element.getBoundingClientRect();
  const band = scrollBand(element);
  return { above: rect.top < band.top - 1, below: rect.bottom > band.bottom + 1 };
}

/** The element's size in CSS px and the device pixel ratio, kept current as either changes. */
export function useFrameSize(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 960, height: 640, dpr: 1 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      const height = Math.floor(element.clientHeight);
      if (width <= 0 || height <= 0) return;
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

/** Height in CSS px of an element, for the camera to keep the map clear of the HUD bars. */
export function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => { setHeight(Math.round(element.getBoundingClientRect().height)); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [ref]);
  return height;
}

export function useMaximized(ref: RefObject<HTMLElement | null>, escapeBlocked: RefObject<boolean>): [boolean, () => void] {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!maximized) return undefined;
    const onFullscreen = () => { if (!document.fullscreenElement) setMaximized(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !escapeBlocked.current && !document.fullscreenElement) setMaximized(false);
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('keydown', onKey);
    };
  }, [maximized, escapeBlocked]);
  const toggle = () => {
    if (maximized) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setMaximized(false);
      return;
    }
    setMaximized(true);
    const frame = ref.current;
    if (frame && 'requestFullscreen' in frame) void frame.requestFullscreen().catch(() => undefined);
  };
  return [maximized, toggle];
}
