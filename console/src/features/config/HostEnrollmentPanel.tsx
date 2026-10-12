import { useState } from 'react';
import type { HostInvitation } from '../../api/client/host-enrollment-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice } from '../../components/kit';
import { Time } from '../../components/ui';

/** The client keeps these fields untyped; they are read only when their shape is exact. */
function executorReady(row: object): boolean { return 'executor_ready' in row && row.executor_ready === true; }
function signerFingerprint(value: object | undefined): string | undefined {
  const candidate = value && 'setup_signer_fingerprint' in value ? value.setup_signer_fingerprint : undefined;
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/u.test(candidate) ? candidate : undefined;
}
function enrolledState(row: object): string {
  return executorReady(row) ? 'Ejecutor listo: puede crear agentes' : 'Identidad confirmada; falta preparar el ejecutor con cauce hosts setup en ese ordenador';
}

export function HostEnrollmentPanel({ canEnroll }: { canEnroll: boolean }) {
  const api = useApi();
  const enrollments = useResource('host-enrollments', () => api.getHostEnrollments());
  const [form, setForm] = useState(false);
  const [hostId, setHostId] = useState('');
  const [name, setName] = useState('');
  const [invitation, setInvitation] = useState<HostInvitation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ready = canEnroll && !busy && !enrollments.loading && !enrollments.error;
  async function create() {
    if (!ready) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await api.inviteHost({ host_id: hostId, display_name: name });
      setInvitation(receipt); setForm(false); setHostId(''); setName('');
      await enrollments.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó la invitación. Relee antes de reintentar.'); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó la cancelación.'); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(JSON.stringify(invitation)); setNotice('Invitación copiada.'); }
    catch { setError('No se pudo copiar. Selecciona y copia el contenido de la invitación.'); }
  }
  const currentInvitation = invitation && !enrollments.data?.enrollments.some(row => row.enrollment_id === invitation.enrollment_id && row.state !== 'pending') ? invitation : undefined;
  const fingerprint = signerFingerprint(enrollments.data);
  return <section aria-label="Añadir ordenador" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-semibold">Conectar un ordenador</h3>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || enrollments.loading} onClick={() => { void enrollments.reload(); }}>Releer invitaciones</Button>
        <Button variant="primary" size="sm" disabled={!ready || !!currentInvitation} onClick={() => { setForm(true); }}>Añadir ordenador</Button></div></div>
    <p className="m-0 text-xs text-muted">Crea una invitación y úsala en el ordenador que vas a conectar. Allí se confirma su identidad y después se prepara el ejecutor con la política de tu empresa, sin pasar por la plataforma.</p>
    {error || enrollments.error ? <Notice tone="danger" role="alert">{error || enrollments.error?.message}</Notice> : null}
    {notice ? <Notice tone="info" role="status">{notice}</Notice> : null}
    {enrollments.loading ? <p role="status">Leyendo invitaciones…</p> : null}
    {form ? <form aria-label="Invitar ordenador" className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>Identificador del ordenador<input required pattern="[a-z][a-z0-9_-]{0,63}" maxLength={64} value={hostId} disabled={!ready} onChange={event => { setHostId(event.target.value); }} /></label>
      <label>Nombre del ordenador<input required maxLength={120} value={name} disabled={!ready} onChange={event => { setName(event.target.value); }} /></label>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={!ready}>Crear invitación</Button><Button disabled={busy} onClick={() => { setForm(false); }}>Cancelar</Button></div>
    </form> : null}
    {currentInvitation ? <section aria-label="Invitación de un solo uso" className="grid gap-2 rounded-lg border border-warn p-3">
      <Notice tone="warn">Esta invitación se entrega una sola vez. Caduca <Time value={currentInvitation.expires_at} />. Conserva su contenido antes de cerrar; podrás cancelar y crear otra si lo pierdes.</Notice>
      <label>Invitación del ordenador<textarea readOnly className="min-h-32 font-mono text-xs" value={JSON.stringify(currentInvitation, null, 2)} /></label>
      <p className="m-0 text-xs">En ese ordenador, con Cauce CLI, Docker, Node.js 22 y Python 3.12 instalados, ejecuta el primer comando y pega la invitación por su entrada estándar; después, el segundo instala y arranca el ejecutor como servicio de tu usuario:</p>
      <code aria-label="Comando de enrolamiento" className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-2 text-xs">{`cauce hosts enroll --gateway ${window.location.origin} --invitation-stdin`}</code>
      <code aria-label="Comando de preparación" className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-2 text-xs">cauce hosts setup</code>
      <p className="m-0 text-xs text-muted">La invitación fija la huella del firmante de la política, así que el ordenador rechaza cualquier otra. Comprueba el resultado con <code>cauce hosts status</code>.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { void copy(); }}>Copiar invitación</Button>
        <Button disabled={busy} onClick={() => { setInvitation(undefined); setNotice('La invitación sigue pendiente hasta su uso, caducidad o cancelación.'); }}>Cerrar invitación</Button></div>
    </section> : null}
    <ul aria-label="Invitaciones de ordenadores" className="m-0 grid list-none gap-2 p-0">{enrollments.data?.enrollments.map(row => {
      const expired = row.state === 'pending' && Date.parse(row.expires_at) <= Date.now();
      return <li key={row.enrollment_id} className="flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-xs">
        <span>{row.display_name} · {row.host_id} · {row.state === 'enrolled' ? enrolledState(row) : row.state === 'revoked' ? 'Cancelada' : expired ? 'Caducada' : 'Pendiente de uso'}<br />Caduca <Time value={row.expires_at} /></span>
        {row.state === 'pending' ? <Button size="sm" disabled={!ready} onClick={() => { void revoke(row.enrollment_id); }}>Cancelar invitación de {row.display_name}</Button> : null}
      </li>;
    })}</ul>
    {enrollments.data && !enrollments.data.enrollments.length ? <p className="m-0 text-xs text-muted">Aún no hay invitaciones.</p> : null}
    {fingerprint ? <p className="m-0 text-xs text-muted">Un ordenador enrolado antes de que la plataforma firmara la preparación la ancla con <code className="break-all">{`cauce hosts setup --signer-fingerprint ${fingerprint}`}</code></p> : null}
  </section>;
}
