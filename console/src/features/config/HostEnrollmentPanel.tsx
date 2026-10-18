import { useRef, useState } from 'react';
import type { HostEnrollment, HostInvitation } from '../../api/client/host-enrollment-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ApiError } from '../../api/client/core';
import { FormDialog } from '../../components/dialogs';
import { ActionButton } from '../../components/action-button';
import { Button, Notice } from '../../components/kit';
import { Time } from '../../components/ui';
import { useCompanyAuthority } from '../auth/company-authority';
import { UNREACHABLE_SERVER } from '../auth/RegistrationForm';
import { HOST_ID_PATTERN } from './form-patterns';

const HOST_NAME_PATTERN = '[a-z0-9_]+';

function enrollmentFailure(cause: unknown, fallback: string): string {
  if (cause instanceof TypeError) return UNREACHABLE_SERVER;
  return cause instanceof Error && !(cause instanceof ApiError) ? cause.message : fallback;
}

/** The server answers in English; the console maps by status and never shows that text. */
function inviteFailure(cause: unknown, prefix: string): string {
  if (cause instanceof ApiError && cause.status === 403) {
    return prefix ? `Este ordenador debe llamarse ${prefix}nombre, con letras minúsculas, números o guiones bajos en el nombre, o tu rol no permite invitar.` : 'Tu rol no permite invitar ordenadores.';
  }
  if (cause instanceof ApiError && cause.status === 409) {
    return cause.message.includes('already registered')
      ? 'Ese identificador ya pertenece a un ordenador registrado. Elige otro nombre.'
      : 'Ese ordenador ya tiene una invitación pendiente. Cancélala o espera a que caduque antes de crear otra.';
  }
  return enrollmentFailure(cause, 'No se confirmó la invitación. Relee antes de reintentar.');
}

function signerFingerprint(value: string | undefined): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}
/** `lostReady` marks a computer whose executor was ready earlier in this view and stopped publishing capabilities. */
function enrolledState(row: HostEnrollment, canPrepare: boolean, lostReady: boolean): string {
  if (row.executor_ready === true) return 'Ejecutor listo';
  if (lostReady) return 'Identidad confirmada; el ejecutor no responde';
  return canPrepare
    ? 'Identidad confirmada; falta preparar el ejecutor con cauce hosts setup en ese ordenador'
    : 'Identidad confirmada; el ejecutor aún no está listo';
}

