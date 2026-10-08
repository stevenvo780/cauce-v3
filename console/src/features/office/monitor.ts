import type { LiveState } from '../live/agent-state';
import { behaviourFor, type MonitorMode } from './behaviour';

/** The desk screen tells the state at a glance; whoever is asleep in bed leaves it dark. */
export function deskMonitor(state: LiveState, asleep: boolean): MonitorMode {
  return asleep ? 'off' : behaviourFor(state).monitor;
}
