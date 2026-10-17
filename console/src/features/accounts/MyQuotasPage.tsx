import { useCallback, useRef, useState } from 'react';
import type { QuotaAccount, QuotaProvider } from '../../api/client/my-quotas-client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { Button, Notice } from '../../components/kit';
import { canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { randomUuid } from '../../random-id';
import { QuotaAccountCard } from './QuotaAccountCard';
import { QuotaEnvironmentPanel } from './QuotaEnvironmentPanel';
import { EXECUTABLE_QUOTA_PROVIDERS } from './quota-environment-capabilities';
import { failedQuotaRead } from './quota-availability';
import { automaticPauseWindow, canManageQuotaAccounts, describeQuotaEnvironmentError, describeQuotaError, pauseReasonText } from './quota-messages';

export function MyQuotasPage() {
  const api = useApi();
  const authority = useCompanyAuthority();
  const accounts = useResource('my-quota-accounts', () => api.getQuotaAccounts());
  const environments = useResource('my-quota-environments', () => api.getQuotaEnvironments());
  const preferences = useResource('my-quota-preferences', () => api.getConsolePreferences());
  const [filterPinned, setFilterPinned] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QuotaAccount>();
  const [removing, setRemoving] = useState<QuotaAccount>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mutating = useRef(false);
  const [pinFailed, setPinFailed] = useState(false);
  const ready = !!accounts.data && !accounts.error && !accounts.loading && !busy;
  const canWrite = canManageCompany(authority?.role) && ready;
  const canWriteAccounts = canManageQuotaAccounts(authority?.role) && ready;
  const canRegisterAccounts = canWriteAccounts && !environments.loading && !environments.error;
  const reloadAccounts = accounts.reload;
  const reloadEnvironments = environments.reload;
  const reload = useCallback(async () => {
    const e = await reloadEnvironments();
    const a = await reloadAccounts();
    if (a.error) throw a.error;
    if (e.error) throw e.error;
  }, [reloadAccounts, reloadEnvironments]);
  const poll = useCallback(() => { if (!mutating.current) void reload().catch(() => undefined); }, [reload]);
  usePolling(poll, 15_000);
  async function write(action: () => Promise<unknown>, message: string) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); setCreating(false); setEditing(undefined); setRemoving(undefined); await reload(); setNotice(message); }
    catch (cause) { setError(describeQuotaError(cause, 'No se confirmó el cambio de cuenta.')); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function pin(account: QuotaAccount) {
    const settings = preferences.data;
    if (!settings || preferences.error || preferences.loading || busy) return;
    const pinned = settings.pinned_quota_accounts.includes(account.id)
      ? settings.pinned_quota_accounts.filter(id => id !== account.id) : [...settings.pinned_quota_accounts, account.id];
    setPinFailed(false);
    await write(async () => {
      try { await api.saveConsolePreferences({ expected_version: settings.version, pinned_quota_accounts: pinned }); }
      catch (cause) { setPinFailed(true); void preferences.reload(); throw cause; }
      const reread = await preferences.reload(); if (reread.error) throw reread.error; }, 'Tarjetas fijadas guardadas para esta persona y empresa.');
  }
  const registerBlock = canWriteAccounts ? undefined : !canManageQuotaAccounts(authority?.role)
    ? 'Solo el dueño o un administrador de la empresa registra cuentas de cuotas. Pide a uno de ellos que la registre.'
    : busy ? 'Espera a que termine la operación en curso.'
      : accounts.loading || environments.loading ? 'Espera a que termine la lectura de cuentas y entornos.'
        : 'No hay una lectura vigente de cuentas. Actualiza cuotas y entornos y vuelve a intentarlo.';
  const executableProviders = environments.data?.capabilities.available
    ? environments.data.capabilities.providers.filter(provider => EXECUTABLE_QUOTA_PROVIDERS.has(provider)) : [];
  const pinned = preferences.data?.pinned_quota_accounts ?? [];
  const visible = [...accounts.data?.accounts ?? []].filter(account => !filterPinned || pinned.includes(account.id))
    .sort((left, right) => Number(pinned.includes(right.id)) - Number(pinned.includes(left.id)) || left.label.localeCompare(right.label));
  return <div className="grid gap-6">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="m-0 text-2xl font-semibold">Mis cuotas</h1>
      <p className="m-0 mt-1 max-w-2xl text-sm text-muted">Consulta tus suscripciones, incluso sin agentes. Fija las cuentas que sigues y opera sus entornos de consulta.</p></div>
      <Button disabled={busy || accounts.loading || environments.loading} onClick={() => { void reload().catch((cause: unknown) => { setError(describeQuotaEnvironmentError(cause, 'No se pudo actualizar.')); }); }}>Actualizar cuotas y entornos</Button></header>
    {accounts.loading && !accounts.data ? <p role="status">Leyendo cuentas y ventanas…</p> : null}
    {preferences.loading && !preferences.data ? <p role="status">Leyendo tarjetas fijadas…</p> : null}
    {environments.loading && !environments.data ? <p role="status">Leyendo entornos de consulta…</p> : null}
    {accounts.error || environments.error || preferences.error || error ? <Notice tone="danger" role="alert">{error || (accounts.error
      ? describeQuotaError(accounts.error, 'No se pudieron leer las cuotas.')
      : environments.error ? describeQuotaEnvironmentError(environments.error, 'No se pudieron leer los entornos.')
        : describeQuotaError(preferences.error, 'No se pudieron leer las cuotas.'))}
      {preferences.error || pinFailed ? <Button size="sm" disabled={preferences.loading} onClick={() => { setPinFailed(false); void preferences.reload(); }}>Releer tarjetas fijadas</Button> : null}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    <div className="flex flex-wrap gap-2"><Button aria-pressed={filterPinned} disabled={!preferences.data || !!preferences.error} onClick={() => { setFilterPinned(!filterPinned); }}>{filterPinned ? 'Ver todas las cuentas' : 'Ver sólo cuentas fijadas'}</Button>
      <Button variant="primary" disabled={!canWriteAccounts} title={registerBlock} onClick={() => { setCreating(true); }}>Registrar cuenta</Button></div>
    {creating ? <QuotaAccountForm providers={executableProviders} busy={busy} canWrite={canRegisterAccounts} cancel={() => { setCreating(false); }}
      save={input => canRegisterAccounts ? write(() => api.createQuotaAccount({ provider: input.provider, label: input.label, idempotency_key: input.idempotency_key }), 'Cuenta registrada. Crea su entorno para autenticar y consultar.') : Promise.resolve()} /> : null}
    {editing ? <QuotaAccountForm key={editing.id} account={editing} providers={executableProviders} busy={busy} canWrite={canWriteAccounts} cancel={() => { setEditing(undefined); }}
      save={input => canWriteAccounts ? write(() => api.updateQuotaAccount(editing.id, { expected_version: editing.version, label: input.label, enabled: input.enabled,
        ...input.pause }), 'Cuenta actualizada.') : Promise.resolve()} /> : null}
    {removing ? <section aria-label="Confirmar eliminación de cuenta" className="grid gap-2 rounded-xl border border-line p-4"><p>Eliminar {removing.label} exige retirar antes sus entornos y asignaciones. El servidor comprobará esas dependencias.</p>
      <div className="flex gap-2"><Button variant="danger" disabled={!canWriteAccounts} onClick={() => { void write(() => api.deleteQuotaAccount(removing.id, removing.version), 'Cuenta eliminada.'); }}>Confirmar eliminación de cuenta</Button>
        <Button disabled={busy} onClick={() => { setRemoving(undefined); }}>Cancelar</Button></div></section> : null}
    <section aria-label="Tarjetas de Mis cuotas" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map(account => <QuotaAccountCard key={account.id} account={accounts.error ? failedQuotaRead(account) : account}
      pinned={pinned.includes(account.id)} canPin={!!preferences.data && !preferences.error && !preferences.loading && !busy} onPin={() => { void pin(account); }}
      canEdit={canWriteAccounts} onEdit={() => { setEditing(account); }} onRemove={() => { setRemoving(account); }} />)}</section>
    {accounts.data && !visible.length ? <Notice tone="info">{filterPinned ? 'No has fijado ninguna cuenta. Muestra todas y elige las que quieras seguir.' : 'Aún no hay cuentas. Registra una suscripción para empezar.'}</Notice> : null}
    <QuotaEnvironmentPanel snapshot={environments.error ? undefined : environments.data} loading={environments.loading && !environments.data} accounts={accounts.data?.accounts ?? []} canWrite={canWrite}
      canAuthenticate={canManageCompany(authority?.role) && !!accounts.data && !accounts.error && !busy} reload={reload} />
  </div>;
}