export function HostEnrollmentPanel({ canEnroll }: { canEnroll: boolean }) {
  const api = useApi();
  const enrollments = useResource('host-enrollments', () => api.getHostEnrollments());
  const [form, setForm] = useState(false);
  const authority = useCompanyAuthority();
  const prefix = authority && authority.role !== 'platform_admin' ? `${authority.acting_company}-` : '';
  const [hostId, setHostId] = useState('');
  const wasReady = useRef(new Set<string>());
  const [name, setName] = useState('');
  const [invitation, setInvitation] = useState<HostInvitation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ready = canEnroll && !busy && !enrollments.loading && !enrollments.error;
  async function create() {
    if (!ready) return;
    if (!hostId.trim() || !name.trim()) { setError('Escribe el identificador y el nombre del ordenador.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await api.inviteHost({ host_id: `${prefix}${hostId.trim()}`, display_name: name.trim() });
      setInvitation(receipt); setForm(false); setHostId(''); setName('');
      await enrollments.reload();
    } catch (cause) { setError(inviteFailure(cause, prefix)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!ready) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.revokeHostInvitation(id);
      if (invitation?.enrollment_id === id) setInvitation(undefined);
      const result = await enrollments.reload();
      if (result.error) throw new Error('La cancelación respondió; falta releer el estado.');
      setNotice('Invitación cancelada.');
    } catch (cause) { setError(enrollmentFailure(cause, 'No se confirmó la cancelación. Relee el estado.')); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(JSON.stringify(invitation)); setNotice('Invitación copiada.'); }
    catch { setError('No se pudo copiar. Selecciona y copia el contenido de la invitación.'); }
  }
  const currentInvitation = invitation && !enrollments.data?.enrollments.some(row => row.enrollment_id === invitation.enrollment_id && row.state !== 'pending') ? invitation : undefined;
  const enrollCommand = `cauce hosts enroll --gateway ${window.location.origin} --invitation-stdin`;
  const fingerprint = signerFingerprint(enrollments.data?.setup_signer_fingerprint);
  const canPrepare = fingerprint !== undefined;
  for (const row of enrollments.data?.enrollments ?? []) if (row.executor_ready === true) wasReady.current.add(row.enrollment_id);
  return <section aria-label="Añadir ordenador" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-semibold">Conectar un ordenador</h3>
      <div className="flex flex-wrap gap-2"><ActionButton size="sm" label="Releer invitaciones" disabled={busy} busy={enrollments.loading} announceError={false} action={() => enrollments.reload()} />
        <Button variant="primary" size="sm" disabled={!ready || !!currentInvitation} onClick={() => { setForm(true); }}>Añadir ordenador</Button></div></div>
    <p className="m-0 text-xs text-muted">Crea una invitación y úsala en el ordenador que vas a conectar. Allí se confirma su identidad y después se prepara el ejecutor con la política de tu empresa, sin pasar por la plataforma.</p>
    {!form && (error || enrollments.error) ? <Notice tone="danger" role="alert">{error || enrollmentFailure(enrollments.error, 'No se pudieron leer las invitaciones. Relee el estado.')}</Notice> : null}
    {notice ? <Notice tone="info" role="status">{notice}</Notice> : null}
    {enrollments.loading ? <p role="status">Leyendo invitaciones…</p> : null}
    <FormDialog open={form} busy={busy} onClose={() => { setForm(false); }} title="Invitar ordenador"
      description="El identificador y el nombre van en campos propios. La invitación se usa una sola vez en ese ordenador.">
      <form aria-label="Invitar ordenador" className="grid gap-3" onSubmit={event => { event.preventDefault(); void create(); }}>
        {error || enrollments.error ? <Notice tone="danger" role="alert">{error || enrollmentFailure(enrollments.error, 'No se pudieron leer las invitaciones. Relee el estado.')}</Notice> : null}
        <label>Identificador del ordenador
          {prefix ? <span aria-hidden="true" className="font-mono text-sm break-all">{prefix}</span> : null}
          <input required pattern={prefix ? HOST_NAME_PATTERN : HOST_ID_PATTERN} title={prefix ? `Solo letras minúsculas, números o guiones bajos; el identificador completo será ${prefix}nombre.` : undefined} maxLength={64 - prefix.length} value={hostId} placeholder={prefix ? 'equipo_1' : 'equipo-1'} disabled={!ready} onChange={event => { setHostId(event.target.value); }} />
        </label>
        {prefix ? <p className="m-0 text-xs text-muted">Completa el identificador con minúsculas, números o guiones bajos (sin guiones): ya empieza con «{prefix}».</p> : null}
        <label>Nombre del ordenador
          <input required maxLength={120} value={name} placeholder="Ordenador del equipo" disabled={!ready} onChange={event => { setName(event.target.value); }} />
        </label>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!ready}>Crear invitación</Button><Button disabled={busy} onClick={() => { setForm(false); }}>Cancelar</Button></div>
      </form>
    </FormDialog>
    {currentInvitation ? <section aria-label="Invitación de un solo uso" className="grid gap-2 rounded-lg border border-warn p-3">
      <Notice tone="warn">Esta invitación se entrega una sola vez. Caduca <Time value={currentInvitation.expires_at} />. Conserva su contenido antes de cerrar; podrás cancelar y crear otra si lo pierdes.</Notice>
      <label>Invitación del ordenador<textarea readOnly className="min-h-32 font-mono text-xs" value={JSON.stringify(currentInvitation, null, 2)} /></label>
      {signerFingerprint(currentInvitation.setup_signer_fingerprint) ? <>
        <p className="m-0 text-xs">En ese ordenador, con Cauce CLI, Docker, Node.js 22, Python 3.12 con PyYAML y OpenSSL instalados, y desde un usuario del sistema dedicado a esta empresa, ejecuta el primer comando y pega la invitación por su entrada estándar; después, el segundo instala y arranca el ejecutor como servicio de tu usuario:</p>
        <code aria-label="Comando de enrolamiento" className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-2 text-xs">{enrollCommand}</code>
        <code aria-label="Comando de preparación" className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-2 text-xs">cauce hosts setup</code>
        <p className="m-0 text-xs text-muted">La invitación fija la huella del firmante de la política, así que el ordenador rechaza cualquier otra. Comprueba el resultado con <code>cauce hosts status</code>.</p>
      </> : <>
        <p className="m-0 text-xs">En ese ordenador, con Cauce CLI instalado, ejecuta este comando y pega la invitación por su entrada estándar. Esta plataforma no firma la preparación del ejecutor, así que aquí solo se confirma la identidad:</p>
        <code aria-label="Comando de enrolamiento" className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-2 text-xs">{enrollCommand}</code>
      </>}
      <div className="flex flex-wrap gap-2"><Button onClick={() => { void copy(); }}>Copiar invitación</Button>
        <Button disabled={busy} onClick={() => { setInvitation(undefined); setNotice('Invitación cerrada. Relee la lista para comprobar si ya se usó, caducó o se canceló.'); }}>Cerrar invitación</Button></div>
    </section> : null}
    <ul aria-label="Invitaciones de ordenadores" className="m-0 grid list-none gap-2 p-0">{enrollments.data?.enrollments.map(row => {
      const expired = row.state === 'pending' && Date.parse(row.expires_at) <= Date.now();
      return <li key={row.enrollment_id} className="flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-xs">
        <span>{row.display_name} · {row.host_id} · {row.state === 'enrolled' ? enrolledState(row, canPrepare, wasReady.current.has(row.enrollment_id)) : row.state === 'revoked' ? 'Cancelada' : expired ? 'Caducada' : 'Pendiente de uso'}<br />Caduca <Time value={row.expires_at} /></span>
        {row.state === 'pending' ? <Button size="sm" disabled={!ready} onClick={() => { void revoke(row.enrollment_id); }}>Cancelar invitación de {row.display_name}</Button> : null}
      </li>;
    })}</ul>
    {enrollments.data && !enrollments.data.enrollments.length ? <p className="m-0 text-xs text-muted">Aún no hay invitaciones.</p> : null}
    {fingerprint && enrollments.data?.enrollments.some(row => row.state === 'enrolled') ? <p className="m-0 text-xs text-muted">Un ordenador enrolado antes de que la plataforma firmara la preparación la ancla con <code className="break-all">{`cauce hosts setup --signer-fingerprint ${fingerprint}`}</code></p> : null}
  </section>;
}
