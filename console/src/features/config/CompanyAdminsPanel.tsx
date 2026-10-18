import { useState } from 'react';
import { ApiError } from '../../api/client/core';
import type { CompanyAdmin } from '../../api/client/company-client';
import { useApi } from '../../api/context';
import { UNREACHABLE_SERVER } from '../auth/RegistrationForm';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { diffConflictFields, isCasConflict, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';
import { Button, Notice } from '../../components/kit';

const ADMIN_ROLE_LABEL: Record<'owner' | 'admin', string> = { owner: 'Dueño', admin: 'Administrador' };

/** Said by status: the server message is never shown, as in CompaniesPanel. */
function adminErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error && !(cause instanceof TypeError) ? cause.message : UNREACHABLE_SERVER;
  if (cause.status === 401) return 'La sesión venció. Vuelve a iniciar sesión.';
  if (cause.status === 403) return 'No se pudo guardar la autoridad: solo un dueño de esta empresa puede asignarla y la persona elegida debe ser operadora con permiso de control. Revisa ambos puntos y vuelve a intentarlo.';
  if (cause.status === 404) return 'La persona o la empresa ya no están disponibles. Relee la autoridad y vuelve a intentarlo.';
  if (cause.status === 409) return 'La autoridad cambió mientras guardabas. Relee la autoridad y vuelve a intentarlo.';
  if (cause.status === 429) return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentarlo.';
  if (cause.status === 504) return 'El servidor no contestó a tiempo. Relee la autoridad antes de reintentar.';
  return 'No se confirmó la autoridad de empresa. Relee la autoridad y vuelve a intentarlo.';
}

