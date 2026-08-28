import { AlertCircle } from 'lucide-react';
import type { ConfigurationSnapshot, QuotaSnapshot } from '../../api/types';
import './licenses.css';
import { Badge } from '../../components/ui';
import {
  accountAssignments, accountConsumption, extractAgents, extractBindings, extractCeiling,
} from './licenses';

/**
 * Ficha de ruteo y consumo desplegable para una cuenta:
 * presenta plan, motivo de inactividad, agentes asignados y techo de ruteo.
 * El motivo de consumo se muestra sólo cuando su alcance es `account`.
 */
export function AccountRoutingDetail({ accountId, quotas, config }: {
  accountId: string;
  quotas: QuotaSnapshot | undefined;
  config: ConfigurationSnapshot | undefined;
}) {
  const agents = extractAgents(config);
  const bindings = extractBindings(config);
  const ceiling = extractCeiling(config);
  const consumption = accountConsumption(accountId, quotas, quotas?.thresholds);
  const assignments = accountAssignments(accountId, bindings, agents);
  const accountCeiling = ceiling.find((entry) => entry.account_id === accountId);

  return (
    <div className="account-body">
      <div className="account-section">
        <h4>Plan</h4>
        {consumption.plan
          ? <span className="mono">{consumption.plan}</span>
          : <span className="unknown">desconocido</span>}
      </div>

      {!consumption.available && consumption.scope === 'account' && (
        <div className="account-section">
          <div className="account-notice">
            <AlertCircle size={14} aria-hidden="true" />
            {consumption.reason ?? 'No disponible'}
          </div>
        </div>
      )}

      <div className="account-section">
        <h4>Asignada a</h4>
        {assignments.length === 0
          ? <span className="unknown">Ningún alias la tiene asignada.</span>
          : <ul className="assignments-list">
            {assignments.map((assignment, index) => (
              <li key={`${assignment.alias ?? 'unknown'}-${String(index)}`} className={`assignment-item ${assignment.isPrimary ? 'primary' : 'fallback'} ${!assignment.enabled ? 'disabled' : ''}`}>
                <div className="assignment-header">
                  <span className="agent-alias mono">{assignment.alias ?? '?'}</span>
                  <span className="agent-display">{assignment.display_name ?? '—'}</span>
                  {assignment.isPrimary && <Badge tone="online">PRIMARIA</Badge>}
                  {!assignment.enabled && <Badge tone="offline">INACTIVO</Badge>}
                </div>
                <div className="assignment-container">
                  Contenedor: <span className="mono">{assignment.container_name ?? '?'}</span>
                </div>
              </li>
            ))}
          </ul>}
      </div>

      {accountCeiling && (
        <div className="account-section">
          <h4>Techo de ruteo</h4>
          <div className="ceiling-info">
            Alias <span className="mono">{accountCeiling.alias}</span> está limitado a esta cuenta.
            {accountCeiling.account_payer_tenant && accountCeiling.account_payer_tenant !== accountCeiling.created_by_tenant && (
              <div className="ceiling-note">Creado por tenant <span className="mono">{accountCeiling.created_by_tenant}</span></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
