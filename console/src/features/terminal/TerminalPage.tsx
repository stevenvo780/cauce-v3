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
    return () => window.clearInterval(interval);
  }, [loading, milliseconds, reload]);
}

export function TerminalPage() {
  const api = useApi();
  /**
   * Con una sesión abierta la página entra en modo observación: el terminal se queda con el alto
   * y los seis contadores se repliegan a una tira. Sin esto el terminal empezaba en y=856 sobre
   * una ventana de 900 —44 px visibles— y en el móvil, en y=1.952: fuera de la pantalla entera.
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
      : `Operación privilegiada · ${agents.length} agentes`;
  // El relay PTY es opt-in por stack (ver 0a1d0e3): ausencia, permiso y medición inconclusa tienen
  // un aviso propio y explícito, en vez de sumarse como un "PTY: Bad Gateway" sin clasificación.
  const relay = deriveTerminalRelayState(capability.data, capability.error);
  const relayUnavailable = relay.status === 'unavailable';
  const failures = [
    status.error ? `Presencia: ${status.error.message}` : undefined,
    topology.error ? `Salas: ${topology.error.message}` : undefined,
    adapters.error ? `Adaptadores: ${adapters.error.message}` : undefined,
    access.error ? `Permisos: ${access.error.message}` : undefined,
    // El inventario de targets depende de la misma consulta; si el aviso del relay ya explica su
    // fallo, no lo duplicamos con el mismo error técnico.
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
   * ═══ MODO OBSERVACIÓN: LO QUE SE MIRA ANTES DE ABRIR NO OCUPA ALTO MIENTRAS SE MIRA UNA TUI ═══
   *
   * Los seis contadores contestan una sola pregunta, y es de ANTES: «¿puedo abrir una terminal, y
   * de quién?». Ninguno habla del alias que estás mirando y ninguno cambia mientras lo mirás. Con
   * una sesión abierta pasan a un desplegable que vive en la fila de la cabecera —o sea que cuesta
   * CERO renglones— y vuelven enteros de un clic. MEDIDO a 1920x1080 antes de esto: la tira se
   * llevaba 40 px más 10 de margen, y el pie de doctrina otros 30, sobre un terminal que se quedaba
   * con el 54,1 % de la ventana.
   *
   * Sin ninguna sesión abierta NO se pliega nada: ahí esos seis datos son justamente lo que se vino
   * a leer. Lo comprueba `densidad-observacion.test.tsx`, con su control negativo.
   */
  const observando = sesionesAbiertas > 0;
  const contadores = (
    <div className="terminal-overview" aria-label="Estado de la terminal de agentes">
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
                  El rótulo lleva la cifra que de verdad se mira de reojo —leases vigentes— para que
                  el desplegable cerrado no sea un botón mudo: se abre cuando hace falta el detalle,
                  no para averiguar si pasa algo.
                */}
                <summary title="Los seis contadores de la flota y la doctrina de la vista. Se repliegan mientras mirás una TUI porque no cambian mientras la mirás.">
                  <Wifi size={14} aria-hidden="true" />
                  Estado de la flota
                  <span className="terminal-resumen-cifra">{online} / {agents.length || '?'}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </summary>
                <div className="terminal-resumen-panel">
                  {contadores}
                  {/* La misma constante que el pie de la rejilla, que en este modo se repliega. */}
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
          {/* El TÍTULO también tiene que decir la verdad: con un 403 el canal existe y lo que falta
              es el permiso, así que «no disponible en este stack» era la misma mentira que el
              cuerpo. Ver `TerminalRelayCause` en relay-status.ts. */}
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
