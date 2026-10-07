import type { LiveState } from '../live/agent-state';

export type Pose =
  | 'stand' | 'walk' | 'sit' | 'type' | 'lie' | 'play' | 'stretch' | 'coffee' | 'handover' | 'ghost';
export type BubbleKind = 'mail' | 'alert' | 'paper' | 'zzz' | null;
export type MonitorMode = 'code' | 'error' | 'idle' | 'off';

export interface Behaviour {
  /** Where the person ends up once any errand is done. */
  rest: 'desk' | 'bed' | 'patio';
  pose: Pose;
  bubble: BubbleKind;
  /** What they do before resting; `deliver` repeats for as long as the state lasts. */
  errand: 'deliver' | 'wander' | 'coffee' | null;
  shake: boolean;
  monitor: MonitorMode;
}

/** How each live state is acted out; `AWAKE_IDLE` is idle but active a moment ago, so still up and playing. */
export const BEHAVIOUR: Record<LiveState, Behaviour> = {
  thinking: { rest: 'desk', pose: 'type', bubble: null, errand: null, shake: false, monitor: 'code' },
  receiving: { rest: 'desk', pose: 'sit', bubble: 'mail', errand: null, shake: false, monitor: 'code' },
  delegating: { rest: 'desk', pose: 'type', bubble: null, errand: 'deliver', shake: false, monitor: 'code' },
  blocked: { rest: 'desk', pose: 'sit', bubble: 'alert', errand: null, shake: true, monitor: 'error' },
  settled: { rest: 'patio', pose: 'play', bubble: null, errand: 'coffee', shake: false, monitor: 'idle' },
  idle: { rest: 'bed', pose: 'lie', bubble: 'zzz', errand: 'wander', shake: false, monitor: 'idle' },
  down: { rest: 'desk', pose: 'ghost', bubble: null, errand: null, shake: false, monitor: 'off' },
};

export const AWAKE_IDLE: Behaviour = { rest: 'patio', pose: 'play', bubble: null, errand: 'coffee', shake: false, monitor: 'idle' };

export function behaviourFor(state: LiveState, awake = false): Behaviour {
  return state === 'idle' && awake ? AWAKE_IDLE : BEHAVIOUR[state];
}
