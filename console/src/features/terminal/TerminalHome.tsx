import { AlertTriangle, CircleOff } from 'lucide-react';
import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { cn } from '../../cn';
import { AgentOrb } from '../../components/AgentOrb';
import { LoadingState } from '../../components/ui';
import { onNavClick } from '../../router';
import { STATE_TONE, TONE_CLASS, type Tone } from '../../status-tone';
import { LIVE_STATE_META, type LiveAgentView } from '../live/agent-state';
import type { TerminalTargetsSnapshot } from './api';
import { agentLiveState, fleetTerminalChip, type FleetAgent, type TerminalAccessStatus } from './fleet';
import { ultimateTerminalGate } from './plugin';

const CHIP_TONE: Record<TerminalAccessStatus | 'no_tui', Tone> = {
  allowed: 'ok', no_tui: 'info', unknown: 'neutral', offline: 'warn', denied: 'danger',
};

/** Why the picker offers nothing to mirror, said once and briefly. Absent when there is something to pick. */
function homeNotice(
  access: ConsoleAccess | undefined,
  capability: TerminalCapability | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  emitting: number,
): { title: string; body: string } | undefined {
  const gate = ultimateTerminalGate(capability, access);
  if (!gate.enabled) return { title: 'Aquí no se puede espejar ninguna TUI', body: gate.reason };
  if (!targets?.items) {
    return {
      title: 'No se sabe qué alias pueden emitir su TUI',
      body: 'El gateway no publicó el inventario de destinos PTY, así que ningún alias se da por disponible. No es que no haya ninguno: es que no se pudo comprobar.',
    };
  }
  if (emitting === 0) {
    return {
      title: 'Ningún alias está emitiendo su TUI ahora mismo',
      body: 'El canal está abierto y el inventario llegó, pero ningún destino publica el modo harness en este momento.',
    };
  }
  return undefined;
}

/** Bare /terminal: the fleet as cards. Opening one is a link, so middle-click and new tab work. */
export function TerminalHome({ agents, live, access, capability, targets, loading, error, summary }: {
  agents: FleetAgent[];
  live: ReadonlyMap<string, LiveAgentView>;
  access?: ConsoleAccess;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  loading: boolean;
  error?: Error;
  summary: string;
}) {
  if (loading && agents.length === 0) return <LoadingState label="Leyendo la flota del servidor…" />;
  if (error && agents.length === 0) {
    return (
      <p role="alert" className="notice error m-4">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span><strong>La flota no se pudo leer.</strong> No es que no haya agentes. {error.message}</span>
      </p>
    );
  }
  const chips = new Map(agents.map((agent) => [agent.id, fleetTerminalChip(targets?.items, agent)]));
  const emitting = agents.filter((agent) => chips.get(agent.id)?.status === 'allowed').length;
  // Agents that can open a TUI come first; the rest keep the roster order.
  const ordered = [...agents].sort((a, b) => Number(chips.get(b.id)?.status === 'allowed') - Number(chips.get(a.id)?.status === 'allowed'));
  const notice = homeNotice(access, capability, targets, emitting);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1680px] p-4 min-[761px]:p-6">
        <h2 className="m-0 text-lg font-semibold tracking-tight">Elegí un agente</h2>
        <p className="m-0 mt-0.5 mb-4 text-[13px] text-muted">{summary}</p>
        {notice ? (
          <p role="status" className="notice mb-4">
            <CircleOff size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span><strong className="font-semibold text-fg">{notice.title}.</strong> {notice.body}</span>
          </p>
        ) : null}
        <ul aria-label="Agentes" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-0">
          {ordered.map((agent) => {
            const state = agentLiveState(agent, live);
            const chip = chips.get(agent.id);
            const href = `/terminal/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
            return (
              <li key={agent.id}>
                <a
                  href={href}
                  data-agent-id={agent.id}
                  onClick={(event) => { onNavClick(event, href); }}
                  className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-fg no-underline shadow-card transition-colors hover:border-line-strong hover:bg-subtle"
                >
                  <AgentOrb seed={`${agent.tenantId}/${agent.alias}`} state={state} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-sm font-semibold">{agent.alias}</span>
                      <span className="truncate text-xs text-muted">{agent.tenantId}</span>
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TONE_CLASS[STATE_TONE[state]].pill)}>
                        {LIVE_STATE_META[state].label}
                      </span>
                      {chip?.status === 'unknown' ? (
                        <span title={chip.reason} className="inline-flex items-center gap-1 px-1 py-0.5 text-[11px] text-muted">
                          <CircleOff size={11} aria-hidden="true" />{chip.label}
                        </span>
                      ) : chip ? (
                        <span title={chip.reason} className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TONE_CLASS[CHIP_TONE[chip.status]].pill)}>
                          {chip.label}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