interface AccountFormValues { provider: QuotaProvider; label: string; enabled: boolean; pause: { paused_until?: string | null; paused_reason?: string | null }; idempotency_key: string }
const pad = (value: number) => String(value).padStart(2, '0');
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const formatLocal = (date: Date) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date);

function isOfferedProvider(choice: string, providers: readonly QuotaProvider[]): boolean {
  return providers.some(provider => provider === choice);
}

function offeredProvider(choice: string, providers: readonly QuotaProvider[]): string {
  return isOfferedProvider(choice, providers) ? choice : providers[0] ?? '';
}

function QuotaAccountForm({ account, providers, busy, canWrite, save, cancel }: {
  account?: QuotaAccount; providers: readonly QuotaProvider[]; busy: boolean; canWrite: boolean; save: (input: AccountFormValues) => Promise<void>; cancel: () => void;
}) {
  const automatic = automaticPauseWindow(account?.paused_reason ?? null) !== undefined;
  const initialPause = toLocalInput(account?.paused_until ?? null);
  const initialReason = automatic ? '' : account?.paused_reason ?? '';
  const [label, setLabel] = useState(account?.label ?? '');
  const [providerChoice, setProviderChoice] = useState(account?.provider ?? '');
  const provider = account ? account.provider : offeredProvider(providerChoice, providers);
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [paused, setPaused] = useState(initialPause);
  const [reason, setReason] = useState(initialReason);
  const [resume, setResume] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(randomUuid);
  const pausedDate = paused ? new Date(paused) : undefined;
  const hasPause = !!account?.paused_until || !!account?.paused_reason;
  const locked = busy || !canWrite;
  return <form aria-label={account ? 'Editar cuenta de cuotas' : 'Registrar cuenta de cuotas'} className="grid gap-2 rounded-xl border border-line bg-surface p-4" onSubmit={event => { event.preventDefault();
    if (locked) return;
    if (pausedDate && Number.isNaN(pausedDate.getTime())) { setError('Introduce una fecha de pausa válida.'); return; }
    if (!account && !isOfferedProvider(provider, providers)) { setError('Elige un proveedor que los hosts puedan ejecutar ahora.'); return; }
    setError('');
    const pause: AccountFormValues['pause'] = {};
    if (resume) { pause.paused_until = null; pause.paused_reason = null; }
    else {
      const untilChanged = paused !== initialPause; const reasonChanged = reason.trim() !== initialReason;
      if (untilChanged) pause.paused_until = pausedDate ? pausedDate.toISOString() : null;
      if (reasonChanged) pause.paused_reason = reason.trim() || null;
      else if (untilChanged && automatic) pause.paused_reason = null;
    }
    void save({ provider: provider as QuotaProvider, label: label.trim(), enabled, pause, idempotency_key: idempotencyKey }); }}>
    <label>Nombre de la cuenta<input required maxLength={80} value={label} disabled={locked} onChange={event => { setLabel(event.target.value); }} /></label>
    <label>Proveedor<select value={provider} disabled={locked || !!account} onChange={event => { setProviderChoice(event.target.value); }}>
      {[...new Set([...providers, ...account ? [account.provider] : []])].map(value => <option key={value}>{value}</option>)}</select></label>
    {!account && !providers.length ? <Notice tone="warn">Ningún host puede ejecutar consultas de cuota todavía. Relee los entornos.</Notice> : null}
    {account ? <><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={locked} onChange={event => { setEnabled(event.target.checked); }} />Cuenta habilitada</label>
      {automatic ? <p className="m-0 text-sm">{pauseReasonText(account.paused_reason)}</p> : null}
      <label>Pausa hasta (hora de tu navegador)<input type="datetime-local" value={paused} disabled={locked || resume} onChange={event => { setPaused(event.target.value); }} /></label>
      {pausedDate && !Number.isNaN(pausedDate.getTime()) && !resume ? <p className="m-0 text-xs text-muted">Se guardará: {formatLocal(pausedDate)}</p> : null}
      {automatic ? null : <label>Motivo de pausa<input maxLength={128} value={reason} disabled={locked || resume} onChange={event => { setReason(event.target.value); }} /></label>}
      {hasPause ? <label className="flex items-center gap-2"><input type="checkbox" checked={resume} disabled={locked} onChange={event => { setResume(event.target.checked); }} />Reanudar ahora (quita la pausa)</label> : null}</> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <div className="flex gap-2"><Button type="submit" disabled={locked || !label.trim() || (!account && !isOfferedProvider(provider, providers))} title={locked ? (!canWrite ? 'Tu rol no permite guardar cuentas de cuotas. Pide a un dueño o administrador de la empresa que lo haga.' : 'Espera a que termine la operación en curso.') : !label.trim() ? 'Escribe el nombre de la cuenta.' : !account && !isOfferedProvider(provider, providers) ? 'Elige un proveedor que los hosts puedan ejecutar ahora.' : undefined}>{account ? 'Guardar cuenta' : 'Registrar cuenta'}</Button>
      <Button type="button" disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </form>;
}
