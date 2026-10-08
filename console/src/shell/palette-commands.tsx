import type { ReactNode } from 'react';
import { AgentOrb } from '../components/AgentOrb';
import { agentKey, agentPaths } from '../components/agent-actions/agent-actions';
import { NAV_ENTRIES } from '../nav';

export interface Command { id: string; label: string; detail: string; href: string; icon: ReactNode; rank: number }

const AGENT_ACTIONS = [
  ['chat', 'Chat'], ['tui', 'TUI'], ['terminal', 'Terminal'], ['office', 'En la oficina'], ['context', 'Perfil y contexto'],
] as const;
const LIMIT = 14;

function rankOf(text: string, term: string): number {
  const value = text.toLocaleLowerCase();
  return value.startsWith(term) ? 0 : value.includes(term) ? 1 : -1;
}

/** Commands for a query: every action of the matching agents, then the sections. Empty query: favorites and sections. */
export function paletteCommands(agents: readonly { tenantId: string; alias: string }[], favorites: ReadonlySet<string> | undefined, query: string): Command[] {
  const term = query.trim().toLocaleLowerCase();
  const list: Command[] = [];
  for (const agent of agents) {
    const key = agentKey(agent);
    const rank = term ? Math.max(rankOf(agent.alias, term), rankOf(agent.tenantId, term) === -1 ? -1 : 2) : favorites?.has(key) ? 0 : -1;
    if (rank < 0) continue;
    const paths = agentPaths(agent);
    for (const [action, label] of term ? AGENT_ACTIONS : AGENT_ACTIONS.slice(0, 1)) {
      list.push({ id: `${key}:${action}`, label: agent.alias, detail: `${label} · ${agent.tenantId}`, href: paths[action], rank,
        icon: <AgentOrb seed={key} size={22} /> });
    }
  }
  for (const entry of NAV_ENTRIES) {
    const rank = term ? rankOf(entry.label, term) : 3;
    if (rank < 0) continue;
    const Icon = entry.icon;
    list.push({ id: `nav:${entry.id}`, label: entry.label, detail: 'Ir a la sección', href: `/${entry.id}`, rank: rank + 0.5,
      icon: <span className="grid size-[22px] place-items-center text-muted"><Icon size={16} aria-hidden={true} /></span> });
  }
  return list.sort((left, right) => left.rank - right.rank).slice(0, LIMIT);
}
