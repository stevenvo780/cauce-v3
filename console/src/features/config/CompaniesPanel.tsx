import { useState } from 'react';
import type { CompanyRecord, RegistrationInput } from '../../api/client/company-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice, SectionCard } from '../../components/kit';
import { COMPANY_ROLE_LABEL, useCompanyAuthority } from '../auth/company-authority';
import { CompanyAdminsPanel } from './CompanyAdminsPanel';
import { COMPANY_SLUG_PATTERN } from './form-patterns';

export function CompaniesPanel() {
  const api = useApi();
  const authority = useCompanyAuthority();
  const resource = useResource('managed-companies', () => api.getCompanies());
  const [editing, setEditing] = useState<CompanyRecord>();
  const [name, setName] = useState('');
  const [retiring, setRetiring] = useState<CompanyRecord>();
  const [creating, setCreating] = useState(false);
  const [adminsCompany, setAdminsCompany] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canCreate = authority?.role === 'platform_admin' || authority?.role === 'company_owner';
  const canEdit = (company: CompanyRecord) => authority?.role === 'platform_admin'
    || authority?.role === 'company_owner' && company.id === authority.acting_company;
  async function perform(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action(); setEditing(undefined); setRetiring(undefined); setCreating(false);
      const reread = await resource.reload();
      setNotice(message);
      if (reread.error) setError(`El cambio se guardó, pero no se pudo releer: ${reread.error.message}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó el cambio de empresa.'); }
    finally { setBusy(false); }
  }
  return <SectionCard level={3} title="Empresas" className="gap-2 p-3">
    {authority ? <p className="text-xs text-muted">{COMPANY_ROLE_LABEL[authority.role]} · {authority.acting_company}</p> : null}
    <div className="flex flex-wrap gap-2"><Button disabled={!canCreate || busy || resource.loading || !!resource.error} onClick={() => { setCreating(true); }}>Crear empresa</Button>
      <Button disabled={busy || resource.loading} onClick={() => { void resource.reload(); }}>Releer empresas</Button></div>
    {resource.loading ? <p role="status">Leyendo empresas…</p> : null}
    {error || resource.error ? <Notice tone="danger" role="alert">{error || resource.error?.message}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    <ul className="m-0 grid list-none gap-2 p-0">{resource.data?.companies.map(company => <li key={company.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
      <div><strong>{company.name}</strong><p className="m-0 text-xs text-muted">{company.state === 'enabled' ? 'Activa' : company.state === 'disabled' ? 'Deshabilitada' : 'Retirada'} · versión {company.version}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canEdit(company) || busy || !!resource.error} onClick={() => { setName(company.name); setEditing(company); }}>Editar</Button>
        <Button size="sm" disabled={busy || !!resource.error} onClick={() => { setAdminsCompany(current => current === company.id ? undefined : company.id); }}>Autoridad de empresa</Button>
        <Button size="sm" disabled={!canEdit(company) || busy || !!resource.error} onClick={() => { setRetiring(company); }}>{company.state !== 'retired' ? 'Retirar' : 'Restaurar'}</Button></div>
    </li>)}</ul>
    {resource.data && !resource.data.companies.length ? <p>No hay empresas disponibles para esta sesión.</p> : null}
    {editing ? <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void perform(() => api.updateCompany(editing.id, { expected_version: editing.version, name: name.trim() }), 'Empresa actualizada.'); }}>
      <label>Nombre de empresa<input required maxLength={80} value={name} disabled={busy} onChange={event => { setName(event.target.value); }} /></label>
      <div className="flex gap-2"><Button type="submit" disabled={busy || !name.trim()}>Guardar empresa</Button><Button type="button" disabled={busy} onClick={() => { setEditing(undefined); }}>Cancelar</Button></div>
    </form> : null}
    {retiring ? <section aria-label="Confirmar estado de empresa" className="grid gap-2"><p>{retiring.state !== 'retired'
      ? `Retirar ${retiring.name} revoca su operación y conserva sus datos. Las dependencias serán comprobadas por el servidor.`
      : `Restaurar ${retiring.name} vuelve a habilitar la empresa.`}</p>
      <div className="flex gap-2"><Button disabled={busy} onClick={() => { void perform(() => retiring.state !== 'retired' ? api.retireCompany(retiring.id, retiring.version)
        : api.updateCompany(retiring.id, { expected_version: retiring.version, state: 'enabled' }), 'Estado de empresa actualizado.'); }}>Confirmar cambio de empresa</Button>
        <Button disabled={busy} onClick={() => { setRetiring(undefined); }}>Cancelar</Button></div></section> : null}
    {creating ? <CompanyCreateForm busy={busy} cancel={() => { setCreating(false); }} save={input => perform(() => api.createCompany(input), 'Empresa y cuenta de dueño creadas.')} /> : null}
    {adminsCompany ? <CompanyAdminsPanel key={adminsCompany} companyId={adminsCompany} canAssignPeople={authority?.acting_company === adminsCompany} /> : null}
  </SectionCard>;
}

function CompanyCreateForm({ busy, save, cancel }: { busy: boolean; save: (input: RegistrationInput) => Promise<void>; cancel: () => void }) {
  const [draft, setDraft] = useState<RegistrationInput>({ email: '', name: '', password: '', company: { name: '', slug: '' } });
  const input = (key: 'email' | 'name' | 'password', value: string) => { setDraft(previous => ({ ...previous, [key]: value })); };
  return <form aria-label="Crear empresa y dueño" className="grid gap-2" onSubmit={event => { event.preventDefault();
    void save(draft).finally(() => { setDraft(previous => ({ ...previous, password: '' })); }); }}>
    <label>Nombre de empresa<input required maxLength={80} value={draft.company.name} disabled={busy} onChange={event => { setDraft(previous => ({ ...previous, company: { ...previous.company, name: event.target.value } })); }} /></label>
    <label>Identificador de empresa<input required pattern={COMPANY_SLUG_PATTERN} value={draft.company.slug} disabled={busy} onChange={event => { setDraft(previous => ({ ...previous, company: { ...previous.company, slug: event.target.value } })); }} /></label>
    <label>Nombre del dueño<input required maxLength={120} value={draft.name} disabled={busy} onChange={event => { input('name', event.target.value); }} /></label>
    <label>Correo del dueño<input required type="email" value={draft.email} disabled={busy} onChange={event => { input('email', event.target.value); }} /></label>
    <label>Contraseña inicial<input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={draft.password} disabled={busy} onChange={event => { input('password', event.target.value); }} /></label>
    <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear empresa y dueño'}</Button><Button type="button" disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </form>;
}
