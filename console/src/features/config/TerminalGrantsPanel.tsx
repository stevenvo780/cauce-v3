import { useState } from 'react';
import { ApiError } from '../../api/client/core';
import type { TerminalGrant, TerminalGrantMode } from '../../api/client/terminal-grants-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Button, Notice } from '../../components/kit';
import { listTerminalTargets } from '../terminal/api';
import { UNREACHABLE_SERVER } from '../auth/RegistrationForm';

const MODE_LABEL: Record<TerminalGrantMode, string> = {
  shell: 'Shell', harness: 'Visor de TUI', harness_rw: 'TUI escribible',
};
const ALL_MODES: readonly TerminalGrantMode[] = ['shell', 'harness', 'harness_rw'];

function grantErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error && !(cause instanceof TypeError) ? cause.message : UNREACHABLE_SERVER;
  if (cause.status === 401) return 'La sesión venció. Vuelve a iniciar sesión.';
  if (cause.status === 403) return 'Solo el dueño o un administrador de la empresa del agente puede conceder acceso a su terminal.';
  if (cause.status === 404) return 'La persona, el agente o la concesión ya no están disponibles. Relee las concesiones y vuelve a intentarlo.';
  if (cause.status === 409 && cause.message.includes('already covers')) {
    return 'Ya existe una concesión activa para esa persona sobre ese agente (campos: persona y agente). Edita o revoca la concesión existente.';
  }
  if (cause.status === 409) return 'La concesión cambió mientras guardabas (campo: versión). Relee las concesiones y vuelve a intentarlo.';
  if (cause.status === 400 && cause.message.includes('modes')) {
    return 'Campo «Modos»: elige al menos un modo válido (Shell, Visor de TUI o TUI escribible), sin repetir.';
  }
  if (cause.status === 400 && cause.message.includes('person is not active')) {
    return 'Campo «Persona»: la persona elegida no está activa y no puede recibir una concesión.';
  }
  if (cause.status === 400 && cause.message.includes('expiry')) {
    return 'Campo «Caducidad»: la fecha indicada no es válida.';
  }
  if (cause.status === 400) return 'Datos no válidos: revisa persona, agente, modos y caducidad, y vuelve a intentarlo.';
  if (cause.status === 429) return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentarlo.';
  if (cause.status === 504) return 'El servidor no contestó a tiempo. Relee las concesiones antes de reintentar.';
  return 'No se confirmó la concesión. Relee las concesiones y vuelve a intentarlo.';
}

const NO_MODE_TEXT = 'Campo «Modos»: elige al menos un modo (Shell, Visor de TUI o TUI escribible).';

