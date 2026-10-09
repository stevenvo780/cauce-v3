import { useEffect, useMemo, type MouseEvent, type RefObject } from 'react';
import { cn } from '../../cn';
import { centerOn, originOf } from './camera';
import type { OfficeEngine } from './engine';
import { HUD_PANEL } from './hud-style';
import { CAMPUS, TILE } from './level';
import { drawMinimap, minimapSize, minimapToWorld } from './minimap';

const REFRESH_MS = 250;

/** The campus from above in a corner: houses in their colours, people outside, capsules in the tubes; a click goes there. */
export function CampusMap({ canvasRef, open, engine, level, stats, onGo, kick }: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  open: boolean;
  engine: OfficeEngine;
  level: string;
  stats: ReadonlyMap<string, { members: number; alerts: number }>;
  onGo: (id: string) => void;
  kick: () => void;
}) {
  const campus = engine.world.map.campus;
  const size = useMemo(() => minimapSize(campus, { width: 200, height: 132 }), [campus]);
  const alerts = useMemo(() => new Map([...stats].map(([id, entry]) => [id, entry.alerts])), [stats]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas) return undefined;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const paint = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.setTransform !== 'function') return;
      const { cam, view } = engine;
      const origin = originOf(cam, view);
      const shown = engine.level === CAMPUS
        ? { x: -origin.x / cam.zoom, y: -origin.y / cam.zoom, w: view.width / cam.zoom, h: view.height / cam.zoom }
        : null;
      const states = new Map([...engine.world.actors.values()].map((actor) => [actor.id, actor.state]));
      drawMinimap(ctx, { campus: engine.world.map.campus, world: engine.world, level: engine.level, view: shown, alerts, states }, canvas.width, canvas.height, performance.now() / 1000);
    };
    paint();
    const timer = window.setInterval(paint, REFRESH_MS);
    return () => { window.clearInterval(timer); };
  }, [open, canvasRef, size, engine, alerts, level]);

  if (!open) return null;
  const jump = (event: MouseEvent<HTMLCanvasElement>) => {
    const point = minimapToWorld(campus, event.currentTarget.getBoundingClientRect(), { x: event.clientX, y: event.clientY });
    const site = campus.sites.find((item) => point.x >= item.x * TILE - 4 && point.x < (item.x + item.w) * TILE + 4 && point.y >= item.y * TILE - 8 && point.y < (item.y + item.h) * TILE + 4);
    if (site) {
      onGo(site.id);
      return;
    }
    if (engine.level !== CAMPUS) {
      onGo(CAMPUS);
      return;
    }
    engine.following = false;
    engine.flying = true;
    engine.untouched = false;
    engine.target = engine.clamp(centerOn(engine.target, point, engine.inset));
    kick();
  };
  return (
    <div className={cn(HUD_PANEL, 'pointer-events-auto p-1')}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        onClick={jump}
        title="Mapa del campus: clic en un edificio para entrar"
        style={{ width: size.width, height: size.height }}
        className="block cursor-pointer [image-rendering:pixelated]"
      />
    </div>
  );
}
