import { pixelIconLoader } from './loaders';
import { svgToPathData } from './svg-shapes';

const settled = new Map<string, string | null>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Path data of an icon once it has loaded; `null` when the name is unknown or its SVG is unusable. */
export function pixelIconPath(name: string): string | null | undefined {
  return settled.get(name);
}

export function subscribePixelIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function requestPixelIcon(name: string): void {
  if (settled.has(name) || pending.has(name)) return;
  const load = pixelIconLoader(name);
  const finish = (path: string | null) => {
    settled.set(name, path);
    pending.delete(name);
    listeners.forEach((listener) => { listener(); });
  };
  if (!load) { settled.set(name, null); return; }
  pending.set(name, load().then((svg) => { finish(svgToPathData(svg)); }, () => { finish(null); }));
}
