import { useState, type SyntheticEvent } from 'react';
import { ApiError } from '../../api/client/core';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';
import { COMPANY_SLUG_PATTERN } from '../config/form-patterns';

export const REGISTRATION_INPUT_HINT = 'Revisa correo, nombre, contraseña (12 caracteres o más) e identificador de empresa (de 2 a 63 minúsculas, números o guiones, empezando por una letra).';
export const UNREACHABLE_SERVER = 'No se pudo contactar con el servidor. Revisa la conexión y vuelve a intentarlo.';

/** Said by status: the server message is never shown, and a 409 must not tell a taken email from a taken identifier. */
function registrationErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error && !(cause instanceof TypeError) ? cause.message : UNREACHABLE_SERVER;
  if (cause.status === 400) return REGISTRATION_INPUT_HINT;
  if (cause.status === 409) return 'No se pudo completar el registro: el correo o el identificador de empresa ya están en uso. '
    + 'Si ya tienes cuenta, inicia sesión; si no, prueba con otro identificador.';
  if (cause.status === 429) return 'Demasiados intentos de registro. Espera unos minutos y vuelve a intentarlo.';
  if (cause.status === 504) return 'El servidor no contestó a tiempo. Antes de reintentar, prueba a iniciar sesión por si la cuenta se creó.';
  return 'El registro no está disponible ahora. Intenta más tarde.';
}

export function RegistrationForm({ onLogin, onCancel }: {
  onLogin: (email: string, password: string) => Promise<void>; onCancel: () => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState({ email: '', name: '', password: '', companyName: '', slug: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const { email, password, name, companyName, slug } = draft;
    let registered = false;
    try {
      await api.register({ email: email.trim(), name: name.trim(), password, company: { name: companyName.trim(), slug: slug.trim() } });
      registered = true; setCreated(true);
      await onLogin(email.trim(), password);
    } catch (cause) { setError(registered ? 'No se pudo iniciar sesión automáticamente.' : registrationErrorText(cause)); }
    finally { setDraft(previous => ({ ...previous, password: '' })); setBusy(false); }
  }
  const edit = (key: keyof typeof draft, value: string) => { setDraft(previous => ({ ...previous, [key]: value })); };
  if (created) return <div className="grid gap-3"><Notice tone="ok">Cuenta y empresa creadas.</Notice>
    {error ? <Notice tone="warn" role="alert">{error} Inicia sesión con el correo registrado.</Notice> : null}
    <Button onClick={onCancel}>Ir a iniciar sesión</Button></div>;
  return <form aria-label="Registro de persona y empresa" className="grid gap-3" onSubmit={event => { void submit(event); }}>
    <h1>Creá tu empresa en Cauce</h1>
    <label>Tu nombre<input required maxLength={120} autoComplete="name" value={draft.name} disabled={busy} onChange={event => { edit('name', event.target.value); }} /></label>
    <label>Correo<input type="email" required maxLength={254} autoComplete="email" value={draft.email} disabled={busy} onChange={event => { edit('email', event.target.value); }} /></label>
    <label>Contraseña<input type="password" required minLength={12} maxLength={1024} autoComplete="new-password" value={draft.password} disabled={busy} onChange={event => { edit('password', event.target.value); }} /></label>
    <p className="m-0 text-xs text-muted">Usa al menos 12 caracteres.</p>
    <label>Nombre de empresa<input required maxLength={80} value={draft.companyName} disabled={busy} onChange={event => { edit('companyName', event.target.value); }} /></label>
    <label>Identificador de empresa<input required pattern={COMPANY_SLUG_PATTERN} maxLength={63} value={draft.slug} disabled={busy} onChange={event => { edit('slug', event.target.value); }} /></label>
    <p className="m-0 text-xs text-muted">Entre 2 y 63 caracteres: comienza con una letra y usa minúsculas, números o guiones.</p>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creando cuenta y empresa…' : 'Crear cuenta y empresa'}</Button>
    <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Ya tengo una cuenta</Button>
  </form>;
}
