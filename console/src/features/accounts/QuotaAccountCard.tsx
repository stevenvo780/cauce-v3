import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { Button, Notice, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { accountFatigue, FATIGUE_LABEL, OBSERVATION_LABEL, quotaFailureReason } from './quota-availability';
import { formatPercent } from './quotas';

export function QuotaAccountCard({ account, pinned, canPin, onPin, canEdit, onEdit, onRemove }: {
  account: QuotaAccount; pinned: boolean; canPin?: boolean; onPin?: () => void;
  canEdit?: boolean; onEdit?: () => void; onRemove?: () => void;
}) {
  const fatigue = accountFatigue(account);
  const failure = quotaFailureReason(account);
  const tone = fatigue === 'available' ? 'ok' : fatigue === 'low' || fatigue === 'stale' ? 'warn'
    : fatigue === 'exhausted' || fatigue === 'error' ? 'danger' : 'neutral';
  return <article aria-label={`Cuotas de ${account.label}`} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="m-0 text-base">{account.label}</h3>
      <p className="m-0 text-xs text-muted">{account.provider}</p></div><Pill tone={tone}>{FATIGUE_LABEL[fatigue]}</Pill></header>
    {onPin ? <Button size="sm" aria-pressed={pinned} disabled={!canPin} onClick={onPin}>{pinned ? 'Desfijar cuenta' : 'Fijar cuenta'}</Button> : null}
    <p className="m-0 text-sm">{account.shared || account.agents.length > 1
      ? `Consumo compartido por ${String(account.agents.length)} agentes. Cada tarjeta muestra la misma suscripción.` : 'Cuota de esta suscripción.'}</p>
    {account.agents.length ? <ul className="m-0 flex list-none flex-wrap gap-1 p-0 text-xs">{account.agents.map(agent => <li key={`${agent.tenant_id}/${agent.alias}`} className="rounded-md bg-subtle px-2 py-1">{agent.tenant_id}/{agent.alias}{agent.enabled ? '' : ' (asignación deshabilitada)'}</li>)}</ul> : <p className="m-0 text-xs text-muted">Sin agente vinculado.</p>}
    {failure ? <Notice tone={account.note?.trim() === 'rate_limited' ? 'warn' : 'danger'}>{failure}</Notice>
      : account.note ? <Notice tone={account.observation_status === 'error' ? 'danger' : 'info'}>{account.note}</Notice> : null}
    {account.paused_until ? <p className="m-0 text-xs">Pausa hasta <Time value={account.paused_until} />{account.paused_reason ? `: ${account.paused_reason}` : ''}</p> : null}
    <div aria-label={`Ventanas de ${account.label}`} className="grid gap-3">{account.windows.map((window, index) => {
      const known = window.observation_status === 'ok' && window.remaining_percent !== null && Number.isFinite(window.remaining_percent);
      const remaining = known ? Math.max(0, Math.min(100, window.remaining_percent ?? 0)) : undefined;
      return <div key={`${window.group_key}:${window.window_key}:${window.model ?? ''}:${window.host}:${String(index)}`} className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-1"><span className="text-sm">{window.label ?? window.window_key}{window.model ? ` · ${window.model}` : ''}</span>
          <strong className="text-sm tabular-nums">{known ? `${formatPercent(remaining ?? 0)} disponible` : OBSERVATION_LABEL[window.observation_status]}</strong></div>
        <meter aria-label={`Disponibilidad ${window.label ?? window.window_key}${window.model ? ` ${window.model}` : ''}`} min={0} max={100} value={remaining ?? 0}
          hidden={!known} className="h-3 w-full accent-ok" />
        {!known && window.remaining_percent !== null ? <p className="m-0 text-xs text-muted">Último saldo informado: {formatPercent(window.remaining_percent)}; no acredita disponibilidad actual.</p> : null}
        <p className="m-0 text-xs text-muted">{window.window_minutes == null ? '' : `Ventana de ${String(window.window_minutes)} min. `}
          {window.captured_at ? <>Medida <Time value={window.captured_at} relativo /> · </> : null}
          {window.received_at ? <>Actualizada <Time value={window.received_at} /></> : 'Sin fecha de actualización.'}
          {' '}{window.reset_at ? <>Reinicio <Time value={window.reset_at} /></> : 'Reinicio no informado.'}</p>
      </div>;
    })}</div>
    {!account.windows.length ? <Notice tone="info">{OBSERVATION_LABEL[account.observation_status]}. No hay ventanas informadas para esta cuenta.</Notice> : null}
    {onEdit || onRemove ? <footer className="flex flex-wrap gap-2 border-t border-line pt-3">
      {onEdit ? <Button size="sm" disabled={!canEdit} onClick={onEdit}>Editar cuenta</Button> : null}
      {onRemove ? <Button size="sm" variant="danger" disabled={!canEdit} onClick={onRemove}>Eliminar cuenta</Button> : null}</footer> : null}
  </article>;
}
