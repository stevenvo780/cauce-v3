import { ChevronDown, Search } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { AgentOrb, OrbView } from '../components/AgentOrb';
import { agentKey } from '../components/agent-actions/agent-actions';
import { AgentContextMenu, AgentKebab, FavoriteStar } from '../components/agent-actions/AgentActionsMenu';
import { useAgentPreferences, usePreferencesSettled } from '../components/agent-actions/preferences-context';
import { cn } from '../cn';
import { LIVE_STATE_META } from '../features/live/agent-state';
import { colaNecesitaAtencion, ordenarPorSaludDeCola } from '../features/messages/queue-health';
import type { AgenteDeMensajeria } from '../features/messages/roster';
import { agentLiveState } from '../features/terminal/fleet';
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

function AgentRow({ agent, routeId, active, rail }: { agent: AgenteDeMensajeria; routeId: string; active: boolean; rail: boolean }) {
  const { salud, live } = useFleet();
  const state = agentLiveState(agent, live);
  const tone = STATE_TONE[state];
  const hint = queueHint(agent, salud);
  const alert = colaNecesitaAtencion(salud[agent.id]);
  const href = agentHref(routeId, agent);
  const label = `${agent.alias} · ${LIVE_STATE_META[state].label}${hint ? ` · ${hint}` : ''}`;
  const tabIndex = active ? undefined : -1;
  return (
    <li data-agent-key={agentKey(agent)}>
      <AgentContextMenu agent={agent} data-active={active || undefined}
        className={cn('group relative rounded-lg transition-colors', active ? 'bg-muted-bg' : 'hover:bg-subtle')}>
        <a
          href={href}
          data-agent-id={agent.id}
          aria-current={active ? 'page' : undefined}
          aria-keyshortcuts="Shift+F10"
          aria-label={rail ? label : undefined}
          title={rail ? label : undefined}
          onClick={(event) => { onNavClick(event, href); }}
          className={cn(
            'flex items-center gap-2.5 rounded-lg no-underline',
            rail ? 'justify-center p-1.5' : 'px-2 py-1.5 pointer-coarse:pr-10',
            active ? 'text-fg' : 'text-fg-2 group-hover:text-fg',
          )}
        >
          <span className="relative">
            <AgentOrb seed={agentKey(agent)} state={state} size={rail ? 32 : 28} />
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
        {rail ? null : (
          <span className={cn(
            'absolute top-1/2 right-1 flex -translate-y-1/2 items-center rounded-md pl-1 opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-popup-open]]:opacity-100',
            'pointer-coarse:bg-transparent pointer-coarse:opacity-100',
            active ? 'bg-muted-bg' : 'bg-subtle',
          )}>
            <FavoriteStar agent={agent} tabIndex={tabIndex} className="pointer-coarse:hidden" />
            <AgentKebab agent={agent} tabIndex={tabIndex} />
          </span>
        )}
      </AgentContextMenu>
    </li>
  );
}

function Skeleton({ rail }: { rail: boolean }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((row) => (
        <li key={row} aria-hidden="true" className={cn('flex items-center gap-2.5', rail ? 'justify-center p-1.5' : 'px-2 py-1.5')}>
          <span className="skeleton size-7 shrink-0 rounded-full" />
          {rail ? null : (
            <span className="grid flex-1 gap-1.5">
              <span className="skeleton h-2.5 rounded-full" style={{ width: `${String(70 - row * 9)}%` }} />
              <span className="skeleton h-2 w-2/5 rounded-full" />
            </span>
          )}
        </li>
      ))}
    </>
  );
}

