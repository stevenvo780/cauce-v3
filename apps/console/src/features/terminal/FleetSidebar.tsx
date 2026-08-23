import { Bot, ChevronRight, Filter, Radio, Search, TerminalSquare, Wifi, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AdapterView } from '../../api/types';
import { Badge, EmptyState, LoadingState, Time } from '../../components/ui';
import type { TerminalTargetsSnapshot } from './api';
import { traducirCodigosEnTexto } from './denegaciones';
import { adapterBreakdownText, fleetTerminalChip, filterFleetAgents, LEASE_STATE_LABEL, type FleetAgent } from './fleet';

interface FleetSidebarProps {
  agents: FleetAgent[];
  adapters: AdapterView[];
  activeAgentId?: string;
  onOpenAgent: (agent: FleetAgent) => void;
  loading: boolean;
  error?: Error;
  /** Optional: absent inventory renders every alias as an explicit UNKNOWN, never as a spinner. */
  targets?: TerminalTargetsSnapshot;
}

function agentTone(state: FleetAgent['leaseState']): 'online' | 'offline' | 'unknown' {
  return state === 'online' ? 'online' : state === 'expired' ? 'offline' : 'unknown';
}

export function FleetSidebar({ agents, adapters, activeAgentId, onOpenAgent, loading, error, targets }: FleetSidebarProps) {
  const [tenantId, setTenantId] = useState('all');
  const [roomId, setRoomId] = useState('all');
  const [query, setQuery] = useState('');
  const tenants = useMemo(() => [...new Set(agents.map((agent) => agent.tenantId))].sort(), [agents]);
  const rooms = useMemo(() => [...new Set(agents.flatMap((agent) => agent.roomIds))].sort(), [agents]);
  const visible = useMemo(
    () => filterFleetAgents(agents, { tenantId, roomId, query }),
    [agents, query, roomId, tenantId],
  );
  const online = agents.filter((agent) => agent.leaseState === 'online').length;
  const adapterTexto = adapterBreakdownText(adapters);

  return (
    <aside className="terminal-fleet-sidebar" aria-label="Fleet de agentes">
      <header className="terminal-fleet-head">
        <div>
          <p className="eyebrow">Fleet live</p>
          <h2>{agents.length} agentes</h2>
        </div>
        <Badge tone={online > 0 ? 'online' : agents.length ? 'warning' : 'unknown'}>{online} online</Badge>
      </header>

      <div className="fleet-health-strip" aria-label="Salud de adapters">
        <Bot size={15} aria-hidden="true" />
        <span>Adaptadores</span>
        {/* «3/6» se leía como «3 rotos»: sin reportar no es lo mismo que caído. */}
        <strong>{adapterTexto}</strong>
      </div>

      <div className="fleet-filters">
        <label className="terminal-search">
          <span className="sr-only">Buscar agente o capability</span>
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar agente…" />
        </label>
        <div className="fleet-filter-row">
          <label>
            <span><Filter size={12} aria-hidden="true" /> Tenant</span>
            <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
              <option value="all">Todos</option>
              {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
            </select>
          </label>
          <label>
            <span><Radio size={12} aria-hidden="true" /> Room</span>
            <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
              <option value="all">Todos</option>
              {rooms.map((room) => <option key={room} value={room}>{room}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="fleet-list-meta">
        <span>{visible.length} visibles</span>
        {loading ? <span className="terminal-syncing"><span className="spinner" aria-hidden="true" /> Sync</span> : <span>leases del servidor</span>}
      </div>

      <div className="terminal-agent-list" aria-label="Agentes disponibles">
        {loading && agents.length === 0 ? <LoadingState label="Sincronizando fleet del servidor…" />
          : error && agents.length === 0 ? <div role="alert"><EmptyState>No se pudo cargar el fleet: {error.message}</EmptyState></div>
            : visible.length === 0 ? <EmptyState>No hay agentes que coincidan con los filtros.</EmptyState> : visible.map((agent) => {
          const expiry = agent.presence?.lease_expires_at ?? agent.presence?.lease_until;
          const capabilities = agent.presence?.capabilities ?? [];
          const pty = fleetTerminalChip(targets?.items, agent);
          return (
            <button
              className="terminal-agent"
              data-state={agent.leaseState}
              data-active={activeAgentId === agent.id || undefined}
              key={agent.id}
              type="button"
              onClick={() => onOpenAgent(agent)}
              aria-label={`Abrir sesión con ${agent.alias}, ${agent.tenantId}, ${LEASE_STATE_LABEL[agent.leaseState]}, PTY: ${pty.label}`}
            >
              <span className={`agent-presence ${agent.leaseState}`} aria-hidden="true">
                {agent.leaseState === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}
              </span>
              <span className="agent-copy">
                <span className="agent-name"><strong>{agent.alias}</strong><small>{agent.tenantId}</small></span>
                <span className="agent-lease">
                  <Badge tone={agentTone(agent.leaseState)}>{LEASE_STATE_LABEL[agent.leaseState]}</Badge>
                  <span>epoch {agent.presence?.epoch ?? 'sin dato'}</span>
                </span>
                <span className="agent-expiry">Lease <Time value={expiry} /></span>
                {/* `pty.label` ya viene en castellano de `fleetTerminalChip`; lo que faltaba era
                    el MOTIVO, que llegaba con los códigos crudos del servidor dentro. */}
                <span className="agent-pty-state" data-status={pty.status} title={traducirCodigosEnTexto(pty.reason)}>
                  <TerminalSquare size={12} aria-hidden="true" /> {pty.label}
                </span>
                <span className="agent-capabilities">
                  {capabilities.length ? capabilities.slice(0, 2).map((capability) => <span className="chip" key={capability}>{capability}</span>) : <span className="unknown">sin capacidades informadas</span>}
                  {capabilities.length > 2 ? <span className="chip">+{capabilities.length - 2}</span> : null}
                </span>
              </span>
              <ChevronRight className="agent-open-icon" size={17} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
