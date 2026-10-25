import { useState, type RefObject } from 'react';
import { isReservedAlias } from '@cauce/protocol/configuration';
import type { ManagedPerson, PersonValues } from '../../api/client/people-admin-client';
import type { ConfigurationSnapshot } from '../../api/types';

/** A new company has no enabled agent, so an empty identity choice becomes an alias derived from the mailbox. */
function aliasFromEmail(email: string, taken: ReadonlySet<string>): string {
  const local = email.trim().toLowerCase().split('@')[0] ?? '';
  let base = local.replace(/[^a-z0-9_-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  if (!/^[a-z]/u.test(base)) base = `p${base}`;
  base = base.slice(0, 60);
  if (base.length < 2) base = 'persona';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate) || isReservedAlias(candidate)) {
    const suffix = `-${String(n)}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    n += 1;
    if (n > 100) break;
  }
  return candidate;
}

export function PeopleAdminForm({ person, snapshot, occupied = [], busy, save, cancel, formRef }: {
  person?: ManagedPerson; snapshot: ConfigurationSnapshot; occupied?: readonly Pick<ManagedPerson, 'tenant_id' | 'alias'>[];
  busy: boolean; save: (values: PersonValues) => Promise<void>; cancel: () => void;
  formRef?: RefObject<HTMLFormElement | null>;
}) {
  const [values, setValues] = useState<PersonValues>({ email: person?.email ?? '', display_name: person?.display_name ?? '',
    role: person?.role ?? 'reader', tenant_id: person?.tenant_id ?? '', alias: person?.alias ?? '',
    active: person?.active ?? true, password: '' });
  const [error, setError] = useState('');
  const tenants = (snapshot.tenants ?? []).filter(row => row.enabled === true && typeof row.id === 'string');
  const catalog = (snapshot.agents ?? []).filter(row => row.enabled === true && row.tenant_id === values.tenant_id
    && typeof row.alias === 'string' && snapshot.memberships?.some(member => member.tenant_id === row.tenant_id
      && member.alias === row.alias && member.enabled === true && snapshot.rooms?.some(room =>
        room.tenant_id === member.tenant_id && room.id === member.room_id && room.enabled === true)));
  const currentAlias = person?.tenant_id === values.tenant_id ? person.alias : undefined;
  const aliases = currentAlias && !catalog.some(row => row.alias === currentAlias)
    ? [...catalog, { alias: currentAlias }] : catalog;
  const taken = new Set<string>();
  for (const agent of snapshot.agents ?? []) {
    if (agent.tenant_id === values.tenant_id && typeof agent.alias === 'string') taken.add(agent.alias);
  }
  for (const row of occupied) if (row.tenant_id === values.tenant_id) taken.add(row.alias);
  const generated = values.alias === '' ? aliasFromEmail(values.email || 'persona@local.invalid', taken) : '';
  function edit(patch: Partial<PersonValues>) { setError(''); setValues(previous => ({ ...previous, ...patch })); }
  async function submit() {
    const password = values.password;
    const email = values.email.trim();
    if (!values.display_name.trim() || values.display_name.trim().length > 120 || email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      setError('Escribí un correo válido y un nombre de 1 a 120 caracteres.'); return;
    }
    if (!tenants.some(row => row.id === values.tenant_id)) {
      setError('Elegí un espacio del inventario actual.'); return;
    }
    if (values.alias !== '' && !aliases.some(row => row.alias === values.alias)) {
      setError('Elegí una identidad del inventario o creá una nueva para este correo.'); return;
    }
    const alias = values.alias || aliasFromEmail(email, taken);
    if ((!person || password.length > 0) && (password.length < 12 || password.length > 1024)) {
      setError('La contraseña debe tener entre 12 y 1024 caracteres.'); return;
    }
    await save({ ...values, email, display_name: values.display_name.trim(), alias });
  }
  return <form ref={formRef} noValidate className="people-admin-form" aria-label={person ? `Editar persona ${person.email}` : 'Invitar persona'}
    onSubmit={event => { event.preventDefault(); if (!busy) void submit(); }}>
    <h3>{person ? 'Editar persona' : 'Invitar persona'}</h3>
    {person ? <p>Revisión visible: <code>{person.revision}</code>. Cambiar identidad, rol o contraseña revoca las sesiones y accesos anteriores.</p> : null}
    <label>Correo de acceso<input type="email" autoComplete="off" value={values.email} disabled={busy} maxLength={254}
      onChange={event => { edit({ email: event.target.value }); }} /></label>
    <label>Nombre de persona<input value={values.display_name} disabled={busy} maxLength={120}
      onChange={event => { edit({ display_name: event.target.value }); }} /></label>
    <label>Permiso web<select value={values.role} disabled={busy} onChange={event => { edit({ role: event.target.value as ManagedPerson['role'] }); }}>
      <option value="reader">Lector</option><option value="operator">Operador</option></select></label>
    <label>Espacio de la persona<select value={values.tenant_id} disabled={busy} onChange={event => { edit({ tenant_id: event.target.value, alias: '' }); }}>
      <option value="">Elegí un espacio existente</option>{tenants.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.display_name ?? row.id)} · {String(row.id)}</option>)}
      {person && !tenants.some(row => row.id === person.tenant_id) ? <option value={person.tenant_id} disabled>{person.tenant_id} · no habilitado</option> : null}
    </select></label>
    <label>Identidad de la persona<select value={values.alias} disabled={busy} onChange={event => { edit({ alias: event.target.value }); }}>
      <option value="">{generated ? `Crear identidad ${generated}` : 'Crear identidad para este correo'}</option>
      {aliases.map(row => <option key={String(row.alias)} value={String(row.alias)}>{String(row.alias)}</option>)}
    </select></label>
    {values.alias === '' ? <p className="notice" role="status">Se crea una identidad propia para este correo. No hace falta que el espacio tenga ya un agente habilitado.</p> : null}
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
