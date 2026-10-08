import { ChevronDown, Users } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../cn';
import { teamTone } from './teams';

export interface LegendTeam { id: string; label: string; hue: number; count: number }

const PANEL = 'border border-line bg-surface/92 shadow-card backdrop-blur-sm';

/** The groups of the office with their colour and headcount; choosing one flies the camera to its rug. */
export function TeamLegend({ teams, defaultOpen, onGo }: {
  teams: readonly LegendTeam[];
  defaultOpen: boolean;
  onGo: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label="Grupos" className="pointer-events-none absolute top-14 left-2 z-10 flex max-w-[min(15rem,calc(100%-4.5rem))] flex-col items-start gap-1 pointer-coarse:top-16">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(!open); }}
        className={cn(PANEL, 'pointer-events-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-fg-2 hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand pointer-coarse:h-10')}
      >
        <Users size={14} aria-hidden="true" />
        Grupos
        <span className="tabular-nums opacity-70">{teams.length}</span>
        <ChevronDown size={12} aria-hidden="true" className={cn('transition-transform', open ? 'rotate-180' : null)} />
      </button>
      {open ? (
        <ul className={cn(PANEL, 'pointer-events-auto m-0 flex max-h-44 w-full list-none flex-col gap-0.5 overflow-y-auto rounded-lg p-1')}>
          {teams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                title={`Ir al grupo ${team.label}`}
                onClick={() => { onGo(team.id); if (!defaultOpen) setOpen(false); }}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs font-medium text-fg-2 hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand pointer-coarse:h-10"
              >
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-[3px] border border-black/25"
                  style={{ backgroundColor: teamTone(team.hue, 55, 52) }}
                />
                <span className="min-w-0 flex-1 truncate">{team.label}</span>
                <span className="tabular-nums opacity-70" aria-label={`, ${String(team.count)} ${team.count === 1 ? 'agente' : 'agentes'}`}>{team.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
