import { useState } from 'react';
import { ApiError } from '../../api/client/core';
import type { CompanyRecord, RegistrationInput } from '../../api/client/company-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice, SectionCard } from '../../components/kit';
import { COMPANY_ROLE_LABEL, canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { REGISTRATION_INPUT_HINT, UNREACHABLE_SERVER } from '../auth/RegistrationForm';
import { CompanyAdminsPanel } from './CompanyAdminsPanel';
import { COMPANY_SLUG_PATTERN } from './form-patterns';

type StateChange = 'disable' | 'enable' | 'retire' | 'restore';
interface PendingChange { company: CompanyRecord; change: StateChange }

const STATE_CHANGES: Record<CompanyRecord['state'], readonly StateChange[]> = {
  enabled: ['disable', 'retire'], disabled: ['enable', 'retire'], retired: ['restore'],
};
const CHANGE_LABEL: Record<StateChange, string> = { disable: 'Deshabilitar', enable: 'Habilitar', retire: 'Retirar', restore: 'Restaurar' };
const STATE_LABEL: Record<CompanyRecord['state'], string> = { enabled: 'Activa', disabled: 'Deshabilitada', retired: 'Retirada' };

/** Losing the home company ends this document: the shell would keep painting the previous read. */
function leaveRetiredCompany(): void {
  window.location.assign('/');
}

function changeText({ company, change }: PendingChange): string {
  if (change === 'disable') return `Deshabilitar ${company.name} detiene su operación y conserva sus datos.`;
  if (change === 'retire') return `Retirar ${company.name} revoca su operación y conserva sus datos. Las dependencias serán comprobadas por el servidor.`;
  return change === 'enable' ? `Habilitar ${company.name} restablece su operación.` : `Restaurar ${company.name} vuelve a habilitar la empresa.`;
}

/** Said by status: a server message is never shown as is. */
function companyErrorText(cause: unknown, request: 'read' | 'create' | 'update'): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error && !(cause instanceof TypeError) ? cause.message : UNREACHABLE_SERVER;
  if (cause.status === 400) return request === 'create' ? REGISTRATION_INPUT_HINT : 'El servidor rechazó los datos de la empresa. Revisa el nombre y vuelve a intentarlo.';
  if (cause.status === 401) return 'La sesión venció. Vuelve a iniciar sesión.';
  if (cause.status === 403) return request === 'read' ? 'Tu sesión no puede ver las empresas.' : 'Tu sesión no tiene autoridad para este cambio de empresa.';
  if (cause.status === 404) return 'La empresa ya no existe; relee la lista.';
  if (cause.status === 409 && cause.code === 'conflict') return request === 'create'
    ? 'El correo o el identificador de empresa ya están en uso.' : 'La empresa cambió mientras la revisabas; relee la lista antes de reintentar.';
  if (cause.status === 409) return 'La sesión cambió o hay otro cambio de empresa en curso; relee y vuelve a intentarlo.';
  if (cause.status === 429) return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentarlo.';
  if (cause.status === 504) return 'El servidor no contestó a tiempo; relee la lista antes de reintentar.';
  return request === 'read' ? 'No se pudieron leer las empresas. Intenta más tarde.' : 'El servidor no pudo completar el cambio de empresa. Intenta más tarde.';
}

