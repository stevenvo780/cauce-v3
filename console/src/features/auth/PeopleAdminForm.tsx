import { useState } from 'react';
import type { ManagedPerson, PersonValues } from '../../api/client/people-admin-client';
import type { ConfigurationSnapshot } from '../../api/types';

export function PeopleAdminForm({ person, snapshot, busy, save, cancel }: {
  person?: ManagedPerson; snapshot: ConfigurationSnapshot; busy: boolean;
  save: (values: PersonValues) => Promise<void>; cancel: () => void;
}) {
  const [values, setValues] = useState<PersonValues>({ email: person?.email ?? '', display_name: person?.display_name ?? '',
    role: person?.role ?? 'reader', tenant_id: person?.tenant_id ?? '', alias: person?.alias ?? '',
    active: person?.active ?? true, password: '' });
  const [error, setError] = useState('');
  const tenants = (snapshot.tenants ?? []).filter(row => row.enabled === true && typeof row.id === 'string');
  const aliases = (snapshot.agents ?? []).filter(row => row.enabled === true && row.tenant_id === values.tenant_id
    && typeof row.alias === 'string' && snapshot.memberships?.some(member => member.tenant_id === row.tenant_id
      && member.alias === row.alias && member.enabled === true && snapshot.rooms?.some(room =>
        room.tenant_id === member.tenant_id && room.id === member.room_id && room.enabled === true)));
  function edit(patch: Partial<PersonValues>) { setError(''); setValues(previous => ({ ...previous, ...patch })); }
  async function submit() {
    const password = values.password;
    if (!values.display_name.trim() || values.display_name.trim().length > 120 || values.email.trim().length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(values.email.trim())) {
      setError('Introduce un correo válido y un nombre de 1 a 120 caracteres.'); return;
    }
    if (!tenants.some(row => row.id === values.tenant_id) || !aliases.some(row => row.alias === values.alias)) {
      setError('Elige un espacio y una identidad habilitada del inventario actual. El servidor verificará su lectura efectiva.'); return;
    }
    if ((!person || password.length > 0) && (password.length < 12 || password.length > 1024)) {
      setError('La contraseña debe tener entre 12 y 1024 caracteres.'); return;
    }
    await save({ ...values, email: values.email.trim(), display_name: values.display_name.trim() });
    setValues(previous => ({ ...previous, password: '' }));
  }
  return <form className="people-admin-form" aria-label={person ? `Editar persona ${person.email}` : 'Crear persona'}
    onSubmit={event => { event.preventDefault(); if (!busy) void submit(); }}>
    <h3>{person ? 'Editar persona' : 'Crear persona'}</h3>
    {person ? <p>Revisión visible: <code>{person.revision}</code>. Cambiar identidad, rol o contraseña revoca las sesiones y accesos anteriores.</p> : null}
    <label>Correo de acceso<input type="email" autoComplete="off" value={values.email} disabled={busy} maxLength={254}
      onChange={event => { edit({ email: event.target.value }); }} /></label>
    <label>Nombre de persona<input value={values.display_name} disabled={busy} maxLength={120}
      onChange={event => { edit({ display_name: event.target.value }); }} /></label>
    <label>Permiso web<select value={values.role} disabled={busy} onChange={event => { edit({ role: event.target.value as ManagedPerson['role'] }); }}>
      <option value="reader">Lector</option><option value="operator">Operador</option></select></label>
    <label>Espacio de la persona<select value={values.tenant_id} disabled={busy} onChange={event => { edit({ tenant_id: event.target.value, alias: '' }); }}>
      <option value="">Elige espacio existente</option>{tenants.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.display_name ?? row.id)} · {JSON.stringify(row.id)}</option>)}
      {person && !tenants.some(row => row.id === person.tenant_id) ? <option value={person.tenant_id} disabled>{person.tenant_id} · no habilitado</option> : null}
    </select></label>
    <label>Identidad de la persona<select value={values.alias} disabled={busy} onChange={event => { edit({ alias: event.target.value }); }}>
      <option value="">Elige identidad habilitada</option>{aliases.map(row => <option key={String(row.alias)} value={String(row.alias)}>{String(row.alias)}</option>)}
      {person?.tenant_id === values.tenant_id && !aliases.some(row => row.alias === person.alias)
        ? <option value={person.alias} disabled>{person.alias} · no habilitada</option> : null}
    </select></label>
    <label>{person ? 'Nueva contraseña (opcional)' : 'Contraseña inicial'}<input type="password" autoComplete="new-password"
      value={values.password} disabled={busy} maxLength={1024} onChange={event => { edit({ password: event.target.value }); }} /></label>
    <p>La contraseña se escribe una sola vez; no aparece en el inventario. {person ? 'Déjala vacía para conservarla.' : 'Usa entre 12 y 1024 caracteres.'}</p>
    {!person ? <label className="people-admin-checkbox"><input type="checkbox" checked={values.active} disabled={busy}
      onChange={event => { edit({ active: event.target.checked }); }} />Habilitar acceso al crear</label> : null}
    {error ? <p className="notice" role="alert">{error}</p> : null}
    <div className="acciones"><button type="submit" className="button" disabled={busy}>{person ? 'Guardar persona' : 'Crear cuenta de persona'}</button>
      <button type="button" className="button secondary" disabled={busy} onClick={cancel}>Cerrar edición de persona</button></div>
  </form>;
}
