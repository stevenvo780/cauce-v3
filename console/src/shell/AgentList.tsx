import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AgentOrb } from '../components/AgentOrb';
import { cn } from '../cn';
import { LIVE_STATE_META } from '../features/live/agent-state';
import { colaNecesitaAtencion, ordenarPorSaludDeCola } from '../features/messages/queue-health';
import type { AgenteDeMensajeria } from '../features/messages/roster';
import { onNavClick } from '../router';
import { STATE_TONE, TONE_CLASS } from '../status-tone';
import { agentHref } from './agent-href';
import { useFleet } from './fleet-context';

type Salud = ReturnType<typeof useFleet>['salud'];

function queueHint(agent: AgenteDeMensajeria, salud: Partial<Salud>): string | undefined {
  const s = salud[agent.id];
  if (!s) return undefined;
  if (s.muertas) return `${String(s.muertas)} muerta${s.muertas === 1 ? '' : 's'}`;
  if (s.reintentos) return `${String(s.reintentos)} en reintento`;
  if (s.enCurso) return `${String(s.enCurso)} en curso`;
  if (s.pendientes) return `${String(s.pendientes)} en cola`;
  return undefined;
}

export function AgentList({ routeId, activeId, rail = false, className }: {
  routeId: string;
  activeId?: string;
  rail?: boolean;
  className?: string;
}) {
  const { agents, salud, live, loading, error } = useFleet();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const sorted = ordenarPorSaludDeCola(agents, salud);
    return term ? sorted.filter((agent) => `${agent.alias} ${agent.tenantId}`.toLocaleLowerCase().includes(term)) : sorted;
  }, [agents, salud, query]);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {rail ? null : (
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-xs font-medium text-muted">Agentes</span>
            <span className="text-xs tabular-nums text-muted">{agents.length || ''}</span>
          </div>
          <label className="relative block">
            <span className="sr-only">Buscar agente</span>
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder="Buscar agente"
              className="min-h-8 rounded-md border-transparent bg-muted-bg py-1 pl-8 text-[13px]"
            />
          </label>
        </div>
      )}
      <ul className={cn('m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2', rail ? 'px-2' : 'px-2')} aria-label="Agentes">
        {loading && agents.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted" role="status">Cargando agentes…</li>
        ) : null}
        {error && agents.length === 0 ? (
          <li className="px-3 py-2 text-xs text-danger-ink" role="alert">No se pudo leer la flota: {error.message}</li>
        ) : null}
        {visible.map((agent) => {
          const view = live.get(agent.id);
          const state = view?.state ?? (agent.leaseState === 'online' ? 'idle' : 'down');
          const tone = STATE_TONE[state];
          const hint = queueHint(agent, salud);
          const alert = colaNecesitaAtencion(salud[agent.id]);
          const href = agentHref(routeId, agent);
          const active = agent.id === activeId;
          const label = `${agent.alias} · ${LIVE_STATE_META[state].label}${hint ? ` · ${hint}` : ''}`;
          return (
            <li key={agent.id}>
              <a
                href={href}
                data-agent-id={agent.id}
                aria-current={active ? 'page' : undefined}
                aria-label={rail ? label : undefined}
                title={rail ? label : undefined}
                onClick={(event) => { onNavClick(event, href); }}
                className={cn(
                  'group flex items-center gap-2.5 rounded-lg no-underline transition-colors',
                  rail ? 'justify-center p-1.5' : 'px-2 py-1.5',
                  active ? 'bg-muted-bg text-fg' : 'text-fg-2 hover:bg-subtle hover:text-fg',
                )}
              >
                <span className="relative">
                  <AgentOrb seed={`${agent.tenantId}/${agent.alias}`} state={state} size={rail ? 32 : 28} />
                  <span className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface', TONE_CLASS[tone].dot)} />
                </span>
                {rail ? null : (
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{agent.alias}</span>
                      <span className="shrink-0 truncate text-[11px] text-muted">{agent.tenantId}</span>
                    </span>
                    <span className={cn('block truncate text-xs', alert ? 'text-danger-ink' : 'text-muted')}>
                      {LIVE_STATE_META[state].label}{hint ? ` · ${hint}` : ''}
                    </span>
                  </span>
                )}
              </a>
            </li>
          );
        })}
        {!loading && !error && visible.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted">{query ? 'Ningún agente coincide.' : 'Sin agentes en la flota.'}</li>
        ) : null}
      </ul>
    </div>
  );
}
