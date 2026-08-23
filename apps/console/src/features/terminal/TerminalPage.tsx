import { Activity, MonitorPlay, RadioTower, RefreshCw, ShieldCheck, TerminalSquare, Wifi } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, PageHeader } from '../../components/ui';
import { permissionState } from '../../lib';
import { listTerminalTargets } from './api';
import { adapterBreakdown, adapterBreakdownText, buildFleetAgents, countLiveTuiTargets, countOnlinePtyTargets } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { ultimateTerminalGate } from './plugin';
import { deriveTerminalRelayState, TERMINAL_RELAY_SIN_COMPROBAR_TITULO } from './relay-status';
import './terminal-panel.css';

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
  const adapters = useResource('ultimate-terminal-adapters', () => api.listAdapters());
  const access = useResource('ultimate-terminal-access', () => api.getConsoleAccess());
  const capability = useResource('ultimate-terminal-capability', () => api.getTerminalCapability());
  const targets = useResource('ultimate-terminal-targets', () => listTerminalTargets());

  useRefreshInterval(status.reload, 5_000, status.loading);
  useRefreshInterval(adapters.reload, 15_000, adapters.loading);
  useRefreshInterval(targets.reload, 15_000, targets.loading);
  useRefreshInterval(topology.reload, 30_000, topology.loading);
  useRefreshInterval(access.reload, 30_000, access.loading);
  useRefreshInterval(capability.reload, 30_000, capability.loading);

  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const online = agents.filter((agent) => agent.leaseState === 'online').length;
  const adapterItems = adapters.data?.items ?? [];
  const adapterCuenta = adapterBreakdown(adapterItems);
  const verifiedAccess = access.error ? undefined : access.data;
  const verifiedCapability = capability.error ? undefined : capability.data;
  const verifiedTargets = targets.error ? undefined : targets.data;
  const connectState = permissionState(verifiedAccess, 'ultimate-terminal.connect');
  const ptyEnabled = ultimateTerminalGate(verifiedCapability, verifiedAccess).enabled;
  const ptyOnline = countOnlinePtyTargets(verifiedTargets?.items);
  const tuiOnline = countLiveTuiTargets(verifiedTargets?.items);
  const fleetLoading = (status.loading && !status.data) || (topology.loading && !topology.data);
  const fleetError = status.error ?? topology.error;
  const fleetLabel = fleetLoading
    ? 'Operación privilegiada · leyendo la flota'
    : fleetError && agents.length === 0
      ? 'Operación privilegiada · no se pudo leer la flota'
      : `Operación privilegiada · ${agents.length} agentes`;
  // El relay PTY es opt-in por stack (ver 0a1d0e3): su ausencia tiene un aviso propio, calmo y
  // con motivo explícito, en vez de sumarse como un "PTY: Bad Gateway" al banner de incidentes.
  const relay = deriveTerminalRelayState(capability.data, capability.error);
  const relayUnavailable = relay.status === 'unavailable';
  const failures = [
    status.error ? `Presencia: ${status.error.message}` : undefined,
    topology.error ? `Salas: ${topology.error.message}` : undefined,
    adapters.error ? `Adaptadores: ${adapters.error.message}` : undefined,
    access.error ? `Permisos: ${access.error.message}` : undefined,
    // El inventario de targets depende del mismo relay; si ya sabemos que está ausente, no
    // duplicamos el aviso con su propio error técnico.
    targets.error && !relayUnavailable ? `Destinos PTY: ${targets.error.message}` : undefined,
  ].filter((value): value is string => Boolean(value));

  function refreshAll() {
    status.reload();
    topology.reload();
    adapters.reload();
    access.reload();
    capability.reload();
    targets.reload();
  }

  return (
    <div className="ultimate-terminal-page">
      <PageHeader
        eyebrow={fleetLabel}
        title="Ultimate Terminal"
        description="Transmisión en vivo de la TUI de cada agente —la sesión tmux que está corriendo ahora— en solo lectura. Un alias sólo emite si el servidor publica su modo harness; el resto queda con su motivo escrito, nunca en verde."
        actions={<button className="button secondary" type="button" onClick={refreshAll} disabled={status.loading && !status.data}><RefreshCw size={16} aria-hidden="true" /> Sincronizar todo</button>}
      />

      <div className="terminal-overview" aria-label="Estado de Ultimate Terminal">
        <article><span className="overview-icon online"><Wifi size={17} aria-hidden="true" /></span><div><small>Leases vigentes</small><strong>{online} / {agents.length || 'sin dato'}</strong></div><Badge tone={online ? 'online' : agents.length ? 'warning' : 'unknown'}>LIVE</Badge></article>
        {/*
          «3 / 6» se leía como «3 rotos». Son 3 disponibles y 3 que no reportaron estado, que no
          es lo mismo: el contador ahora cuenta cada grupo por su nombre.
        */}
        <article><span className="overview-icon"><RadioTower size={17} aria-hidden="true" /></span><div><small>Adaptadores</small><strong>{adapters.data?.items ? adapterBreakdownText(adapterItems) : 'sin dato'}</strong></div><Badge tone={adapterCuenta.conFallo ? 'warning' : adapterCuenta.disponibles ? 'info' : 'unknown'}>SERVER</Badge></article>
        <article><span className="overview-icon"><ShieldCheck size={17} aria-hidden="true" /></span><div><small>Tu permiso</small><strong>{connectState === 'allowed' ? 'CONCEDIDO' : connectState === 'denied' ? 'DENEGADO' : 'SIN DATO'}</strong></div><Badge tone={connectState === 'allowed' ? 'online' : connectState === 'denied' ? 'danger' : 'unknown'}>RBAC</Badge></article>
        <article><span className="overview-icon"><TerminalSquare size={17} aria-hidden="true" /></span><div><small>Canal</small><strong>{ptyEnabled ? 'PTY + FEED' : 'SÓLO FEED'}</strong></div><Badge tone={ptyEnabled ? 'online' : 'info'}>CLIENT</Badge></article>
        <article><span className="overview-icon"><TerminalSquare size={17} aria-hidden="true" /></span><div><small>Con PTY online</small><strong>{ptyOnline === undefined ? 'sin dato' : `${ptyOnline} / ${verifiedTargets?.items?.length ?? 0}`}</strong></div><Badge tone={ptyOnline ? 'online' : ptyOnline === 0 ? 'warning' : 'unknown'}>TARGETS</Badge></article>
        <article><span className="overview-icon"><MonitorPlay size={17} aria-hidden="true" /></span><div><small>Emiten su TUI</small><strong>{tuiOnline === undefined ? 'sin dato' : `${tuiOnline} / ${verifiedTargets?.items?.length ?? 0}`}</strong></div><Badge tone={tuiOnline ? 'online' : tuiOnline === 0 ? 'warning' : 'unknown'}>TUI</Badge></article>
      </div>

      {relayUnavailable ? (
        <div className="terminal-relay-notice" role="status">
          <TerminalSquare size={17} aria-hidden="true" />
          {/* El TÍTULO también tiene que decir la verdad: con un 403 el canal existe y lo que falta
              es el permiso, así que «no disponible en este stack» era la misma mentira que el
              cuerpo. Ver `TerminalRelayCause` en relay-status.ts. */}
          <div>
            <strong>{relay.cause === 'sin-permiso'
              ? 'Ultimate Terminal necesita permiso de control'
              : relay.cause === 'sin-comprobar'
                ? TERMINAL_RELAY_SIN_COMPROBAR_TITULO
                : 'Canal PTY no disponible en este stack'}</strong>
            <p>{relay.reason}</p>
          </div>
        </div>
      ) : null}

      {failures.length ? (
        <div className="terminal-degraded" role="alert">
          <Activity size={17} aria-hidden="true" />
          <div><strong>El plano de control contestó a medias</strong><p>{failures.join(' · ')}</p></div>
          <button className="button small secondary" type="button" onClick={refreshAll}><RefreshCw size={14} aria-hidden="true" /> Reintentar</button>
        </div>
      ) : null}

      <OperatorWorkspace
        agents={agents}
        adapters={adapters.data?.items ?? []}
        access={verifiedAccess}
        topologyAccess={topology.error ? undefined : topology.data}
        terminalCapability={verifiedCapability}
        terminalTargets={verifiedTargets}
        fleetLoading={fleetLoading}
        fleetError={fleetError}
      />
    </div>
  );
}
