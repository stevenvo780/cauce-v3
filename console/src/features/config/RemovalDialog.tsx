import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { FleetOperationRequestSchema, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol/fleet-operation';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { AgentFleetOperation, AgentFleetPreview } from './AgentFleetOperation';
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
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const flow = useAgentLifecycle(true, target);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sequence = useRef(0);
  const revisionSeen = useRef(revision);
  const canWrite = !sessionInvalid && !access.error && !access.loading && access.data?.permissions?.includes('config.write') === true;
  const available = flow.capability?.available === true && flow.capability.actions.includes(kind);
  const busy = sending || flow.busy;
  const inProgress = !!flow.operation && ['queued', 'running', 'awaiting_auth', 'cancelling'].includes(flow.operation.status);
  const parsed = FleetOperationRequestSchema.safeParse({ kind, target, parameters: {}, expected_revision: revision, idempotency_key: key });
  const request = parsed.success ? parsed.data : undefined;
  const fingerprint = JSON.stringify(request);
  const current = useRef(fingerprint);
  current.current = fingerprint;
  const valid = !!request && !!validated && fingerprint === JSON.stringify(validated.request);
  const trap = useFocusTrap(dialog);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const shell = document.querySelector('.app-shell');
    const ownedInert = !!shell && !shell.hasAttribute('inert');
    if (ownedInert) shell.setAttribute('inert', '');
    heading.current?.focus();
    return () => { sequence.current += 1; if (ownedInert) shell.removeAttribute('inert'); opener?.focus(); };
  }, []);
  useEffect(() => api.onAuthGenerationChange(() => {
    sequence.current += 1; setSessionInvalid(true); setValidated(undefined); setError('La sesión cambió. Cierra y relee los permisos antes de operar.');
  }), [api]);
  useEffect(() => {
    if (revisionSeen.current === revision) return;
    revisionSeen.current = revision; sequence.current += 1; setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`);
    setError('La configuración cambió. Previsualiza de nuevo sobre la revisión actual.');
  }, [revision]);
  async function preview() {
    if (!request || !canWrite || !available || busy || inProgress) return;
    const read = ++sequence.current;
    const expected = fingerprint;
    setSending(true); setError(undefined); setValidated(undefined);
    try {
      const receipt = await api.previewFleetOperation(request);
      if (read === sequence.current && expected === current.current) setValidated({ request, preview: receipt });
    } catch (cause) { if (read === sequence.current) setError(cause instanceof Error ? cause.message : 'No se pudo previsualizar.'); }
    finally { setSending(false); }
  }
  async function enqueue() {
    if (!valid || !validated.preview.can_apply || !canWrite || !available || busy || inProgress) return;
    const read = ++sequence.current;
    setSending(true); setError(undefined);
    try {
      const operation = await api.enqueueFleetOperation(validated.request);
      if (read === sequence.current) { flow.accept(operation); setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`); }
    } catch (cause) { if (read === sequence.current) setError(cause instanceof Error ? cause.message : 'No se confirmó el encolado. El reintento conserva su clave.'); }
    finally { setSending(false); }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !sending) { event.stopPropagation(); onClose(); return; }
    trap(event);
  }
  return createPortal(<div className="config-modal-fondo"><div ref={dialog} className="config-modal" role="dialog" aria-modal="true"
    aria-labelledby="group-removal-title" onKeyDown={keyboard}>
    <div className="config-modal-cuerpo agent-lifecycle-panel">
      <h2 ref={heading} id="group-removal-title" tabIndex={-1}>Retiro y recuperación de {target.resource === 'tenant' ? 'espacio' : 'grupo'}</h2>
      <p>Identidad exacta: <code>{JSON.stringify(target)}</code></p>
      <p>Pausar admisión cambia la configuración de entrega. El retiro coordina el cierre de entregas y la detención de runtimes. La purga exige resolver las dependencias.</p>
      <label>Tipo de operación<select value={kind} disabled={busy || inProgress} onChange={(event) => {
        setKind(event.target.value as RemovalKind); setValidated(undefined); setKey(`fleet_${crypto.randomUUID()}`); sequence.current += 1;
      }}><option value="retire">Retirar</option><option value="restore">Restaurar</option><option value="purge">Purgar definitivamente</option></select></label>
      {kind === 'restore' ? <p>Los agentes conservan la admisión deshabilitada hasta que una operación individual verifique su ejecución.</p> : null}
      {kind === 'purge' ? <p className="notice">La purga elimina el registro retirado de forma definitiva. Comprueba las dependencias en la previsualización.</p> : null}
      {!canWrite ? <p className="notice">No se acreditó autoridad actual para operar este grupo o espacio.</p> : null}
      {flow.capabilityError ? <p className="notice">{flow.capabilityError}</p> : !flow.capability ? <p role="status">Leyendo capacidades operativas…</p>
        : !available ? <p className="notice">El servidor no acredita esta acción{flow.capability.reason ? ` (${flow.capability.reason})` : ''}.</p> : null}
      {!request ? <p className="notice">Falta una revisión o identidad válida para esta operación.</p> : null}
      {error ? <p className="notice" role="alert">{error}</p> : null}
      <div className="config-actions"><button type="button" className="button secondary" disabled={!canWrite || !available || !request || busy || inProgress}
        onClick={() => { void preview(); }}>Previsualizar {LABELS[kind]}</button>
        <button type="button" className="button primary" disabled={!canWrite || !available || busy || inProgress || !valid || !validated.preview.can_apply}
          onClick={() => { void enqueue(); }}>Encolar {LABELS[kind]}</button></div>
      {valid ? <><AgentFleetPreview preview={validated.preview} /><pre aria-label={`Solicitud de ${LABELS[kind]}`}>{JSON.stringify(validated.request, null, 2)}</pre></> : null}
      {flow.operation ? <><AgentFleetOperation operation={flow.operation} busy={busy} current={!flow.readError && canWrite && available}
        control={(action) => { void flow.control(action); }} />
        {flow.readError ? <p className="notice" role="alert">{flow.readError}</p> : null}
        <button type="button" className="button secondary" disabled={busy} onClick={() => { void flow.refresh(); }}>Releer operación</button></> : null}
      <details open><summary>Historial operativo durable</summary>
        {flow.historyError ? <p className="notice">{flow.historyError}</p> : null}
        {flow.history?.length ? <ul>{flow.history.map((operation) => <li key={operation.id}>{operation.kind} · {operation.status}
          <button type="button" className="button small" disabled={busy} aria-label={`Abrir operación ${operation.id}`}
            onClick={() => { flow.accept(operation); }}>{operation.id}</button></li>)}</ul> : <p>No hay operaciones acreditadas en esta lectura.</p>}
      </details>
    </div><div className="config-modal-pie config-actions">
      {reload ? <button type="button" className="button secondary" onClick={() => { void reload(); }}>Releer inventario</button> : null}
      <button type="button" className="button secondary" disabled={sending} onClick={onClose}>Cerrar retiro y recuperación</button>
    </div>
  </div></div>, document.body);
}
