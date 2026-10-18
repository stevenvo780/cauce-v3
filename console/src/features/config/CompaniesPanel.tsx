import { useState } from 'react';
import { ApiError } from '../../api/client/core';
import type { CompanyRecord, RegistrationInput } from '../../api/client/company-client';
import { CompanyPurgeBlockedError, type CompanyPurgeBlocker, type CompanyPurgeReceipt } from '../../api/client/company-purge';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Button, Notice, SectionCard } from '../../components/kit';
import { COMPANY_ROLE_LABEL, canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { REGISTRATION_INPUT_HINT, UNREACHABLE_SERVER } from '../auth/RegistrationForm';
import { CompanyAdminsPanel } from './CompanyAdminsPanel';
import { CompanyPurgeBlockers, CompanyPurgeResult } from './CompanyPurgeResult';
import { COMPANY_SLUG_PATTERN } from './form-patterns';
import { diffConflictFields, isCasConflict, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';

type StateChange = 'disable' | 'enable' | 'retire' | 'restore' | 'purge';
interface PendingChange { company: CompanyRecord; change: StateChange }

const STATE_CHANGES: Record<CompanyRecord['state'], readonly StateChange[]> = {
  enabled: ['disable', 'retire'], disabled: ['enable', 'retire'], retired: ['restore'],
};
const CHANGE_LABEL: Record<StateChange, string> = { disable: 'Deshabilitar', enable: 'Habilitar', retire: 'Retirar', restore: 'Restaurar', purge: 'Purgar definitivamente' };
const STATE_LABEL: Record<CompanyRecord['state'], string> = { enabled: 'Activa', disabled: 'Deshabilitada', retired: 'Retirada' };

/** Losing the home company ends this document: the shell would keep painting the previous read. */
function leaveRetiredCompany(): void {
  window.location.assign('/');
}

function changeText({ company, change }: PendingChange): string {
  if (change === 'disable') return `Deshabilitar ${company.name} detiene su operación y conserva sus datos.`;
  if (change === 'retire') return `Retirar ${company.name} revoca su operación y conserva sus datos. Las dependencias serán comprobadas por el servidor.`;
  if (change === 'purge') return `Purgar definitivamente ${company.name} borra sus personas, agentes de registro, salas, invitaciones, cuentas de cuota, sesiones y espacios. No se puede deshacer. El servidor guarda una copia JSON antes de borrar; primero debes eliminar los recursos físicos pendientes desde Flota o Mis cuotas.`;
  return change === 'enable' ? `Habilitar ${company.name} restablece su operación.` : `Restaurar ${company.name} vuelve a habilitar la empresa.`;
}

/** Said by status: a server message is never shown as is. */
function companyErrorText(cause: unknown, request: 'read' | 'create' | 'update' | 'purge'): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error && !(cause instanceof TypeError) ? cause.message : UNREACHABLE_SERVER;
  if (request === 'purge' && cause.code === 'invalid_company_purge_receipt') return 'El servidor no confirmó la copia y los conteos de la purga. Relee la empresa antes de continuar.';
  if (request === 'purge' && (cause.status === 400 || cause.status === 422)) return 'La confirmación debe coincidir exactamente con el identificador de la empresa.';
  if (request === 'purge' && cause.status === 409) return 'Solo se puede purgar una empresa retirada y sin dependencias pendientes. Relee las empresas y revisa sus recursos.';
  if (request === 'purge' && cause.status === 503) return 'No se pudo guardar la copia o completar la purga. Relee la empresa antes de reintentar.';
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
  const [conflictDiffs, setConflictDiffs] = useState<ConflictFieldDiff[]>();
  const [purged, setPurged] = useState<CompanyPurgeReceipt>();
  const [blockers, setBlockers] = useState<CompanyPurgeBlocker[]>([]);
  const canCreate = authority?.role === 'platform_admin';
  const canSeeAdmins = canManageCompany(authority?.role);
  const canEdit = (company: CompanyRecord) => authority?.role === 'platform_admin'
    || authority?.role === 'company_owner' && company.id === authority.acting_company;
  async function perform<T>(action: () => Promise<T>, message: string | ((result: T) => void), request: 'create' | 'update' | 'purge', recheckAccess = false) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setPurged(undefined); setBlockers([]);
    try {
      const result = await action(); setEditing(undefined); setPending(undefined); setCreating(false);
      if (typeof message === 'string') setNotice(message); else message(result);
      if (request === 'purge') setAdminsCompany(undefined);
      if (recheckAccess) { leaveRetiredCompany(); return; }
      const reread = await resource.reload();
      if (reread.error instanceof ApiError && (reread.error.status === 401 || reread.error.status === 403)) {
        leaveRetiredCompany(); return;
      }
      if (reread.error) setError(`El cambio se guardó, pero no se pudo releer: ${companyErrorText(reread.error, 'read')}`);
    } catch (cause) { if (cause instanceof CompanyPurgeBlockedError) setBlockers(cause.blockers); else setError(companyErrorText(cause, request)); }
    finally { setBusy(false); }
  }
  async function saveCompanyName() {
    if (!editing || busy) return;
    setBusy(true); setError(''); setNotice(''); setPurged(undefined); setBlockers([]);
    try {
      await api.updateCompany(editing.id, { expected_version: editing.version, name: name.trim() });
      setEditing(undefined); setConflictDiffs(undefined); setNotice('Empresa actualizada.');
      const reread = await resource.reload();
      if (reread.error) setError(`El cambio se guardó, pero no se pudo releer: ${companyErrorText(reread.error, 'read')}`);
    } catch (cause) {
      if (isCasConflict(cause)) {
        setError(companyErrorText(cause, 'update'));
        const fresh = (await resource.reload()).data?.companies.find((company) => company.id === editing.id);
        if (fresh) {
          setEditing(fresh);
          setConflictDiffs(diffConflictFields({ name: name.trim() }, { name: fresh.name }, { name: 'Nombre de empresa' }));
        } else setConflictDiffs([]);
      } else setError(companyErrorText(cause, 'update'));
    } finally { setBusy(false); }
  }
  function applyChange({ company, change }: PendingChange, confirmation: string) {
    if (change === 'purge') {
      if (!canCreate || company.state !== 'retired' || confirmation !== company.id) return;
      void perform(() => api.purgeCompany(company.id, confirmation), setPurged, 'purge', company.id === authority.home_company);
      return;
    }
    void perform(() => change === 'retire' ? api.retireCompany(company.id, company.version)
      : api.updateCompany(company.id, { expected_version: company.version, state: change === 'disable' ? 'disabled' : 'enabled' }),
    'Estado de empresa actualizado.', 'update', company.id === authority?.home_company && (change === 'disable' || change === 'retire'));
  }
  return <SectionCard level={3} title="Empresas" className="gap-2 p-3">
    {authority ? <p className="text-xs text-muted">{COMPANY_ROLE_LABEL[authority.role]} · {authority.acting_company}</p> : null}
    <div className="flex flex-wrap gap-2">{canCreate ? <Button disabled={busy || resource.loading || !!resource.error} onClick={() => { setCreating(true); }}>Crear empresa</Button> : null}
      <ActionButton label="Releer empresas" disabled={busy} busy={resource.loading} announceError={false} action={() => resource.reload()} /></div>
    {resource.loading ? <p role="status">Leyendo empresas…</p> : null}
    {error || resource.error ? <Notice tone="danger" role="alert">{error || companyErrorText(resource.error, 'read')}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {purged ? <CompanyPurgeResult receipt={purged} /> : null}
    {blockers.length ? <CompanyPurgeBlockers blockers={blockers} /> : null}
    {!canSeeAdmins && resource.data ? <p className="m-0 text-xs text-muted">Solo dueños, administradores de empresa y la plataforma ven y asignan la autoridad de empresa.</p> : null}
    <ul className="m-0 grid list-none gap-2 p-0">{resource.data?.companies.map(company => <li key={company.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
      <div><strong>{company.name}</strong><p className="m-0 text-xs text-muted">{STATE_LABEL[company.state]} · versión {company.version}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canEdit(company) || busy || !!resource.error} onClick={() => { setName(company.name); setEditing(company); setConflictDiffs(undefined); }}>Editar</Button>
        <Button size="sm" disabled={!canSeeAdmins || busy || !!resource.error} onClick={() => { setAdminsCompany(current => current === company.id ? undefined : company.id); }}>Autoridad de empresa</Button>
        {STATE_CHANGES[company.state].map(change => <Button key={change} size="sm" disabled={!canEdit(company) || busy || !!resource.error}
          onClick={() => { setPending({ company, change }); }}>{CHANGE_LABEL[change]}</Button>)}
        {canCreate && company.state === 'retired' ? <Button size="sm" variant="danger" disabled={busy || !!resource.error}
          onClick={() => { setPending({ company, change: 'purge' }); }}>Purgar definitivamente</Button> : null}</div>
    </li>)}</ul>
    {resource.data && !resource.data.companies.length ? <p>No hay empresas disponibles para esta sesión.</p> : null}
    {editing ? <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void saveCompanyName(); }}>
      <label>Nombre de empresa<input required maxLength={80} value={name} disabled={busy} onChange={event => { setName(event.target.value); }} /></label>
      <div className="flex gap-2"><Button type="submit" disabled={busy || !name.trim()}>Guardar empresa</Button><Button type="button" disabled={busy} onClick={() => { setEditing(undefined); setConflictDiffs(undefined); }}>Cancelar</Button></div>
    </form> : null}
    {editing && conflictDiffs ? <ConflictNotice diffs={conflictDiffs} busy={busy}
      onRetry={() => { void saveCompanyName(); }}
      onDiscard={() => { setName(editing.name); setConflictDiffs(undefined); }} /> : null}
    {pending && (pending.change !== 'purge' || canCreate) ? <StateChangeConfirmation key={`${pending.company.id}:${pending.change}`} pending={pending} busy={busy}
      ownHome={pending.company.id === authority?.home_company} confirm={confirmation => { applyChange(pending, confirmation); }} cancel={() => { setPending(undefined); }} /> : null}
    {creating && canCreate ? <CompanyCreateForm busy={busy} cancel={() => { setCreating(false); }} save={input => perform(() => api.createCompany(input), 'Empresa y cuenta de dueño creadas.', 'create')} /> : null}
    {adminsCompany && canSeeAdmins ? <CompanyAdminsPanel key={adminsCompany} companyId={adminsCompany} canAssignPeople={authority?.acting_company === adminsCompany} /> : null}
  </SectionCard>;
}

