import type { MessagePage } from '../../api/types';
import type { LiveState } from '../live/agent-state';
import { humanAuthor } from '../terminal/message-author';
import { colaNecesitaAtencion, type SaludDeCola } from './queue-health';
import type { AgenteDeMensajeria } from './roster';

export type LauncherSectionId = 'favoritos' | 'recientes' | 'atencion' | 'todos' | 'resultados';

export const SECTION_TITLE: Record<LauncherSectionId, string> = {
  favoritos: 'Favoritos',
  recientes: 'Recientes',
  atencion: 'Necesitan atención',
  todos: 'Todos',
  resultados: 'Resultados',
};

export const MAX_RECENTS = 6;

export interface LastMessage {
  at: number;
  createdAt: string;
  text: string;
  /** Who wrote it, when it was not the agent itself. */
  from?: string;
}

export interface LauncherSection {
  id: LauncherSectionId;
  agents: AgenteDeMensajeria[];
}

const same = (left: unknown, right: string) => typeof left === 'string' && left.trim() === right;

/** Latest visible message per roster id, with the same sender/recipient pairing the thread uses. */
export function lastMessages(page: MessagePage | undefined, agents: readonly AgenteDeMensajeria[]): Map<string, LastMessage> {
  const result = new Map<string, LastMessage>();
  for (const message of page?.items ?? []) {
    const at = Date.parse(message.created_at ?? '');
    if (Number.isNaN(at)) continue;
    const author = humanAuthor(message);
    for (const agent of agents) {
      const output = !author && same(message.tenant_id, agent.tenantId) && same(message.actor_alias, agent.alias);
      const input = (message.deliveries ?? []).some((delivery) => (
        same(delivery.recipient_tenant, agent.tenantId) && same(delivery.recipient_alias, agent.alias)
      ));
      if (!output && !input) continue;
      const previous = result.get(agent.id);
      if (previous && previous.at >= at) continue;
      const sender = message.actor_alias?.trim();
      const from = output ? undefined : author ? 'Vos' : sender === '' ? undefined : sender;
      result.set(agent.id, { at, createdAt: message.created_at ?? '', text: message.body_preview?.trim() ?? '', from });
    }
  }
  return result;
}

export function needsAttention(state: LiveState, salud: SaludDeCola | undefined): boolean {
  return state === 'down' || state === 'blocked' || colaNecesitaAtencion(salud);
}

function matchRank(agent: AgenteDeMensajeria, term: string): number {
  const alias = agent.alias.toLocaleLowerCase();
  if (alias.startsWith(term)) return 0;
  if (alias.includes(term)) return 1;
  if (agent.tenantId.toLocaleLowerCase().includes(term)) return 2;
  if (`${agent.tenantId}/${agent.alias}`.toLocaleLowerCase().includes(term)) return 3;
  return -1;
}

/** Each agent lands in exactly one section, the first that claims it, so arrow keys never visit it twice. */
export function launcherSections(input: {
  agents: readonly AgenteDeMensajeria[];
  stateOf: (agent: AgenteDeMensajeria) => LiveState;
  salud: Record<string, SaludDeCola>;
  last: Map<string, LastMessage>;
  favorites?: ReadonlySet<string>;
  query?: string;
}): LauncherSection[] {
  const { agents, stateOf, salud, last, favorites } = input;
  const term = input.query?.trim().toLocaleLowerCase() ?? '';
  if (term) {
    const ranked = agents
      .map((agent, index) => ({ agent, index, rank: matchRank(agent, term) }))
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => left.rank - right.rank
        || (last.get(right.agent.id)?.at ?? 0) - (last.get(left.agent.id)?.at ?? 0)
        || left.index - right.index);
    return [{ id: 'resultados', agents: ranked.map((entry) => entry.agent) }];
  }

  const taken = new Set<string>();
  const claim = (list: readonly AgenteDeMensajeria[]) => list.filter((agent) => {
    if (taken.has(agent.id)) return false;
    taken.add(agent.id);
    return true;
  });
  const favorite = claim(agents.filter((agent) => favorites?.has(`${agent.tenantId}/${agent.alias}`)));
  const recent = claim(agents
    .filter((agent) => last.has(agent.id) && !taken.has(agent.id))
    .sort((left, right) => (last.get(right.id)?.at ?? 0) - (last.get(left.id)?.at ?? 0))
    .slice(0, MAX_RECENTS));
  const attention = claim(agents.filter((agent) => needsAttention(stateOf(agent), salud[agent.id])));
  const rest = claim(agents);
  const sections: LauncherSection[] = [
    { id: 'favoritos', agents: favorite },
    { id: 'recientes', agents: recent },
    { id: 'atencion', agents: attention },
    { id: 'todos', agents: rest },
  ];
  return sections.filter((section) => section.agents.length > 0);
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

interface Box { left: number; top: number; width: number; height: number }

/**
 * Next card for an arrow key over the rendered layout: left/right walk the reading order,
 * up/down jump to the nearest card in the adjacent row even across sections. Without
 * geometry (zero-sized boxes) up/down fall back to the reading order.
 */
export function nextCardIndex(boxes: readonly Box[], from: number, key: ArrowKey): number {
  const count = boxes.length;
  if (count === 0) return -1;
  if (from < 0 || from >= count) return key === 'ArrowUp' || key === 'ArrowLeft' ? count - 1 : 0;
  if (key === 'ArrowLeft') return Math.max(0, from - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, from + 1);
  const origin = boxes[from];
  const down = key === 'ArrowDown';
  const middle = origin.top + origin.height / 2;
  const candidates = boxes
    .map((box, index) => ({ box, index }))
    .filter(({ box, index }) => index !== from && box.height > 0
      && (down ? box.top >= middle : box.top + box.height <= middle));
  if (candidates.length > 0) {
    const tops = candidates.map(({ box }) => box.top);
    const rowTop = down ? Math.min(...tops) : Math.max(...tops);
    const center = origin.left + origin.width / 2;
    const distance = (box: Box) => Math.abs(box.left + box.width / 2 - center);
    return candidates
      .filter(({ box }) => Math.abs(box.top - rowTop) < 8)
      .reduce((best, entry) => (distance(entry.box) < distance(best.box) ? entry : best)).index;
  }
  if (origin.height > 0) return from;
  return down ? Math.min(count - 1, from + 1) : Math.max(0, from - 1);
}
