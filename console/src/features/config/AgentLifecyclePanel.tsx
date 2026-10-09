import { useEffect, useRef, useState } from 'react';
import { FleetOperationRequestSchema, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol/fleet-operation';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentLifecycleFields } from './AgentLifecycleFields';
import { AgentFleetOperation, AgentFleetPreview } from './AgentFleetOperation';
import { operationSummary } from './fleet-operation-text';
import { agentLifecycleDraft, agentLifecycleRequest, FLEET_ACTION_LABELS, type AgentLifecycleDraft } from './agent-lifecycle-model';
import { useAgentLifecycle } from './use-agent-lifecycle';
import './agent-lifecycle.css';

type Kind = FleetOperationRequest['kind'];
const newKey = () => `fleet_${crypto.randomUUID()}`;
const ACTION_LABELS: Record<Kind, string> = { ...FLEET_ACTION_LABELS, purge: 'Eliminar definitivamente' };
export function AgentLifecyclePanel({ snapshot, target, onReloaded, initialDraft, initialOpen = false, initialKind, triggerLabel, hideTrigger = false, embedded = false, fixedKind = false, onClose, onDirtyChange }: {
  snapshot: ConfigurationSnapshot; target?: FleetTarget; onReloaded?: (value: ConfigurationSnapshot) => void;
  initialDraft?: AgentLifecycleDraft; initialOpen?: boolean; initialKind?: Kind | undefined; triggerLabel?: string | undefined;
  hideTrigger?: boolean; embedded?: boolean; onClose?: () => void;
  /** The action is decided by the caller (the removal guide): no action picker and no preparation copy. */
  fixedKind?: boolean; onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [open, setOpen] = useState(initialOpen);
  const [kind, setKind] = useState<Kind>(initialKind ?? (target ? 'update' : 'create'));
  const [draft, setDraft] = useState(() => initialDraft ?? agentLifecycleDraft(snapshot, target));
  const [key, setKey] = useState(newKey);
  const [validated, setValidated] = useState<{ input: FleetOperationRequest; receipt: FleetOperationPreview }>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [inventoryNotice, setInventoryNotice] = useState<string>();
  const previousRevision = useRef(snapshot.revision);
  const flow = useAgentLifecycle(open, target);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const dirty = useRef(false);
  const currentFingerprint = useRef('');
  const canWrite = !sessionInvalid && !access.loading && !access.error && access.data?.permissions?.includes('config.write') === true;
  const available = flow.capability?.available === true && flow.capability.actions.includes(kind);
  const draftKind = kind === 'create' || kind === 'update';
  const prepared = draftKind ? agentLifecycleRequest(draft, snapshot, flow.capability, kind, key, target)
    : simpleRequest();
  const input = prepared.request;
  currentFingerprint.current = JSON.stringify(input);
  const samePreview = !!input && !!validated && JSON.stringify(input) === JSON.stringify(validated.input);
  const busy = sending || flow.busy;
  const inProgress = !!flow.operation && ['queued', 'running', 'awaiting_auth', 'cancelling'].includes(flow.operation.status);
  useEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (previousRevision.current === snapshot.revision) return;
    previousRevision.current = snapshot.revision; generation.current += 1; setValidated(undefined); setKey(newKey());
    const keepDraft = dirty.current;
    if (target && !keepDraft) setDraft(agentLifecycleDraft(snapshot, target));
    setInventoryNotice(target && !keepDraft ? 'El inventario cambió. Se cargaron los datos actuales; revisa la intención antes de previsualizar otra operación.'
      : 'El inventario cambió. El borrador se conserva y requiere una nueva previsualización.');
  }, [snapshot, target]);
  useEffect(() => api.onAuthGenerationChange(() => {
    generation.current += 1; setSessionInvalid(true); setValidated(undefined); setError('La sesión cambió. Relee permisos y capacidades antes de continuar.');
  }), [api]);

  function simpleRequest(): { request?: FleetOperationRequest; error?: string } {
    if (!target || !available) return { error: 'El servidor no acredita esta acción para el agente seleccionado.' };
    const result = FleetOperationRequestSchema.safeParse({ kind, target, parameters: {}, expected_revision: snapshot.revision, idempotency_key: key });
    return result.success ? { request: result.data } : { error: 'Falta una identidad o revisión durable válida.' };
  }
  function edit(patch: Partial<AgentLifecycleDraft>) {
    generation.current += 1; dirty.current = true; onDirtyChange?.(true); setDraft((previous) => ({ ...previous, ...patch }));
    setKey(newKey()); setValidated(undefined); setError(undefined);
  }
  async function preview() {
    if (!canWrite || !available || busy || inProgress) return;
    if (!input) { setError(prepared.error); return; }
    const expected = JSON.stringify(input);
    const sequence = ++generation.current;
    setSending(true); setError(undefined); setValidated(undefined);
    try {
      const receipt = await api.previewFleetOperation(input);
      if (sequence === generation.current && expected === currentFingerprint.current) setValidated({ input, receipt });
    } catch (cause) { if (sequence === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudo previsualizar la operación.'); }
    finally { setSending(false); }
  }
  async function enqueue() {
    if (!canWrite || !available || busy || inProgress || !samePreview || !validated.receipt.can_apply) return;
    const sequence = ++generation.current;
    setSending(true); setError(undefined);
    try {
      const operation = await api.enqueueFleetOperation(validated.input);
      if (sequence === generation.current) { flow.accept(operation); setValidated(undefined); setKey(newKey()); onDirtyChange?.(false); }
    } catch (cause) {
      if (sequence === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudo confirmar el encolado. Reintenta con la misma solicitud.');
    } finally { setSending(false); }
  }
  async function revalidate() {
    const result = await access.reload();
    if (result.data) { setSessionInvalid(false); setError(undefined); if (!embedded) setOpen(false); onClose?.(); }
    else setError('No se pudo acreditar la sesión actual. Reintenta la lectura de permisos.');
  }
  async function reloadSnapshot() {
    try { onReloaded?.(await api.getConfiguration()); }
    catch { setError('No se pudo releer el inventario. El recibo operativo se conserva.'); }
  }
  const agent = target?.resource === 'agent' ? [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])]
    .find((row) => row.tenant_id === target.tenant_id && row.alias === target.alias) : undefined;
  return <div className="agent-lifecycle-panel" data-open={String(open)}>
    {hideTrigger ? null : <button ref={trigger} type="button" className="button secondary"
      onClick={() => { setOpen((value) => !value); }} aria-expanded={open}
      aria-label={triggerLabel ?? (target?.resource === 'agent' ? `Operar agente ${target.tenant_id}/${target.alias}` : 'Preparar agente')}>
      {triggerLabel ?? (target ? 'Operar agente' : 'Preparar agente')}
    </button>}
    {open ? <section className="settings-context" aria-label={target?.resource === 'agent' ? `Operación de ${target.tenant_id}/${target.alias}` : 'Alta operativa de agente'}>
      <div className="settings-context-heading"><h3 ref={heading} tabIndex={-1}>{target ? 'Ejecución y ciclo de vida' : 'Preparar nuevo agente'}</h3>
        {embedded ? null : <button type="button" className="button secondary" onClick={() => { setOpen(false); trigger.current?.focus(); onClose?.(); }}>Cerrar operaciones</button>}
      </div>
      {fixedKind ? null : <p>Preparar no exige una ejecución activa. La operación guarda su intención y acredita cada paso antes de admitir entregas.</p>}
      {agent ? <p>Estado durable del agente: {typeof agent.lifecycle_state === 'string' ? agent.lifecycle_state : 'Sin publicar en esta lectura'}.</p> : null}
      {!canWrite ? <p className="notice">No se acreditó permiso para operar agentes desde esta cuenta.</p> : null}
      {sessionInvalid ? <button type="button" className="button secondary" onClick={() => { void revalidate(); }}>Revalidar sesión y cerrar borrador</button> : null}
      {!flow.capability && !flow.capabilityError ? <p role="status">Leyendo capacidades de flota…</p> : null}
      {inventoryNotice ? <p className="notice" role="note">{inventoryNotice}</p> : null}
      {draftKind && flow.capability?.available && !flow.capability.placements.length ? <p className="notice">El ejecutor no publicó hosts permitidos para preparar agentes.</p> : null}
      {flow.capabilityError ? <p className="notice">{flow.capabilityError}</p> : null}
      {flow.capability && !available ? <p className="notice">Esta acción no está disponible en el ejecutor publicado{flow.capability.reason ? ` (${flow.capability.reason})` : ''}.</p> : null}
      {target && !fixedKind ? <label>Acción operativa<select value={kind} disabled={busy || inProgress} onChange={(event) => {
        setKind(event.target.value as Kind); setKey(newKey()); setValidated(undefined); setError(undefined); generation.current += 1;
      }}>{Object.entries(ACTION_LABELS).filter(([action]) => action !== 'create').map(([action, label]) =>
        <option key={action} value={action}>{label}</option>)}</select></label> : null}
      {draftKind ? <AgentLifecycleFields draft={draft} snapshot={snapshot} capability={flow.capability} target={target}
        disabled={busy || inProgress || !canWrite || !available} edit={edit} /> : null}
      {kind === 'purge' ? <p className="notice">La purga elimina el registro retirado. El servidor exige ausencia de dependencias antes de aplicar.</p> : null}
      {error ? <p className="notice" role="alert">{error}</p> : null}
      <div className="acciones"><button type="button" className="button secondary" disabled={busy || inProgress || !canWrite || !available}
        onClick={() => { void preview(); }}>Previsualizar operación</button>
        <button type="button" className="button" disabled={busy || inProgress || !canWrite || !available || !samePreview || !validated.receipt.can_apply}
          onClick={() => { void enqueue(); }}>Encolar operación</button></div>
      {samePreview ? <><AgentFleetPreview preview={validated.receipt} />
        <details><summary>Solicitud exacta de esta previsualización</summary><pre>{JSON.stringify(validated.input, null, 2)}</pre></details></> : null}
      {flow.operation ? <><AgentFleetOperation operation={flow.operation} busy={busy} current={!flow.readError && canWrite && !!flow.capability?.available}
        onAuthRefreshed={flow.accept}
        control={(action) => { void flow.control(action); }} />
        {flow.readError ? <p className="notice" role="alert">{flow.readError}</p> : null}
        <button type="button" className="button secondary" disabled={busy} onClick={() => { void flow.refresh(); }}>Releer operación</button>
        {onReloaded ? <button type="button" className="button secondary" onClick={() => { void reloadSnapshot(); }}>Releer inventario</button> : null}</> : null}
      <details><summary>Historial operativo durable</summary>
        {flow.historyError ? <p className="notice">{flow.historyError}</p> : null}
        {flow.history?.length ? <ul>{flow.history.map((operation) => <li key={operation.id}>
          {operationSummary(operation)} · {operation.created_at}
          <button type="button" className="button secondary" aria-label={`Abrir operación ${operation.id}`}
            disabled={busy} onClick={() => { flow.accept(operation); }}>{operation.id}</button></li>)}</ul>
          : <p>{target ? 'No hay operaciones acreditadas en esta lectura.' : 'El historial de este agente se podrá releer desde su registro guardado.'}</p>}
      </details>
    </section> : null}
  </div>;
}
