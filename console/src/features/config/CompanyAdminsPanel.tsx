import { useState } from 'react';
import type { CompanyAdmin } from '../../api/client/company-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { diffConflictFields, isCasConflict, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';
import { Button, Notice } from '../../components/kit';

const ADMIN_ROLE_LABEL: Record<'owner' | 'admin', string> = { owner: 'Dueño', admin: 'Administrador' };

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
      if (isCasConflict(cause)) {
        const fresh = (await admins.reload()).data?.items.find(admin => admin.user_id === userId);
        setAdminConflict({
          userId, nextRole,
          diffs: diffConflictFields(
            { autoridad: nextRole === null ? 'Sin autoridad' : ADMIN_ROLE_LABEL[nextRole] },
            { autoridad: fresh ? ADMIN_ROLE_LABEL[fresh.role] : 'Sin autoridad' },
            { autoridad: 'Autoridad de empresa' },
          ),
        });
      } else setError(cause instanceof Error ? cause.message : 'No se confirmó la autoridad de empresa.');
    }
    finally { setBusy(false); }
  }
  const eligiblePeople = people.data?.items.filter(person => person.active) ?? [];
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
    <form aria-label="Asignar autoridad de empresa" className="grid gap-2 sm:grid-cols-3" onSubmit={event => { event.preventDefault();
      if (!canAssignPeople || people.loading || people.error) return;
      const current = admins.data?.items.find(admin => admin.user_id === personId); void write(personId, role, current?.version ?? 0); }}>
      <label>Persona<select required value={personId} disabled={!ready || !canAssignPeople || !admins.data?.capabilities.grant_admin || people.loading || !!people.error} onChange={event => { setPersonId(event.target.value); }}>
        <option value="">Elige persona</option>{people.data?.items.filter(person => person.active).map(person => <option key={person.id} value={person.id}>{person.display_name} · {person.email}</option>)}</select></label>
      <label>Autoridad<select value={role} disabled={!ready || !admins.data?.capabilities.grant_admin} onChange={event => { setRole(event.target.value as 'owner' | 'admin'); }}>
        <option value="admin">Administrador de empresa</option>{admins.data?.capabilities.grant_owner ? <option value="owner">Dueño de empresa</option> : null}</select></label>
      <Button type="submit" disabled={!ready || !canAssignPeople || !personId || !admins.data?.capabilities.grant_admin || people.loading || !!people.error}>Guardar autoridad</Button>
    </form>
    {!canAssignPeople ? <Notice tone="info">Selecciona esta empresa en el menú de cuenta para asignar autoridad a sus personas.</Notice> : null}
    {confirmation ? <section aria-label="Confirmar revocación de autoridad" className="grid gap-2"><p>Revocar a {confirmation.display_name} retira su autoridad de empresa y sus sesiones. Se conserva su cuenta y autoría histórica.</p>
      <div className="flex gap-2"><Button variant="danger" disabled={!ready} onClick={() => { void write(confirmation.user_id, null, confirmation.version); }}>Confirmar revocación</Button><Button disabled={busy} onClick={() => { setConfirmation(undefined); }}>Cancelar</Button></div></section> : null}
  </section>;
}