/** Disabling or retiring takes the company id typed out; on the session's home company it also ends the session's own authority. */
function StateChangeConfirmation({ pending, ownHome, busy, confirm, cancel }: {
  pending: PendingChange; ownHome: boolean; busy: boolean; confirm: (confirmation: string) => void; cancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const { company, change } = pending;
  const typedConfirmation = change === 'disable' || change === 'retire' || change === 'purge';
  return <section aria-label="Confirmar estado de empresa" className="grid gap-2">
    <p className="m-0">{changeText(pending)}</p>
    {typedConfirmation && ownHome ? <Notice tone="warn">Es tu empresa de origen: al confirmar perderás el acceso a la consola en ese mismo momento.
      {change === 'purge' ? ' Sus datos quedarán borrados definitivamente.' : 'Solo un administrador de plataforma puede volver a habilitarla o restaurarla.'}</Notice> : null}
    {typedConfirmation ? <label>Escribe el identificador <code>{company.id}</code> para confirmar
      <input value={typed} autoComplete="off" disabled={busy} onChange={event => { setTyped(event.target.value); }} /></label> : null}
    <div className="flex gap-2"><Button variant={change === 'purge' ? 'danger' : 'secondary'} disabled={busy || (typedConfirmation && typed !== company.id)} onClick={() => { confirm(typed); }}>{change === 'purge' ? busy ? 'Purgando…' : 'Confirmar purga definitiva' : 'Confirmar cambio de empresa'}</Button>
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
