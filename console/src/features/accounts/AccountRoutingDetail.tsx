import { AlertCircle, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { QuotaSnapshot } from '../../api/types';
import { Notice } from '../../components/form-kit';
import { Badge, Unknown } from '../../components/ui';
import { accountConsumption } from './licenses';
import type { AccountRouteProjection, ProviderAccount } from './registry';

/** The payer fields are not "empty": visible, redacted by the server, or not published at all. */
function PayerScoped({ account, children }: { account: ProviderAccount; children: ReactNode }) {
  if (account.payerFields === 'absent') {
    return <span className="unknown">No publicado por el gateway</span>;
  }
  if (account.payerFields === 'redacted') {
    return <span className="unknown inline-flex items-center gap-1">
      <EyeOff size={13} aria-hidden="true" /> No visible: la paga {account.payerTenant ?? 'otro tenant'}
    </span>;
  }
  return <>{children}</>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <h4 className="m-0 text-xs font-medium text-muted">{title}</h4>
      {children}
    </div>
  );
}

/**
 * Expandable detail of an account: plan, the identifiers that only the payer sees, fallback
 * bindings and routing ceiling. The consumption reason is only shown when its scope is `account`.
 */
export function AccountRoutingDetail({ accountId, account, quotas, route }: {
  accountId: string;
  account?: ProviderAccount;
  quotas: QuotaSnapshot | undefined;
  route: AccountRouteProjection | undefined;
}) {
  const consumption = accountConsumption(accountId, quotas, quotas?.thresholds);
  const entries = route?.entries ?? [];
  const fallbacks = entries.filter((entry) => entry.cell.state === 'bound-enabled'
    || entry.cell.state === 'bound-disabled');

  return (
    <div className="grid gap-4 p-3 md:grid-cols-2">
      <Section title="Plan">
        {consumption.plan
          ? <span className="mono">{consumption.plan}</span>
          : <span className="unknown">desconocido</span>}
        {!consumption.available && consumption.scope === 'account' && (
          <Notice tone="danger" role="note" className="flex items-start gap-1.5">
            <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            {consumption.reason ?? 'No disponible'}
          </Notice>
        )}
      </Section>

      {account ? (
        <Section title="Identidad">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-muted">Id externo</dt>
            <dd className="m-0 break-all"><PayerScoped account={account}><span className="mono"><Unknown value={account.externalAccountId} /></span></PayerScoped></dd>
            <dt className="text-muted">Locator</dt>
            <dd className="m-0"><PayerScoped account={account}><span className="mono"><Unknown value={account.credentialRefKind} /></span></PayerScoped></dd>
          </dl>
        </Section>
      ) : null}

      <Section title="Fallback para">
        {fallbacks.length === 0
          ? <span className="unknown">Ningún alias la tiene configurada como fallback.</span>
          : <ul className="m-0 grid list-none gap-1.5 p-0">
            {fallbacks.map(({ agent, cell }) => (
              <li key={`${agent.tenantId}/${agent.alias}`}
                className={`rounded-lg border border-line bg-surface px-3 py-2 text-[13px] ${cell.state === 'bound-disabled' ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="mono font-semibold">{agent.tenantId}/{agent.alias}</span>
                  <span className="text-muted">{agent.displayName ?? '—'}</span>
                  {cell.state === 'bound-enabled'
                    ? <Badge tone="online">FALLBACK #{String(cell.rank ?? '?')}</Badge>
                    : <Badge tone="offline">FALLBACK INACTIVO</Badge>}
                </div>
                <div className="text-xs text-muted">
                  Contenedor: <span className="mono">{agent.containerName ?? '?'}</span>
                  {' · '}prioridad <span className="mono">{cell.priority ?? 'UNKNOWN'}</span>
                </div>
              </li>
            ))}
          </ul>}
      </Section>

      {entries.length > 0 && (
        <Section title="Techo de ruteo">
          <ul className="m-0 grid list-none gap-1 p-0 text-[13px]">
            {entries.map(({ agent, cell, ceiling }) => <li key={`${agent.tenantId}/${agent.alias}`}>
              <span className="mono">{agent.tenantId}/{agent.alias}</span> puede alcanzar esta cuenta
              {cell.state === 'ceiling-only' ? ' · sin binding de fallback' : ''}
              {cell.borrowed ? ' · prestada' : ''}
              {ceiling.createdByTenant ? ` · otorgado por ${ceiling.createdByTenant}` : ''}
            </li>)}
          </ul>
        </Section>
      )}
    </div>
  );
}