export function CompanyAdminsPanel({ companyId, canAssignPeople }: { companyId: string; canAssignPeople: boolean }) {
  const api = useApi();
  const admins = useResource(`company-admins:${companyId}`, () => api.getCompanyAdmins(companyId));
  const people = useResource(`company-admin-people:${companyId}:${String(canAssignPeople)}`, () => canAssignPeople ? api.listPeople()
    : Promise.resolve({ items: [], capabilities: { create: false, update: false, retire: false, restore: false, purge: false } }));
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<'owner' | 'admin'>('admin');
  const [confirmation, setConfirmation] = useState<CompanyAdmin>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adminConflict, setAdminConflict] = useState<{ userId: string; nextRole: 'owner' | 'admin' | null; diffs: ConflictFieldDiff[] }>();
  const ready = !!admins.data && !admins.error && !admins.loading && !busy;
  async function write(userId: string, nextRole: 'owner' | 'admin' | null, version: number) {
    if (!ready) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.saveCompanyAdmin(companyId, { user_id: userId, role: nextRole, expected_version: version });
      setConfirmation(undefined); setAdminConflict(undefined); const reread = await admins.reload();
      if (reread.error) throw reread.error;
      setNotice(nextRole === null ? 'Autoridad de empresa revocada.' : 'Autoridad de empresa guardada.');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      if (message === 'company must retain a qualified owner') {
        setAdminConflict(undefined);
        setError('La empresa necesita al menos un dueño activo. Asigna otro dueño antes de revocar esta autoridad.');
        return;
      }
      if (isCasConflict(cause)) {
        const reread = await admins.reload();
        const fresh = reread.data?.items.find(admin => admin.user_id === userId);
        if (reread.error || (fresh?.version ?? 0) === version) {
          setAdminConflict(undefined);
          setError(adminErrorText(cause));
          return;
        }
        setAdminConflict({
          userId, nextRole,
          diffs: diffConflictFields(
            { autoridad: nextRole === null ? 'Sin autoridad' : ADMIN_ROLE_LABEL[nextRole] },
            { autoridad: fresh ? ADMIN_ROLE_LABEL[fresh.role] : 'Sin autoridad' },
            { autoridad: 'Autoridad de empresa' },
          ),
        });
      } else { setAdminConflict(undefined); setError(adminErrorText(cause)); }
    }
    finally { setBusy(false); }
  }
  // Only an active operator can hold company authority; the console cannot see the control
  // permission itself, so operators stay selectable and the server still decides on control.
  const eligiblePeople = people.data?.items.filter(person => person.active && person.role === 'operator') ?? [];
  return <section aria-label="Autoridad de empresa" className="grid gap-3 rounded-xl border border-line bg-subtle p-4">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="m-0 text-base">Dueños y administradores</h3><ActionButton size="sm" label="Releer autoridad" disabled={busy} busy={admins.loading || people.loading} announceError={false} action={async () => {
      const [adminResult, peopleResult] = await Promise.all([admins.reload(), canAssignPeople ? people.reload() : Promise.resolve(undefined)]);
      const error = adminResult.error ?? peopleResult?.error;
      return error ? { error } : undefined;
    }} /></div>
    {admins.loading ? <p role="status">Leyendo autoridad…</p> : null}
    {canAssignPeople && people.loading ? <p role="status">Leyendo personas elegibles…</p> : null}
    {error || admins.error || people.error ? <Notice tone="danger" role="alert">{error || (admins.error?.message ?? people.error?.message)}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {adminConflict ? <ConflictNotice diffs={adminConflict.diffs} busy={busy}
      onRetry={() => {
        const fresh = admins.data?.items.find(admin => admin.user_id === adminConflict.userId);
        void write(adminConflict.userId, adminConflict.nextRole, fresh?.version ?? 0);
      }}
      onDiscard={() => {
        const fresh = admins.data?.items.find(admin => admin.user_id === adminConflict.userId);
        setAdminConflict(undefined); setConfirmation(undefined);
        if (fresh) { setPersonId(fresh.user_id); setRole(fresh.role); } else setPersonId('');
      }} /> : null}
    {admins.data?.items.length === 0 && !admins.error ? <p className="m-0 text-sm text-muted">Todavía no hay dueños ni administradores asignados a esta empresa.</p> : null}
    <ul className="m-0 grid list-none gap-2 p-0">{admins.data?.items.map(admin => <li key={admin.user_id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2">
      <span>{admin.display_name} · {admin.email} · {admin.role === 'owner' ? 'Dueño' : 'Administrador'}</span>
      <Button size="sm" variant="danger" disabled={!ready || !admins.data?.capabilities.revoke || admin.role === 'owner' && !admins.data.capabilities.grant_owner}
        onClick={() => { setConfirmation(admin); }}>Revocar autoridad de {admin.display_name}</Button>
    </li>)}</ul>
    {canAssignPeople && !people.loading && !people.error && people.data && eligiblePeople.length === 0 ? <p className="m-0 text-sm text-muted">No hay personas activas elegibles para asignar en esta empresa.</p> : null}
    <form aria-label="Asignar autoridad de empresa" className="grid items-end gap-3 sm:grid-cols-3" onSubmit={event => { event.preventDefault();
      if (!canAssignPeople || people.loading || people.error) return;
      const current = admins.data?.items.find(admin => admin.user_id === personId); void write(personId, role, current?.version ?? 0); }}>
      <label>Persona<select required value={personId} disabled={!ready || !canAssignPeople || !admins.data?.capabilities.grant_admin || people.loading || !!people.error} onChange={event => { setPersonId(event.target.value); }}>
        <option value="">Elige persona</option>{people.data?.items.map(person => {
          const blocked = !person.active ? 'cuenta retirada: no puede recibir autoridad'
            : person.role !== 'operator' ? 'lectora: no puede recibir autoridad' : undefined;
          return <option key={person.id} value={person.id} disabled={blocked !== undefined}>{person.display_name} · {person.email}{blocked ? ` — ${blocked}` : ''}</option>;
        })}</select></label>
      <label>Autoridad<select value={role} disabled={!ready || !admins.data?.capabilities.grant_admin} onChange={event => { setRole(event.target.value as 'owner' | 'admin'); }}>
        <option value="admin">Administrador de empresa</option>{admins.data?.capabilities.grant_owner ? <option value="owner">Dueño de empresa</option> : null}</select></label>
      <Button type="submit" disabled={!ready || !canAssignPeople || !personId || !admins.data?.capabilities.grant_admin || people.loading || !!people.error}>Guardar autoridad</Button>
    </form>
    {canAssignPeople && people.data ? <p className="m-0 text-xs text-muted">Solo una operadora activa puede recibir autoridad, y además necesita permiso de control en su empresa. Las lectoras y las cuentas retiradas no se pueden elegir y el selector dice por qué; si eliges una operadora sin control, el servidor lo rechaza al guardar y el aviso lo explica.</p> : null}
    {!canAssignPeople ? <Notice tone="info">Selecciona esta empresa en el menú de cuenta para asignar autoridad a sus personas.</Notice> : null}
    {confirmation ? <section aria-label="Confirmar revocación de autoridad" className="grid gap-3"><p className="m-0">Revocar a {confirmation.display_name} retira su autoridad de empresa y sus sesiones. Se conserva su cuenta y autoría histórica.</p>
      <div className="flex flex-wrap items-center gap-2"><Button variant="danger" disabled={!ready} onClick={() => { void write(confirmation.user_id, null, confirmation.version); }}>Confirmar revocación</Button><Button disabled={busy} onClick={() => { setConfirmation(undefined); }}>Cancelar</Button></div></section> : null}
  </section>;
}
