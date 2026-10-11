import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice } from '../../components/kit';
import { COMPANY_ROLE_LABEL, useCompanyAuthority } from './company-authority';

export function CompanySelector() {
  const api = useApi();
  const authority = useCompanyAuthority();
  const companies = useResource('session-companies', () => api.getCompanies());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(companyId: string) {
    if (busy || authority?.role !== 'platform_admin') return;
    setBusy(true); setError('');
    try { await api.switchCompany(companyId === authority.home_company ? null : companyId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo cambiar de empresa.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Empresa de la sesión" className="grid gap-2 border-t border-line pt-3">
    <label>Empresa<select value={authority?.acting_company ?? ''} disabled={busy || companies.loading || authority?.role !== 'platform_admin'}
      onChange={event => { void choose(event.target.value); }}>
      {!companies.data ? <option value={authority?.acting_company ?? ''}>{authority?.acting_company ?? 'Verificando empresa…'}</option> : null}
      {companies.data?.companies.map(company => <option key={company.id} value={company.id} disabled={company.state !== 'enabled'}>{company.name}</option>)}
    </select></label>
    <p className="m-0 text-xs text-muted">{authority ? COMPANY_ROLE_LABEL[authority.role] : 'Autoridad no informada por el servidor.'}</p>
    {authority?.platform_override ? <Notice tone="warn">Estás operando otra empresa con autoridad de plataforma.</Notice> : null}
    {companies.error || error ? <Notice tone="danger" role="alert">{error || companies.error?.message}
      <Button size="sm" disabled={busy || companies.loading} onClick={() => { void companies.reload(); }}>Releer empresas</Button></Notice> : null}
  </section>;
}
