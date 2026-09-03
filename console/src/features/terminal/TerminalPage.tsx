import { Activity, ChevronDown, MonitorPlay, RadioTower, RefreshCw, ShieldCheck, TerminalSquare, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, PageHeader, PageShell } from '../../components/ui';
import { permissionState } from '../../lib';
import { listTerminalTargets } from './api';
import { TEXTO_DOCTRINA } from './doctrina';
import {
  adapterBreakdown,
  adapterBreakdownText,
  buildFleetAgents,
  countLiveTuiTargets,
  countOnlinePtyTargets,
  fleetAgentId,
} from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { ultimateTerminalGate } from './plugin';
import {
  deriveTerminalRelayState,
  TerminalRelayBoundary,
  TERMINAL_RELAY_SIN_COMPROBAR_TITULO,
  useTerminalCapability,
} from './relay-status';
import './terminal-panel.css';

/**
 * The CSS variables carrying what the viewport does NOT hand to the terminal box: the measured top
 * of the block plus the room the page container keeps below it. The sheet READS them and this
 * component WRITES them, so a drift between the two strings fails no typecheck, no lint and no DOM
 * test — the box would quietly fall back to the hand-summed 396. `alto-medido.test.ts` pins them.
 */
export const VAR_TOPE_TERMINAL = '--terminal-tope';
export const VAR_TOPE_PAGINA = '--shell-tope';

interface TerminalPageProps {
  params?: readonly string[];
}

export function TerminalPage({ params }: TerminalPageProps = {}) {
  return (
    <ConsoleAccessBoundary>
      <TerminalRelayBoundary><TerminalPageContent params={params} /></TerminalRelayBoundary>
    </ConsoleAccessBoundary>
  );
}

function TerminalPageContent({ params }: TerminalPageProps) {
  const api = useApi();
  const tenantId = params?.[0];
  const alias = params?.[1];
  /**
   * With an open session the page enters observation mode: the terminal keeps the height and the
   * six counters collapse into a single strip. Without this the terminal started at y=856 on a
   * 900-px window —44 px visible— and on mobile, at y=1952: off the entire screen.
   */
  const [sesionesAbiertas, setSesionesAbiertas] = useState(0);
  const [flotaPlegada, setFlotaPlegada] = useState(false);
  const paginaRef = useRef<HTMLDivElement | null>(null);
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const medirElTope = useCallback(() => {
    const envoltura = paginaRef.current?.parentElement;
    if (!envoltura) return;
    const contenedor = envoltura.closest('main');
    const reserva = contenedor ? Number.parseFloat(getComputedStyle(contenedor).paddingBottom) : 0;
    const tope = (nodo: Element) => {
      const alto = nodo.getBoundingClientRect().top + window.scrollY + (Number.isFinite(reserva) ? reserva : 0);
      return `${String(Math.round(alto))}px`;
    };
    envoltura.style.setProperty(VAR_TOPE_PAGINA, tope(envoltura));
    if (cajaRef.current) envoltura.style.setProperty(VAR_TOPE_TERMINAL, tope(cajaRef.current));
  }, []);
  useEffect(medirElTope);
  useEffect(() => {
    window.addEventListener('resize', medirElTope);
    return () => { window.removeEventListener('resize', medirElTope); };
  }, [medirElTope]);
  const status = useResource('ultimate-terminal-status', () => api.getStatus());
  const topology = useResource('ultimate-terminal-topology', () => api.getTopology());
  const adapters = useResource('ultimate-terminal-adapters', () => api.listAdapters());
  const access = useConsoleAccess();
  const capability = useTerminalCapability();
  const targets = useResource('ultimate-terminal-targets', () => listTerminalTargets());

  usePolling(status.reload, 5_000, { pausedWhile: status.loading });
  usePolling(adapters.reload, 15_000, { pausedWhile: adapters.loading });
  usePolling(targets.reload, 15_000, { pausedWhile: targets.loading });
  usePolling(topology.reload, 30_000, { pausedWhile: topology.loading });
  usePolling(access.reload, 30_000, { pausedWhile: access.loading });

  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const initialAgentId = tenantId && alias ? fleetAgentId(tenantId, alias) : undefined;
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
  const requestedAgentMissing = initialAgentId !== undefined
    && !fleetLoading
    && !fleetError
    && agents.every((agent) => agent.id !== initialAgentId);
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
   * OBSERVATION MODE. The six counters answer a BEFORE-the-fact question —"can I open a terminal,
   * and whose?"— so with a session open they move to a disclosure in the header row and cost ZERO
   * rows. With no session NOTHING collapses: `densidad-observacion.test.tsx` is the control.
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
    <PageShell kind="aplicacion">
      <div
        className="ultimate-terminal-page"
        ref={paginaRef}
        data-tui={observando ? 'abierta' : undefined}
        data-flota={flotaPlegada ? 'plegada' : undefined}
      >
        <PageHeader
          eyebrow={fleetLabel}
          title="Terminal de agentes"
          description="Transmisión en vivo de la TUI de cada agente —la sesión tmux que está corriendo ahora—. Se abre mirando, sin teclado; en los destinos donde el servidor publica un modo con escritura podés tomar el control con un motivo escrito a mano, y mientras lo tengas el bus le deja los mensajes en cola a ese alias. Un alias sólo emite si el servidor publica su modo harness; el resto queda con su motivo escrito, nunca en verde."
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

        {requestedAgentMissing ? (
          <EmptyState>El servidor no observa al agente {tenantId}:{alias}. No se abrió otra terminal en su lugar.</EmptyState>
        ) : (
          <>
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
              initialAgentId={initialAgentId}
              adapters={adapters.data?.items ?? []}
              access={verifiedAccess}
              topologyAccess={topology.error ? undefined : topology.data}
              terminalCapability={verifiedCapability}
              terminalTargets={verifiedTargets}
              fleetLoading={fleetLoading}
              fleetError={fleetError}
              onSesionesAbiertas={setSesionesAbiertas}
              cajaRef={cajaRef}
              flotaPlegada={flotaPlegada}
              onPlegarFlota={() => { setFlotaPlegada((plegada) => !plegada); }}
            />
          </>
        )}
      </div>
    </PageShell>
  );
}