export function CompaniesPanel() {
  const api = useApi();
  const authority = useCompanyAuthority();
  const resource = useResource('managed-companies', () => api.getCompanies());
  const [editing, setEditing] = useState<CompanyRecord>();
  const [name, setName] = useState('');
  const [pending, setPending] = useState<PendingChange>();
  const [creating, setCreating] = useState(false);
  const [adminsCompany, setAdminsCompany] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canCreate = authority?.role === 'platform_admin';
  const canSeeAdmins = canManageCompany(authority?.role);
  const canEdit = (company: CompanyRecord) => authority?.role === 'platform_admin'
    || authority?.role === 'company_owner' && company.id === authority.acting_company;
  async function perform(action: () => Promise<unknown>, message: string, request: 'create' | 'update', recheckAccess = false) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action(); setEditing(undefined); setPending(undefined); setCreating(false);
      setNotice(message);
      if (recheckAccess) { leaveRetiredCompany(); return; }
      const reread = await resource.reload();
      if (reread.error instanceof ApiError && (reread.error.status === 401 || reread.error.status === 403)) {
        leaveRetiredCompany(); return;
      }
      if (reread.error) setError(`El cambio se guardó, pero no se pudo releer: ${companyErrorText(reread.error, 'read')}`);
    } catch (cause) { setError(companyErrorText(cause, request)); }
    finally { setBusy(false); }
  }
  function applyChange({ company, change }: PendingChange) {
    void perform(() => change === 'retire' ? api.retireCompany(company.id, company.version)
      : api.updateCompany(company.id, { expected_version: company.version, state: change === 'disable' ? 'disabled' : 'enabled' }),
    'Estado de empresa actualizado.', 'update', company.id === authority?.home_company && (change === 'disable' || change === 'retire'));
  }
  return <SectionCard level={3} title="Empresas" className="gap-2 p-3">
    {authority ? <p className="text-xs text-muted">{COMPANY_ROLE_LABEL[authority.role]} · {authority.acting_company}</p> : null}
    <div className="flex flex-wrap gap-2">{canCreate ? <Button disabled={busy || resource.loading || !!resource.error} onClick={() => { setCreating(true); }}>Crear empresa</Button> : null}
      <Button disabled={busy || resource.loading} onClick={() => { void resource.reload(); }}>Releer empresas</Button></div>
    {resource.loading ? <p role="status">Leyendo empresas…</p> : null}
    {error || resource.error ? <Notice tone="danger" role="alert">{error || companyErrorText(resource.error, 'read')}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {!canSeeAdmins && resource.data ? <p className="m-0 text-xs text-muted">Solo dueños, administradores de empresa y la plataforma ven y asignan la autoridad de empresa.</p> : null}
    <ul className="m-0 grid list-none gap-2 p-0">{resource.data?.companies.map(company => <li key={company.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
      <div><strong>{company.name}</strong><p className="m-0 text-xs text-muted">{STATE_LABEL[company.state]} · versión {company.version}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canEdit(company) || busy || !!resource.error} onClick={() => { setName(company.name); setEditing(company); }}>Editar</Button>
        <Button size="sm" disabled={!canSeeAdmins || busy || !!resource.error} onClick={() => { setAdminsCompany(current => current === company.id ? undefined : company.id); }}>Autoridad de empresa</Button>
        {STATE_CHANGES[company.state].map(change => <Button key={change} size="sm" disabled={!canEdit(company) || busy || !!resource.error}
          onClick={() => { setPending({ company, change }); }}>{CHANGE_LABEL[change]}</Button>)}</div>
    </li>)}</ul>
    {resource.data && !resource.data.companies.length ? <p>No hay empresas disponibles para esta sesión.</p> : null}
    {editing ? <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void perform(() => api.updateCompany(editing.id, { expected_version: editing.version, name: name.trim() }), 'Empresa actualizada.', 'update'); }}>
      <label>Nombre de empresa<input required maxLength={80} value={name} disabled={busy} onChange={event => { setName(event.target.value); }} /></label>
      <div className="flex gap-2"><Button type="submit" disabled={busy || !name.trim()}>Guardar empresa</Button><Button type="button" disabled={busy} onClick={() => { setEditing(undefined); }}>Cancelar</Button></div>
    </form> : null}
    {pending ? <StateChangeConfirmation key={`${pending.company.id}:${pending.change}`} pending={pending} busy={busy}
      ownHome={pending.company.id === authority?.home_company} confirm={() => { applyChange(pending); }} cancel={() => { setPending(undefined); }} /> : null}
    {creating && canCreate ? <CompanyCreateForm busy={busy} cancel={() => { setCreating(false); }} save={input => perform(() => api.createCompany(input), 'Empresa y cuenta de dueño creadas.', 'create')} /> : null}
    {adminsCompany && canSeeAdmins ? <CompanyAdminsPanel key={adminsCompany} companyId={adminsCompany} canAssignPeople={authority?.acting_company === adminsCompany} /> : null}
  </SectionCard>;
}

/** Disabling or retiring takes the company id typed out; on the session's home company it also ends the session's own authority. */
function StateChangeConfirmation({ pending, ownHome, busy, confirm, cancel }: {
  pending: PendingChange; ownHome: boolean; busy: boolean; confirm: () => void; cancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const { company, change } = pending;
  const typedConfirmation = change === 'disable' || change === 'retire';
  return <section aria-label="Confirmar estado de empresa" className="grid gap-2">
    <p className="m-0">{changeText(pending)}</p>
    {typedConfirmation && ownHome ? <Notice tone="warn">Es tu empresa de origen: al confirmar perderás el acceso a la consola en ese mismo momento.
      Solo un administrador de plataforma puede volver a habilitarla o restaurarla.</Notice> : null}
    {typedConfirmation ? <label>Escribe el identificador <code>{company.id}</code> para confirmar
      <input value={typed} autoComplete="off" disabled={busy} onChange={event => { setTyped(event.target.value); }} /></label> : null}
    <div className="flex gap-2"><Button disabled={busy || (typedConfirmation && typed !== company.id)} onClick={confirm}>Confirmar cambio de empresa</Button>
      <Button disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </section>;
}

function CompanyCreateForm({ busy, save, cancel }: { busy: boolean; save: (input: RegistrationInput) => Promise<void>; cancel: () => void }) {
  const [draft, setDraft] = useState<RegistrationInput>({ email: '', name: '', password: '', company: { name: '', slug: '' } });
  const input = (key: 'email' | 'name' | 'password', value: string) => { setDraft(previous => ({ ...previous, [key]: value })); };
  return <form aria-label="Crear empresa y dueño" className="grid gap-2" onSubmit={event => { event.preventDefault();
    void save(draft).finally(() => { setDraft(previous => ({ ...previous, password: '' })); }); }}>
    <label>Nombre de empresa<input required maxLength={80} value={draft.company.name} disabled={busy} onChange={event => { setDraft(previous => ({ ...previous, company: { ...previous.company, name: event.target.value } })); }} /></label>
    <label>Identificador de empresa<input required pattern={COMPANY_SLUG_PATTERN} maxLength={63} value={draft.company.slug} disabled={busy} onChange={event => { setDraft(previous => ({ ...previous, company: { ...previous.company, slug: event.target.value } })); }} /></label>
    <label>Nombre del dueño<input required maxLength={120} value={draft.name} disabled={busy} onChange={event => { input('name', event.target.value); }} /></label>
    <label>Correo del dueño<input required type="email" value={draft.email} disabled={busy} onChange={event => { input('email', event.target.value); }} /></label>
    <label>Contraseña inicial<input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={draft.password} disabled={busy} onChange={event => { input('password', event.target.value); }} /></label>
    <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear empresa y dueño'}</Button><Button type="button" disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </form>;
}