export function AgentList({ routeId, activeId, rail = false, className }: {
  routeId: string;
  activeId?: string;
  rail?: boolean;
  className?: string;
}) {
  const { agents, salud, loading, error } = useFleet();
  const preferences = useAgentPreferences();
  const settled = usePreferencesSettled();
  const [query, setQuery] = useState('');
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const favoriteKeys = preferences?.favorites;
  const favoriteCount = favoriteKeys?.size ?? 0;
  const [seenFavorites, setSeenFavorites] = useState(favoriteCount);
  if (favoriteCount !== seenFavorites) {
    setSeenFavorites(favoriteCount);
    if (favoriteCount > seenFavorites) setFavoritesOpen(true);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<{ key: string; part: string } | null>(null);
  const { favorites, others } = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const sorted = ordenarPorSaludDeCola(agents, salud);
    const matching = term ? sorted.filter((agent) => `${agent.alias} ${agent.tenantId}`.toLocaleLowerCase().includes(term)) : sorted;
    const isFavorite = (agent: AgenteDeMensajeria) => favoriteKeys?.has(agentKey(agent)) ?? false;
    return {
      favorites: matching.filter(isFavorite).sort((a, b) => a.alias.localeCompare(b.alias) || a.tenantId.localeCompare(b.tenantId)),
      others: matching.filter((agent) => !isFavorite(agent)),
    };
  }, [agents, salud, query, favoriteKeys]);
  const visible = favorites.length + others.length;
  const waiting = (loading && agents.length === 0) || (!settled && agents.length > 0);
  const shownFavorites = rail || favoritesOpen ? favorites : favorites.filter((agent) => agent.id === activeId);

  useLayoutEffect(() => {
    const last = lastFocus.current;
    if (!last || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const row = scrollRef.current?.querySelector(`[data-agent-key="${CSS.escape(last.key)}"]`);
    row?.querySelector<HTMLElement>(last.part)?.focus();
  }, [favorites, others, favoritesOpen]);

  const trackFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target;
    const key = scrollRef.current?.contains(target) ? target.closest<HTMLElement>('[data-agent-key]')?.dataset.agentKey : undefined;
    if (key === undefined) return;
    const part = target.hasAttribute('data-favorite-star') ? '[data-favorite-star]' : target.hasAttribute('data-agent-kebab') ? '[data-agent-kebab]' : 'a';
    lastFocus.current = { key, part };
  };
  const forgetFocus = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next && !scrollRef.current?.contains(next) && !next.closest('[role="menu"]')) lastFocus.current = null;
  };
  const row = (agent: AgenteDeMensajeria) => (
    <AgentRow key={agent.id} agent={agent} routeId={routeId} active={agent.id === activeId} rail={rail} />
  );

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
      <div ref={scrollRef} onFocus={trackFocus} onBlur={forgetFocus} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {favorites.length > 0 && !waiting ? (
          <section aria-label="Favoritos" className={cn('mb-1', rail ? 'border-b border-line pb-1' : '')}>
            {rail ? null : (
              <button type="button" aria-expanded={favoritesOpen} aria-controls="agentes-favoritos"
                onClick={() => { setFavoritesOpen(!favoritesOpen); }}
                className="flex w-full cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-[11px] font-medium tracking-wide text-muted uppercase hover:text-fg">
                <ChevronDown size={13} aria-hidden="true" className={cn('transition-transform', !favoritesOpen && '-rotate-90')} />
                Favoritos
                <span className="ml-auto tabular-nums">{favorites.length}</span>
              </button>
            )}
            <ul id="agentes-favoritos" className="m-0 list-none p-0" aria-label="Agentes favoritos">
              {shownFavorites.map(row)}
            </ul>
          </section>
        ) : null}
        {favorites.length > 0 && !waiting && !rail && others.length > 0 ? (
          <p className="m-0 px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Todos</p>
        ) : null}
        <ul className="m-0 list-none p-0" aria-label="Agentes">
          {waiting ? (
            <>
              <li className="sr-only" role="status">Cargando agentes…</li>
              <Skeleton rail={rail} />
            </>
          ) : null}
          {error && agents.length === 0 ? (
            <li className="px-3 py-2 text-xs text-danger-ink" role="alert">No se pudo leer la flota: {error.message}</li>
          ) : null}
          {waiting ? null : others.map(row)}
          {!waiting && !loading && !error && visible === 0 ? (
            <li className="grid justify-items-center gap-2 px-3 py-6 text-center text-xs text-muted">
              {query ? null : <OrbView seed="cauce/vacio" state="idle" size={36} sleeping look={{ style: 'orb', hue: 250 }} />}
              {query ? 'Ningún agente coincide.' : 'Sin agentes en la flota.'}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
