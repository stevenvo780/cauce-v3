import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { EmptyState, PageShell } from '../../components/ui';
import { listTerminalTargets } from './api';
import { buildFleetAgents, fleetAgentId } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { deriveTerminalRelayState, TERMINAL_RELAY_SIN_COMPROBAR_TITULO, TerminalRelayBoundary, useTerminalCapability } from './relay-status';
import './terminal-panel.css';

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
  const [sesionesAbiertas, setSesionesAbiertas] = useState(0);
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
  const access = useConsoleAccess();
  const capability = useTerminalCapability();
  const targets = useResource('ultimate-terminal-targets', () => listTerminalTargets());

  usePolling(status.reload, 5_000, { pausedWhile: status.loading });
  usePolling(targets.reload, 15_000, { pausedWhile: targets.loading });
  usePolling(topology.reload, 30_000, { pausedWhile: topology.loading });
  usePolling(access.reload, 30_000, { pausedWhile: access.loading });

  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const initialAgentId = tenantId && alias ? fleetAgentId(tenantId, alias) : undefined;
  const fleetLoading = (status.loading && !status.data) || (topology.loading && !topology.data);
  const fleetError = status.error ?? topology.error;
  const relay = deriveTerminalRelayState(capability.data, capability.error);
  const missing = initialAgentId !== undefined && !fleetLoading && !fleetError
    && agents.every((agent) => agent.id !== initialAgentId);
  const failures = [
    { endpoint: 'Presencia', error: status.error },
    { endpoint: 'Flota', error: topology.error },
    { endpoint: 'Permisos', error: access.error },
    { endpoint: 'Terminales', error: targets.error },
  ].filter((item) => item.error !== undefined);

  function refreshAll() {
    void status.reload();
    void topology.reload();
    void access.reload();
    void capability.reload();
    void targets.reload();
  }

  return (
    <PageShell kind="aplicacion">
      <div className="ultimate-terminal-page terminal-focused" ref={paginaRef} data-tui={sesionesAbiertas > 0 ? 'abierta' : undefined}>
        <h1 className="sr-only">Terminal de agentes</h1>
        {relay.status === 'unavailable' ? (
          <div className="notice error" role="status">
            <strong>{relay.cause === 'sin-permiso' ? 'La terminal de agentes requiere permiso de control'
              : relay.cause === 'sin-comprobar' ? TERMINAL_RELAY_SIN_COMPROBAR_TITULO : 'Canal PTY no disponible en este stack'}</strong>
            <span>{relay.reason}</span>
          </div>
        ) : null}
        {failures.length ? <div className="notice error" role="alert">
          <strong>El plano de control contestó a medias</strong>
          <span>{failures.map(({ endpoint, error }) => `${endpoint}: ${error?.message ?? ''}`).join(' · ')}</span>
          <button className="button small secondary" type="button" onClick={refreshAll}>Reintentar</button>
        </div> : null}
        {missing ? <EmptyState>El servidor no observa al agente {tenantId}:{alias}.</EmptyState> : (
          <OperatorWorkspace
            agents={agents}
            initialAgentId={initialAgentId}
            adapters={[]}
            toolbar={<>
              <a href="/ayuda#terminal">Docs</a>
              <button className="button small secondary" type="button" onClick={refreshAll} title="Actualizar agentes y permisos">
                <RefreshCw size={15} aria-hidden="true" /><span className="sr-only">Actualizar</span>
              </button>
            </>}
            access={access.error ? undefined : access.data}
            topologyAccess={topology.error ? undefined : topology.data}
            terminalCapability={capability.error ? undefined : capability.data}
            terminalTargets={targets.error ? undefined : targets.data}
            fleetLoading={fleetLoading}
            fleetError={fleetError}
            onSesionesAbiertas={setSesionesAbiertas}
            cajaRef={cajaRef}
          />
        )}
      </div>
    </PageShell>
  );
}
