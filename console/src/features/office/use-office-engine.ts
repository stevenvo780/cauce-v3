import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { OfficeEngine, type EngineProps } from './engine';
import { makeCanvas } from './frame';
import { CAMPUS } from './level';
import type { ActorInput } from './simulation';
import { mergeFeed, type FeedEntry } from './feed';
import type { WorldMap } from './world-map';

/** Deliveries and the feed outlive the page: coming back to the campus does not send the same capsule twice. */
const memory = { seen: new Set<string>(), feed: [] as FeedEntry[], level: CAMPUS };

export interface EngineState {
  engine: OfficeEngine;
  level: string;
  nearby: string | null;
  edges: { atMin: boolean; atMax: boolean };
  occupancy: ReadonlyMap<string, number>;
  feed: readonly FeedEntry[];
  kick: () => void;
}

/**
 * Owns the campus engine for one canvas: feeds it the map, the fleet and the page's props, sizes
 * it, and runs the frame loop only while the canvas is on screen and motion is allowed.
 */
export function useOfficeEngine({ canvasRef, map, inputs, reducedMotion, night, props }: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  map: WorldMap;
  inputs: readonly ActorInput[];
  reducedMotion: boolean;
  night: boolean;
  props: EngineProps;
}): EngineState {
  const [level, setLevel] = useState(() => (map.levels.has(memory.level) ? memory.level : CAMPUS));
  const [nearby, setNearby] = useState<string | null>(null);
  const [edges, setEdges] = useState({ atMin: true, atMax: false });
  const [occupancy, setOccupancy] = useState<ReadonlyMap<string, number>>(new Map());
  const [feed, setFeed] = useState<readonly FeedEntry[]>(memory.feed);
  const [engine] = useState(() => {
    const created = new OfficeEngine(map, reducedMotion, makeCanvas, {
      level: (id) => {
        memory.level = id;
        setLevel(id);
      },
      nearby: setNearby,
      edges: (atMin, atMax) => { setEdges({ atMin, atMax }); },
      occupancy: setOccupancy,
      tube: (event) => {
        memory.feed = mergeFeed(memory.feed, event);
        setFeed(memory.feed);
      },
    }, memory.seen);
    if (level !== CAMPUS) created.level = level;
    return created;
  });
  engine.props = props;
  engine.night = night;
  const kickRef = useRef<() => void>(() => undefined);
  const kick = useCallback(() => { kickRef.current(); }, []);

  useEffect(() => {
    engine.setMap(map);
    kick();
  }, [engine, map, kick]);

  useEffect(() => {
    engine.sync(inputs);
    kick();
  }, [engine, inputs, kick]);

  useEffect(() => {
    engine.setReducedMotion(reducedMotion);
    kick();
  }, [engine, reducedMotion, kick]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let visible = true;
    let frame = 0;
    let looping = false;
    let last = performance.now();
    const render = (now: number, dt: number) => {
      engine.tick(now, dt);
      const ctx = canvas.getContext('2d');
      if (ctx) engine.draw(ctx, now / 1000);
    };
    const loop = (now: number) => {
      render(now, (now - last) / 1000);
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
    const stop = () => {
      looping = false;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    kickRef.current = () => {
      if (looping || frame) return;
      frame = requestAnimationFrame((now) => {
        frame = 0;
        last = now;
        render(now, 0);
      });
    };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start(); else stop();
    });
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    render(performance.now(), 0);
    start();
    return () => {
      stop();
      kickRef.current = () => undefined;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [engine, canvasRef, reducedMotion]);

  return { engine, level, nearby, edges, occupancy, feed, kick };
}
