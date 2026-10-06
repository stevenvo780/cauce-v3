import type { LiveState } from '../live/agent-state';

export type Pose =
  | 'stand' | 'walk' | 'sit' | 'type' | 'sleep' | 'nap' | 'stretch' | 'coffee' | 'handover' | 'ghost';
export type BubbleKind = 'mail' | 'alert' | 'paper' | 'zzz' | null;
export type MonitorMode = 'code' | 'error' | 'idle' | 'off';

export interface Behaviour {
  /** Where the person ends up once any errand is done. */
  rest: 'desk' | 'lounge' | 'coffee';
  pose: Pose;
  bubble: BubbleKind;
  /** What they do before resting; `deliver` repeats for as long as the state lasts. */
  errand: 'deliver' | 'wander' | 'stretch' | null;
  shake: boolean;
  monitor: MonitorMode;
}

/** How each live state is acted out in the office. Kept as data so the mapping is testable at a glance. */
export const BEHAVIOUR: Record<LiveState, Behaviour> = {
  thinking: { rest: 'desk', pose: 'type', bubble: null, errand: null, shake: false, monitor: 'code' },
  receiving: { rest: 'desk', pose: 'sit', bubble: 'mail', errand: null, shake: false, monitor: 'code' },
  delegating: { rest: 'desk', pose: 'type', bubble: null, errand: 'deliver', shake: false, monitor: 'code' },
  blocked: { rest: 'desk', pose: 'sit', bubble: 'alert', errand: null, shake: true, monitor: 'error' },
  settled: { rest: 'coffee', pose: 'coffee', bubble: null, errand: 'stretch', shake: false, monitor: 'idle' },
  idle: { rest: 'lounge', pose: 'sleep', bubble: 'zzz', errand: 'wander', shake: false, monitor: 'idle' },
  down: { rest: 'desk', pose: 'ghost', bubble: null, errand: null, shake: false, monitor: 'off' },
};

export function behaviourFor(state: LiveState): Behaviour {
  return BEHAVIOUR[state];
}
