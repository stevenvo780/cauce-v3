import { Activity, ChevronDown, MonitorPlay, RadioTower, RefreshCw, ShieldCheck, TerminalSquare, Wifi } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, PageHeader } from '../../components/ui';
import { permissionState } from '../../lib';
import { listTerminalTargets } from './api';
import { TEXTO_DOCTRINA } from './doctrina';
import { adapterBreakdown, adapterBreakdownText, buildFleetAgents, countLiveTuiTargets, countOnlinePtyTargets } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { ultimateTerminalGate } from './plugin';
import { deriveTerminalRelayState, TERMINAL_RELAY_SIN_COMPROBAR_TITULO } from './relay-status';
import './terminal-panel.css';

function useRefreshInterval(reload: () => void, milliseconds: number, loading: boolean) {
  useEffect(() => {
    if (loading) return;
    const interval = window.setInterval(reload, milliseconds);
    return () => { window.clearInterval(interval); };
  }, [loading, milliseconds, reload]);
}

export function TerminalPage() {
  const api = useApi();
  /**
   * With an open session the page enters observation mode: the terminal keeps the height and the
   * six counters collapse into a single strip. Without this the terminal started at y=856 on a
   * 900-px window —44 px visible— and on mobile, at y=1952: off the entire screen.
   */
  const [sesionesAbiertas, setSesionesAbiertas] = useState(0);
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
      : `Operación privilegiada · ${String(agents.length)} agentes`;
  // The PTY relay is opt-in per stack (see 0a1d0e3): absence, permission and inconclusive measurement
  // each get their own explicit notice, rather than summing up as an unclassified "PTY: Bad Gateway".
  const relay = deriveTerminalRelayState(capability.data, capability.error);
  const relayUnavailable = relay.status === 'unavailable';
  const failures = [
    status.error ? `Presencia: ${status.error.message}` : undefined,
    topology.error ? `Salas: ${topology.error.message}` : undefined,
    adapters.error ? `Adaptadores: ${adapters.error.message}` : undefined,
    access.error ? `Permisos: ${access.error.message}` : undefined,
    // The targets inventory depends on the same query; if the relay's notice already explains its
    // failure, we do not duplicate it with the same technical error.
    targets.error && !relayUnavailable ? `Destinos PTY: ${targets.error.message}` : undefined,
  ].filter((value): value is string => Boolean(value));

  function refreshAll() {
    void status.reload();
    void topology.reload();
    void adapters.reload();
    void access.reload();
    void capability.reload();
    void targets.reload();
  }

  /*
   * ═══ OBSERVATION MODE: WHAT YOU CHECK BEFORE OPENING TAKES NO HEIGHT WHILE A TUI IS OPEN ═══
   *
   * The six counters answer a single question, and a BEFORE-the-fact one: "can I open a terminal,
   * and whose?". None talks about the alias you are watching and none changes while you watch it.
   * With an open session they move to a disclosure living in the header row —cost: ZERO rows—
   * and come back whole with a click. MEASURED at 1920x1080 before this: the strip took 40 px
   * plus 10 of margin, and the doctrine footer another 30, on a terminal left with 54.1% of the
   * window.
   *
   * With no open session NOTHING collapses: those six pieces of data are exactly what the operator
   * came to read. `densidad-observacion.test.tsx` checks this, with its negative control.
   */
  const observando = sesionesAbiertas > 0;
  const contadores = (
    <div className="terminal-overview" aria-label="Estado de la terminal de agentes">
      <article><span className="overview-icon online"><Wifi size={17} aria-hidden="true" /></span><div><small>Leases vigentes</small><strong>{online} / {agents.length || 'sin dato'}</strong></div><Badge tone={online ? 'online' : agents.length ? 'warning' : 'unknown'}>LIVE</Badge></article>
      {/*
        "3 / 6" used to read as "3 broken". It is 3 available and 3 that did not report state,
        which is not the same thing: the counter now labels each group by its own name.
      */}
      <article><span className="overview-icon"><RadioTower size={17} aria-hidden="true" /></span><div><small>Adaptadores</small><strong>{adapters.data?.items ? adapterBreakdownText(adapterItems) : 'sin dato'}</strong></div><Badge tone={adapterCuenta.conFallo ? 'warning' : adapterCuenta.disponibles ? 'info' : 'unknown'}>SERVER</Badge></article>
      <article><span className="overview-icon"><ShieldCheck size={17} aria-hidden="true" /></span><div><small>Tu permiso</small><strong>{connectState === 'allowed' ? 'CONCEDIDO' : connectState === 'denied' ? 'DENEGADO' : 'SIN DATO'}</strong></div><Badge tone={connectState === 'allowed' ? 'online' : connectState === 'denied' ? 'danger' : 'unknown'}>RBAC</Badge></article>
      <article><span className="overview-icon"><TerminalSquare size={17} aria-hidden="true" /></span><div><small>Canal</small><strong>{ptyEnabled ? 'PTY + FEED' : 'SÓLO FEED'}</strong></div><Badge tone={ptyEnabled ? 'online' : 'info'}>CLIENT</Badge></article>
      <article><span className="overview-icon"><TerminalSquare size={17} aria-hidden="true" /></span><div><small>Con PTY online</small><strong>{ptyOnline === undefined ? 'sin dato' : `${String(ptyOnline)} / ${String(verifiedTargets?.items?.length ?? 0)}`}</strong></div><Badge tone={ptyOnline ? 'online' : ptyOnline === 0 ? 'warning' : 'unknown'}>TARGETS</Badge></article>
      <article><span className="overview-icon"><MonitorPlay size={17} aria-hidden="true" /></span><div><small>Emiten su TUI</small><strong>{tuiOnline === undefined ? 'sin dato' : `${String(tuiOnline)} / ${String(verifiedTargets?.items?.length ?? 0)}`}</strong></div><Badge tone={tuiOnline ? 'online' : tuiOnline === 0 ? 'warning' : 'unknown'}>TUI</Badge></article>
    </div>
  );

  return (
    <div className="ultimate-terminal-page" data-tui={observando ? 'abierta' : undefined}>
      <PageHeader
        eyebrow={fleetLabel}
        title="Terminal de agentes"
        description="Transmisión en vivo de la TUI de cada agente —la sesión tmux que está corriendo ahora— en solo lectura. Un alias sólo emite si el servidor publica su modo harness; el resto queda con su motivo escrito, nunca en verde."
        actions={
          <>
            {observando ? (
              <details className="terminal-resumen">
                {/*
                  The label carries the figure you actually glance at —active leases— so the closed
                  disclosure is not a mute button: it opens when the detail is needed, not to find
                  out whether something is happening.
                */}
                <summary title="Los seis contadores de la flota y la doctrina de la vista. Se repliegan mientras mirás una TUI porque no cambian mientras la mirás.">
                  <Wifi size={14} aria-hidden="true" />
                  Estado de la flota
                  <span className="terminal-resumen-cifra">{online} / {agents.length || '?'}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </summary>
                <div className="terminal-resumen-panel">
                  {contadores}
                  {/* Same constant as the grid footer, which in this mode collapses. */}
                  <p className="terminal-resumen-doctrina"><ShieldCheck size={13} aria-hidden="true" /> {TEXTO_DOCTRINA}</p>
                </div>
              </details>
            ) : null}
            <button className="button secondary" type="button" onClick={refreshAll} disabled={status.loading && !status.data}><RefreshCw size={16} aria-hidden="true" /> Sincronizar todo</button>
          </>
        }
      />

      {observando ? null : contadores}

      {relayUnavailable ? (
        <div className="terminal-relay-notice" role="status">
          <TerminalSquare size={17} aria-hidden="true" />
          {/* The TITLE must tell the truth too: with a 403 the channel exists and what is missing is
              the permission, so "not available in this stack" was the same lie as the body. See
              `TerminalRelayCause` in relay-status.ts. */}
          <div>
            <strong>{relay.cause === 'sin-permiso'
              ? 'La terminal de agentes requiere permiso de control'
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
        onSesionesAbiertas={setSesionesAbiertas}
      />
    </div>
  );
}
