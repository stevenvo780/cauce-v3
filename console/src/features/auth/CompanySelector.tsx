import { useId, useState } from 'react';
import { ApiError } from '../../api/client/core';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Notice } from '../../components/kit';
import { COMPANY_ROLE_LABEL, useCompanyAuthority } from './company-authority';
import { UNREACHABLE_SERVER } from './RegistrationForm';

function selectorErrorText(cause: unknown, request: 'read' | 'switch'): string {
  if (!(cause instanceof ApiError)) return UNREACHABLE_SERVER;
  if (cause.status === 401) return 'La sesión venció. Vuelve a iniciar sesión.';
  if (cause.status === 403) return request === 'read' ? 'Tu sesión no puede ver las empresas.' : 'Tu sesión no tiene autoridad para cambiar de empresa.';
  if (cause.status === 404) return 'La empresa ya no existe; relee la lista.';
  if (cause.status === 409) return 'La sesión cambió o hay otro cambio de empresa en curso; relee y vuelve a intentarlo.';
  if (cause.status === 429) return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentarlo.';
  return request === 'read' ? 'No se pudieron leer las empresas. Intenta más tarde.' : 'No se pudo cambiar de empresa. Intenta más tarde.';
}

export function CompanySelector() {
  const id = useId();
  const api = useApi();
  const authority = useCompanyAuthority();
  const companies = useResource('session-companies', () => api.getCompanies());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(companyId: string) {
    if (busy || authority?.role !== 'platform_admin') return;
    setBusy(true); setError('');
    try { await api.switchCompany(companyId === authority.home_company ? null : companyId); }
    catch (cause) { setError(selectorErrorText(cause, 'switch')); }
    finally { setBusy(false); }
  }
  return <section aria-label="Empresa de la sesión" className="grid gap-2 border-t border-line pt-3">
    <div className="grid gap-1">
    <label htmlFor={id}>Empresa</label><select id={id} value={authority?.acting_company ?? ''} disabled={busy || companies.loading || authority?.role !== 'platform_admin'}
      onChange={event => { void choose(event.target.value); }}>
      {!companies.data ? <option value={authority?.acting_company ?? ''}>{authority?.acting_company ?? 'Verificando empresa…'}</option> : null}
      {companies.data?.companies.map(company => <option key={company.id} value={company.id} disabled={company.state !== 'enabled'}>{company.name}</option>)}
    </select></div>
    <p className="m-0 text-xs text-muted">{authority ? COMPANY_ROLE_LABEL[authority.role] : 'Autoridad no informada por el servidor.'}</p>
    {authority?.platform_override ? <Notice tone="warn">Estás operando otra empresa con autoridad de plataforma.</Notice> : null}
    {companies.error || error ? <Notice tone="danger" role="alert">{error || selectorErrorText(companies.error, 'read')}
      <ActionButton size="sm" label="Releer empresas" disabled={busy} busy={companies.loading} announceError={false} action={() => companies.reload()} /></Notice> : null}
  </section>;
}
