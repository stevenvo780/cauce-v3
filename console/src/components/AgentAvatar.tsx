import type { LeaseState } from '../lib';

interface AgentAvatarProps {
  alias: string;
  tenantId: string;
  state?: LeaseState;
  working?: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function AgentAvatar({ alias, tenantId, state, working }: AgentAvatarProps) {
  const identity = `${tenantId}:${alias}`;
  let hash = 0;
  for (const character of identity) hash += character.codePointAt(0) ?? 0;
  const initials = Array.from(graphemes.segment(alias), ({ segment }) => segment).slice(0, 2).join('').toUpperCase();
  return <span className="agent-avatar" data-color={hash % 5} data-state={state} data-working={working} aria-hidden="true">
    {initials}
    {state ? <span className="agent-avatar-status" /> : null}
  </span>;
}
