import { AlertCircle, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { QuotaSnapshot } from '../../api/types';
import { Notice } from '../../components/kit';
import { Unknown } from '../../components/ui';
import { accountConsumption } from './licenses';
import type { ProviderAccount } from './registry';

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
 * Expandable detail of an account: plan and the identifiers that only the payer sees. Who reaches
 * the account and in which fallback order is the assignments matrix's job. The consumption reason
 * is only shown when its scope is `account`.
 */
export function AccountDetail({ accountId, account, quotas }: {
  accountId: string;
  account?: ProviderAccount;
  quotas: QuotaSnapshot | undefined;
}) {
  const consumption = accountConsumption(accountId, quotas, quotas?.thresholds);

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
    </div>
  );
}
