import type { QuotaAccount, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { Notice } from '../../components/kit';
import { Time } from '../../components/ui';
import { describeQuotaOperationFailure } from './quota-messages';

export function AccountAuthenticationNotice({ account, companyId, snapshot, hideVerified = false }: {
  account: QuotaAccount; companyId: string; snapshot?: QuotaEnvironmentsSnapshot | null; hideVerified?: boolean;
}) {
  if (snapshot?.company_id !== companyId) return null;
  const environments = snapshot.environments.filter(environment => environment.company_id === companyId
    && environment.account_id === account.id && environment.provider === account.provider
    && environment.status !== 'deleted' && environment.status !== 'deleting');
  const operation = snapshot.operations.filter(item => environments.some(environment => environment.id === item.environment_id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)).at(0);
  if (operation?.action !== 'authenticate') return null;
  const environment = environments.find(item => item.id === operation.environment_id);
  const expired = operation.status === 'failed' && operation.error_code === 'AUTH_EXPIRED';
  const expiresAt = operation.result?.expires_at;
  const deadline = typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : undefined;
  const verified = operation.status === 'done' && operation.result?.authenticated_verified === true
    && operation.result.account_id === account.id;
  if (verified && hideVerified) return null;
  const message = operation.status === 'failed' || operation.error_code ? describeQuotaOperationFailure(operation)
    : verified ? 'Sesión iniciada y verificada.'
      : operation.status === 'done' ? 'Inicio de sesión completado.'
        : operation.status === 'awaiting_auth' ? 'Esperando que inicies sesión en la cuenta.' : 'Inicio de sesión en curso.';
  return <section aria-label="Inicio de sesión de la cuenta" className="grid gap-1">
    <p className="m-0 text-xs text-muted">Último intento publicado · {environment?.label}</p>
    <Notice tone={operation.status === 'failed' ? 'warn' : verified ? 'ok' : 'info'}>{message}</Notice>
    {deadline && (expired || operation.status === 'awaiting_auth') ? <p className="m-0 text-xs">
      {expired ? 'El intento caducó' : 'El intento caduca'} <Time value={deadline} />
    </p> : null}
  </section>;
}
