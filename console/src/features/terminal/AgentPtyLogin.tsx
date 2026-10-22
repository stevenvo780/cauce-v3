import { useContext, useMemo, type ReactNode } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { FleetProvider } from '../../shell/fleet';
import { FleetContext, useFleet } from '../../shell/fleet-context';
import { listTerminalTargets } from './api';
import { fleetAgentId } from './fleet';
import { harnessIdForTerminal } from './login-recipe';
import { OperatorWorkspace } from './OperatorWorkspace';
import { TerminalRelayBoundary, useTerminalCapability } from './relay-status';
import { resumenDeFlota } from './resumen';

function FleetBoundary({ children }: { children: ReactNode }) {
  return useContext(FleetContext) ? children : <FleetProvider>{children}</FleetProvider>;
}

/** The live-agent terminal, already in a shell, with the harness login command typed once it attaches. */
export function AgentPtyLogin({ tenantId, alias, harnessId }: {
  tenantId: string; alias: string; harnessId: string | null | undefined;
}) {
  return <ConsoleAccessBoundary>
    <TerminalRelayBoundary><FleetBoundary><AgentPtyLoginContent tenantId={tenantId} alias={alias} harnessId={harnessId} /></FleetBoundary></TerminalRelayBoundary>
  </ConsoleAccessBoundary>;
}

function AgentPtyLoginContent({ tenantId, alias, harnessId }: {
  tenantId: string; alias: string; harnessId: string | null | undefined;
}) {
  const fleet = useFleet();
  const access = useConsoleAccess();
  const capability = useTerminalCapability();
  const targets = useResource('agent-sign-in-targets', () => listTerminalTargets());
  usePolling(targets.reload, 15_000, { pausedWhile: targets.loading });
  usePolling(access.reload, 30_000, { pausedWhile: access.loading });
  const agentId = fleetAgentId(tenantId, alias);
  const { agents, live, loading, error } = fleet;
  const present = agents.some((agent) => agent.id === agentId);
  const targetItems = targets.error ? undefined : targets.data;
  const summary = useMemo(() => resumenDeFlota(agents, targetItems?.items), [agents, targetItems]);
  function refreshAll() {
    fleet.reload();
    void access.reload();
    void capability.reload();
    void targets.reload();
  }
  if (loading && !present) return <p className="m-0 text-sm" role="status">Leyendo la flota del agente…</p>;
  if (!loading && !error && !present) {
    return <p className="m-0 text-sm" role="status">El servidor no observa al agente {tenantId}:{alias}. No hay canal PTY para iniciar sesión aquí.</p>;
  }
  return <div className="flex h-[min(70dvh,32rem)] min-h-0 min-w-0 flex-col wrap-anywhere">
    <OperatorWorkspace agents={agents} agentId={agentId} live={live} summary={summary}
      access={access.error ? undefined : access.data} terminalCapability={capability.error ? undefined : capability.data}
      terminalTargets={targetItems} fleetLoading={loading} fleetError={error} onRefresh={refreshAll}
      requestedView="terminal" loginAction="autenticar"
      harnessId={harnessIdForTerminal(live, agentId, fleet.topology.data, tenantId, alias) ?? harnessId ?? null} />
  </div>;
}
