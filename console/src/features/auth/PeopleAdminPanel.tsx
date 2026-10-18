import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ManagedPerson, PeopleInventory, PersonValues } from '../../api/client/people-admin-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { PeopleAdminForm } from './PeopleAdminForm';
import { CompanySession } from './company-authority';
import './PeopleAdmin.css';

type Action = 'retire' | 'restore' | 'purge';
export function PeopleAdminPanel({ startCreating = false }: { startCreating?: boolean } = {}) {
  const api = useApi();
  const session = useContext(CompanySession);
  const ownEmail = session?.authenticated === true && session.login_mode === 'password' ? session.subject?.trim().toLowerCase() : undefined;
  const isOwnPerson = (person: ManagedPerson) => !!ownEmail && person.email.trim().toLowerCase() === ownEmail;
  const [inventory, setInventory] = useState<PeopleInventory>();
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ person?: ManagedPerson }>();
  const [confirmation, setConfirmation] = useState<{ person: ManagedPerson; action: Action }>();
  const [stale, setStale] = useState(false);
  const generation = useRef(0);
  const sending = useRef(false);
  const reload = useCallback(async () => {
    const read = ++generation.current;
    setLoading(true); setError(''); setEditing(undefined); setConfirmation(undefined);
    try {
      const [people, config] = await Promise.all([api.listPeople(), api.getConfiguration()]);
      if (read === generation.current) { setInventory(people); setSnapshot(config); setStale(false); return true; }
    } catch (cause) {
      if (read === generation.current) { setStale(true); setError(cause instanceof Error ? cause.message : 'No se pudo acreditar el inventario.'); }
    } finally { if (read === generation.current) setLoading(false); }
    return false;
  }, [api]);
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);
  const askedToCreate = useRef(false);
  useEffect(() => {
    if (!startCreating || askedToCreate.current || loading || !inventory?.capabilities.create) return;
    askedToCreate.current = true; setEditing({}); setConfirmation(undefined); setNotice('');
  }, [startCreating, loading, inventory]);
  useEffect(() => api.onAuthGenerationChange(() => {
    generation.current += 1; setStale(true); setLoading(false); setEditing(undefined); setConfirmation(undefined);
    setNotice(''); setError('La sesión cambió. Relee personas y permisos desde la cuenta actual.');
  }), [api]);
  const canUse = !!inventory && !!snapshot && !loading && !busy && !stale && !error;
  function blockFor(allowed: boolean): string | undefined {
    if (canUse && allowed) return undefined;
    if (loading) return 'Espera a que termine la lectura de personas y permisos.';
    if (busy) return 'Espera a que termine la operación en curso.';
    if (!inventory || stale || error) return 'La última lectura no es vigente. Relee personas y permisos antes de cambiar nada.';
    return 'El servidor no habilitó esta acción para tu rol.';
  }
  async function perform(action: () => Promise<unknown>, text: string) {
    if (!canUse || sending.current) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    const current = generation.current;
    try {
      await action();
      if (current !== generation.current) return;
      setEditing(undefined); setConfirmation(undefined);
      const rereadGeneration = generation.current + 1;
      const reread = await reload();
      if (generation.current === rereadGeneration) setNotice(reread ? `${text}. Inventario releído.` : `${text}. La relectura no llegó; relee antes de otro cambio.`);
    } catch (cause) {
      if (current === generation.current) {
        setStale(true); setEditing(undefined); setConfirmation(undefined);
        setError(cause instanceof Error ? cause.message : 'No se confirmó el cambio. Relee antes de reintentar.');
      }
    } finally { sending.current = false; setBusy(false); }
  }
  async function save(values: PersonValues) {
    if (!editing || !inventory) return;
    const person = editing.person;
    if (person && !inventory.capabilities.update || !person && !inventory.capabilities.create) return;
    await perform(() => {
      if (!person) return api.createPerson(values);
      const { email, display_name, role, tenant_id, alias, password } = values;
      return api.updatePerson(person.id, person.revision, { email, display_name, role, tenant_id, alias, ...(password ? { password } : {}) });
    }, person ? 'Persona actualizada' : 'Persona creada');
  }
  async function confirm() {
    if (!confirmation || isOwnPerson(confirmation.person) || !inventory?.capabilities[confirmation.action]) return;
    const { person, action } = confirmation;
    await perform(() => action === 'retire' ? api.retirePerson(person.id, person.revision)
      : action === 'restore' ? api.restorePerson(person.id, person.revision) : api.purgePerson(person.id, person.revision),
    action === 'retire' ? 'Acceso de persona retirado' : action === 'restore' ? 'Acceso de persona restaurado' : 'Registro de persona purgado');
  }
  function ask(person: ManagedPerson, action: Action) {
    if (isOwnPerson(person)) return;
    setEditing(undefined); setNotice(''); setConfirmation({ person, action });
  }
  return <section className="people-admin" aria-label="Administración de personas">
    <div className="people-admin-heading"><div><h2>Personas y acceso web</h2>
      <p>Gestiona cuentas, identidad, rol y contraseña. Retirar conserva la autoría histórica y revoca acceso; purgar exige ausencia de dependencias.</p></div>
      <button type="button" className="button secondary" disabled={loading || busy} onClick={() => { void reload(); }}>Releer personas y permisos</button></div>
    {loading ? <p role="status">Leyendo personas y permisos…</p> : null}
    {error ? <p className="notice" role="alert">{error}</p> : null}
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <button type="button" className="button" disabled={!canUse || !inventory.capabilities.create} title={blockFor(inventory?.capabilities.create ?? false)}
      onClick={() => { setEditing({}); setConfirmation(undefined); setNotice(''); }}>Invitar persona</button>
    {inventory ? <div className="people-admin-table"><table><caption>Cuentas de personas</caption>
      <thead><tr><th>Persona</th><th>Identidad</th><th>Permiso</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{inventory.items.map(person => <tr key={person.id}><td><strong>{person.display_name}</strong><br />{person.email}</td>
        <td><code>{person.tenant_id}/{person.alias}</code></td><td>{person.role === 'operator' ? 'Operador' : 'Lector'}</td>
        <td>{person.active ? 'Habilitada' : 'Retirada'}</td><td><div className="acciones">
          <button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities.update} title={blockFor(inventory.capabilities.update)}
            onClick={() => { setEditing({ person }); setConfirmation(undefined); setNotice(''); }} aria-label={`Editar persona ${person.email}`}>Editar</button>
          {isOwnPerson(person) ? <p className="m-0 text-sm text-muted" role="note">No puedes retirar, restaurar ni purgar tu propia cuenta. Pide a otro administrador con autoridad sobre tu cuenta que lo haga.</p> : <><button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities[person.active ? 'retire' : 'restore']} title={blockFor(inventory.capabilities[person.active ? 'retire' : 'restore'])}
            onClick={() => { ask(person, person.active ? 'retire' : 'restore'); }} aria-label={`${person.active ? 'Retirar' : 'Restaurar'} persona ${person.email}`}>{person.active ? 'Retirar' : 'Restaurar'}</button>
          {!person.active ? <button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities.purge} title={blockFor(inventory.capabilities.purge)}
            onClick={() => { ask(person, 'purge'); }} aria-label={`Purgar persona ${person.email}`}>Purgar</button> : null}</>}
        </div></td></tr>)}</tbody></table>{!inventory.items.length ? <p>No hay personas en este inventario.</p> : null}</div> : null}
    {editing && snapshot ? <PeopleAdminForm key={editing.person?.id ?? 'create'} person={editing.person} snapshot={snapshot}
      occupied={inventory?.items ?? []} busy={!canUse} save={save} cancel={() => { setEditing(undefined); }} /> : null}
    {confirmation ? <section className="people-admin-confirm" aria-label="Confirmar cambio de acceso">
      <h3>{confirmation.action === 'retire' ? 'Retirar acceso' : confirmation.action === 'restore' ? 'Restaurar acceso' : 'Purgar definitivamente'}</h3>
      <p>{confirmation.person.email} · revisión <code>{confirmation.person.revision}</code></p>
      <p>{confirmation.action === 'retire' ? 'Se revocan sesiones y accesos anteriores. La autoría de sus mensajes se conserva.'
        : confirmation.action === 'restore' ? 'La cuenta podrá abrir una nueva sesión. Los accesos revocados no se recuperan.'
        : 'El registro se borra solo si no quedan históricos ni dependencias. El alta y el retiro ya dejan la membresía y la auditoría: si el servidor lo rechaza, la cuenta sigue retirada y sin acceso. Esta consola no borra ese historial. Si la revisión cambió, relee el inventario.'}</p>
      <div className="acciones"><button type="button" className="button" disabled={!canUse} title={blockFor(inventory?.capabilities[confirmation.action] ?? false)}
        onClick={() => { void confirm(); }}>Confirmar cambio de persona</button><button type="button" className="button secondary" disabled={busy}
          onClick={() => { setConfirmation(undefined); }}>Cancelar cambio de persona</button></div>
    </section> : null}
  </section>;
}
