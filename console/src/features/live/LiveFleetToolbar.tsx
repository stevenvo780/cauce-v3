import { RefreshCw, Search, Settings2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Time } from '../../components/ui';
import { formatDurationSeconds } from '../../lib';

const INTERVALS = [
  { value: 2000, label: 'cada 2 s' },
  { value: 4000, label: 'cada 4 s' },
  { value: 10000, label: 'cada 10 s' },
  { value: 30000, label: 'cada 30 s' },
  { value: 0, label: 'en pausa' },
];

interface LiveFleetToolbarProps {
  feedState: 'error' | 'paused' | 'stale' | 'live';
  intervalMs: number;
  setIntervalMs: Dispatch<SetStateAction<number>>;
  refrescarTodo: () => void;
  observedAt?: string;
  edadSegundos: number | null;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  tenants: string[];
  tenantFilter: string;
  setTenantFilter: Dispatch<SetStateAction<string>>;
  activityError?: Error | null;
  topologyError?: Error | null;
  recargarTopologia: () => void;
}

export function LiveFleetToolbar({
  feedState,
  intervalMs,
  setIntervalMs,
  refrescarTodo,
  observedAt,
  edadSegundos,
  query,
  setQuery,
  tenants,
  tenantFilter,
  setTenantFilter,
  activityError,
  topologyError,
  recargarTopologia,
}: LiveFleetToolbarProps) {
  const feedLabel = feedState === 'error' ? 'Error de lectura' : feedState === 'paused' ? 'En pausa'
    : feedState === 'stale' ? 'Sin datos actuales' : 'Consulta automática';
  const feedDescription = feedLabel + (edadSegundos !== null ? ` · hace ${formatDurationSeconds(edadSegundos)}` : '');
  return (
    <div className="live-toolbar">
      <label className="live-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Buscar un alias</span>
        <input
          type="search"
          value={query}
          placeholder="Buscar alias…"
          onChange={(event) => { setQuery(event.target.value); }}
        />
      </label>

      {tenants.length > 1 ? (
        <label className="live-client-filter">
          <span className="sr-only">Cliente</span>
          <select aria-label="Cliente" value={tenantFilter} onChange={(event) => { setTenantFilter(event.target.value); }}>
            <option value="todos">todos ({tenants.length})</option>
            {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
          </select>
        </label>
      ) : tenants.length === 1 ? (
        <span className="badge badge-info live-single-client" title={`Vista acotada a ${tenants[0]}`}>{tenants[0]}</span>
      ) : null}

      <button type="button" className="button secondary live-refresh" onClick={refrescarTodo} aria-label="Refrescar ahora" title="Refrescar ahora">
        <RefreshCw size={18} aria-hidden="true" />
        <span className="live-feed-state" data-feed={feedState} role="status" aria-live="polite" title={feedDescription}>
          <span className="live-feed-dot" aria-hidden="true" /><span className="sr-only">{feedDescription}</span>
        </span>
      </button>
      <details className="live-refresh-settings">
        <summary aria-label="Ajustes de refresco" title="Ajustes de refresco"><Settings2 size={18} aria-hidden="true" /></summary>
        <div className="live-refresh-popover">
          <p className="live-age">{feedDescription}</p>
          <label className="live-refresh-filter">
            Refresco
            <select value={intervalMs} onChange={(event) => { setIntervalMs(Number(event.target.value)); }} aria-label="Intervalo de refresco">
              {INTERVALS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="muted live-age">
            Servidor: <Time value={observedAt} />
            {edadSegundos !== null ? <strong> · hace {formatDurationSeconds(edadSegundos)}</strong> : null}
          </span>
        </div>
      </details>
      {activityError ? (
        <span className="notice error" role="alert">
          Última lectura falló: {activityError.message}. Se muestra el snapshot anterior.
        </span>
      ) : null}
      {topologyError ? (
        <span className="notice error" role="alert">
          No se pudo leer la topología: {topologyError.message}.
          <button type="button" className="button small secondary" onClick={recargarTopologia}>Reintentar la topología</button>
        </span>
      ) : null}
    </div>
  );
}
