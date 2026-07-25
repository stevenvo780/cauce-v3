import { Activity, Clock3, Cpu, Search, Server } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { buildFleetAgents, filterFleetAgents, type FleetAgent } from '../terminal/fleet';

function agentStateBadge(agent: FleetAgent): { tone: 'online' | 'offline' | 'unknown'; label: string } {
  if (agent.leaseState === 'online') return { tone: 'online', label: 'ONLINE' };
  if (agent.leaseState === 'expired') return { tone: 'offline', label: 'EXPIRADO' };
  // Sin presence nunca reportado por el servidor: distinto de un lease ambiguo (epoch/expiry ilegibles).
  return { tone: 'unknown', label: agent.presence ? 'UNKNOWN' : 'NUNCA CONECTADO' };
}

export function FleetPage() {
  const api = useApi();
  const status = useResource('fleet-status', () => api.getStatus());
  const topology = useResource('fleet-topology', () => api.getTopology());
  const [query, setQuery] = useState('');

  if (status.loading && !status.data) {
    return <LoadingState label="Consultando leases, epochs y topología…" />;
  }
  if (status.error && !status.data) {
    return <ErrorState error={status.error} onRetry={() => { status.reload(); topology.reload(); }} />;
  }

  // La topología puede fallar o seguir en vuelo sin bloquear la página: la presencia observada sigue siendo autoridad de lease.
  const agents = buildFleetAgents(status.data, topology.data);
  const visible = filterFleetAgents(agents, { tenantId: 'all', roomId: 'all', query });
  // presence: [] es un cero conocido (0 leases vigentes); UNKNOWN sólo cuando el propio campo falta.
  const live = status.data?.presence ? agents.filter((agent) => agent.leaseState === 'online').length : null;

  function refreshAll() {
    status.reload();
    topology.reload();
  }

  return (
    <>
      <PageHeader
        eyebrow="Runtime"
        title="Fleet & presencia"
        description="Cruce de topología configurada (GET /v3/console/topology) y presencia observada (GET /v3/status): un agente configurado y nunca conectado se lista igual, sin inventarle un lease."
        actions={<RefreshButton onClick={refreshAll} loading={status.loading || topology.loading} />}
      />
      {topology.error ? <p className="notice error" role="alert">No se pudo leer la topología: {topology.error.message}. Mostrando sólo presencia observada.</p> : null}
      <div className="metrics-grid">
        <Metric label="Leases vigentes" value={live} tone="positive" detail="expiry > reloj actual" />
        <Metric label="En cola" value={status.data?.queued} tone="warning" detail="pending + retry + claimed" />
        <Metric label="DLQ abierta" value={status.data?.dead_letters} tone="danger" detail="sin resolver" />
        <Metric label="Outbox pendiente" value={status.data?.outbox_pending} detail={`API ${status.data?.version ?? 'UNKNOWN'}`} />
      </div>
      <Panel>
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Filtrar fleet</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por alias, tenant, room o capability…" />
        </label>
      </Panel>
      <Panel title="Fleet configurada" subtitle="Topología y lease se cruzan sin inventar miembros: un agente sin conexión previa se lista igual, con estado distinguible.">
        {visible.length === 0 ? (
          <EmptyState>{agents.length === 0 ? 'No hay agentes configurados ni leases informados.' : 'Ningún agente coincide con el filtro.'}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Fleet de agentes: topología cruzada con presencia</caption>
              <thead><tr><th>Consumer</th><th>Tenant</th><th>Rooms</th><th>Estado</th><th>Epoch</th><th>Instance</th><th>Heartbeat</th><th>Lease vence</th><th>Capabilities</th></tr></thead>
              <tbody>
                {visible.map((agent) => {
                  const state = agentStateBadge(agent);
                  const expiry = agent.presence?.lease_expires_at ?? agent.presence?.lease_until;
                  return (
                    <tr key={agent.id} data-state={agent.leaseState}>
                      <td><div className="identity-cell"><span className="icon-box"><Cpu size={16} aria-hidden="true" /></span><strong>{agent.alias}</strong></div></td>
                      <td>{agent.tenantId}</td>
                      <td><div className="chip-list">{agent.roomIds.length ? agent.roomIds.map((roomId) => <span className="chip" key={roomId}>{roomId}</span>) : <span className="unknown">UNKNOWN</span>}</div></td>
                      <td><Badge tone={state.tone}>{state.label}</Badge></td>
                      <td><span className="mono"><Unknown value={agent.presence?.epoch} /></span></td>
                      <td><span className="mono"><Unknown value={agent.presence?.instance_id} /></span></td>
                      <td><Time value={agent.presence?.last_heartbeat_at} /></td>
                      <td><Time value={expiry} /></td>
                      <td><div className="chip-list">{agent.presence?.capabilities?.length ? agent.presence.capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>) : <span className="unknown">UNKNOWN</span>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="explain-grid">
        <article><Activity aria-hidden="true" /><div><strong>Lease real</strong><p>Un heartbeat no alcanza: la fecha de expiración debe seguir vigente.</p></div></article>
        <article><Clock3 aria-hidden="true" /><div><strong>Fencing por epoch</strong><p>Epoch ausente o inválido se muestra como UNKNOWN; no se reemplaza por cero.</p></div></article>
        <article><Server aria-hidden="true" /><div><strong>Solo observación</strong><p>La consola no mantiene presencia, sockets de consumers ni estado durable.</p></div></article>
      </div>
    </>
  );
}
