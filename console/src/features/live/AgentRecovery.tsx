import { AgentSessionOutcomeSchema, NativeRuntimeIdentitySchema, type AgentSessionOutcome, type NativeRuntimeIdentity } from '@cauce/protocol/native-admin';
import { FleetRecoveryPreviewSchema } from '@cauce/protocol/fleet-recovery';
import type { ConsoleFleetOperation } from '@cauce/protocol/console-fleet-operation';
import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useOptionalConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client/core';
import { Button, Notice } from '../../components/kit';
import { cn } from '../../cn';
import { permissionState, type PermissionState } from '../../lib';
import { navigate } from '../../router';
import { prepareAgentHref } from '../config/use-agent-route';
import { terminalRequest } from '../terminal/api';
import { executeFleetRecovery, FleetRecoveryFailure, unresolvedFleetRecovery } from './fleet-agent-recovery';
import { recoveryError, recoveryProblem, type RecoveryProblem } from './recovery-problem';
import { UnresolvedRecovery } from './UnresolvedRecovery';

interface Props {
  tenantId: string;
  alias: string;
  permission?: PermissionState;
  className?: string;
  onRecovered?: () => void;
}

interface RecoveryPreview {
  identity: NativeRuntimeIdentity;
  session: AgentSessionOutcome;
  in_flight: number;
  expected_revision?: number;
  relaunch?: { recreates_container: boolean };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La recuperación no devolvió un resultado verificable.');
  return value as Record<string, unknown>;
}

function recoveryPreview(value: unknown, tenantId: string, alias: string): RecoveryPreview {
  const result = record(value);
  const identity = NativeRuntimeIdentitySchema.parse(result.identity);
  const session = AgentSessionOutcomeSchema.parse(result.session);
  if (result.tenant_id !== tenantId || result.alias !== alias
    || typeof result.in_flight !== 'number' || !Number.isSafeInteger(result.in_flight) || result.in_flight < 0) {
    throw new Error('La recuperación no acreditó el agente, su conversación y sus entregas en vuelo.');
  }
  return { identity, session, in_flight: result.in_flight };
}

function relaunchText(preview: RecoveryPreview): string | undefined {
  if (!preview.relaunch) return undefined;
  const container = preview.relaunch.recreates_container ? ' Su contenedor se recreará con la versión vigente y conservará sus volúmenes.' : '';
  return `${preview.session.state === 'present'
    ? 'El adaptador corre con una versión anterior: se detendrá y se relanzará con la versión vigente.'
    : 'El adaptador está detenido: se relanzará con la versión vigente.'}${container} La TUI compartida reanudará la conversación exacta.`;
}

export function AgentRecovery(props: Props) {
  const access = useOptionalConsoleAccess();
  const permission = props.permission ?? permissionState(access?.error ? undefined : access?.data, 'config.write');
  return permission === 'denied' ? null : <RecoveryControl key={`${props.tenantId}/${props.alias}`} {...props} permission={permission} />;
}

