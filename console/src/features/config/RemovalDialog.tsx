import { useEffect, useRef, useState } from 'react';
import { FleetOperationRequestSchema, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol/fleet-operation';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import { ActionButton } from '../../components/action-button';
import { Button } from '../../components/kit';
import { FormDialog } from '../../components/dialogs';
import { AgentFleetOperation, AgentFleetPreview, OperationLine } from './AgentFleetOperation';
import { blockingOperation, blockingText, fleetCapabilityReasonText, fleetErrorText, isUnpreparedMaintenance, isUnresolved, operationTitle, partitionOperations } from './fleet-operation-text';
import { useAgentLifecycle } from './use-agent-lifecycle';
import './agent-lifecycle.css';

type RemovalKind = 'retire' | 'restore' | 'purge';
const LABELS = { retire: 'retiro', restore: 'restauración', purge: 'purga' };
export function RemovalDialog({ target, kind: initialKind, revision, onClose, reload }: {
  target: FleetTarget; kind: RemovalKind; revision: number | undefined; onClose: () => void; reload?: () => Promise<unknown>;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [kind, setKind] = useState(initialKind);
  const [key, setKey] = useState(() => `fleet_${crypto.randomUUID()}`);
  const [validated, setValidated] = useState<{ request: FleetOperationRequest; preview: FleetOperationPreview }>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [typed, setTyped] = useState('');
  const flow = useAgentLifecycle(true, target, () => { void reload?.(); });
  const sequence = useRef(0);
  const revisionSeen = useRef(revision);
  const canWrite = !sessionInvalid && !access.error && !access.loading && access.data?.permissions?.includes('config.write') === true;
  const available = flow.capability?.available === true && flow.capability.actions.includes(kind);
  const busy = sending || flow.busy;
  const inProgress = isUnresolved(flow.operation) && !isUnpreparedMaintenance(flow.operation);
  const blocked = !!blockingOperation(flow.operation, kind);
  const parsed = FleetOperationRequestSchema.safeParse({ kind, target, parameters: {}, expected_revision: revision, idempotency_key: key });
  const request = parsed.success ? parsed.data : undefined;
  const fingerprint = JSON.stringify(request);
  const current = useRef(fingerprint);
  current.current = fingerprint;
  const valid = !!request && !!validated && fingerprint === JSON.stringify(validated.request);
  const equipo = target.resource === 'tenant';
  const noun = equipo ? 'equipo' : 'grupo';
  const confirmName = target.resource === 'tenant' ? target.tenant_id : target.resource === 'room' ? target.room_id : '';
  const nameConfirmed = kind === 'restore' || typed === confirmName;
  const retireDone = flow.operation?.kind === 'retire' && flow.operation.status === 'succeeded';
  useEffect(() => () => { sequence.current += 1; }, []);
  useEffect(() => api.onAuthGenerationChange(() => {
    sequence.current += 1; setSessionInvalid(true); setValidated(undefined); setError('La sesión cambió. Cierra y relee los permisos antes de operar.');
  }), [api]);
  useEffect(() => {
    if (revisionSeen.current === revision) return;
    revisionSeen.current = revision; sequence.current += 1; setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`);
    setError('La configuración cambió. Previsualiza de nuevo sobre la revisión actual.');
  }, [revision]);
  async function preview() {
    if (!request || !canWrite || !available || busy || inProgress || blocked) return;
    const read = ++sequence.current;
    const expected = fingerprint;
    setSending(true); setPreviewing(true); setError(undefined); setValidated(undefined);
    try {
      const receipt = await api.previewFleetOperation(request);
      if (read === sequence.current && expected === current.current) setValidated({ request, preview: receipt });
    } catch (cause) { if (read === sequence.current) setError(cause instanceof Error ? fleetErrorText(cause.message, flow.operation, kind) : 'No se pudo previsualizar.'); }
    finally { setSending(false); setPreviewing(false); }
  }
  async function enqueue() {
    if (!valid || !validated.preview.can_apply || !canWrite || !available || busy || inProgress || blocked || !nameConfirmed) return;
    const read = ++sequence.current;
    setSending(true); setError(undefined);
    try {
      const operation = await api.enqueueFleetOperation(validated.request);
      if (read === sequence.current) { flow.accept(operation); setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`); setTyped(''); }
    } catch (cause) { if (read === sequence.current) setError(cause instanceof Error ? fleetErrorText(cause.message, flow.operation, kind) : 'No se confirmó el encolado. El reintento conserva su clave.'); }
    finally { setSending(false); }
  }
  function goPurge() {
    sequence.current += 1; setKind('purge'); setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`); setTyped(''); setError(undefined);
  }
  const previewBlock = !canWrite ? 'No se acreditó autoridad actual para operar este equipo o grupo.'
    : !available ? `El servidor no acredita esta acción: ${fleetCapabilityReasonText(flow.capability?.reason)}.`
      : !request ? 'Falta una revisión o identidad válida para esta operación.'
        : blocked ? blockingText(flow.operation, kind)
          : inProgress ? blockingText(flow.operation, kind)
            : busy ? 'Espera a que termine la operación en curso.' : undefined;
  const enqueueBlock = previewBlock ?? (!valid ? 'Previsualiza la operación para poder encolarla.'
    : !validated.preview.can_apply ? 'La vista previa no permite aplicar esta operación. Revisa los motivos de la vista previa.'
      : !nameConfirmed ? `Escribe ${confirmName} para confirmar.` : undefined);
  const title = kind === 'restore' ? `Restaurar ${noun}` : kind === 'purge' ? `Purgar ${noun}` : `Retirar ${noun}`;
  return <FormDialog open wide anchorTop busy={sending} onClose={onClose} title={title}>
    <div className="config-modal-cuerpo agent-lifecycle-panel">
      <p>{equipo ? <>Equipo <code>{target.tenant_id}</code>.</> : <>Grupo <code>{target.resource === 'room' ? target.room_id : ''}</code> del equipo <code>{target.tenant_id}</code>.</>}</p>
      {kind === 'retire' ? <p><strong>Paso 1 de 2 · Retirar.</strong> Se deshabilita el {noun}, se revocan sus permisos con otros espacios,
        se quitan sus membresías y grupos, se revocan sus sesiones de terminal y se terminan sus entregas pendientes.
        El historial (mensajes, entregas cerradas y auditoría) se conserva y todavía se puede restaurar.</p> : null}
      {kind === 'purge' ? <p><strong>Paso 2 de 2 · Purgar.</strong> Se borra la configuración retirada (perfiles, cuentas vinculadas y destinos de aviso)
        y se conservan los mensajes, las entregas cerradas y la auditoría como historial. No se puede deshacer.</p> : null}
      {kind === 'restore' ? <p>Los agentes conservan la admisión deshabilitada hasta que una operación individual verifique su ejecución.</p> : null}
      {kind === 'purge' ? <p className="notice">Hace falta que el retiro haya terminado. La vista previa dice, en palabras simples, qué se borra y qué se conserva como historial.</p> : null}
      {!canWrite ? <p className="notice">No se acreditó autoridad actual para operar este equipo o grupo.</p> : null}
      {flow.capabilityError ? <p className="notice">{flow.capabilityError}</p> : !flow.capability ? <p role="status">Leyendo capacidades operativas…</p>
        : !available ? <p className="notice">El servidor no acredita esta acción: {fleetCapabilityReasonText(flow.capability.reason)}.</p> : null}
      {!request ? <p className="notice">Falta una revisión o identidad válida para esta operación.</p> : null}
      <div className="flex flex-wrap items-center gap-2"><Button disabled={!canWrite || !available || !request || busy || inProgress || blocked} title={previewBlock}
        aria-busy={previewing} onClick={() => { void preview(); }}>{previewing ? 'Previsualizando…' : `Previsualizar ${LABELS[kind]}`}</Button>
        <Button variant="primary" disabled={!canWrite || !available || busy || inProgress || blocked || !valid || !validated.preview.can_apply || !nameConfirmed} title={enqueueBlock}
          onClick={() => { void enqueue(); }}>Encolar {LABELS[kind]}</Button></div>
      {!valid && !blocked && !previewing ? <p className="m-0 text-xs text-muted">Previsualiza la operación para poder encolarla.</p> : null}
      {valid && kind !== 'restore' ? <label>Escribe <code>{confirmName}</code> para confirmar
        <input value={typed} autoComplete="off" disabled={busy || inProgress} onChange={(event) => { setTyped(event.target.value); }} /></label> : null}
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {valid ? <><AgentFleetPreview preview={validated.preview} />
        <details><summary>Detalles técnicos de la solicitud</summary><pre aria-label={`Solicitud de ${LABELS[kind]}`}>{JSON.stringify(validated.request, null, 2)}</pre></details></> : null}
      {flow.operation ? <><AgentFleetOperation operation={flow.operation} busy={busy} current={!flow.readError && canWrite && !!flow.capability?.available}
        intended={kind} stale={flow.stale}
        control={(action) => { void flow.control(action); }} />
        {flow.readError ? <p className="notice" role="alert">{flow.readError}</p> : null}
        <ActionButton size="sm" variant="ghost" className="underline underline-offset-2" label="Releer operación" disabled={busy} announceError={false} action={() => flow.refresh()} /></> : null}
      {retireDone && kind === 'retire' ? <section className="notice grid gap-2" aria-label="Retiro terminado">
        <p className="m-0">El retiro terminó. Ya puedes purgar el {noun}: se borrará su configuración y el historial quedará conservado.</p>
        <div><Button variant="primary" disabled={busy} onClick={goPurge}>Continuar a purgar</Button></div>
      </section> : null}
      <details open><summary>Historial de operaciones</summary>
        {flow.historyError ? <p className="notice">{flow.historyError}</p> : null}
        {flow.history?.length ? (() => {
          const { attention, finished } = partitionOperations(flow.history);
          const row = (operation: (typeof flow.history)[number]) => <li key={operation.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line p-3">
            <OperationLine operation={operation} />
            <Button size="sm" disabled={busy} aria-label={`Ver detalle de ${operationTitle(operation)}`}
              onClick={() => { flow.accept(operation); }}>Ver</Button>
          </li>;
          return <div className="grid gap-2">
            {attention.length ? <ul className="m-0 grid list-none gap-2 p-0">{attention.map(row)}</ul> : null}
            {finished.length ? <details><summary className="cursor-pointer text-sm">Terminadas ({finished.length})</summary>
              <ul className="m-0 mt-2 grid list-none gap-2 p-0">{finished.map(row)}</ul></details> : null}
          </div>;
        })() : <p>Todavía no hay operaciones en esta lectura.</p>}
      </details>
    </div><div className="config-modal-pie flex flex-wrap items-center gap-2">
      {reload ? <ActionButton size="sm" variant="ghost" className="underline underline-offset-2" label="Releer inventario" announceError={false} action={() => reload()} /> : null}
      <Button disabled={sending} onClick={onClose} className="ml-auto">Cerrar</Button>
    </div>
  </FormDialog>;
}
