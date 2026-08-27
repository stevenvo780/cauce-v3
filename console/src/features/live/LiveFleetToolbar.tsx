import { Pause, Play, Search } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Time, Tooltip } from '../../components/ui';
import { formatDurationSeconds } from '../../lib';

const INTERVALS = [
  { value: 2000, label: 'cada 2 s' },
  { value: 4000, label: 'cada 4 s' },
  { value: 10000, label: 'cada 10 s' },
  { value: 30000, label: 'cada 30 s' },
  { value: 0, label: 'en pausa' },
];

const FEED_HINT: ReactNode = (
  <>
    <p>
      <strong>Esto es polling</strong>, no un canal en vivo: el gateway no publica websocket ni SSE
      para la consola (<code>/v3/ws</code> es el bus de los agentes, no un canal de lectura).
    </p>
    <p>
      Por eso el intervalo se elige a mano y por eso se muestra la hora del servidor: lo que ves
      es tan fresco como diga esa hora, ni un segundo más.
    </p>
  </>
);

export interface LiveFleetToolbarProps {
  feedState: 'error' | 'paused' | 'live';
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
  return (
    <div className="live-toolbar">
      <Tooltip label={FEED_HINT} focusable={false}>
        <span className="live-feed-state" data-feed={feedState}>
          <span className="live-feed-dot" aria-hidden="true" />
          {feedState === 'error' ? 'Feed caído' : feedState === 'paused' ? 'En pausa' : 'En vivo'}
        </span>
      </Tooltip>

      <label>
        Refresco
        <select
          value={intervalMs}
          onChange={(event) => setIntervalMs(Number(event.target.value))}
          aria-label="Intervalo de refresco"
        >
          {INTERVALS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <button type="button" className="button secondary" onClick={refrescarTodo}>
        {intervalMs <= 0 ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
        Refrescar ahora
      </button>

      <span className="muted live-age">
        Servidor: <Time value={observedAt} />
        {edadSegundos !== null ? <strong> · hace {formatDurationSeconds(edadSegundos)}</strong> : null}
      </span>

      <label className="live-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Buscar un alias</span>
        <input
          type="search"
          value={query}
          placeholder="Buscar alias…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {tenants.length > 1 ? (
        <label>
          Cliente
          <select value={tenantFilter} onChange={(event) => setTenantFilter(event.target.value)}>
            <option value="todos">todos ({tenants.length})</option>
            {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
          </select>
        </label>
      ) : tenants.length === 1 ? (
        <span className="badge badge-info">Vista acotada a {tenants[0]}</span>
      ) : null}

      {activityError ? (
        <span className="notice error">
          Última lectura falló: {activityError.message}. Se muestra el snapshot anterior.
        </span>
      ) : null}

      {topologyError ? (
        <span className="notice error">
          No se pudo leer la topología: {topologyError.message}. Sin ella no hay salas, ni
          mapa, ni selector de cliente, ni «sin reportar» — no es que no existan.
          <button type="button" className="button small secondary" onClick={recargarTopologia}>
            Reintentar la topología
          </button>
        </span>
      ) : null}
    </div>
  );
}
