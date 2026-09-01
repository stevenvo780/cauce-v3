import { AlertCircle } from 'lucide-react';
import type { QuotaSnapshot } from '../../api/types';
import './licenses.css';
import { Badge } from '../../components/ui';
import { accountConsumption } from './licenses';
import type { AccountRouteProjection } from './registry';

/**
 * Expandable routing and consumption card for an account:
 * shows plan, inactivity reason, fallback bindings and routing ceiling.
 * The consumption reason is only shown when its scope is `account`.
 */
export function AccountRoutingDetail({ accountId, quotas, route }: {
  accountId: string;
  quotas: QuotaSnapshot | undefined;
  route: AccountRouteProjection | undefined;
}) {
  const consumption = accountConsumption(accountId, quotas, quotas?.thresholds);
  const entries = route?.entries ?? [];
  const fallbacks = entries.filter((entry) => entry.cell.state === 'bound-enabled'
    || entry.cell.state === 'bound-disabled');

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
        <h4>Fallback para</h4>
        {fallbacks.length === 0
          ? <span className="unknown">Ningún alias la tiene configurada como fallback.</span>
          : <ul className="assignments-list">
            {fallbacks.map(({ agent, cell }) => (
              <li key={`${agent.tenantId}/${agent.alias}`} className={`assignment-item ${cell.state === 'bound-disabled' ? 'disabled' : ''}`}>
                <div className="assignment-header">
                  <span className="agent-alias mono">{agent.tenantId}/{agent.alias}</span>
                  <span className="agent-display">{agent.displayName ?? '—'}</span>
                  {cell.state === 'bound-enabled'
                    ? <Badge tone="online">FALLBACK #{String(cell.rank ?? '?')}</Badge>
                    : <Badge tone="offline">FALLBACK INACTIVO</Badge>}
                </div>
                <div className="assignment-container">
                  Contenedor: <span className="mono">{agent.containerName ?? '?'}</span>
                  {' · '}prioridad <span className="mono">{cell.priority ?? 'UNKNOWN'}</span>
                </div>
              </li>
            ))}
          </ul>}
      </div>

      {entries.length > 0 && (
        <div className="account-section">
          <h4>Techo de ruteo</h4>
          <ul className="config-records">
            {entries.map(({ agent, cell, ceiling }) => <li key={`${agent.tenantId}/${agent.alias}`}>
              <span className="mono">{agent.tenantId}/{agent.alias}</span> puede alcanzar esta cuenta
              {cell.state === 'ceiling-only' ? ' · sin binding de fallback' : ''}
              {cell.borrowed ? ' · prestada' : ''}
              {ceiling.createdByTenant ? ` · otorgado por ${ceiling.createdByTenant}` : ''}
            </li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