function toExpiryInput(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromExpiryInput(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** CRUD of permanent terminal grants (database source; the grants file keeps working alongside). */
export function TerminalGrantsPanel() {
  const api = useApi();
  const grants = useResource('terminal-grants', () => api.listTerminalGrants());
  const people = useResource('terminal-grant-people', () => api.listPeople());
  const targets = useResource('terminal-grant-targets', async () => (await listTerminalTargets()).items ?? []);
  const [personId, setPersonId] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [modes, setModes] = useState<TerminalGrantMode[]>(['harness']);
  const [expires, setExpires] = useState('');
  const [editing, setEditing] = useState<TerminalGrant>();
  const [editModes, setEditModes] = useState<TerminalGrantMode[]>([]);
  const [editExpires, setEditExpires] = useState('');
  const [confirmation, setConfirmation] = useState<TerminalGrant>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ready = !!grants.data && !grants.error && !grants.loading && !busy;
  const canWrite = ready && grants.data?.capabilities.create === true;

  function toggle(list: TerminalGrantMode[], mode: TerminalGrantMode, set: (next: TerminalGrantMode[]) => void) {
    set(list.includes(mode) ? list.filter((item) => item !== mode) : [...list, mode]);
  }

  async function create() {
    const [tenantId, alias] = targetKey.split('\0');
    if (!canWrite || !personId || !tenantId || !alias) return;
    if (modes.length === 0) { setError(NO_MODE_TEXT); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.createTerminalGrant({
        tenant_id: tenantId, alias, grantee_human_id: personId, modes,
        expires_at: fromExpiryInput(expires),
      });
      const reread = await grants.reload();
      if (reread.error) throw reread.error;
      setNotice('Concesión de terminal creada.');
    } catch (cause) { setError(grantErrorText(cause)); } finally { setBusy(false); }
  }

  async function saveEdit() {
    if (!editing || !ready) return;
    if (editModes.length === 0) { setError(NO_MODE_TEXT); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.updateTerminalGrant(editing.id, {
        expected_version: editing.version, modes: editModes, expires_at: fromExpiryInput(editExpires),
      });
      setEditing(undefined);
      const reread = await grants.reload();
      if (reread.error) throw reread.error;
      setNotice('Concesión de terminal actualizada.');
    } catch (cause) { setError(grantErrorText(cause)); } finally { setBusy(false); }
  }

  async function revoke() {
    if (!confirmation || !ready) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.revokeTerminalGrant(confirmation.id, confirmation.version);
      setConfirmation(undefined);
      const reread = await grants.reload();
      if (reread.error) throw reread.error;
      setNotice('Concesión revocada. Sus sesiones abiertas se cerraron.');
    } catch (cause) { setError(grantErrorText(cause)); } finally { setBusy(false); }
  }

  return <section aria-label="Concesiones de terminal" className="grid gap-3 rounded-xl border border-line bg-subtle p-4">
    <div className="flex flex-wrap justify-between gap-2">
      <h3 className="m-0 text-base">Concesiones de terminal</h3>
      <ActionButton size="sm" label="Releer concesiones" disabled={busy} busy={grants.loading} announceError={false}
        action={async () => {
          const result = await grants.reload();
          return result.error ? { error: result.error } : undefined;
        }} />
    </div>
    <p className="m-0 text-sm text-muted">
      Quién puede abrir la terminal de cada agente, por persona y modo. Estas concesiones conviven con el
      archivo <code>grants.json</code>: cualquiera de las dos fuentes que conceda basta, y revocar aquí no
      revoca una fila del archivo. Revocar cierra las sesiones abiertas de esa concesión.
    </p>
    {grants.loading ? <p role="status">Leyendo concesiones…</p> : null}
    {error || grants.error ? <Notice tone="danger" role="alert">{error || grants.error?.message}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {grants.data?.items.length === 0 && !grants.error ? <p className="m-0 text-sm text-muted">Todavía no hay concesiones en esta empresa.</p> : null}
    <div className="grid gap-2">
      {grants.data?.items.map((grant) => <div key={grant.id} className="grid gap-2 border-b border-line py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            {grant.grantee_display_name} · {grant.grantee_email} → {grant.tenant_id}:{grant.alias} ·{' '}
            {grant.modes.map((mode) => MODE_LABEL[mode]).join(', ')}
            {grant.expires_at ? ` · caduca ${new Date(grant.expires_at).toLocaleString()}` : ' · sin caducidad'}
            {grant.expired ? ' · caducada' : ''}
          </span>
          <span className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!ready || grants.data?.capabilities.update !== true} onClick={() => {
              setEditing(grant); setEditModes(grant.modes); setEditExpires(toExpiryInput(grant.expires_at)); setConfirmation(undefined);
            }}>Editar</Button>
            <Button size="sm" variant="danger" disabled={!ready || grants.data?.capabilities.revoke !== true}
              onClick={() => { setConfirmation(grant); setEditing(undefined); }}>Revocar</Button>
          </span>
        </div>
        {editing?.id === grant.id ? <form aria-label={`Editar concesión de ${grant.grantee_email}`} className="grid gap-2 sm:grid-cols-3"
          onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
          <fieldset className="grid gap-1">
            <legend className="text-sm">Modos</legend>
            {ALL_MODES.map((mode) => <label key={mode} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editModes.includes(mode)} disabled={!ready}
                onChange={() => { toggle(editModes, mode, setEditModes); }} />{MODE_LABEL[mode]}
            </label>)}
          </fieldset>
          <label className="text-sm">Caducidad<input type="datetime-local" value={editExpires} disabled={!ready}
            onChange={(event) => { setEditExpires(event.target.value); }} /></label>
          <span className="flex flex-wrap items-end gap-2">
            <Button type="submit" disabled={!ready}>Guardar concesión</Button>
            <Button disabled={busy} onClick={() => { setEditing(undefined); }}>Cancelar</Button>
          </span>
        </form> : null}
      </div>)}
    </div>
    {confirmation ? <section aria-label="Confirmar revocación de concesión" className="grid gap-3">
      <p className="m-0">Revocar la concesión de {confirmation.grantee_display_name} sobre
        {' '}{confirmation.tenant_id}:{confirmation.alias} cierra sus sesiones abiertas de esa concesión.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="danger" disabled={!ready} onClick={() => { void revoke(); }}>Confirmar revocación</Button>
        <Button disabled={busy} onClick={() => { setConfirmation(undefined); }}>Cancelar</Button>
      </div>
    </section> : null}
    <form aria-label="Crear concesión de terminal" className="grid items-end gap-3 sm:grid-cols-2"
      onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="text-sm">Persona<select required value={personId} disabled={!canWrite || people.loading || !!people.error}
        onChange={(event) => { setPersonId(event.target.value); }}>
        <option value="">Elige persona</option>
        {people.data?.items.filter((person) => person.active).map((person) => <option key={person.id} value={person.id}>
          {person.display_name} · {person.email}</option>)}
      </select></label>
      <label className="text-sm">Agente<select required value={targetKey} disabled={!canWrite || targets.loading || !!targets.error}
        onChange={(event) => { setTargetKey(event.target.value); }}>
        <option value="">Elige agente</option>
        {targets.data?.map((target) => <option key={`${target.tenant_id}\0${target.alias}`} value={`${target.tenant_id}\0${target.alias}`}>
          {target.tenant_id}:{target.alias}</option>)}
        {[...new Set(targets.data?.map((target) => target.tenant_id) ?? [])].map((tenantId) => <option
          key={`${tenantId}\0*`} value={`${tenantId}\0*`}>
          {tenantId}:* · Todos los agentes</option>)}
      </select></label>
      <fieldset className="grid gap-1">
        <legend className="text-sm">Modos</legend>
        {ALL_MODES.map((mode) => <label key={mode} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={modes.includes(mode)} disabled={!canWrite}
            onChange={() => { toggle(modes, mode, setModes); }} />{MODE_LABEL[mode]}
        </label>)}
      </fieldset>
      <label className="text-sm">Caducidad (opcional)<input type="datetime-local" value={expires} disabled={!canWrite}
        onChange={(event) => { setExpires(event.target.value); }} /></label>
      <Button type="submit" disabled={!canWrite || !personId || !targetKey}>Crear concesión</Button>
    </form>
    {people.error || targets.error ? <Notice tone="danger" role="alert">
      {people.error?.message ?? targets.error?.message}</Notice> : null}
  </section>;
}
