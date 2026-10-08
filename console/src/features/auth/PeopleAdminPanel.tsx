import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ManagedPerson, PeopleInventory, PersonValues } from '../../api/client/people-admin-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { PeopleAdminForm } from './PeopleAdminForm';
import './PeopleAdmin.css';

type Action = 'retire' | 'restore' | 'purge';
export function PeopleAdminPanel() {
  const api = useApi();
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
  useEffect(() => api.onAuthGenerationChange(() => {
    generation.current += 1; setStale(true); setLoading(false); setEditing(undefined); setConfirmation(undefined);
    setNotice(''); setError('La sesión cambió. Relee personas y permisos desde la cuenta actual.');
  }), [api]);
  const canUse = !!inventory && !!snapshot && !loading && !busy && !stale && !error;
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
    if (!confirmation || !inventory?.capabilities[confirmation.action]) return;
    const { person, action } = confirmation;
    await perform(() => action === 'retire' ? api.retirePerson(person.id, person.revision)
      : action === 'restore' ? api.restorePerson(person.id, person.revision) : api.purgePerson(person.id, person.revision),
    action === 'retire' ? 'Acceso de persona retirado' : action === 'restore' ? 'Acceso de persona restaurado' : 'Registro de persona purgado');
  }
  function ask(person: ManagedPerson, action: Action) { setEditing(undefined); setNotice(''); setConfirmation({ person, action }); }
  return <section className="people-admin" aria-label="Administración de personas">
    <div className="people-admin-heading"><div><h2>Personas y acceso web</h2>
      <p>Gestiona cuentas, identidad, rol y contraseña. Retirar conserva la autoría histórica y revoca acceso; purgar exige ausencia de dependencias.</p></div>
      <button type="button" className="button secondary" disabled={loading || busy} onClick={() => { void reload(); }}>Releer personas y permisos</button></div>
    {loading ? <p role="status">Leyendo personas y permisos…</p> : null}
    {error ? <p className="notice" role="alert">{error}</p> : null}
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <button type="button" className="button" disabled={!canUse || !inventory.capabilities.create}
      onClick={() => { setEditing({}); setConfirmation(undefined); setNotice(''); }}>Crear persona</button>
    {inventory ? <div className="people-admin-table"><table><caption>Cuentas de personas</caption>
      <thead><tr><th>Persona</th><th>Identidad</th><th>Permiso</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>{inventory.items.map(person => <tr key={person.id}><td><strong>{person.display_name}</strong><br />{person.email}</td>
        <td><code>{person.tenant_id}/{person.alias}</code></td><td>{person.role === 'operator' ? 'Operador' : 'Lector'}</td>
        <td>{person.active ? 'Habilitada' : 'Retirada'}</td><td><div className="acciones">
          <button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities.update}
            onClick={() => { setEditing({ person }); setConfirmation(undefined); setNotice(''); }} aria-label={`Editar persona ${person.email}`}>Editar</button>
          <button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities[person.active ? 'retire' : 'restore']}
            onClick={() => { ask(person, person.active ? 'retire' : 'restore'); }} aria-label={`${person.active ? 'Retirar' : 'Restaurar'} persona ${person.email}`}>{person.active ? 'Retirar' : 'Restaurar'}</button>
          {!person.active ? <button type="button" className="button secondary" disabled={!canUse || !inventory.capabilities.purge}
            onClick={() => { ask(person, 'purge'); }} aria-label={`Purgar persona ${person.email}`}>Purgar</button> : null}
        </div></td></tr>)}</tbody></table>{!inventory.items.length ? <p>No hay personas en este inventario.</p> : null}</div> : null}
    {editing && snapshot ? <PeopleAdminForm key={editing.person?.id ?? 'create'} person={editing.person} snapshot={snapshot}
      busy={!canUse} save={save} cancel={() => { setEditing(undefined); }} /> : null}
    {confirmation ? <section className="people-admin-confirm" aria-label="Confirmar cambio de acceso">
      <h3>{confirmation.action === 'retire' ? 'Retirar acceso' : confirmation.action === 'restore' ? 'Restaurar acceso' : 'Purgar definitivamente'}</h3>
      <p>{confirmation.person.email} · revisión <code>{confirmation.person.revision}</code></p>
      <p>{confirmation.action === 'retire' ? 'Se revocan sesiones y accesos anteriores. La autoría de sus mensajes se conserva.'
        : confirmation.action === 'restore' ? 'La cuenta podrá abrir una nueva sesión. Los accesos revocados no se recuperan.'
        : 'El registro se elimina definitivamente si el servidor acredita que no tiene históricos ni dependencias.'}</p>
      <div className="acciones"><button type="button" className="button" disabled={!canUse}
        onClick={() => { void confirm(); }}>Confirmar cambio de persona</button><button type="button" className="button secondary" disabled={busy}
          onClick={() => { setConfirmation(undefined); }}>Cancelar cambio de persona</button></div>
    </section> : null}
  </section>;
}
