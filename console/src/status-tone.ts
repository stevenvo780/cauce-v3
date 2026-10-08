import type { LiveState } from './features/live/agent-state';

/** The single state→colour map. Chips, badges, orbs, the office and the terminal all read it. */
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'violet' | 'neutral';

export const STATE_TONE: Record<LiveState, Tone> = {
  down: 'danger',
  blocked: 'warn',
  delegating: 'violet',
  settled: 'info',
  receiving: 'info',
  thinking: 'ok',
  idle: 'neutral',
};

/** Utility classes per tone: a dot, a soft pill and plain ink. Literal strings so Tailwind sees them. */
export const TONE_CLASS: Record<Tone, { dot: string; pill: string; ink: string }> = {
  ok: { dot: 'bg-ok', pill: 'bg-ok-soft text-ok-ink', ink: 'text-ok-ink' },
  info: { dot: 'bg-info', pill: 'bg-info-soft text-info-ink', ink: 'text-info-ink' },
  warn: { dot: 'bg-warn', pill: 'bg-warn-soft text-warn-ink', ink: 'text-warn-ink' },
  danger: { dot: 'bg-danger', pill: 'bg-danger-soft text-danger-ink', ink: 'text-danger-ink' },
  violet: { dot: 'bg-violet', pill: 'bg-violet-soft text-violet-ink', ink: 'text-violet-ink' },
  neutral: { dot: 'bg-line-strong', pill: 'bg-muted-bg text-muted', ink: 'text-muted' },
};
