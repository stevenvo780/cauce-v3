import type { LiveState } from '../live/agent-state';

export type Pose =
  | 'stand' | 'walk' | 'sit' | 'type' | 'lie' | 'play' | 'stretch' | 'coffee' | 'handover' | 'ghost'
  | 'cook' | 'eat' | 'tidy' | 'sweep' | 'water' | 'read' | 'chat';
export type BubbleKind = 'mail' | 'alert' | 'paper' | 'zzz' | 'chat' | null;
/** code: scrolling lines; error: red screen when down; alert: amber when blocked; dim: resting; off: asleep or unplugged. */
export type MonitorMode = 'code' | 'error' | 'alert' | 'dim' | 'off';

export interface Behaviour {
  /** Where the person spends the state: their own desk, or the daily routine of the free. */
  rest: 'desk' | 'routine';
  pose: Pose;
  bubble: BubbleKind;
  /** `deliver` walks paper to the delegate for as long as the state lasts. */
  errand: 'deliver' | null;
  shake: boolean;
  monitor: MonitorMode;
}

/** How each live state is acted out; whoever has no work follows the routine in `routine.ts`. */
export const BEHAVIOUR: Record<LiveState, Behaviour> = {
  thinking: { rest: 'desk', pose: 'type', bubble: null, errand: null, shake: false, monitor: 'code' },
  receiving: { rest: 'desk', pose: 'sit', bubble: 'mail', errand: null, shake: false, monitor: 'code' },
  delegating: { rest: 'desk', pose: 'type', bubble: null, errand: 'deliver', shake: false, monitor: 'code' },
  blocked: { rest: 'desk', pose: 'sit', bubble: 'alert', errand: null, shake: true, monitor: 'alert' },
  settled: { rest: 'routine', pose: 'stand', bubble: null, errand: null, shake: false, monitor: 'dim' },
  idle: { rest: 'routine', pose: 'stand', bubble: null, errand: null, shake: false, monitor: 'dim' },
  down: { rest: 'desk', pose: 'ghost', bubble: null, errand: null, shake: false, monitor: 'error' },
};

export function behaviourFor(state: LiveState): Behaviour {
  return BEHAVIOUR[state];
}