function RecoveryControl({ tenantId, alias, permission, className, onRecovered }: Props) {
  const api = useApi();
  const titleId = useId();
  const revision = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const [preview, setPreview] = useState<RecoveryPreview>();
  const [problem, setProblem] = useState<RecoveryProblem>();
  const [unresolved, setUnresolved] = useState<ConsoleFleetOperation>();
  const [busy, setBusy] = useState<'reading' | 'recovering'>();
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const path = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/recovery`;

  useEffect(() => {
    function clear() {
      revision.current += 1;
      pending.current?.abort();
      pending.current = undefined;
      setPreview(undefined); setProblem(undefined); setUnresolved(undefined); setBusy(undefined); setError(''); setOutcome('');
    }
    clear();
    const unsubscribe = api.onAuthGenerationChange(clear);
    return () => { revision.current += 1; pending.current?.abort(); unsubscribe(); };
  }, [api, permission]);

  async function inspect() {
    if (pending.current || busy || permission === 'denied') return;
    const token = ++revision.current;
    const controller = new AbortController(); pending.current = controller;
    setBusy('reading'); setPreview(undefined); setProblem(undefined); setUnresolved(undefined); setError(''); setOutcome('');
    try {
      let blocking: ConsoleFleetOperation | undefined;
      try { blocking = await unresolvedFleetRecovery(api, { tenant_id: tenantId, alias }); }
      catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      if (token !== revision.current) return;
      if (blocking) { setUnresolved(blocking); return; }
      const measured = record(await terminalRequest<unknown>(path, { signal: controller.signal }, api));
      let result: RecoveryPreview;
      if (measured.transport === 'fleet') {
        const checked = FleetRecoveryPreviewSchema.safeParse(measured);
        if (!checked.success || checked.data.tenant_id !== tenantId || checked.data.alias !== alias) {
          throw new Error('La consulta no acreditó el agente y la revisión de su empresa.');
        }
        const state = checked.data;
        if (state.status !== 'ready') {
          if (token === revision.current) setProblem(recoveryProblem(state.reason_code, state.next_action));
          return;
        }
        result = { identity: state.recovery.identity, session: state.recovery.session,
          in_flight: state.in_flight, expected_revision: state.expected_revision,
          ...(state.recovery.strategy === 'relaunch' ? { relaunch: { recreates_container: state.recovery.recreates_container } } : {}) };
      } else result = recoveryPreview(measured, tenantId, alias);
      if (token === revision.current) setPreview(result);
    } catch (failure) {
      if (token === revision.current) setError(recoveryError(failure, 'No se pudo comprobar la conversación.'));
    } finally { if (token === revision.current) { pending.current = undefined; setBusy(undefined); } }
  }

  const resumable = preview?.session.resumable === true && preview.session.fingerprint !== null;
  const ready = resumable && preview.in_flight === 0 && (preview.session.state === 'present' || preview.session.state === 'absent');

  async function recover() {
    if (!preview || !ready || !preview.session.fingerprint || pending.current || busy || permission === 'denied') return;
    const fingerprint = preview.session.fingerprint;
    const original = preview;
    const token = ++revision.current;
    const controller = new AbortController(); pending.current = controller;
    setBusy('recovering'); setPreview(undefined); setProblem(undefined); setError(''); setOutcome('');
    try {
      const result = original.expected_revision === undefined ? recoveryPreview(await terminalRequest<unknown>(path, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ identity: original.identity, expected_fingerprint: original.session.fingerprint,
          force: original.session.state === 'present' }) }, api), tenantId, alias)
        : await executeFleetRecovery(api, { tenant_id: tenantId, alias }, original.expected_revision,
          { action: 'apply', identity: original.identity, expected_fingerprint: fingerprint,
            force: original.session.state === 'present', ...(original.relaunch ? { strategy: 'relaunch' as const } : {}) }, controller.signal);
      if (token !== revision.current) return;
      if ((result.session.state !== 'resumed' && result.session.state !== 'recreated')
        || !result.session.resumable || result.session.fingerprint !== original.session.fingerprint) {
        throw new Error(result.session.reason || 'El servidor no acreditó la recuperación de la conversación exacta.');
      }
      setOutcome(`${result.session.state === 'resumed' ? 'Reanudado' : 'Recreado'}: ${alias} continúa la misma conversación.`);
      if (onRecovered) onRecovered();
      else navigate(`/terminal/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}?modo=tui`);
    } catch (failure) {
      if (token === revision.current) {
        setError(recoveryError(failure, 'No se confirmó la recuperación.'));
        if (failure instanceof FleetRecoveryFailure && failure.reason) setProblem(recoveryProblem(failure.reason));
        if (failure instanceof Error && failure.message === 'target already has an unresolved fleet operation') {
          const blocking = await unresolvedFleetRecovery(api, { tenant_id: tenantId, alias }).catch(() => undefined);
          if (token === revision.current) setUnresolved(blocking);
        }
      }
    } finally { if (token === revision.current) { pending.current = undefined; setBusy(undefined); } }
  }

  return <section aria-label={`Recuperación de ${alias}`} className={cn('grid min-w-0 gap-2 text-[13px]', className)}>
    <Button size="sm" disabled={busy !== undefined} aria-expanded={preview !== undefined || problem !== undefined || unresolved !== undefined} onClick={() => { void inspect(); }}>
      <RotateCcw size={13} aria-hidden="true" />{busy === 'reading' ? 'Comprobando conversación…' : 'Reiniciar agente'}
    </Button>
    {unresolved ? <UnresolvedRecovery operation={unresolved} tenantId={tenantId} alias={alias} onClose={() => { setUnresolved(undefined); }}
      onResolved={() => { setUnresolved(undefined); void inspect(); }} onChanged={setUnresolved} /> : null}
    {problem ? <div role="region" aria-labelledby={titleId} className="grid gap-2 rounded-lg border border-line bg-subtle p-3">
      <h2 id={titleId} className="m-0 text-sm font-semibold">Reiniciar {alias}</h2>
      <Notice tone="warn" role="alert">{problem.reason}</Notice>
      <div className="flex flex-wrap gap-2">
        {problem.next_action === 'update'
          ? <Button size="sm" onClick={() => { navigate(prepareAgentHref(tenantId, alias)); }}>Actualizar ejecución</Button>
          : <><Button size="sm" onClick={() => { navigate(prepareAgentHref(tenantId, alias, 'stop')); }}>Detener</Button>
            <Button size="sm" onClick={() => { navigate(prepareAgentHref(tenantId, alias, 'start')); }}>Arrancar</Button></>}
        <Button size="sm" onClick={() => { setProblem(undefined); }}>Cancelar</Button>
      </div>
    </div> : null}
    {preview ? <div role="region" aria-labelledby={titleId} className="grid gap-2 rounded-lg border border-line bg-subtle p-3">
      <h2 id={titleId} className="m-0 text-sm font-semibold">Reiniciar {alias}</h2>
      {ready ? <p className="m-0 text-fg-2">{relaunchText(preview) ?? (preview.session.state === 'present'
        ? 'Se cerrará la TUI actual y se reanudará la conversación exacta. Confirma solo si necesitas recuperarla.'
        : 'Se recreará la TUI ausente reanudando la conversación exacta.')}</p> : null}
      {!resumable ? <Notice tone="warn" role="alert">No hay una conversación reanudable verificada. Reiniciar sin reanudar causaría amnesia; esta acción está bloqueada.</Notice> : null}
      {preview.in_flight > 0 ? <Notice tone="warn" role="alert">Hay {preview.in_flight} {preview.in_flight === 1 ? 'entrega en vuelo' : 'entregas en vuelo'}. El reinicio está bloqueado hasta que terminen.</Notice> : null}
      {preview.session.reason ? <p className="m-0 wrap-anywhere text-xs text-muted">{preview.session.reason}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="danger" disabled={!ready || busy !== undefined} onClick={() => { void recover(); }}>Confirmar reinicio y reanudar</Button>
        <Button size="sm" onClick={() => { setPreview(undefined); }}>Cancelar</Button>
      </div>
    </div> : null}
    {busy === 'recovering' ? <Notice role="status">Recuperando la conversación de {alias}…</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error} Vuelve a comprobar el estado antes de intentar otro reinicio.</Notice> : null}
    {outcome ? <Notice tone="ok" role="status">{outcome}</Notice> : null}
  </section>;
}
