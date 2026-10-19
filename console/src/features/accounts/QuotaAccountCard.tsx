import { Pin, PinOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AccountQuotaWindow, QuotaAccount, QuotaRefreshStatus } from '../../api/client/my-quotas-client';
import { Button, Notice, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { accountFatigue, FATIGUE_LABEL, OBSERVATION_LABEL, quotaFailureReason } from './quota-availability';
import { formatPercent, formatResetIn, PROVIDER_LABEL } from './quotas';

const REFRESH_LABEL: Partial<Record<QuotaRefreshStatus, string>> = {
  not_authenticated: 'Cuenta sin sesión iniciada: pulsa «Iniciar sesión».',
  executor_unavailable: 'No hay un ejecutor disponible para actualizar esta cuenta.',
  deleted: 'El entorno de consulta fue eliminado.',
  busy: 'El entorno está ocupado. La cuota se consultará cuando termine su operación.',
  read_only: 'La consulta automática requiere permiso para operar el entorno.',
  failed: 'La consulta automática falló. Relee el entorno para revisar su resultado.',
  stale: 'La consulta terminó y la captura sigue antigua. Se consultará de nuevo en la próxima ventana.',
};

export function QuotaRefreshNotice({ status }: { status?: QuotaRefreshStatus }) {
  if (status === 'updating') return <p className="m-0 text-sm text-muted" role="status">Actualizando…</p>;
  const message = status ? REFRESH_LABEL[status] : undefined;
  return message ? <Notice tone={status === 'failed' ? 'danger' : 'warn'}>{message}</Notice> : null;
}

function windowName(window: AccountQuotaWindow): string {
  const minutes = window.window_minutes ?? { '5h': 300, '7d': 10_080 }[window.window_key];
  if (minutes === 300) return '5 h';
  if (minutes === 10_080) return 'Semanal';
  if (minutes === 1440) return 'Diaria';
  return minutes ? `${String(minutes)} min` : window.window_key;
}

const sameDay = (left: Date, right: Date) => left.toDateString() === right.toDateString();
const clock = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const dayAndClock = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ResetLine({ resetAt, now }: { resetAt: string | null; now: number }) {
  const reset = resetAt ? new Date(resetAt) : undefined;
  if (!reset || Number.isNaN(reset.getTime())) return <span>Reinicio no informado</span>;
  const absolute = sameDay(reset, new Date(now)) ? clock.format(reset) : dayAndClock.format(reset);
  return <span>Se reinicia <time dateTime={reset.toISOString()}>{absolute}</time> ({formatResetIn((reset.getTime() - now) / 1000)})</span>;
}

function WindowRow({ window, now }: { window: AccountQuotaWindow; now: number }) {
  const name = `${windowName(window)}${window.model ? ` · ${window.model}` : ''}`;
  const known = window.observation_status === 'ok';
  const used = window.used_percent ?? (window.remaining_percent === null ? null : 100 - window.remaining_percent);
  const remaining = window.remaining_percent ?? (used === null ? null : 100 - used);
  return <div className="grid gap-1">
    <div className="flex flex-wrap items-baseline justify-between gap-1">
      <span className="text-sm font-medium">{name}</span>
      <span className="text-sm tabular-nums">{used === null || remaining === null ? OBSERVATION_LABEL[window.observation_status]
        : <><strong>{formatPercent(used)}</strong> usado · <strong>{formatPercent(remaining)}</strong> restante</>}</span>
    </div>
    <meter aria-label={`Restante ${name}`} min={0} max={100} value={Math.max(0, Math.min(100, remaining ?? 0))}
      hidden={remaining === null} className={`h-3 w-full ${known ? 'accent-ok' : 'opacity-50'}`} />
    <p className="m-0 text-xs text-muted">{known ? null : `${OBSERVATION_LABEL[window.observation_status]}. `}<ResetLine resetAt={window.reset_at} now={now} /></p>
  </div>;
}

/** Grouped by model; a model whose windows report a reset goes first, and each group runs from the shortest window. */
function orderedWindows(windows: readonly AccountQuotaWindow[]): AccountQuotaWindow[] {
  const informed = new Set(windows.filter(window => window.reset_at !== null).map(window => window.model ?? ''));
  const rank = (window: AccountQuotaWindow) => informed.has(window.model ?? '') ? 0 : 1;
  return [...windows].sort((left, right) => rank(left) - rank(right) || (left.model ?? '').localeCompare(right.model ?? '')
    || (left.window_minutes ?? 0) - (right.window_minutes ?? 0));
}

export function QuotaAccountCard({ account, pinned, canPin, onPin, canEdit, onEdit, onRemove, login }: {
  account: QuotaAccount; pinned: boolean; canPin?: boolean; onPin?: () => void;
  canEdit?: boolean; onEdit?: () => void; onRemove?: () => void; login?: ReactNode;
}) {
  const now = Date.now();
  const fatigue = accountFatigue(account, now);
  const failure = quotaFailureReason(account);
  const tone = fatigue === 'available' ? 'ok' : fatigue === 'low' || fatigue === 'stale' ? 'warn'
    : fatigue === 'exhausted' || fatigue === 'error' ? 'danger' : 'neutral';
  const measured = account.windows.map(window => window.captured_at).filter((value): value is string => value !== null).sort().at(-1);
  return <article aria-label={`Cuotas de ${account.label}`} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
    <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2"><div className="min-w-0"><h3 className="m-0 text-base">{account.label}</h3>
      <p className="m-0 text-xs text-muted">{PROVIDER_LABEL[account.provider] ?? account.provider}</p></div><Pill tone={tone}>{FATIGUE_LABEL[fatigue]}</Pill></header>
    <QuotaRefreshNotice status={account.refresh_status} />
    {login}
    {account.agents.length ? <p className="m-0 text-xs text-muted">Usada por {account.agents.map(agent => `${agent.tenant_id}/${agent.alias}`).join(', ')}
      {account.agent_count > account.agents.length ? ` y ${String(account.agent_count - account.agents.length)} más` : ''}</p> : null}
    {failure ? <Notice tone={account.note?.trim() === 'rate_limited' ? 'warn' : 'danger'}>{failure}</Notice>
      : account.note ? <Notice tone={account.observation_status === 'error' ? 'danger' : 'info'}>{account.note}</Notice> : null}
    {account.paused_until ? <p className="m-0 text-xs">Pausa hasta <Time value={account.paused_until} />{account.paused_reason ? `: ${account.paused_reason}` : ''}</p> : null}
    <div aria-label={`Ventanas de ${account.label}`} className="grid gap-3">{orderedWindows(account.windows).map(window =>
      <WindowRow key={`${window.group_key}:${window.window_key}:${window.model ?? ''}:${window.host}`} window={window} now={now} />)}</div>
    {!account.windows.length ? <Notice tone="info">{OBSERVATION_LABEL[account.observation_status]}. No hay ventanas informadas para esta cuenta.</Notice> : null}
    <p className="m-0 text-xs text-muted">{measured ? <>Medido <Time value={measured} relativo /></> : 'Sin medición'}</p>
    <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      {onPin ? <Button size="sm" variant="ghost" className="mr-auto" aria-pressed={pinned} disabled={!canPin} onClick={onPin}>
        {pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}{pinned ? 'Desfijar cuenta' : 'Fijar cuenta'}</Button> : null}
      {onEdit ? <Button size="sm" disabled={!canEdit} onClick={onEdit}>Editar cuenta</Button> : null}
      {onRemove ? <Button size="sm" variant="danger" disabled={!canEdit} onClick={onRemove}>Eliminar cuenta</Button> : null}
    </footer>
  </article>;
}
