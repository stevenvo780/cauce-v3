import { DoorClosed, Filter, Inbox, Search, Wifi, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, EmptyState, LoadingState } from '../../components/ui';
import { filterFleetAgents } from '../terminal/fleet';
import { cifrasVivas, formaDeLaCola, ROTULO_DE_LEASE } from './fila-de-agente';
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

/** The one line a clean queue is worth: only what is above zero, or the word for clean AND read. */
function ColaBreve({ salud }: { salud?: SaludDeCola }) {
  const vivas = cifrasVivas(salud);
  return (
    <span className="messenger-cola-breve">
      {vivas.length === 0 ? (
        <span
          className="messenger-cola-limpia"
          title="0 en cola, 0 en curso, 0 en reintento y 0 muertas: las cuatro cifras leídas, ninguna UNKNOWN."
        >sin cola</span>
      ) : vivas.map((cifra) => (
        <span className="messenger-cifra-viva" key={cifra.kind} data-kind={cifra.kind}>{cifra.texto}</span>
      ))}
    </span>
  );
}

/**
 * The whole reading, chip by chip, for the row that earns a second line. Each chip carries its
 * exact source in the `title`: half the defects of this console were correct numbers read as if
 * they measured something else.
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
 * The left column of the messenger: who each agent is and HOW ITS QUEUE IS DOING.
 *
 * Does not reuse `FleetSidebar` (Ultimate Terminal) on purpose: that list is built around the
 * PTY channel state — "PTY unknown" on every row, capabilities, adapter health — which here
 * is pure noise, and conditioning it would have put the 20 TerminalPage tests at risk without
 * gaining anything. What IS reused is the LOGIC, where the costly duplication would live:
 * `buildFleetAgents` and `filterFleetAgents` are the same.
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
  // How many roster aliases live in no declared room. Surfaced on screen: if the count rises
  // after an onboarding or removal, someone touched only one of the two tables and it shows the same day.
  const sueltos = agents.filter(fueraDeLaTopologia).length;

  return (
    <aside className="messenger-roster" aria-label="Agentes">
      <header className="messenger-roster-head">
        <div>
          <p className="eyebrow">Conversaciones</p>
          <h2>{agents.length} agentes</h2>
        </div>
        <Badge tone={online > 0 ? 'online' : agents.length ? 'warning' : 'unknown'}>{online} en línea</Badge>
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
            : visibles.length === 0 ? (
              <EmptyState>
                {query.trim() || tenantId !== 'all'
                  ? 'Ningún agente coincide con el filtro.'
                  : 'No hay ningún agente visible en las fuentes que contestaron.'}
              </EmptyState>
            )
              : visibles.map((agent) => {
                const forma = formaDeLaCola(salud[agent.id]);
                return (
                  <button
                    className="messenger-agent"
                    key={agent.id}
                    type="button"
                    data-state={agent.leaseState}
                    data-cola={forma}
                    data-active={activeAgentId === agent.id || undefined}
                    data-attention={colaNecesitaAtencion(salud[agent.id]) || undefined}
                    onClick={() => { onSelect(agent); }}
                    aria-label={`Conversación con ${agent.alias}, ${agent.tenantId}, lease ${ROTULO_DE_LEASE[agent.leaseState]}${fueraDeLaTopologia(agent) ? ', sin sala declarada' : ''}`}
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
                        {forma === 'breve' ? <ColaBreve salud={salud[agent.id]} /> : null}
                      </span>
                      {forma === 'breve' ? null : <PildorasDeCola salud={salud[agent.id]} />}
                    </span>
                  </button>
                );
              })}
      </div>
    </aside>
  );
}
