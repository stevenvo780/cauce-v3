import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton } from '../../components/ui';
// Regla del encargo: la lógica de fleet/leases vive en features/terminal; se reutiliza, no se duplica.
import { buildFleetAgents, fleetAgentId } from '../terminal/fleet';
import { OperatorWorkspace } from '../terminal/OperatorWorkspace';

interface FleetAgentDetailPageProps {
  tenantId: string;
  alias: string;
}

/**
 * Detalle de un bot en #/fleet/:tenant/:alias. No construye una vista propia de
 * sesión/ACK/PTY: delega en OperatorWorkspace (Terminal), acotado a un único agente,
 * para reusar exactamente el mismo AckInspector, PtyTerminal y ultimateTerminalGate
 * ya verificados en Ultimate Terminal.
 */
export function FleetAgentDetailPage({ tenantId, alias }: FleetAgentDetailPageProps) {
  const api = useApi();
  const status = useResource('fleet-agent-status', () => api.getStatus());
  const topology = useResource('fleet-agent-topology', () => api.getTopology());
  const adapters = useResource('fleet-agent-adapters', () => api.listAdapters());
  const access = useResource('fleet-agent-access', () => api.getConsoleAccess());
  const capability = useResource('fleet-agent-capability', () => api.getTerminalCapability());

  const agents = useMemo(() => buildFleetAgents(status.data, topology.data), [status.data, topology.data]);
  const targetId = fleetAgentId(tenantId, alias);
  const agent = agents.find((candidate) => candidate.id === targetId);
  const verifiedAccess = access.error ? undefined : access.data;
  const verifiedCapability = capability.error ? undefined : capability.data;
  const verifiedTopology = topology.error ? undefined : topology.data;
  const fleetLoading = (status.loading && !status.data) || (topology.loading && !topology.data);
  const fleetError = status.error ?? topology.error;

  function refreshAll() {
    status.reload();
    topology.reload();
    adapters.reload();
    access.reload();
    capability.reload();
  }

  return (
    <div className="ultimate-terminal-page">
      <a className="button small secondary" href="#/fleet"><ArrowLeft size={14} aria-hidden="true" /> Volver a Fleet</a>
      {fleetLoading ? <LoadingState label={`Cargando detalle de ${alias}…`} /> : fleetError && !agent ? (
        <ErrorState error={fleetError} onRetry={refreshAll} />
      ) : (
        <>
          <PageHeader
            eyebrow={`Fleet · ${tenantId}`}
            title={agent?.alias ?? alias}
            description="Sesión de mensajes, ACK del servidor y PTY (cuando el backend lo declara) para este bot."
            actions={<RefreshButton onClick={refreshAll} loading={status.loading} />}
          />
          {!agent ? (
            <EmptyState>
              El servidor no observa a <strong>{tenantId}:{alias}</strong> en presencia ni topología. Cauce no inventa un agente inexistente.
            </EmptyState>
          ) : (
            <OperatorWorkspace
              agents={[agent]}
              adapters={adapters.data?.items ?? []}
              access={verifiedAccess}
              topologyAccess={verifiedTopology}
              terminalCapability={verifiedCapability}
              fleetLoading={fleetLoading}
              fleetError={fleetError}
            />
          )}
        </>
      )}
    </div>
  );
}
