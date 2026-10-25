import { AgentSessionOutcomeSchema, NativeRuntimeIdentitySchema, type AgentSessionOutcome, type NativeRuntimeIdentity } from '@cauce/protocol/native-admin';
import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useOptionalConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';
import { cn } from '../../cn';
import { permissionState, type PermissionState } from '../../lib';
import { terminalRequest } from '../terminal/api';

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
  const [busy, setBusy] = useState<'reading' | 'recovering'>();
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const path = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/recovery`;

  useEffect(() => {
    function clear() {
      revision.current += 1;
      pending.current?.abort();
      pending.current = undefined;
      setPreview(undefined); setBusy(undefined); setError(''); setOutcome('');
    }
    clear();
    const unsubscribe = api.onAuthGenerationChange(clear);
    return () => { revision.current += 1; pending.current?.abort(); unsubscribe(); };
  }, [api, permission]);

  async function inspect() {
    if (pending.current || busy || permission === 'denied') return;
    const token = ++revision.current;
    const controller = new AbortController(); pending.current = controller;
    setBusy('reading'); setPreview(undefined); setError(''); setOutcome('');
    try {
      const result = recoveryPreview(await terminalRequest<unknown>(path, { signal: controller.signal }, api), tenantId, alias);
      if (token === revision.current) setPreview(result);
    } catch (failure) {
      if (token === revision.current) setError(failure instanceof Error ? failure.message : 'No se pudo comprobar la conversación.');
    } finally { if (token === revision.current) { pending.current = undefined; setBusy(undefined); } }
  }

  const resumable = preview?.session.resumable === true && preview.session.fingerprint !== null;
  const ready = resumable && preview.in_flight === 0 && (preview.session.state === 'present' || preview.session.state === 'absent');

  async function recover() {
    if (!preview || !ready || pending.current || busy || permission === 'denied') return;
    const original = preview;
    const token = ++revision.current;
    const controller = new AbortController(); pending.current = controller;
    setBusy('recovering'); setPreview(undefined); setError(''); setOutcome('');
    try {
      const result = recoveryPreview(await terminalRequest<unknown>(path, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ identity: original.identity, expected_fingerprint: original.session.fingerprint,
          force: original.session.state === 'present' }) }, api), tenantId, alias);
      if (token !== revision.current) return;
      if ((result.session.state !== 'resumed' && result.session.state !== 'recreated')
        || !result.session.resumable || result.session.fingerprint !== original.session.fingerprint) {
        throw new Error(result.session.reason || 'El servidor no acreditó la recuperación de la conversación exacta.');
      }
      setOutcome(`${result.session.state === 'resumed' ? 'Reanudado' : 'Recreado'}: ${alias} continúa la misma conversación.`);
      onRecovered?.();
    } catch (failure) {
      if (token === revision.current) setError(failure instanceof Error ? failure.message : 'No se confirmó la recuperación.');
    } finally { if (token === revision.current) { pending.current = undefined; setBusy(undefined); } }
  }

  return <section aria-label={`Recuperación de ${alias}`} className={cn('grid min-w-0 gap-2 text-[13px]', className)}>
    <Button size="sm" disabled={busy !== undefined} aria-expanded={preview !== undefined} onClick={() => { void inspect(); }}>
      <RotateCcw size={13} aria-hidden="true" />{busy === 'reading' ? 'Comprobando conversación…' : 'Reiniciar agente'}
    </Button>
    {preview ? <div role="region" aria-labelledby={titleId} className="grid gap-2 rounded-lg border border-line bg-subtle p-3">
      <h2 id={titleId} className="m-0 text-sm font-semibold">Reiniciar {alias}</h2>
      {ready ? <p className="m-0 text-fg-2">{preview.session.state === 'present'
        ? 'Se cerrará la TUI actual y se reanudará la conversación exacta. Confirma solo si necesitas recuperarla.'
        : 'Se recreará la TUI ausente reanudando la conversación exacta.'}</p> : null}
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
