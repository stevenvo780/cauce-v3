import type { LiveState } from '../live/agent-state';

export type Pose =
  | 'stand' | 'walk' | 'sit' | 'type' | 'lie' | 'play' | 'stretch' | 'coffee' | 'handover' | 'ghost'
  | 'cook' | 'eat' | 'tidy' | 'sweep' | 'water' | 'read' | 'chat' | 'hidden';
export type BubbleKind = 'mail' | 'alert' | 'paper' | 'zzz' | 'chat' | null;
/** code: scrolling lines; error: red screen when down; alert: amber when blocked; dim: resting; off: asleep or unplugged. */
export type MonitorMode = 'code' | 'error' | 'alert' | 'dim' | 'off';

export interface Behaviour {
  /** Where the state is spent: the own desk, the daily routine of the free, or the workshop when down. */
  rest: 'desk' | 'routine' | 'shop';
  pose: Pose;
  bubble: BubbleKind;
  shake: boolean;
  monitor: MonitorMode;
}

/** How each live state is acted out; whoever has no work follows the routine in `routine.ts`. */
export const BEHAVIOUR: Record<LiveState, Behaviour> = {
  thinking: { rest: 'desk', pose: 'type', bubble: null, shake: false, monitor: 'code' },
  receiving: { rest: 'desk', pose: 'sit', bubble: 'mail', shake: false, monitor: 'code' },
  delegating: { rest: 'desk', pose: 'type', bubble: null, shake: false, monitor: 'code' },
  blocked: { rest: 'desk', pose: 'sit', bubble: 'alert', shake: true, monitor: 'alert' },
  settled: { rest: 'routine', pose: 'stand', bubble: null, shake: false, monitor: 'dim' },
  idle: { rest: 'routine', pose: 'stand', bubble: null, shake: false, monitor: 'dim' },
  down: { rest: 'shop', pose: 'lie', bubble: null, shake: false, monitor: 'error' },
};

export function behaviourFor(state: LiveState): Behaviour {
  return BEHAVIOUR[state];
}
