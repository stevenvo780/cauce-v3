import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronsLeft, ChevronsRight, Users, X } from 'lucide-react';
import { cn } from '../../cn';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { quotaText, type AgentQuotaBar } from './agent-quota-bar';
import { makeCanvas } from './frame';
import { HUD_BUTTON, HUD_ON, HUD_PANEL, HUD_TEXT, STATE_PIXEL } from './hud-style';
import { fleetLook } from './looks';
import type { OfficeAgent } from './office-agent';
import { SpriteCache } from './paint';
import { QuotaMeter } from './QuotaMeter';

const COLLAPSED_KEY = 'cauce.office.party.collapsed';
/** The head of the 16×24 sprite: two px trimmed on each side, one blank row on top. */
const PORTRAIT = 12;
const ATTENTION: ReadonlySet<LiveState> = new Set(['down', 'blocked']);

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

function writeCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* blocked storage only forgets the choice */ }
}

/** Lower is more urgent: an agent in trouble first, then the one with the least quota left; no number goes last. */
function urgency(agent: OfficeAgent, quota: AgentQuotaBar | undefined): number {
  if (ATTENTION.has(agent.state)) return -1;
  if (quota?.remaining != null) return quota.remaining;
  if (quota?.state === 'exhausted' || quota?.state === 'error') return 0;
  return quota?.state === 'low' ? 10 : 101;
}

function describe(agent: OfficeAgent, quota: AgentQuotaBar | undefined, reading: boolean): string {
  const account = quota?.account;
  const shared = account?.shared ? `, cuenta compartida con ${String(account.agent_count)} agentes` : '';
  return `${agent.name}: ${LIVE_STATE_META[agent.state].label}. Cuota: ${quotaText(quota, reading)}${shared}.`;
}

/** The agent's head from its office sprite, so the panel shows the same character as the map. */
function Portrait({ cache, agent, size }: { cache: SpriteCache; agent: OfficeAgent; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ghost = agent.state === 'down';
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = PORTRAIT;
    const ctx = canvas.getContext('2d');
    if (ctx) cache.paintCharacter(ctx, agent.id, ghost, 'stand', 'down', 0, -2, -1);
  }, [cache, agent.id, ghost]);
  return (
    <canvas ref={ref} width={PORTRAIT} height={PORTRAIT} aria-hidden="true"
      className="block shrink-0 border-2 border-[#0e0f17] bg-[#333c57] [image-rendering:pixelated]" style={{ width: size, height: size }} />
  );
}

function SharedMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 7 4" className="h-2 w-3.5 shrink-0" shapeRendering="crispEdges">
      <path fill="#ffcd75" d="M0 1h1v2H0zM1 0h2v1H1zM1 3h2v1H1zM3 1h1v2H3zM4 0h2v1H4zM4 3h2v1H4zM6 1h1v2H6z" />
    </svg>
  );
}

