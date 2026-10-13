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
import { failedQuotaRead } from './quota-availability';

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
  const canWrite = canManageCompany(authority?.role) && !accounts.error && !accounts.loading && !busy;
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
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó el cambio de cuenta.'); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function pin(account: QuotaAccount) {
    const settings = preferences.data;
    if (!settings || preferences.error || preferences.loading || busy) return;
    const pinned = settings.pinned_quota_accounts.includes(account.id)
      ? settings.pinned_quota_accounts.filter(id => id !== account.id) : [...settings.pinned_quota_accounts, account.id];
    await write(async () => { await api.saveConsolePreferences({ expected_version: settings.version, pinned_quota_accounts: pinned });
      const reread = await preferences.reload(); if (reread.error) throw reread.error; }, 'Tarjetas fijadas guardadas para esta persona y empresa.');
  }
  const executableProviders = environments.data?.capabilities.available ? environments.data.capabilities.providers : [];
  const pinned = preferences.data?.pinned_quota_accounts ?? [];
  const visible = [...accounts.data?.accounts ?? []].filter(account => !filterPinned || pinned.includes(account.id))
    .sort((left, right) => Number(pinned.includes(right.id)) - Number(pinned.includes(left.id)) || left.label.localeCompare(right.label));
  return <div className="grid gap-6">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="m-0 text-2xl font-semibold">Mis cuotas</h1>
      <p className="m-0 mt-1 max-w-2xl text-sm text-muted">Consulta tus suscripciones, incluso sin agentes. Fija las cuentas que sigues y opera sus entornos de consulta.</p></div>
      <Button disabled={busy || accounts.loading || environments.loading} onClick={() => { void reload().catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : 'No se pudo actualizar.'); }); }}>Actualizar cuotas y entornos</Button></header>
    {accounts.loading && !accounts.data ? <p role="status">Leyendo cuentas y ventanas…</p> : null}
    {accounts.error || environments.error || preferences.error || error ? <Notice tone="danger" role="alert">{error || (accounts.error?.message ?? environments.error?.message ?? preferences.error?.message)}
      {preferences.error ? <Button size="sm" disabled={preferences.loading} onClick={() => { void preferences.reload(); }}>Releer tarjetas fijadas</Button> : null}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    <div className="flex flex-wrap gap-2"><Button aria-pressed={filterPinned} disabled={!preferences.data || !!preferences.error} onClick={() => { setFilterPinned(!filterPinned); }}>{filterPinned ? 'Ver todas las cuentas' : 'Ver sólo cuentas fijadas'}</Button>
      <Button variant="primary" disabled={!canWrite} onClick={() => { setCreating(true); }}>Registrar cuenta</Button></div>
    {creating ? <QuotaAccountForm providers={executableProviders} busy={busy} cancel={() => { setCreating(false); }}
      save={input => write(() => api.createQuotaAccount({ provider: input.provider, label: input.label, idempotency_key: input.idempotency_key }), 'Cuenta registrada. Crea su entorno para autenticar y consultar.')} /> : null}
    {editing ? <QuotaAccountForm key={editing.id} account={editing} providers={executableProviders} busy={busy} cancel={() => { setEditing(undefined); }}
      save={input => write(() => api.updateQuotaAccount(editing.id, { expected_version: editing.version, label: input.label, enabled: input.enabled,
        paused_until: input.paused_until, paused_reason: input.paused_reason }), 'Cuenta actualizada.')} /> : null}
    {removing ? <section aria-label="Confirmar eliminación de cuenta" className="grid gap-2 rounded-xl border border-line p-4"><p>Eliminar {removing.label} exige retirar antes sus entornos y asignaciones. El servidor comprobará esas dependencias.</p>
      <div className="flex gap-2"><Button variant="danger" disabled={!canWrite} onClick={() => { void write(() => api.deleteQuotaAccount(removing.id, removing.version), 'Cuenta eliminada.'); }}>Confirmar eliminación de cuenta</Button>
        <Button disabled={busy} onClick={() => { setRemoving(undefined); }}>Cancelar</Button></div></section> : null}
    <section aria-label="Tarjetas de Mis cuotas" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map(account => <QuotaAccountCard key={account.id} account={accounts.error ? failedQuotaRead(account) : account}
      pinned={pinned.includes(account.id)} canPin={!!preferences.data && !preferences.error && !preferences.loading && !busy} onPin={() => { void pin(account); }}
      canEdit={canWrite} onEdit={() => { setEditing(account); }} onRemove={() => { setRemoving(account); }} />)}</section>
    {accounts.data && !visible.length ? <Notice tone="info">{filterPinned ? 'No has fijado ninguna cuenta. Muestra todas y elige las que quieras seguir.' : 'Aún no hay cuentas. Registra una suscripción para empezar.'}</Notice> : null}
    <QuotaEnvironmentPanel snapshot={environments.error ? undefined : environments.data} accounts={accounts.data?.accounts ?? []} canWrite={canWrite}
      canAuthenticate={canManageCompany(authority?.role) && !!accounts.data && !accounts.error && !busy} reload={reload} />
  </div>;
}

interface AccountFormValues { provider: QuotaProvider; label: string; enabled: boolean; paused_until: string | null; paused_reason: string | null; idempotency_key: string }
function QuotaAccountForm({ account, providers, busy, save, cancel }: {
  account?: QuotaAccount; providers: readonly QuotaProvider[]; busy: boolean; save: (input: AccountFormValues) => Promise<void>; cancel: () => void;
}) {
  const [label, setLabel] = useState(account?.label ?? '');
  const [provider, setProvider] = useState<string>(account?.provider ?? providers.at(0) ?? 'codex');
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [paused, setPaused] = useState(account?.paused_until ?? '');
  const [reason, setReason] = useState(account?.paused_reason ?? '');
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(randomUuid);
  return <form aria-label={account ? 'Editar cuenta de cuotas' : 'Registrar cuenta de cuotas'} className="grid gap-2 rounded-xl border border-line bg-surface p-4" onSubmit={event => { event.preventDefault();
    if (paused && !Number.isFinite(Date.parse(paused))) { setError('Introduce una fecha de pausa válida, con su zona horaria.'); return; }
    void save({ provider: provider as QuotaProvider, label: label.trim(), enabled, paused_until: paused ? new Date(paused).toISOString() : null, paused_reason: reason.trim() || null, idempotency_key: idempotencyKey }); }}>
    <label>Nombre de la cuenta<input required maxLength={80} value={label} disabled={busy} onChange={event => { setLabel(event.target.value); }} /></label>
    <label>Proveedor<select value={provider} disabled={busy || !!account} onChange={event => { setProvider(event.target.value); }}>
      {[...new Set([...providers, ...account ? [account.provider] : []])].map(value => <option key={value}>{value}</option>)}</select></label>
    {!account && !providers.length ? <Notice tone="warn">Ningún host puede ejecutar consultas de cuota todavía. Relee los entornos.</Notice> : null}
    {account ? <><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); }} />Cuenta habilitada</label>
      <label>Pausa hasta (fecha con zona horaria)<input placeholder="2026-10-12T12:00:00-05:00" value={paused} disabled={busy} onChange={event => { setPaused(event.target.value); }} /></label>
      <label>Motivo de pausa<input maxLength={128} value={reason} disabled={busy} onChange={event => { setReason(event.target.value); }} /></label></> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <div className="flex gap-2"><Button type="submit" disabled={busy || !label.trim() || !account && !providers.length}>{account ? 'Guardar cuenta' : 'Registrar cuenta'}</Button>
      <Button type="button" disabled={busy} onClick={cancel}>Cancelar</Button></div>
  </form>;
}
