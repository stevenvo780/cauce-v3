import { useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';

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
    try {
      await api.register({ email: email.trim(), name: name.trim(), password, company: { name: companyName.trim(), slug: slug.trim() } });
      setCreated(true);
      await onLogin(email.trim(), password);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo crear la cuenta.'); }
    finally { setDraft(previous => ({ ...previous, password: '' })); setBusy(false); }
  }
  const edit = (key: keyof typeof draft, value: string) => { setDraft(previous => ({ ...previous, [key]: value })); };
  if (created) return <div className="grid gap-3"><Notice tone="ok">Cuenta y empresa creadas.</Notice>
    {error ? <Notice tone="warn" role="alert">{error} Inicia sesión con el correo registrado.</Notice> : null}
    <Button onClick={onCancel}>Ir a iniciar sesión</Button></div>;
  return <form aria-label="Registro de persona y empresa" className="grid gap-3" onSubmit={event => { void submit(event); }}>
    <h1>Crea tu empresa en Cauce</h1>
    <label>Tu nombre<input required maxLength={120} autoComplete="name" value={draft.name} disabled={busy} onChange={event => { edit('name', event.target.value); }} /></label>
    <label>Correo<input type="email" required maxLength={254} autoComplete="email" value={draft.email} disabled={busy} onChange={event => { edit('email', event.target.value); }} /></label>
    <label>Contraseña<input type="password" required minLength={12} maxLength={1024} autoComplete="new-password" value={draft.password} disabled={busy} onChange={event => { edit('password', event.target.value); }} /></label>
    <p className="m-0 text-xs text-muted">Usa al menos 12 caracteres.</p>
    <label>Nombre de empresa<input required maxLength={80} value={draft.companyName} disabled={busy} onChange={event => { edit('companyName', event.target.value); }} /></label>
    <label>Identificador de empresa<input required pattern="[a-z][a-z0-9-]{1,62}" maxLength={63} value={draft.slug} disabled={busy} onChange={event => { edit('slug', event.target.value); }} /></label>
    <p className="m-0 text-xs text-muted">Entre 2 y 63 caracteres: comienza con una letra y usa minúsculas, números o guiones.</p>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creando cuenta y empresa…' : 'Crear cuenta y empresa'}</Button>
    <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Ya tengo una cuenta</Button>
  </form>;
}
