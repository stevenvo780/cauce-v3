import type { FleetOperation, FleetOperationPreview } from '@cauce/protocol/fleet-operation';
import { AlertTriangle, Ban, Check, CheckCircle2, Circle, Clock, KeyRound, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { cn } from '../../cn';
import { AuthOperationPanel } from './AuthOperationPanel';
import {
  blockingOperation, blockingText, cancellable, GUIDED_RECREATE_LABEL, guidedDriftHeadline, operationErrorHuman, operationHeadline, operationStatusMeta,
  operationTitle, physicalResult, purgeBlockers, purgeEntries, resumable, STALE_RESUME_TEXT, STEPS,
} from './fleet-operation-text';
import {
  GUIDED_STEPS, guidedProgressLine, guidedStepStatus, isGuidedDrift, isRuntimeDrift,
  type GuidedState,
} from './guided-recreate';

export interface GuidedRecreateControl { state: GuidedState; onStart: () => void; onRetry: () => void }

function GuidedStepIcon({ status }: { status: ReturnType<typeof guidedStepStatus> }) {
  if (status === 'done') return <Check size={13} aria-hidden="true" />;
  if (status === 'failed') return <X size={13} aria-hidden="true" />;
  if (status === 'current') return <Loader2 size={13} aria-hidden="true" className="animate-spin" />;
  return <Circle size={13} aria-hidden="true" />;
}

export function GuidedRecreateProgress({ state }: { state: GuidedState }) {
  return <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Pasos para recrear e iniciar sesión">
    {GUIDED_STEPS.map((step) => {
      const status = guidedStepStatus(state, step.id);
      return <li key={step.id} data-step={step.id} data-status={status}
        className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap',
          status === 'done' ? 'border-ok/30 bg-ok-soft text-ok-ink'
            : status === 'failed' ? 'border-danger/30 bg-danger-soft text-danger-ink font-semibold'
              : status === 'current' ? 'border-info/30 bg-info-soft text-info-ink'
                : 'border-line bg-subtle text-muted')}>
        <GuidedStepIcon status={status} />{step.label}
      </li>;
    })}
  </ol>;
}

const RESOURCE_TYPES = { container: 'Contenedor', volume: 'Volumen', directory: 'Directorio', network: 'Red' };

export function OperationStatusIcon({ status, size = 14 }: { status: FleetOperation['status']; size?: number }) {
  if (status === 'succeeded') return <CheckCircle2 size={size} aria-hidden="true" />;
  if (status === 'failed') return <X size={size} aria-hidden="true" />;
  if (status === 'awaiting_auth') return <KeyRound size={size} aria-hidden="true" />;
  if (status === 'running' || status === 'cancelling') return <Loader2 size={size} aria-hidden="true" className="animate-spin" />;
  if (status === 'cancelled') return <Ban size={size} aria-hidden="true" />;
  return <Clock size={size} aria-hidden="true" />;
}

export function OperationStatusPill({ operation }: { operation: FleetOperation }) {
  const meta = operationStatusMeta(operation);
  return <Pill tone={meta.tone}><OperationStatusIcon status={operation.status} size={12} />{meta.label}</Pill>;
}

export function OperationMetaLine({ operation, className }: { operation: FleetOperation; className?: string }) {
  return <span className={cn('text-xs text-muted', className)}>
    por {operation.actor.alias} · <Time value={operation.created_at} relativo /> · <Time value={operation.created_at} />
  </span>;
}

function StepIcon({ status }: { status: FleetOperation['steps'][number]['status'] }) {
  if (status === 'succeeded' || status === 'compensated') return <Check size={13} aria-hidden="true" />;
  if (status === 'failed') return <X size={13} aria-hidden="true" />;
  if (status === 'running') return <Loader2 size={13} aria-hidden="true" className="animate-spin" />;
  if (status === 'waiting') return <KeyRound size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

export function OperationStepBar({ operation }: { operation: FleetOperation }) {
  if (!operation.steps.length) return null;
  const done = operation.steps.filter((step) => step.status === 'succeeded' || step.status === 'compensated').length;
  const percent = Math.round((done / operation.steps.length) * 100);
  const active = operation.steps.find((step) => step.status === 'running' || step.status === 'waiting' || step.status === 'failed');
  const summary = active
    ? `Hecho: ${String(done)} de ${String(operation.steps.length)} · Ahora: ${STEPS[active.name]}`
    : done === operation.steps.length
      ? `Hecho: los ${String(operation.steps.length)} pasos`
      : `Hecho: ${String(done)} de ${String(operation.steps.length)} pasos`;
  return <div className="grid gap-2">
    <p className="m-0 text-xs text-muted">{summary}</p>
    <div className="h-1.5 overflow-hidden rounded-full bg-muted-bg" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
      aria-label={`Progreso: ${String(done)} de ${String(operation.steps.length)} pasos`}>
      <div className={cn('h-full rounded-full transition-all', operation.status === 'failed' ? 'bg-danger' : 'bg-brand')} style={{ width: `${String(percent)}%` }} />
    </div>
    <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {operation.steps.map((step) => <li key={step.name} data-status={step.status}
        className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap',
          step.status === 'succeeded' || step.status === 'compensated' ? 'border-ok/30 bg-ok-soft text-ok-ink'
            : step.status === 'failed' ? 'border-danger/30 bg-danger-soft text-danger-ink font-semibold'
              : step.status === 'running' ? 'border-info/30 bg-info-soft text-info-ink'
                : step.status === 'waiting' ? 'border-warn/40 bg-warn-soft text-warn-ink'
                  : 'border-line bg-subtle text-muted')}>
        <StepIcon status={step.status} />{STEPS[step.name]}
      </li>)}
    </ol>
  </div>;
}

