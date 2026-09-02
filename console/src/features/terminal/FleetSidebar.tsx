import { Bot, Filter, PanelLeftClose, PanelLeftOpen, Radio, Search, TerminalSquare, Wifi, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AdapterView } from '../../api/types';
import { Badge, EmptyState, LoadingState } from '../../components/ui';
import { haceCuanto } from '../../lib';
import { LEASE_LABEL, LEASE_TONE } from '../../vocabulario';
import type { TerminalTargetsSnapshot } from './api';
import { traducirCodigosEnTexto } from './denegaciones';
import { adapterBreakdownText, fleetTerminalChip, filterFleetAgents, type FleetAgent } from './fleet';

interface FleetSidebarProps {
  agents: FleetAgent[];
  adapters: AdapterView[];
  activeAgentId?: string;
  onOpenAgent: (agent: FleetAgent) => void;
  loading: boolean;
  error?: Error;
  /** Optional: absent inventory renders every alias as an explicit UNKNOWN, never as a spinner. */
  targets?: TerminalTargetsSnapshot;
  plegada?: boolean;
  onPlegar?: () => void;
}

const LISTA_ID = 'terminal-flota-agentes';

function fichaTecnica(agent: FleetAgent, capabilities: string[]): string {
  const expiry = agent.presence?.lease_expires_at ?? agent.presence?.lease_until;
  return [
    `lease ${haceCuanto(expiry) ?? 'sin dato'}`,
    `epoch ${String(agent.presence?.epoch ?? 'sin dato')}`,
    capabilities.length ? `capacidades: ${capabilities.join(', ')}` : 'sin capacidades informadas',
  ].join(' · ');
}

export function FleetSidebar({ agents, adapters, activeAgentId, onOpenAgent, loading, error, targets, plegada, onPlegar }: FleetSidebarProps) {
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
  const filtrando = query.trim().length > 0;

  return (
    <aside className="terminal-fleet-sidebar" aria-label="Flota de agentes">
      <header className="terminal-fleet-head">
        {/* The rail is 272px the mirror renders as columns: folded it leaves the agents one click
            away. Folded the list stays rendered and focusable, so the control reports `aria-pressed`:
            `aria-expanded="false"` over a list that is still there would be false to AT. */}
        {onPlegar ? (
          <button
            className="fleet-plegar"
            type="button"
            onClick={onPlegar}
            aria-pressed={plegada ?? false}
            aria-controls={LISTA_ID}
            aria-label={plegada ? 'Desplegar la lista de la flota' : 'Plegar la lista de la flota'}
            title={plegada ? 'Desplegar la lista de la flota' : 'Plegar la lista de la flota'}
          >
            {plegada ? <PanelLeftOpen size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
            <span className="fleet-plegar-rotulo">{plegada ? 'Desplegar' : 'Plegar'}</span>
          </button>
        ) : null}
        <p className="eyebrow">Flota en vivo</p>
        <div className="fleet-head-count">
          <h2>{agents.length} agentes</h2>
          <Badge tone={online > 0 ? 'online' : agents.length ? 'warning' : 'unknown'}>{online} en línea</Badge>
        </div>
      </header>

      <div className="fleet-health-strip" aria-label="Salud de los adaptadores">
        <span><Bot size={13} aria-hidden="true" /> Adaptadores</span>
        {/* «3/6» se leía como «3 rotos»: sin reportar no es lo mismo que caído. */}
        <strong>{adapterTexto}</strong>
      </div>

      <div className="fleet-filters">
        <label className="terminal-search">
          <span className="sr-only">Buscar agente o capacidad</span>
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar agente…" />
        </label>
        <div className="fleet-filter-row">
          <label>
            <span><Filter size={12} aria-hidden="true" /> Cliente</span>
            <select value={tenantId} onChange={(event) => { setTenantId(event.target.value); }}>
              <option value="all">Todos</option>
              {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
            </select>
          </label>
          <label>
            <span><Radio size={12} aria-hidden="true" /> Sala</span>
            <select value={roomId} onChange={(event) => { setRoomId(event.target.value); }}>
              <option value="all">Todos</option>
              {rooms.map((room) => <option key={room} value={room}>{room}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="fleet-list-meta">
        <span>{visible.length} visibles</span>
        {loading ? <span className="terminal-syncing"><span className="spinner" aria-hidden="true" /> Sincronizando</span> : <span>leases del servidor</span>}
      </div>

      <div className="terminal-agent-list" id={LISTA_ID} aria-label="Agentes disponibles">
        {loading && agents.length === 0 ? <LoadingState label="Sincronizando la flota del servidor…" />
          : error && agents.length === 0 ? <div role="alert"><EmptyState>No se pudo cargar la flota: {error.message}</EmptyState></div>
            : visible.length === 0 ? <EmptyState>No hay agentes que coincidan con los filtros.</EmptyState> : visible.map((agent) => {
          const capabilities = agent.presence?.capabilities ?? [];
          const pty = fleetTerminalChip(targets?.items, agent);
          return (
            <button
              className="terminal-agent"
              data-state={agent.leaseState}
              data-active={activeAgentId === agent.id || undefined}
              key={agent.id}
              type="button"
              title={fichaTecnica(agent, capabilities)}
              onClick={() => { onOpenAgent(agent); }}
              aria-label={`Abrir sesión con ${agent.alias}, ${agent.tenantId}, ${LEASE_LABEL[agent.leaseState]}, PTY: ${pty.label}, ${fichaTecnica(agent, capabilities)}`}
            >
              <span className="agent-name">
                <span className={`agent-presence ${agent.leaseState}`} aria-hidden="true">
                  {agent.leaseState === 'online' ? <Wifi size={12} /> : <WifiOff size={12} />}
                </span>
                <strong>{agent.alias}</strong>
                <small>{agent.tenantId}</small>
                <Badge tone={LEASE_TONE[agent.leaseState]}>{LEASE_LABEL[agent.leaseState]}</Badge>
              </span>
              <span className="agent-meta">
                {/* `pty.label` ya viene en castellano de `fleetTerminalChip`; lo que faltaba era
                    el MOTIVO, que llegaba con los códigos crudos del servidor dentro. */}
                <span className="agent-pty-state" data-status={pty.status} title={traducirCodigosEnTexto(pty.reason)}>
                  <TerminalSquare size={11} aria-hidden="true" /> {pty.label}
                </span>
              </span>
              {filtrando ? (
                <span className="agent-capabilities">
                  {capabilities.length ? capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>) : <span className="unknown">sin capacidades informadas</span>}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
