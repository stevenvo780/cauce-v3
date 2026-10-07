import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import { AgentOrb } from '../../components/AgentOrb';
import { AgentContextMenu, AgentKebab } from '../../components/agent-actions/AgentActionsMenu';
import { Pill, StatePill } from '../../components/kit';
import { BADGE_TONE, Unknown } from '../../components/ui';
import { cn } from '../../cn';
import { useMediaQuery } from '../../shell/use-media-query';
import { TONE_CLASS } from '../../status-tone';
import {
  agentDisplayName, estadoDeFila, formatAckAge, formatInFlightAge, presenciaDeLaFila, resumirSenales,
  rowUrgency, sortAgents, type EstadosVivos, type SortKey,
} from './activity';
import { agentKey } from './agent-state';

const refOf = (agent: FleetActivityAgent) => ({ tenantId: agent.tenant_id, alias: agent.alias });

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'agente', label: 'Agente' },
  { key: 'urgencia', label: 'Estado' },
  { key: 'vuelo', label: 'En vuelo', numeric: true },
  { key: 'cola', label: 'Cola', numeric: true },
  { key: 'antiguedad', label: 'Antigüedad', numeric: true },
  { key: 'ack', label: 'Último ACK', numeric: true },
];

/**
 * The tabular reading of the same snapshot the office draws: who has how much, since when, and
 * whether it advances. Sorted by urgency unless a column says otherwise.
 */
export function FleetActivityTable({ snapshot, estados, only, selectedKey, onOpen }: {
  snapshot: FleetActivitySnapshot | undefined;
  /** Live state per `tenant/alias`, so the row and the office never disagree. */
  estados?: EstadosVivos;
  /** `tenant/alias` keys the state filter keeps; `null` means no filter. */
  only?: ReadonlySet<string> | null;
  selectedKey?: string | null;
  onOpen: (key: string) => void;
}) {
  const phone = useMediaQuery('(max-width: 760px)');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'urgencia', descending: false });
  const lookback = snapshot?.thresholds?.ack_lookback_seconds;

  const agents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sortAgents(snapshot?.agents ?? [], estados, sort.key, sort.descending)
      .filter((agent) => !only || only.has(agentKey(agent)))
      .filter((agent) => !needle || `${agent.tenant_id} ${agent.alias} ${agent.display_name ?? ''} ${agent.harness_id ?? ''}`
        .toLowerCase().includes(needle));
  }, [snapshot, estados, only, query, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== 'agente' && key !== 'urgencia' }));
  };

  return (
    <section aria-labelledby="agentes-titulo" className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 id="agentes-titulo" className="m-0 text-sm font-semibold text-fg">
          Agentes <span className="font-normal text-muted tabular-nums">{agents.length}</span>
        </h2>
        <label className="relative ml-auto w-full sm:w-64">
          <span className="sr-only">Buscar un agente por alias</span>
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            placeholder="Buscar alias, tenant o arnés"
            onChange={(event) => { setQuery(event.target.value); }}
            className="min-h-8 w-full rounded-md border border-line bg-surface py-1 pl-8 text-[13px]"
          />
        </label>
      </header>

      {agents.length === 0 ? (
        <p className="m-0 px-4 py-8 text-center text-[13px] text-muted">
          {query.trim() ? `Ningún alias coincide con «${query.trim()}».` : only ? 'Ningún agente en ese estado ahora mismo.' : 'Ningún agente visible.'}
        </p>
      ) : phone ? (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {agents.map((agent) => (
            <li key={agentKey(agent)}>
              <AgentContextMenu agent={refOf(agent)} omit={['office']} className={cn('group flex items-center pr-2', selectedKey === agentKey(agent) && 'bg-brand-soft')}>
              <button
                type="button"
                onClick={() => { onOpen(agentKey(agent)); }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent py-3 pl-4 text-left"
              >
                <AgentOrb seed={agentKey(agent)} state={estados?.get(agentKey(agent))} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{agentDisplayName(agent)}</span>
                  <span className="block truncate text-xs text-muted">
                    {agent.in_flight ?? 0} en vuelo · {agent.queued ?? 0} en cola · {formatAckAge(agent.seconds_since_last_ack, lookback)}
                  </span>
                </span>
                <RowState agent={agent} estados={estados} />
              </button>
              <AgentKebab agent={refOf(agent)} omit={['office']} />
              </AgentContextMenu>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table data-objeto-principal="tabla-de-flota" className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Actividad en vuelo por agente</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sort.key === column.key ? (sort.descending ? 'descending' : 'ascending') : undefined}
                    className={cn('px-4 py-2 font-medium whitespace-nowrap', column.numeric && 'text-right')}
                  >
                    <button
                      type="button"
                      onClick={() => { toggleSort(column.key); }}
                      className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium text-inherit hover:text-fg"
                    >
                      {column.label}
                      {sort.key === column.key
                        ? (sort.descending ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)
                        : null}
                    </button>
                  </th>
                ))}
                <th scope="col" className="px-4 py-2 text-right font-medium">ACKs recientes</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const key = agentKey(agent);
                const estado = estadoDeFila(agent, estados);
                return (
                  <AgentContextMenu
                    key={key}
                    agent={refOf(agent)}
                    omit={['office']}
                    render={<tr />}
                    data-agent-key={key}
                    data-state={estado.live ?? agent.work_state ?? 'unknown'}
                    data-urgency={rowUrgency(agent.work_state, estado.live)}
                    data-highlighted={selectedKey === key ? 'true' : undefined}
                    onClick={(event) => { if (event.currentTarget.contains(event.target as Node)) onOpen(key); }}
                    className={cn('group cursor-pointer border-b border-line last:border-b-0 hover:bg-subtle', selectedKey === key && 'bg-brand-soft hover:bg-brand-soft')}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <AgentOrb seed={key} state={estado.live} size={24} />
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); onOpen(key); }}
                          className="cursor-pointer border-0 bg-transparent p-0 text-left font-medium text-fg hover:underline"
                        >
                          {agentDisplayName(agent)}
                        </button>
                        <span className="text-xs text-muted">{agent.tenant_id}</span>
                        <AgentKebab agent={refOf(agent)} omit={['office']} reveal className="ml-auto" />
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><RowState agent={agent} estados={estados} signals /></td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{agent.in_flight ?? 0}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{agent.queued ?? 0}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-fg-2">{formatInFlightAge(agent.oldest_in_flight_seconds)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-fg-2">{formatAckAge(agent.seconds_since_last_ack, lookback)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-2"><Unknown value={agent.acks_recent} /></td>
                  </AgentContextMenu>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowState({ agent, estados, signals = false }: { agent: FleetActivityAgent; estados?: EstadosVivos; signals?: boolean }) {
  const estado = estadoDeFila(agent, estados);
  const resumen = resumirSenales(agent.work_state ?? undefined, agent.flags, presenciaDeLaFila(agent), {
    clave: estado.live ?? 'estado', label: estado.label, tone: estado.tone ?? 'unknown',
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={resumen.detalle}>
      {estado.live ? <StatePill state={estado.live} /> : <Pill tone={BADGE_TONE[estado.tone]}>{estado.label}</Pill>}
      {signals ? resumen.senales.map((senal) => (
        <span key={senal.clave} className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px]', TONE_CLASS[BADGE_TONE[senal.tone]].pill)}>
          {senal.label}
        </span>
      )) : null}
      {signals && resumen.ocultas > 0 ? <span className="text-[11px] text-muted">+{resumen.ocultas}</span> : null}
    </span>
  );
}