/** One readable line for operation lists. */
export function OperationLine({ operation, hostId, children }: { operation: FleetOperation; hostId?: string; children?: ReactNode }) {
  const meta = operationStatusMeta(operation);
  return <div className="grid min-w-0 gap-1">
    <span className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 font-semibold break-words text-sm">{operationTitle(operation, hostId)}</span>
      <OperationStatusPill operation={operation} />
    </span>
    <OperationMetaLine operation={operation} />
    {meta.attention && operation.status !== 'queued' ? <span className="text-xs break-words text-fg-2">{operationHeadline(operation, hostId)}</span> : null}
    {children}
  </div>;
}

function previewTitle(preview: FleetOperationPreview): string {
  const target = preview.target;
  const name = target.resource === 'agent' ? target.alias : target.resource === 'room' ? target.room_id : target.tenant_id;
  const kindLabel: Record<FleetOperationPreview['kind'], string> = {
    create: 'Preparar a', update: 'Actualizar a', start: 'Iniciar a', stop: 'Detener a',
    retire: 'Retirar a', restore: 'Restaurar a', purge: 'Eliminar definitivamente a',
  };
  if (target.resource === 'agent') return `${kindLabel[preview.kind]} ${name}`;
  if (target.resource === 'room') return `${kindLabel[preview.kind].replace(' a', ' el grupo')} ${name}`;
  return `${kindLabel[preview.kind].replace(' a', ' el espacio')} ${name}`;
}

export function AgentFleetPreview({ preview }: { preview: FleetOperationPreview }) {
  const deleted = purgeEntries(preview, 'delete');
  const kept = purgeEntries(preview, 'preserve');
  const blockers = purgeBlockers(preview);
  const other = preview.dependencies.filter((entry) => !/^purge\.(?:delete|preserve|blocked)\.[a-z0-9_]+$/u.test(entry.type));
  const toDelete = preview.resources.filter((resource) => resource.action === 'delete');
  const toKeep = preview.resources.filter((resource) => resource.action !== 'delete');
  return <section aria-label="Previsualización operativa" className="agent-fleet-receipt grid gap-3">
    <p className="m-0 text-sm font-semibold">{previewTitle(preview)}</p>
    <p className="m-0 text-xs text-muted">Esto es el plan. Todavía no se hizo nada; el resultado real se muestra cuando la operación termina.</p>
    {preview.steps.length ? <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {preview.steps.map((step, index) => <li key={step} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] whitespace-nowrap text-muted">
        <span aria-hidden="true">{index + 1}.</span>{STEPS[step]}
      </li>)}
    </ol> : null}
    {preview.resources.length ? <section aria-label="Recursos físicos del plan" className="grid gap-1 text-sm">
      {toDelete.length ? <p className="m-0">Se borrará: {toDelete.map((resource) => `${RESOURCE_TYPES[resource.type].toLowerCase()} ${resource.name}`).join(', ')}.</p> : null}
      {toKeep.length ? <p className="m-0 text-muted">Se conservará: {toKeep.map((resource) => `${RESOURCE_TYPES[resource.type].toLowerCase()} ${resource.name}`).join(', ')}.</p> : null}
    </section> : null}
    {deleted.length ? <p className="m-0 text-sm">Se borra: {deleted.join(', ')}.</p> : null}
    {kept.length ? <p className="m-0 text-sm text-muted">Se conserva como historial: {kept.join(', ')}.</p> : null}
    {preview.kind === 'purge' && preview.target.resource === 'agent' ? <p role="note" className="m-0 text-sm">
      {preview.dependencies.some((entry) => entry.type.startsWith('purge.preserve.') && entry.type !== 'purge.preserve.agents')
        ? 'El historial conserva la identidad de este agente: su alias seguirá reservado y no se podrá usar para un agente nuevo.'
        : 'Sin historial que conserve su identidad, el alias quedará libre para otro agente.'}
    </p> : null}
    {blockers.length ? <section aria-label="Qué bloquea la purga" className="notice grid gap-1">
      <p className="m-0 font-semibold">Todavía no se puede eliminar:</p>
      <ul className="m-0 grid gap-1 ps-4">{blockers.map((blocker) => <li key={blocker.table}>
        Queda {blocker.label} ({blocker.count}). Resuelve esta dependencia y vuelve a previsualizar.
      </li>)}</ul>
    </section> : null}
    {!preview.can_apply ? <p className="notice m-0" role="note">Todavía no se puede lanzar: revisa lo que bloquea arriba.</p> : null}
    <details>
      <summary className="cursor-pointer text-xs text-muted">Detalles técnicos</summary>
      <div className="mt-2 grid gap-1 text-xs break-words">
        <p className="m-0">Revisión esperada: {preview.expected_revision}</p>
        <p className="m-0">Huella exacta: <code>{preview.request_sha256}</code></p>
        {other.length ? <pre className="m-0 overflow-auto whitespace-pre-wrap">{JSON.stringify(other, null, 2)}</pre>
          : !preview.dependencies.length ? <p className="m-0">Sin dependencias informadas.</p> : null}
      </div>
    </details>
  </section>;
}

