import { RefreshCw } from 'lucide-react';
import { useContext, useMemo, type ReactNode } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { Button, Notice } from '../../components/kit';
import { onNavClick, useRouteSearch } from '../../router';
import { FleetProvider } from '../../shell/fleet';
import { FleetContext, useFleet } from '../../shell/fleet-context';
import { listTerminalTargets } from './api';
import { fleetAgentId } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';
import { deriveTerminalRelayState, TERMINAL_RELAY_SIN_COMPROBAR_TITULO, TerminalRelayBoundary, useTerminalCapability } from './relay-status';
import { resumenDeFlota } from './resumen';

interface TerminalPageProps {
  params?: readonly string[];
}

/** The app shell already owns the shared roster; an isolated render gets a local owner. */
function FleetBoundary({ children }: { children: ReactNode }) {
  return useContext(FleetContext) ? children : <FleetProvider>{children}</FleetProvider>;
}

export function TerminalPage({ params }: TerminalPageProps = {}) {
  return (
    <ConsoleAccessBoundary>
      <TerminalRelayBoundary><FleetBoundary><TerminalPageContent params={params} /></FleetBoundary></TerminalRelayBoundary>
    </ConsoleAccessBoundary>
  );
}

const BANNER = 'flex shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0';

function TerminalPageContent({ params }: TerminalPageProps) {
  const fleet = useFleet();
  const access = useConsoleAccess();
  const capability = useTerminalCapability();
  const targets = useResource('ultimate-terminal-targets', () => listTerminalTargets());
  const modo = new URLSearchParams(useRouteSearch()).get('modo');
  const requestedView = modo === 'tui' || modo === 'terminal' ? modo : undefined;

  usePolling(targets.reload, 15_000, { pausedWhile: targets.loading });
  usePolling(access.reload, 30_000, { pausedWhile: access.loading });

  const tenantId = params?.[0];
  const alias = params?.[1];
  const agentId = tenantId && alias ? fleetAgentId(tenantId, alias) : undefined;
  const { agents, live, loading, error } = fleet;
  const relay = deriveTerminalRelayState(capability.data, capability.error);
  const missing = agentId !== undefined && !loading && !error && agents.every((agent) => agent.id !== agentId);
  const targetItems = targets.error ? undefined : targets.data;
  const summary = useMemo(() => resumenDeFlota(agents, targetItems?.items), [agents, targetItems]);
  const failures = [
    { endpoint: 'Presencia', error: fleet.status.error },
    { endpoint: 'Flota', error: fleet.topology.error },
    { endpoint: 'Permisos', error: access.error },
    { endpoint: 'Terminales', error: targets.error },
  ].filter((item) => item.error !== undefined);

  function refreshAll() {
    fleet.reload();
    void access.reload();
    void capability.reload();
    void targets.reload();
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col max-[760px]:h-[calc(100dvh-56px-env(safe-area-inset-bottom))]">
      <h1 className="sr-only">Terminal de agentes</h1>
      {relay.status === 'unavailable' ? (
        <Notice tone="danger" className={BANNER} role="status">
          <span>
            <strong>{relay.cause === 'sin-permiso' ? 'La terminal de agentes requiere permiso de control'
              : relay.cause === 'sin-comprobar' ? TERMINAL_RELAY_SIN_COMPROBAR_TITULO : 'Canal PTY no disponible en este stack'}</strong>
            {' '}<span>{relay.reason}</span>
          </span>
        </Notice>
      ) : null}
      {failures.length ? (
        <Notice tone="danger" className={BANNER} role="alert">
          <span className="min-w-0 flex-1">
            <strong>El plano de control contestó a medias.</strong>{' '}
            {failures.map(({ endpoint, error: failure }) => `${endpoint}: ${failure?.message ?? ''}`).join(' · ')}
          </span>
          <Button size="sm" onClick={refreshAll}>
            <RefreshCw size={13} aria-hidden="true" />Reintentar
          </Button>
        </Notice>
      ) : null}
      {missing ? (
        <Notice className="m-4" role="status">
          El servidor no observa al agente {tenantId}:{alias}.{' '}
          <a href="/terminal" onClick={(event) => { onNavClick(event, '/terminal'); }}>Elegir otro agente</a>
        </Notice>
      ) : (
        <OperatorWorkspace
          agents={agents}
          agentId={agentId}
          live={live}
          summary={summary}
          access={access.error ? undefined : access.data}
          terminalCapability={capability.error ? undefined : capability.data}
          terminalTargets={targetItems}
          fleetLoading={loading}
          fleetError={error}
          onRefresh={refreshAll}
          requestedView={requestedView}
        />
      )}
    </div>
  );
}
