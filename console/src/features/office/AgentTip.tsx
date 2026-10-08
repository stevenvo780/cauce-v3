import { cn } from '../../cn';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { LIVE_STATE_META } from '../live/agent-state';
import type { OfficeAgent } from './OfficeCanvas';

/** Hover card of an agent: name, state, why, and the group it sits with. */
export function AgentTip({ agent }: { agent: OfficeAgent }) {
  const tone = TONE_CLASS[STATE_TONE[agent.state]];
  const others = agent.groups ?? [];
  return (
    <>
      <strong>{agent.name}</strong>
      <span className={cn('mt-1 inline-flex items-center gap-1.5 text-xs font-medium', tone.ink)}>
        <span className={cn('size-1.5 rounded-full', tone.dot)} aria-hidden="true" />
        {LIVE_STATE_META[agent.state].label}
      </span>
      {agent.visitor || !agent.team ? null : (
        <span className="mt-0.5 block text-xs text-fg-2">
          Grupo: {agent.team.label}{others.length > 0 ? ` · también en ${others.join(', ')}` : ''}
        </span>
      )}
      <p>{agent.reason}</p>
    </>
  );
}
