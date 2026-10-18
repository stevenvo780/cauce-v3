import { useCallback, useRef, useState } from 'react';
import { QUOTA_ACCOUNT_PROVIDERS, type QuotaAccount, type QuotaAccountProvider } from '../../api/client/my-quotas-client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Button, Notice } from '../../components/kit';
import { onNavClick } from '../../router';
import { canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { randomUuid } from '../../random-id';
import { AccountLogin } from './AccountLogin';
import { QuotaAccountCard } from './QuotaAccountCard';
import { PROVIDER_LABEL } from './quotas';
import { QuotaEnvironmentPanel } from './QuotaEnvironmentPanel';
import { EXECUTABLE_QUOTA_PROVIDERS } from './quota-environment-capabilities';
import { failedQuotaRead } from './quota-availability';
import { automaticPauseWindow, canManageQuotaAccounts, describeQuotaEnvironmentError, describeQuotaError, pauseReasonText } from './quota-messages';
import { diffConflictFields, isCasConflict, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';

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
  const [accountConflict, setAccountConflict] = useState<{ diffs: ConflictFieldDiff[]; fresh: QuotaAccount; input: AccountFormValues }>();
  const [accountFormEpoch, setAccountFormEpoch] = useState(0);
  const ready = !!accounts.data && !accounts.error && !accounts.loading && !busy;
  const canWrite = canManageCompany(authority?.role) && ready;
  const canWriteAccounts = canManageQuotaAccounts(authority?.role) && ready;
  const reloadAccounts = accounts.reload;
  const reloadEnvironments = environments.reload;
  const reload = useCallback(async () => {
    const [e, a] = await Promise.all([reloadEnvironments(), reloadAccounts()]);
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
  async function saveAccountEdit(input: AccountFormValues, account: QuotaAccount) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api.updateQuotaAccount(account.id, { expected_version: account.version, label: input.label, enabled: input.enabled, ...input.pause });
      setEditing(undefined); setAccountConflict(undefined); await reload(); setNotice('Cuenta actualizada.');
    } catch (cause) {
      if (isCasConflict(cause)) {
        setError(describeQuotaError(cause, 'No se confirmó el cambio de cuenta.'));
        const fresh = (await accounts.reload()).data?.accounts.find((candidate) => candidate.id === account.id);
        if (fresh) {
          setEditing(fresh);
          setAccountConflict({
            fresh, input,
            diffs: diffConflictFields(
              { label: input.label, enabled: input.enabled },
              { label: fresh.label, enabled: fresh.enabled },
              { label: 'Nombre de la cuenta', enabled: 'Cuenta habilitada' },
            ),
          });
        } else setAccountConflict({ fresh: account, input, diffs: [] });
      } else setError(describeQuotaError(cause, 'No se confirmó el cambio de cuenta.'));
    } finally { mutating.current = false; setBusy(false); }
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
      : accounts.loading ? 'Espera a que termine la lectura de cuentas.'
        : 'No hay una lectura vigente de cuentas. Actualiza cuotas y entornos y vuelve a intentarlo.';
  const executableProviders: readonly string[] = environments.data?.capabilities.available
    ? environments.data.capabilities.providers.filter(provider => EXECUTABLE_QUOTA_PROVIDERS.has(provider)) : [];
  const pinned = preferences.data?.pinned_quota_accounts ?? [];
  const visible = [...accounts.data?.accounts ?? []].filter(account => !filterPinned || pinned.includes(account.id))
    .sort((left, right) => Number(pinned.includes(right.id)) - Number(pinned.includes(left.id)) || left.label.localeCompare(right.label));
  return <div className="grid gap-6">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="m-0 text-2xl font-semibold">Mis cuotas</h1>
      <p className="m-0 mt-1 max-w-2xl text-sm text-muted">Consulta tus suscripciones, incluso sin agentes. Fija las cuentas que sigues y opera sus entornos de consulta.</p></div>
      <ActionButton label="Actualizar cuotas y entornos" disabled={busy || accounts.loading || environments.loading} announceError={false} action={async () => {
        try { await reload(); }
        catch (cause: unknown) {
          setError(describeQuotaEnvironmentError(cause, 'No se pudo actualizar.'));
          return { error: cause instanceof Error ? cause : new Error('No se pudo actualizar.') };
        }
      }} /></header>
    {accounts.loading && !accounts.data ? <p role="status">Leyendo cuentas y ventanas…</p> : null}
    {preferences.loading && !preferences.data ? <p role="status">Leyendo tarjetas fijadas…</p> : null}
    {environments.loading && !environments.data ? <p role="status">Leyendo entornos de consulta…</p> : null}
    {accounts.error || environments.error || preferences.error || error ? <Notice tone="danger" role="alert">{error || (accounts.error
      ? describeQuotaError(accounts.error, 'No se pudieron leer las cuotas.')
      : environments.error ? describeQuotaEnvironmentError(environments.error, 'No se pudieron leer los entornos.')
        : describeQuotaError(preferences.error, 'No se pudieron leer las cuotas.'))}
      {preferences.error || pinFailed ? <ActionButton size="sm" label="Releer tarjetas fijadas" busy={preferences.loading} done={false} announceError={false} action={() => { setPinFailed(false); return preferences.reload(); }} /> : null}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    <div className="flex flex-wrap gap-2"><Button aria-pressed={filterPinned} disabled={!preferences.data || !!preferences.error} onClick={() => { setFilterPinned(!filterPinned); }}>{filterPinned ? 'Ver todas las cuentas' : 'Ver sólo cuentas fijadas'}</Button>
      <Button variant="primary" disabled={!canWriteAccounts} title={registerBlock} onClick={() => { setCreating(true); }}>Registrar cuenta</Button></div>
    {creating ? <QuotaAccountForm executable={executableProviders} busy={busy} canWrite={canWriteAccounts} cancel={() => { setCreating(false); }}
      save={input => canWriteAccounts ? write(() => api.createQuotaAccount({ provider: input.provider, label: input.label, idempotency_key: input.idempotency_key }), 'Cuenta registrada. Crea su entorno para autenticar y consultar.') : Promise.resolve()} /> : null}
    {editing ? <QuotaAccountForm key={`${editing.id}:${String(accountFormEpoch)}`} account={editing} executable={executableProviders} busy={busy} canWrite={canWriteAccounts} cancel={() => { setEditing(undefined); setAccountConflict(undefined); }}
      save={input => canWriteAccounts ? saveAccountEdit(input, editing) : Promise.resolve()} /> : null}
    {editing && accountConflict ? <ConflictNotice diffs={accountConflict.diffs} busy={busy}
      onRetry={() => {
        void (async () => {
          const fresh = (await accounts.reload()).data?.accounts.find((candidate) => candidate.id === editing.id) ?? accountConflict.fresh;
          setEditing(fresh);
          await saveAccountEdit(accountConflict.input, fresh);
        })();
      }}
      onDiscard={() => { setEditing(accountConflict.fresh); setAccountFormEpoch((epoch) => epoch + 1); setAccountConflict(undefined); }} /> : null}
    {removing ? <section aria-label="Confirmar eliminación de cuenta" className="grid gap-2 rounded-xl border border-line p-4"><p>Eliminar {removing.label} exige retirar antes sus entornos y asignaciones. El servidor comprobará esas dependencias.</p>
      <div className="flex gap-2"><Button variant="danger" disabled={!canWriteAccounts} onClick={() => { void write(() => api.deleteQuotaAccount(removing.id, removing.version), 'Cuenta eliminada.'); }}>Confirmar eliminación de cuenta</Button>
        <Button disabled={busy} onClick={() => { setRemoving(undefined); }}>Cancelar</Button></div></section> : null}
    <section aria-label="Tarjetas de Mis cuotas" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map(account => <QuotaAccountCard key={account.id} account={accounts.error ? failedQuotaRead(account) : account}
      pinned={pinned.includes(account.id)} canPin={!!preferences.data && !preferences.error && !preferences.loading && !busy} onPin={() => { void pin(account); }}
      canEdit={canWriteAccounts} onEdit={() => { setEditing(account); setAccountConflict(undefined); }} onRemove={() => { setRemoving(account); }}
      login={<AccountLogin account={account} snapshot={environments.error ? undefined : environments.data} allowed={canManageCompany(authority?.role)} reload={reload} />} />)}</section>
    {accounts.data && !visible.length ? <Notice tone="info">{filterPinned ? 'No has fijado ninguna cuenta. Muestra todas y elige las que quieras seguir.' : 'Aún no hay cuentas. Registra una suscripción para empezar.'}</Notice> : null}
    <QuotaEnvironmentPanel snapshot={environments.error ? undefined : environments.data} loading={environments.loading && !environments.data} accounts={accounts.data?.accounts ?? []} canWrite={canWrite} canLogin={canManageCompany(authority?.role)}
      reload={reload} />
  </div>;
}

interface AccountFormValues { provider: QuotaAccountProvider; label: string; enabled: boolean; pause: { paused_until?: string | null; paused_reason?: string | null }; idempotency_key: string }
const pad = (value: number) => String(value).padStart(2, '0');
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const formatLocal = (date: Date) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date);

function isAccountProvider(choice: string): choice is QuotaAccountProvider {
  return QUOTA_ACCOUNT_PROVIDERS.some(provider => provider === choice);
}

function QuotaAccountForm({ account, executable, busy, canWrite, save, cancel }: {
  account?: QuotaAccount; executable: readonly string[]; busy: boolean; canWrite: boolean; save: (input: AccountFormValues) => Promise<void>; cancel: () => void;
}) {
  const automatic = automaticPauseWindow(account?.paused_reason ?? null) !== undefined;
  const initialPause = toLocalInput(account?.paused_until ?? null);
  const initialReason = automatic ? '' : account?.paused_reason ?? '';
  const [label, setLabel] = useState(account?.label ?? '');
  const [providerChoice, setProviderChoice] = useState<string>(account?.provider ?? QUOTA_ACCOUNT_PROVIDERS[0]);
  const provider = account ? account.provider : providerChoice;
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
    if (!account && !isAccountProvider(provider)) { setError('Elige un proveedor de la lista.'); return; }
    setError('');
    const pause: AccountFormValues['pause'] = {};
    if (resume) { pause.paused_until = null; pause.paused_reason = null; }
    else {
      const untilChanged = paused !== initialPause; const reasonChanged = reason.trim() !== initialReason;
      if (untilChanged) pause.paused_until = pausedDate ? pausedDate.toISOString() : null;
      if (reasonChanged) pause.paused_reason = reason.trim() || null;
      else if (untilChanged && automatic) pause.paused_reason = null;
    }
    void save({ provider: provider as QuotaAccountProvider, label: label.trim(), enabled, pause, idempotency_key: idempotencyKey }); }}>
    <label>Nombre de la cuenta<input required maxLength={80} value={label} disabled={locked} onChange={event => { setLabel(event.target.value); }} /></label>
    <label>Proveedor<select value={provider} disabled={locked || !!account} onChange={event => { setProviderChoice(event.target.value); }}>
      {[...new Set([...QUOTA_ACCOUNT_PROVIDERS, ...account ? [account.provider] : []])].map(value => <option key={value} value={value}>{PROVIDER_LABEL[value] ?? value}</option>)}</select></label>
    {!account && !executable.includes(provider) ? <Notice tone="info">Ningún ordenador puede consultar todavía esta cuenta. Se registra igual; para ver su cuota, añade una computadora en{' '}
      <a href="/config?seccion=computadoras" onClick={event => { onNavClick(event, '/config?seccion=computadoras'); }}>Ajustes → Computadoras</a>.</Notice> : null}
    {account ? <><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={locked} onChange={event => { setEnabled(event.target.checked); }} />Cuenta habilitada</label>
      {automatic ? <p className="m-0 text-sm">{pauseReasonText(account.paused_reason)}</p> : null}
      <label>Pausa hasta (hora de tu navegador)<input type="datetime-local" value={paused} disabled={locked || resume} onChange={event => { setPaused(event.target.value); }} /></label>
      {pausedDate && !Number.isNaN(pausedDate.getTime()) && !resume ? <p className="m-0 text-xs text-muted">Se guardará: {formatLocal(pausedDate)}</p> : null}
      {automatic ? null : <label>Motivo de pausa<input maxLength={128} value={reason} disabled={locked || resume} onChange={event => { setReason(event.target.value); }} /></label>}
      {hasPause ? <label className="flex items-center gap-2"><input type="checkbox" checked={resume} disabled={locked} onChange={event => { setResume(event.target.checked); }} />Reanudar ahora (quita la pausa)</label> : null}</> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <div className="flex gap-2"><Button type="submit" disabled={locked || !label.trim()} title={locked ? (!canWrite ? 'Tu rol no permite guardar cuentas de cuotas. Pide a un dueño o administrador de la empresa que lo haga.' : 'Espera a que termine la operación en curso.') : !label.trim() ? 'Escribe el nombre de la cuenta.' : undefined}>{account ? 'Guardar cuenta' : 'Registrar cuenta'}</Button>
      <Button type="button" disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </form>;
}