export function PurgeOutcome({ operation }: { operation: FleetOperation }) {
  const physical = physicalResult(operation);
  if (operation.kind !== 'purge') return null;
  const step = operation.steps.find((value) => value.name === 'purge');
  if (step?.status === 'failed') return <section aria-label="Resultado de la purga"><p role="status" className="m-0 text-sm">La eliminación física falló: no se comprobó qué se borró.</p></section>;
  if (!physical) return null;
  return <section aria-label="Resultado de la purga"><p role="status" className="m-0 text-sm">{physical}</p></section>;
}

export function AgentFleetOperation({ operation, busy, current, control, onAuthRefreshed, intended, stale = false, hostId, guided }: {
  operation: FleetOperation; busy: boolean; current: boolean; control: (action: 'cancel' | 'resume') => void;
  onAuthRefreshed?: (value: FleetOperation) => void;
  intended?: FleetOperation['kind']; stale?: boolean; hostId?: string | undefined;
  guided?: GuidedRecreateControl;
}) {
  const blocking = intended ? blockingOperation(operation, intended) : undefined;
  const cancel = cancellable(operation);
  const rawResume = resumable(operation);
  const resume = rawResume && !stale;
  const runtimeDrift = isRuntimeDrift(operation);
  const drift = isGuidedDrift(operation);
  const guidedActive = !!guided && guided.state.status !== 'idle';
  const showGuided = !!guided && (drift || guidedActive);
  const showAuth = operation.status === 'awaiting_auth' && !runtimeDrift && !!onAuthRefreshed;
  const cancelPrimary = cancel && (!!blocking || stale || !resume) && !showAuth && !showGuided;
  const error = operation.error;
  const human = error ? operationErrorHuman(error) : undefined;
  const physical = operation.status === 'succeeded' ? physicalResult(operation) : undefined;
  const showResume = rawResume;
  const showCancel = cancel;
  const guidedBusy = !!guided && guided.state.status === 'running';
  const hideLegacyActions = showGuided && (drift || guided.state.status === 'running' || guided.state.status === 'failed');
  const headline = drift && guided ? guidedDriftHeadline() : operationHeadline(operation, hostId);
  return <section className="agent-fleet-receipt grid gap-3" aria-label="Operación de flota">
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <p role="status" className="m-0 min-w-0 flex-1 text-sm font-semibold break-words">{headline}</p>
      <OperationStatusPill operation={operation} />
    </div>
    <OperationMetaLine operation={operation} />
    <OperationStepBar operation={operation} />
    {physical && operation.kind !== 'purge' ? <p className="m-0 text-sm" role="status">{physical}</p> : null}
    {operation.kind === 'purge' ? <PurgeOutcome operation={operation} /> : null}
    {error && (operation.status === 'failed' || runtimeDrift) ? <p className="notice m-0 grid gap-1" role="alert">
      <span className="flex items-start gap-1.5"><AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span>{showGuided && drift ? human?.message : `${human?.message ?? ''} ${human?.next ?? ''}`}</span></span>
    </p> : null}
    {showGuided ? <section aria-label="Recrear contenedor e iniciar sesión" className="grid gap-2">
      <p role="status" className="m-0 text-sm">{guidedProgressLine(guided.state)}</p>
      <GuidedRecreateProgress state={guided.state} />
      {guided.state.status === 'failed' && guided.state.message ? <p className="notice m-0" role="alert">{guided.state.message}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {guided.state.status === 'idle' ? <Button variant="primary" disabled={busy || !current} onClick={() => { guided.onStart(); }}>{GUIDED_RECREATE_LABEL}</Button> : null}
        {guided.state.status === 'running' ? <Button variant="primary" disabled aria-busy="true"><Loader2 size={14} aria-hidden="true" className="animate-spin" />Recreando…</Button> : null}
        {guided.state.status === 'failed' ? <Button variant="primary" disabled={busy || !current} onClick={() => { guided.onRetry(); }}>Reintentar</Button> : null}
        {guided.state.status === 'awaiting_auth' ? <p className="m-0 text-sm" role="status">Complétalo en la ventana del proveedor.</p> : null}
        {guided.state.status === 'done' ? <p className="m-0 text-sm" role="status">Contenedor recreado.</p> : null}
        {showCancel ? <Button size="sm" variant="ghost" className="underline underline-offset-2" disabled={busy || !current || guidedBusy} onClick={() => { control('cancel'); }}>Cancelar</Button> : null}
        {showCancel ? <span className="text-xs text-muted">{drift ? 'Cancelar solo cancela la operación desfasada, sin recrear el contenedor.' : 'Cancelar detiene esta operación sin seguir el camino guiado.'}</span> : null}
      </div>
    </section> : null}
    {showAuth ? <AuthOperationPanel operation={operation} allowed={current} onRefreshed={onAuthRefreshed} autoOpen={guided?.state.status === 'awaiting_auth'} /> : null}
    {blocking && intended && !showGuided ? <p className="notice m-0" role="note">{blockingText(blocking, intended)}</p> : null}
    {stale ? <p className="notice m-0" role="alert">{STALE_RESUME_TEXT}</p> : null}
    {!current ? <p className="notice m-0">No pudimos confirmar la última lectura de esta operación. Pulsa «Releer operación» para actualizarla antes de seguir.</p> : null}
    {!hideLegacyActions && (showResume || showCancel) ? <div className="flex flex-wrap items-center gap-2">
      {showResume ? <Button variant={resume && !cancelPrimary && !showAuth ? 'primary' : 'secondary'} disabled={busy || !current || !resume} onClick={() => { control('resume'); }}>
        {operation.status === 'failed' ? 'Reintentar' : 'Reanudar'}
      </Button> : null}
      {cancelPrimary ? <Button variant="danger" disabled={busy || !current} onClick={() => { control('cancel'); }}>Cancelar</Button> : null}
      {showCancel && !cancelPrimary && !showGuided ? <Button disabled={busy || !current} onClick={() => { control('cancel'); }}>Cancelar</Button> : null}
      {cancelPrimary && (blocking || stale) ? <span className="text-xs text-muted">Cancela esta operación para poder seguir con la que quieres lanzar.</span>
        : showAuth && showResume ? <span className="text-xs text-muted">Primero inicia sesión; después pulsa «Reanudar».</span>
          : showResume && cancel && operation.status === 'failed' ? <span className="text-xs text-muted">Reintenta desde el paso que falló, o cancela si ya no lo necesitas.</span> : null}
    </div> : null}
    <details>
      <summary className="cursor-pointer text-xs text-muted">Detalles técnicos</summary>
      <div className="mt-2 grid gap-1 text-xs break-words">
        <p className="m-0">ID: <code>{operation.id}</code> · Versión: {operation.version}</p>
        <p className="m-0">Huella: <code>{operation.request_sha256}</code></p>
        <p className="m-0">Revisión esperada: {operation.expected_revision} · Revisión deseada: {operation.desired_revision ?? 'Sin publicar'} · Revisión aplicada: {operation.applied_revision ?? 'Sin acreditar'}</p>
        <p className="m-0">Objetivo: <code>{JSON.stringify(operation.target)}</code> · Actor: {operation.actor.tenant_id}/{operation.actor.alias}</p>
        {error ? <p className="m-0">Código: <code>{error.code}</code>{error.step ? <> · Paso: <code>{error.step}</code></> : null} · Reintentable: {error.retryable ? 'sí' : 'no'}</p> : null}
        {operation.steps.some((step) => step.evidence) ? <pre className="m-0 overflow-auto whitespace-pre-wrap">{JSON.stringify(operation.steps.map((step) => ({ paso: step.name, estado: step.status, evidencia: step.evidence ?? null })), null, 2)}</pre> : null}
      </div>
    </details>
  </section>;
}