/** Party frames for the office: who is on the team, how they are and how much quota is left before they tire. */
export function PartyPanel({ agents, quotas, reading, selectedId, narrow, onPick }: {
  agents: readonly OfficeAgent[];
  quotas: ReadonlyMap<string, AgentQuotaBar>;
  reading: boolean;
  selectedId: string | null;
  narrow: boolean;
  onPick: (id: string) => void;
}) {
  const listId = useId();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [open, setOpen] = useState(false);
  const members = useMemo(() => agents.filter((agent) => !agent.visitor)
    .map((agent) => ({ agent, quota: quotas.get(agent.id), rank: urgency(agent, quotas.get(agent.id)) }))
    .sort((a, b) => a.rank - b.rank || a.agent.name.localeCompare(b.agent.name)), [agents, quotas]);
  const cache = useMemo(() => {
    const sprites = new SpriteCache(makeCanvas);
    sprites.setLooks(new Map(agents.map((agent) => [agent.id, fleetLook(agent)])));
    return sprites;
  }, [agents]);
  if (members.length === 0) return null;
  const alerts = members.filter(({ agent }) => ATTENTION.has(agent.state)).length;
  const compact = collapsed && !narrow;
  const toggle = () => { setCollapsed(!collapsed); writeCollapsed(!collapsed); };
  const pick = (id: string) => { onPick(id); if (narrow) setOpen(false); };

  if (narrow && !open) {
    return (
      <button type="button" aria-expanded={false} aria-controls={listId} onClick={() => { setOpen(true); }}
        className={cn(HUD_BUTTON, HUD_TEXT, 'pointer-events-auto relative h-9 px-2 text-[10px]')}>
        <Users size={13} aria-hidden="true" />Equipo
        {alerts > 0 ? <span className="border-2 border-[#0e0f17] bg-[#b13e53] px-0.5 text-[9px] leading-3 text-white" aria-label={`${String(alerts)} necesitan atención`}>!{alerts}</span> : null}
      </button>
    );
  }

  return (
    <section aria-label="Equipo" className={cn(HUD_PANEL, 'pointer-events-auto flex min-h-0 flex-col gap-1 p-1', compact ? 'w-11' : 'w-52 max-w-full')}>
      <header className={cn('flex shrink-0 items-center gap-1', compact ? 'justify-center' : 'pl-1')}>
        {compact ? null : <h2 className={cn(HUD_TEXT, 'm-0 min-w-0 flex-1 text-[10px] text-[#ffcd75]')}>Equipo <span className="text-[#94b0c2] tabular-nums">{members.length}</span></h2>}
        {narrow ? (
          <button type="button" aria-expanded aria-controls={listId} aria-label="Cerrar el panel de equipo" onClick={() => { setOpen(false); }} className={cn(HUD_BUTTON, 'size-7')}>
            <X size={13} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" aria-expanded={!collapsed} aria-controls={listId} onClick={toggle}
            aria-label={collapsed ? 'Desplegar el panel de equipo' : 'Plegar el panel de equipo'} title={collapsed ? 'Desplegar equipo' : 'Plegar equipo'} className={cn(HUD_BUTTON, 'size-7')}>
            {collapsed ? <ChevronsRight size={13} aria-hidden="true" /> : <ChevronsLeft size={13} aria-hidden="true" />}
          </button>
        )}
      </header>
      <ul id={listId} aria-label="Agentes del equipo, primero los que necesitan atención o tienen menos cuota" className="m-0 flex min-h-0 list-none flex-col gap-0.5 overflow-y-auto p-0 [scrollbar-width:thin]">
        {members.map(({ agent, quota }) => {
          const here = agent.id === selectedId;
          const label = quotaText(quota, reading);
          return (
            <li key={agent.id}>
              <button type="button" aria-label={describe(agent, quota, reading)} aria-current={here ? 'true' : undefined} title={compact ? `${agent.name} · ${label}` : label}
                data-agent-key={agent.id} data-state={agent.state} onClick={() => { pick(agent.id); }}
                className={cn('flex w-full cursor-pointer items-center border-2 border-[#0e0f17] bg-[#333c57]/70 text-left text-[#f4f4f4] hover:bg-[#3e486a] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#ffcd75]',
                  compact ? 'flex-col gap-0.5 p-0.5' : 'gap-1.5 px-1 py-0.5', here ? 'border-[#ffcd75]' : null, here && compact ? HUD_ON : null)}>
                <Portrait cache={cache} agent={agent} size={compact ? 24 : 26} />
                {compact ? <QuotaMeter quota={quota} reading={reading} className="h-1.5 w-6 border" /> : (
                  <span className="grid min-w-0 flex-1 gap-1.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden="true" className="size-2 shrink-0 border border-[#0e0f17]" style={{ backgroundColor: STATE_PIXEL[agent.state] }} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold leading-none">{agent.name}</span>
                      {quota?.account?.shared ? <SharedMark /> : null}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <QuotaMeter quota={quota} reading={reading} className="min-w-8 flex-1" />
                      <span className="max-w-[7rem] shrink-0 truncate font-mono text-[10px] leading-none text-[#94b0c2] tabular-nums">{label}</span>
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
