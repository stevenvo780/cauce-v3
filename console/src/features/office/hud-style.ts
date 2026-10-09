import type { LiveState } from '../live/agent-state';

/** The game's HUD keeps its own dark palette in both themes: it sits over the pixel world, not on the page. */
export const HUD = {
  ink: '#f4f4f4',
  muted: '#94b0c2',
  panel: '#1a1c2c',
  edge: '#0e0f17',
  raised: '#333c57',
  light: '#566c86',
  gold: '#ffcd75',
  red: '#b13e53',
} as const;

export const HUD_PANEL = 'border-2 border-[#0e0f17] bg-[#1a1c2c]/95 text-[#f4f4f4] shadow-[inset_0_0_0_1px_#333c57,0_3px_0_0_rgba(0,0,0,0.4)]';

export const HUD_TEXT = 'font-mono text-[11px] leading-none font-bold tracking-wide uppercase';

export const HUD_BUTTON = 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border-2 border-[#0e0f17] bg-[#333c57] text-[#f4f4f4] shadow-[inset_0_-2px_0_0_#1a1c2c,inset_0_2px_0_0_#566c86] hover:bg-[#3e486a] active:translate-y-px disabled:cursor-default disabled:opacity-40 disabled:active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#ffcd75]';

export const HUD_ON = 'bg-[#ffcd75] text-[#1a1c2c] shadow-[inset_0_-2px_0_0_#c7861d,inset_0_2px_0_0_#fff1c4] hover:bg-[#ffd98f]';

export const HUD_ICON_BUTTON = `${HUD_BUTTON} size-9 pointer-coarse:size-11`;

/** State colours in the HUD and on the map, from the same pixel palette as the art. */
export const STATE_PIXEL: Readonly<Record<LiveState, string>> = {
  down: '#b13e53',
  blocked: '#ef7d57',
  delegating: '#a884f3',
  receiving: '#41a6f6',
  thinking: '#38b764',
  settled: '#73eff7',
  idle: '#94b0c2',
};

export const relativeTime = (ms: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `hace ${String(minutes)} min` : `hace ${String(Math.round(minutes / 60))} h`;
};
