import { useRef, useState } from 'react';
import { CheckCircle2, Clock, KeyRound, Loader2, X } from 'lucide-react';
import type { QuotaAccount, QuotaEnvironment, QuotaEnvironmentAction, QuotaEnvironmentOperation, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { useApi } from '../../api/context';
import { Button, Notice, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { randomUuid } from '../../random-id';
import { quotaEnvironmentActionBlock, quotaEnvironmentExecutable, quotaHostSupports } from './quota-environment-capabilities';
import { QuotaRefreshNotice } from './QuotaAccountCard';
import { describeOperationError, describeQuotaEnvironmentError } from './quota-messages';
import { diffConflictFields, isCasConflict } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';

const ACTION_LABEL: Record<QuotaEnvironmentAction, string> = { create: 'Crear entorno', authenticate: 'Iniciar sesión', query: 'Consultar cuotas', update_cli: 'Actualizar CLI', delete: 'Eliminar entorno' };
const STATUS_LABEL: Record<QuotaEnvironment['status'], string> = { pending: 'Pendiente', running: 'En ejecución', ready: 'Preparado', awaiting_auth: 'Esperando autenticación', failed: 'Fallido', deleting: 'Eliminación pendiente', deleted: 'Eliminado' };
const OPERATION_META: Record<QuotaEnvironmentOperation['status'], { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral' }> = {
  pending: { label: 'En cola', tone: 'neutral' }, running: { label: 'En curso', tone: 'info' },
  awaiting_auth: { label: 'Esperando tu acción', tone: 'warn' }, done: { label: 'Terminada', tone: 'ok' }, failed: { label: 'Falló', tone: 'danger' },
};
function quotaOperationTitle(operation: QuotaEnvironmentOperation, environment: QuotaEnvironment): string {
  if (operation.action === 'create') return `Crear el entorno ${environment.label} en ${environment.host_id}`;
  if (operation.action === 'authenticate') return `Iniciar sesión en ${environment.provider} (${environment.label})`;
  if (operation.action === 'query') return `Consultar las cuotas de ${environment.label}`;
  if (operation.action === 'update_cli') return `Actualizar el CLI de ${environment.label}`;
  return `Eliminar el entorno ${environment.label}`;
}
function QuotaOperationIcon({ status }: { status: QuotaEnvironmentOperation['status'] }) {
  if (status === 'done') return <CheckCircle2 size={12} aria-hidden="true" />;
  if (status === 'failed') return <X size={12} aria-hidden="true" />;
  if (status === 'awaiting_auth') return <KeyRound size={12} aria-hidden="true" />;
  if (status === 'running') return <Loader2 size={12} aria-hidden="true" className="animate-spin" />;
  return <Clock size={12} aria-hidden="true" />;
}

export function QuotaEnvironmentPanel({ snapshot, loading, accounts, canWrite, reload }: {
  snapshot?: QuotaEnvironmentsSnapshot; loading?: boolean; accounts: readonly QuotaAccount[]; canWrite: boolean; reload: () => Promise<void>;
}) {
  const api = useApi();
  const [draft, setDraft] = useState({ account_id: '', host_id: '', label: '' });
  const [editing, setEditing] = useState<QuotaEnvironment>();
  const [label, setLabel] = useState('');
  const [confirm, setConfirm] = useState<QuotaEnvironment>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [envConflict, setEnvConflict] = useState(false);
  const keys = useRef(new Map<string, string>());
  const keyFor = (signature: string) => { const existing = keys.current.get(signature) ?? randomUuid(); keys.current.set(signature, existing); return existing; };
  const available = canWrite && snapshot?.capabilities.available === true && !busy;
  const hosts = snapshot?.capabilities.hosts ?? [];
  const creatableAccounts = accounts.filter(account => hosts.some(host => quotaHostSupports(host, account.provider, 'create')));
  const selectedAccount = creatableAccounts.find(account => account.id === draft.account_id);
  const compatibleHosts = selectedAccount ? hosts.filter(host => quotaHostSupports(host, selectedAccount.provider, 'create')) : [];
  const hostId = compatibleHosts.some(host => host.host_id === draft.host_id) ? draft.host_id : '';
  const canCreate = available && creatableAccounts.length > 0;
  const canEdit = (environment: QuotaEnvironment) => canWrite && !busy && snapshot?.environments.some(current =>
    current.id === environment.id && current.status !== 'deleted' && current.status !== 'deleting') === true;
  const supports = (environment: QuotaEnvironment, action: QuotaEnvironmentAction) => canWrite && !busy && quotaEnvironmentExecutable(snapshot, environment, action);
  const actionBlock = (environment: QuotaEnvironment, action: QuotaEnvironmentAction) => supports(environment, action) ? undefined : quotaEnvironmentActionBlock(snapshot, environment, action, canWrite, busy) ?? 'Esta acción no está disponible ahora.';
  const editBlock = (environment: QuotaEnvironment) => canEdit(environment) ? undefined : !canWrite ? 'Tu rol no permite operar entornos de cuotas. Pide a un dueño o administrador de la empresa que lo haga.' : busy ? 'Espera a que termine la operación en curso.' : 'Este entorno se está eliminando o ya no está en la lectura actual. Actualiza cuotas y entornos.';
  const createBlock = !canWrite ? 'Tu rol no permite operar entornos de cuotas. Pide a un dueño o administrador de la empresa que lo haga.'
    : busy ? 'Espera a que termine la operación en curso.'
      : !snapshot ? 'Todavía no llegó la lectura de entornos. Espera o actualiza cuotas y entornos.'
        : !snapshot.capabilities.available ? 'No hay un ejecutor de cuotas disponible para esta empresa. Recupera la conexión del ordenador y vuelve a leer los entornos.'
          : !creatableAccounts.length ? 'Ninguna cuenta puede crear un entorno en los ordenadores disponibles. Revisa los ordenadores y proveedores habilitados.'
            : !selectedAccount ? 'Elige una cuenta para crear su entorno.'
              : !hostId ? 'Elige una computadora compatible con el proveedor de la cuenta.'
                : !draft.label.trim() ? 'Escribe el nombre del entorno.' : undefined;
  async function perform(action: () => Promise<unknown>, message: string, signature?: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await reload(); if (signature) keys.current.delete(signature); setConfirm(undefined); setEditing(undefined); setNotice(message); }
    catch (cause) { setError(describeQuotaEnvironmentError(cause, 'No se confirmó la operación del entorno.')); }
    finally { setBusy(false); }
  }
  async function saveEnvironmentLabel(environment: QuotaEnvironment) {
    if (busy || !label.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.updateQuotaEnvironment(environment.id, { expected_version: environment.version, label: label.trim() });
      await reload(); setEditing(undefined); setEnvConflict(false); setNotice('Configuración del entorno guardada.');
    } catch (cause) {
      if (isCasConflict(cause)) { await reload().catch(() => undefined); setEnvConflict(true); }
      else setError(describeQuotaEnvironmentError(cause, 'No se confirmó la operación del entorno.'));
    } finally { setBusy(false); }
  }
  function act(environment: QuotaEnvironment, action: QuotaEnvironmentAction) {
    if (!supports(environment, action)) return;
    const signature = `${environment.id}:${String(environment.version)}:${action}`;
    const input = { expected_version: environment.version, idempotency_key: keyFor(signature) };
    void perform(() => action === 'delete' ? api.deleteQuotaEnvironment(environment.id, input)
      : api.actQuotaEnvironment(environment.id, { ...input, action }),
    `${ACTION_LABEL[action]}: solicitud registrada. Su estado aparece en el entorno.`, signature);
  }
  return <section aria-label="Entornos de Mis cuotas" className="grid gap-4">
    <div className="grid gap-1"><h2 className="m-0 text-lg">Entornos de consulta</h2><p className="m-0 text-sm text-muted">Cada entorno aísla el CLI de una cuenta. El inicio de sesión está en la tarjeta de la cuenta.</p></div>
    {loading && !snapshot ? <p role="status">Leyendo entornos de consulta… El formulario se habilita cuando llega la lectura.</p> : null}
    {snapshot && !snapshot.capabilities.available ? <Notice tone="warn">No hay un ejecutor disponible para esta empresa. Los entornos conservan su estado; las operaciones requieren recuperar la conexión.</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}{notice ? <Notice tone="info" role="status">{notice}</Notice> : null}
    <form aria-label="Crear entorno de cuotas" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={event => { event.preventDefault();
      if (!canCreate || !selectedAccount || !hostId || !draft.label.trim()) return; const input = { ...draft, host_id: hostId, label: draft.label.trim() };
      const signature = JSON.stringify(input); void perform(() => api.createQuotaEnvironment({ ...input, idempotency_key: keyFor(signature) }), 'Creación solicitada. Espera su estado completado antes de usar el entorno.', signature); }}>
      <label>Cuenta<select required value={selectedAccount?.id ?? ''} disabled={!canCreate} title={createBlock} onChange={event => {
        const account = creatableAccounts.find(account => account.id === event.target.value);
        setDraft(previous => ({ ...previous, account_id: event.target.value, host_id: hosts.some(host => host.host_id === previous.host_id && account && quotaHostSupports(host, account.provider, 'create')) ? previous.host_id : '' })); }}>
        <option value="">Elige cuenta</option>{creatableAccounts.map(account => <option key={account.id} value={account.id}>{account.label} · {account.provider}</option>)}</select></label>
      <label>Computadora<select required value={hostId} disabled={!canCreate || !selectedAccount} title={!canCreate ? createBlock : !selectedAccount ? 'Elige primero una cuenta.' : undefined} onChange={event => { setDraft(previous => ({ ...previous, host_id: event.target.value })); }}>
        <option value="">Elige computadora</option>{compatibleHosts.map(host => <option key={host.host_id} value={host.host_id}>{host.display_name}</option>)}</select></label>
      <label>Nombre del entorno<input required maxLength={80} disabled={!canCreate} title={createBlock} value={draft.label} onChange={event => { setDraft(previous => ({ ...previous, label: event.target.value })); }} /></label>
      <Button type="submit" variant="primary" disabled={!canCreate || !selectedAccount || !hostId || !draft.label.trim()} title={createBlock}>Crear entorno</Button>
    </form>
    <div className="grid gap-3 md:grid-cols-2">{snapshot?.environments.map(environment => {
      const operation = snapshot.operations.find(item => item.environment_id === environment.id);
      const withoutSession = environment.status === 'ready' && environment.refresh_status === 'not_authenticated';
      const cancelled = operation?.action === 'authenticate' && operation.error_code === 'AUTH_CANCELLED';
      const statusLabel = cancelled && environment.status === 'ready' ? 'Listo para iniciar sesión'
        : withoutSession ? 'Sin sesión' : STATUS_LABEL[environment.status];
      const updating = environment.refresh_status === 'updating' || snapshot.operations.some(item => item.environment_id === environment.id
        && item.action === 'query' && (item.status === 'pending' || item.status === 'running'));
      return <article key={environment.id} aria-label={`Entorno ${environment.label}`} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
        <header className="grid gap-0.5"><h3 className="m-0 text-base">{environment.label}</h3><p className="m-0 text-sm">{statusLabel}</p>
          <p className="m-0 text-xs text-muted">{environment.provider} · {environment.host_id} · {accounts.find(account => account.id === environment.account_id)?.label ?? 'Cuenta no disponible'}</p></header>
        <QuotaRefreshNotice status={updating ? 'updating' : environment.refresh_status} />
        <div className="flex flex-wrap gap-2" aria-label={`Comandos permitidos de ${environment.label}`}>
          {(['query', 'update_cli'] as const).map(action => <Button key={action} size="sm" disabled={!supports(environment, action)} title={actionBlock(environment, action)}
            onClick={() => { act(environment, action); }}>{ACTION_LABEL[action]}</Button>)}
          <Button size="sm" disabled={!canEdit(environment)} title={editBlock(environment)} onClick={() => { setEditing(environment); setLabel(environment.label); setEnvConflict(false); }}>Editar entorno</Button>
          <Button size="sm" variant="danger" disabled={!supports(environment, 'delete')} title={actionBlock(environment, 'delete')} onClick={() => { setConfirm(environment); }}>Eliminar entorno</Button>
        </div>
        {operation ? <section aria-label={`Resultado de ${environment.label}`} className="grid gap-2">
          <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold">{quotaOperationTitle(operation, environment)}
            <Pill tone={cancelled ? 'neutral' : OPERATION_META[operation.status].tone}><QuotaOperationIcon status={operation.status} />{cancelled ? 'Cancelada' : OPERATION_META[operation.status].label}</Pill></p>
          <p className="m-0 text-xs text-muted"><Time value={operation.updated_at} relativo /> · <Time value={operation.updated_at} /></p>
          {operation.status === 'awaiting_auth' ? <p className="m-0 text-sm">Esperando que inicies sesión desde la tarjeta de la cuenta.</p> : null}
          {operation.status === 'pending' || operation.status === 'running' ? <p className="m-0 text-sm">Esta operación está en curso.</p> : null}
          {operation.error_code ? <Notice tone={cancelled ? 'info' : 'danger'}>{describeOperationError(operation.error_code)}</Notice> : null}
          <QuotaCommandResult result={operation.result} operation={operation} />
        </section> : null}
      </article>;
    })}</div>
    {snapshot && !snapshot.environments.length ? <p>No hay entornos de consulta. Registra una cuenta y crea su entorno.</p> : null}
    {editing ? <form aria-label="Editar entorno de cuotas" className="grid gap-3" onSubmit={event => { event.preventDefault(); if (!canEdit(editing) || !label.trim()) return; void saveEnvironmentLabel(editing); }}>
      <label>Nombre del entorno<input required maxLength={80} value={label} disabled={!canEdit(editing)} onChange={event => { setLabel(event.target.value); }} /></label>
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={!canEdit(editing) || !label.trim()} title={!canEdit(editing) ? editBlock(editing) : !label.trim() ? 'Escribe el nombre del entorno.' : undefined}>Guardar entorno</Button><Button disabled={busy} onClick={() => { setEditing(undefined); setEnvConflict(false); }}>Cancelar</Button></div></form> : null}
    {editing && envConflict ? <ConflictNotice busy={busy}
      diffs={diffConflictFields({ label: label.trim() }, { label: snapshot?.environments.find((environment) => environment.id === editing.id)?.label ?? '' }, { label: 'Nombre del entorno' })}
      onRetry={() => {
        const fresh = snapshot?.environments.find((environment) => environment.id === editing.id) ?? editing;
        setEditing(fresh);
        void saveEnvironmentLabel(fresh);
      }}
      onDiscard={() => {
        const fresh = snapshot?.environments.find((environment) => environment.id === editing.id);
        if (fresh) { setEditing(fresh); setLabel(fresh.label); }
        setEnvConflict(false);
      }} /> : null}
    {confirm ? <section aria-label="Confirmar operación del entorno" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
      <p className="m-0">Eliminar {confirm.label} retira su entorno y su sesión. La cuenta y sus agentes vinculados se conservan.</p>
      <div className="flex flex-wrap items-center gap-2"><Button disabled={!supports(confirm, 'delete')} title={actionBlock(confirm, 'delete')} onClick={() => { act(confirm, 'delete'); }}>Confirmar eliminación</Button>
        <Button disabled={busy} onClick={() => { setConfirm(undefined); }}>Cancelar</Button></div></section> : null}
  </section>;
}

function QuotaCommandResult({ result, operation }: { result: Record<string, unknown> | null; operation?: QuotaEnvironmentOperation }) {
  if (!result) return null;
  const url = typeof result.login_url === 'string' ? result.login_url : undefined;
  let safeUrl: string | undefined;
  try { if (url && new URL(url).protocol === 'https:' && !new URL(url).username && !new URL(url).password) safeUrl = url; } catch { /* Invalid login links stay unavailable. */ }
  const hasDetail = typeof result.output === 'string' || !!operation;
  return <>{safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer">Abrir autorización del proveedor</a> : null}
    {typeof result.user_code === 'string' ? <p className="m-0 text-sm">Código de autorización: <code>{result.user_code}</code></p> : null}
    {typeof result.expires_at === 'string' ? <p className="m-0 text-xs">Vence <Time value={result.expires_at} /></p> : null}
    {hasDetail ? <details><summary className="cursor-pointer text-xs text-muted">Detalles técnicos</summary>
      <div className="mt-2 grid gap-1 text-xs break-words">
        {operation ? <p className="m-0">Operación: <code>{operation.id}</code></p> : null}
        {typeof result.output === 'string' ? <pre aria-label="Salida del comando permitido" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-3 text-xs">{result.output}</pre> : null}
      </div></details> : null}</>;
}
