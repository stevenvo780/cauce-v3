import { DoorClosed, Filter, Inbox, Search, Wifi, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, LoadingState } from '../../components/ui';
import { filterFleetAgents } from '../terminal/fleet';
import { colaNecesitaAtencion, ordenarPorSaludDeCola, textoDeCifra, type SaludDeCola } from './queue-health';
import { fueraDeLaTopologia, motivoDeAgenteSuelto, type AgenteDeMensajeria } from './roster';

interface AgentRosterProps {
  agents: AgenteDeMensajeria[];
  salud: Record<string, SaludDeCola>;
  activeAgentId?: string;
  onSelect: (agent: AgenteDeMensajeria) => void;
  loading: boolean;
  error?: Error;
}

/**
 * Las tres cifras que un roster de mensajería no tiene y esta vista sí. Cada una lleva su
 * `title` con la fuente exacta: el operador tiene que poder saber de dónde salió el número sin
 * salir de la pantalla, porque la mitad de los defectos de esta consola fueron números correctos
 * leídos como si midieran otra cosa.
 */
function PildorasDeCola({ salud }: { salud?: SaludDeCola }) {
  const muertas = salud?.muertas;
  return (
    <span className="messenger-queue-pills">
      <span className="messenger-pill" data-kind="pending" title="Entregas encoladas sin tomar (GET /v3/console/activity → queued)">
        {textoDeCifra(salud?.pendientes)} en cola
      </span>
      <span className="messenger-pill" data-kind="running" title="Entregas tomadas y en vuelo (GET /v3/console/activity → in_flight)">
        {textoDeCifra(salud?.enCurso)} en curso
      </span>
      {salud?.reintentos ? (
        <span className="messenger-pill" data-kind="retry" title="Entregas en reintento (GET /v3/console/activity → retrying)">
          {salud.reintentos} reintento{salud.reintentos === 1 ? '' : 's'}
        </span>
      ) : null}
      <span
        className="messenger-pill"
        data-kind={muertas === undefined ? 'unknown' : muertas > 0 ? 'dead' : 'quiet'}
        title={muertas === undefined
          ? 'GET /v3/console/queues no publicó filas verificables: muertas UNKNOWN, no cero.'
          : `Entregas dead o failed en GET /v3/console/queues${salud?.muertasTruncadas ? ' (snapshot truncado en 200 filas: es un piso, no un total)' : ''}.`}
      >
        {salud?.muertasTruncadas && muertas !== undefined ? '≥ ' : ''}{textoDeCifra(muertas)} muertas
      </span>
    </span>
  );
}

/**
 * La columna izquierda del mensajero: quién es cada agente y CÓMO VA SU COLA.
 *
 * No reutiliza `FleetSidebar` (Ultimate Terminal) a propósito: aquella lista está construida
 * alrededor del estado del canal PTY —«PTY desconocido» en cada fila, capabilities, salud de
 * adapters— que acá es ruido puro, y tocarla para condicionarlo habría puesto en riesgo las 20
 * pruebas de TerminalPage sin ganar nada. Lo que sí se reutiliza es la LÓGICA, que es donde
 * estaría la duplicación cara: `buildFleetAgents` y `filterFleetAgents` son los mismos.
 */
export function AgentRoster({ agents, salud, activeAgentId, onSelect, loading, error }: AgentRosterProps) {
  const [tenantId, setTenantId] = useState('all');
  const [query, setQuery] = useState('');
  const tenants = useMemo(() => [...new Set(agents.map((agent) => agent.tenantId))].sort(), [agents]);
  const visibles = useMemo(
    () => ordenarPorSaludDeCola(filterFleetAgents(agents, { tenantId, roomId: 'all', query }), salud),
    [agents, query, salud, tenantId],
  );
  const online = agents.filter((agent) => agent.leaseState === 'online').length;
  // Cuántos alias del roster no viven en ninguna sala declarada. Se dice en pantalla: si sube
  // tras un alta o una baja, alguien tocó una sola de las dos tablas y se nota el mismo día.
  const sueltos = agents.filter(fueraDeLaTopologia).length;

  return (
    <aside className="messenger-roster" aria-label="Agentes">
      <header className="messenger-roster-head">
        <div>
          <p className="eyebrow">Conversaciones</p>
          <h2>{agents.length} agentes</h2>
        </div>
        <Badge tone={online > 0 ? 'online' : agents.length ? 'warning' : 'unknown'}>{online} online</Badge>
      </header>

      <div className="messenger-roster-filters">
        <label className="messenger-search">
          <span className="sr-only">Buscar agente</span>
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar agente…" />
        </label>
        <label className="messenger-tenant-filter">
          <span><Filter size={12} aria-hidden="true" /> Cliente</span>
          <select value={tenantId} onChange={(event) => { setTenantId(event.target.value); }}>
            <option value="all">Todos</option>
            {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
          </select>
        </label>
      </div>

      <p className="messenger-roster-meta">
        <Inbox size={12} aria-hidden="true" /> {visibles.length} visibles · primero las colas con entregas muertas o en reintento
        {sueltos > 0 ? (
          <>
            {' · '}
            <span
              className="messenger-loose-count"
              title="Alias del roster que NO están en ninguna sala declarada: los trae el registro de agentes o el propio feed de mensajes. Se listan a propósito — esconderlos es lo que hizo desaparecer a gaia."
            >
              {sueltos} sin sala
            </span>
          </>
        ) : null}
      </p>

      <div className="messenger-agent-list" aria-label="Lista de agentes">
        {loading && agents.length === 0 ? <LoadingState label="Sincronizando la flota del servidor…" />
          : error && agents.length === 0 ? <div role="alert"><EmptyState>No se pudo cargar la flota: {error.message}</EmptyState></div>
            : visibles.length === 0 ? <EmptyState>Ningún agente coincide con el filtro.</EmptyState>
              : visibles.map((agent) => (
                <button
                  className="messenger-agent"
                  key={agent.id}
                  type="button"
                  data-state={agent.leaseState}
                  data-active={activeAgentId === agent.id || undefined}
                  data-attention={colaNecesitaAtencion(salud[agent.id]) || undefined}
                  onClick={() => { onSelect(agent); }}
                  aria-label={`Conversación con ${agent.alias}, ${agent.tenantId}, lease ${agent.leaseState}${fueraDeLaTopologia(agent) ? ', sin sala declarada' : ''}`}
                  aria-current={activeAgentId === agent.id ? 'true' : undefined}
                >
                  <span className={`messenger-presence ${agent.leaseState}`} aria-hidden="true">
                    {agent.leaseState === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}
                  </span>
                  <span className="messenger-agent-copy">
                    <span className="messenger-agent-name">
                      <strong>{agent.alias}</strong>
                      <small>{agent.tenantId}</small>
                      {fueraDeLaTopologia(agent) ? (
                        <span className="messenger-loose-tag" title={motivoDeAgenteSuelto(agent)}>
                          <DoorClosed size={11} aria-hidden="true" /> sin sala
                        </span>
                      ) : null}
                    </span>
                    <PildorasDeCola salud={salud[agent.id]} />
                  </span>
                </button>
              ))}
      </div>
    </aside>
  );
}
