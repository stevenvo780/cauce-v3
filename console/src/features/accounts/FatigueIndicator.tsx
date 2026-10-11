import { AlertTriangle, BatteryFull, BatteryLow, BatteryWarning, CircleHelp, Clock, PauseCircle } from 'lucide-react';
import { FATIGUE_LABEL, type FatigueState } from './quota-availability';

export function FatigueIndicator({ state }: { state: FatigueState }) {
  const Icon = state === 'available' ? BatteryFull : state === 'low' ? BatteryLow : state === 'exhausted' ? BatteryWarning
    : state === 'error' ? AlertTriangle : state === 'stale' ? Clock : state === 'paused' ? PauseCircle : CircleHelp;
  const color = state === 'available' ? 'text-ok-ink' : state === 'low' || state === 'stale' ? 'text-warn-ink'
    : state === 'exhausted' || state === 'error' ? 'text-danger-ink' : 'text-muted';
  return <span className={`inline-flex items-center gap-1 text-xs ${color}`} data-fatigue={state}>
    <Icon size={16} aria-hidden="true" /><span>{FATIGUE_LABEL[state]}</span>
  </span>;
}
