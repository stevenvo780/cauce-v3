import { Activity, RadioTower, RefreshCw, ShieldCheck, TerminalSquare, Wifi } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, PageHeader } from '../../components/ui';
import { permissionState } from '../../lib';
import { buildFleetAgents } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { ultimateTerminalGate } from './plugin';

function useRefreshInterval(reload: () => void, milliseconds: number, loading: boolean) {
  useEffect(() => {
    if (loading) return;
    const interval = window.setInterval(reload, milliseconds);
    return () => window.clearInterval(interval);
  }, [loading, milliseconds, reload]);
}

export function TerminalPage() {
  const api = useApi();
  const status = useResource('ultimate-terminal-status', () => api.getStatus());
  const topology = useResource('ultimate-terminal-topology', () => api.getTopology());
  const topologyAccess = useResource('ultimate-terminal-topology-access', () => api.getTopologyAccess());
  const adapters = useResource('ultimate-terminal-adapters', () => api.listAdapters());
  const access = useResource('ultimate-terminal-access', () => api.getConsoleAccess());
  const capability = useResource('ultimate-terminal-capability', () => api.getTerminalCapability());

  useRefreshInterval(status.reload, 5_000, status.loading);
  useRefreshInterval(adapters.reload, 15_000, adapters.loading);
  useRefreshInterval(topology.reload, 30_000, topology.loading);
  useRefreshInterval(topologyAccess.reload, 30_000, topologyAccess.loading);
  useRefreshInterval(access.reload, 30_000, access.loading);
  useRefreshInterval(capability.reload, 30_000, capability.loading);

  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const online = agents.filter((agent) => agent.leaseState === 'online').length;
  const healthyAdapters = (adapters.data?.items ?? []).filter((adapter) => adapter.state === 'available').length;
  const verifiedAccess = access.error ? undefined : access.data;
  const verifiedCapability = capability.error ? undefined : capability.data;
  const connectState = permissionState(verifiedAccess, 'ultimate-terminal.connect');
  const ptyEnabled = ultimateTerminalGate(verifiedCapability, verifiedAccess).enabled;
  const fleetLoading = (status.loading && !status.data) || (topology.loading && !topology.data);
  const fleetError = status.error ?? topology.error;
  const fleetLabel = fleetLoading
    ? 'Privileged operations · fleet loading'
    : fleetError && agents.length === 0
      ? 'Privileged operations · fleet unavailable'
      : `Privileged operations · ${agents.length}-agent fleet`;
  const failures = [
    status.error ? `Presence: ${status.error.message}` : undefined,
    topology.error ? `Rooms: ${topology.error.message}` : undefined,
    topologyAccess.error ? `ACL del operador: ${topologyAccess.error.message}` : undefined,
    adapters.error ? `Adapters: ${adapters.error.message}` : undefined,
    access.error ? `RBAC: ${access.error.message}` : undefined,
    capability.error ? `PTY: ${capability.error.message}` : undefined,
  ].filter((value): value is string => Boolean(value));

  function refreshAll() {
    status.reload();
    topology.reload();
    topologyAccess.reload();
    adapters.reload();
    access.reload();
    capability.reload();
  }

  return (
    <div className="ultimate-terminal-page">
      <PageHeader
        eyebrow={fleetLabel}
        title="Ultimate Terminal"
        description="Control operativo multiagente sobre mensajes durables, leases y ACK del servidor. PTY se activa únicamente cuando el backend declara un target exacto."
        actions={<button className="button secondary" type="button" onClick={refreshAll} disabled={status.loading && !status.data}><RefreshCw size={16} aria-hidden="true" /> Sincronizar todo</button>}
      />

      <div className="terminal-overview" aria-label="Estado de Ultimate Terminal">
        <article><span className="overview-icon online"><Wifi size={17} aria-hidden="true" /></span><div><small>Fleet leases</small><strong>{online} / {agents.length || 'UNKNOWN'}</strong></div><Badge tone={online ? 'online' : agents.length ? 'warning' : 'unknown'}>LIVE</Badge></article>
        <article><span className="overview-icon"><RadioTower size={17} aria-hidden="true" /></span><div><small>Adapters available</small><strong>{adapters.data?.items ? `${healthyAdapters} / ${adapters.data.items.length}` : 'UNKNOWN'}</strong></div><Badge tone={healthyAdapters ? 'info' : 'unknown'}>SERVER</Badge></article>
        <article><span className="overview-icon"><ShieldCheck size={17} aria-hidden="true" /></span><div><small>Terminal access</small><strong>{connectState.toUpperCase()}</strong></div><Badge tone={connectState === 'allowed' ? 'online' : connectState === 'denied' ? 'danger' : 'unknown'}>RBAC</Badge></article>
        <article><span className="overview-icon"><TerminalSquare size={17} aria-hidden="true" /></span><div><small>Interactive channel</small><strong>{ptyEnabled ? 'PTY + FEED' : 'DURABLE FEED'}</strong></div><Badge tone={ptyEnabled ? 'online' : 'info'}>CLIENT</Badge></article>
      </div>

      {failures.length ? (
        <div className="terminal-degraded" role="alert">
          <Activity size={17} aria-hidden="true" />
          <div><strong>Control plane parcialmente degradado</strong><p>{failures.join(' · ')}</p></div>
          <button className="button small secondary" type="button" onClick={refreshAll}><RefreshCw size={14} aria-hidden="true" /> Reintentar</button>
        </div>
      ) : null}

      <OperatorWorkspace
        agents={agents}
        adapters={adapters.data?.items ?? []}
        access={verifiedAccess}
        topologyAccess={topologyAccess.error ? undefined : topologyAccess.data}
        terminalCapability={verifiedCapability}
        fleetLoading={fleetLoading}
        fleetError={fleetError}
      />
    </div>
  );
}
