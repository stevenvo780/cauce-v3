import { useEffect, useRef, useState } from 'react';
import { FleetOperationSubmissionSchema, type FleetOperationPreview, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol/fleet-operation';
import { ActionButton } from '../../components/action-button';
import { Button } from '../../components/kit';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentLifecycleFields } from './AgentLifecycleFields';
import { AgentFleetOperation, AgentFleetPreview, OperationLine, OperationStatusPill } from './AgentFleetOperation';
import { blockingOperation, blockingText, fleetCapabilityReasonText, fleetErrorText, guidedDriftHeadline, needsAttention, operationHeadline, operationTitle, partitionOperations } from './fleet-operation-text';
import { focusPrimaryMembershipCheckbox, isPrimaryMembershipError, translateFleetOperationError } from './fleet-operation-error-translations';
import { agentLifecycleDraft, agentLifecycleRequest, fleetScopeGap, FLEET_ACTION_LABELS, isRegistryDraftRow, type AgentLifecycleDraft } from './agent-lifecycle-model';
import { lifecycleLabel } from './agent-view';
import { useAgentLifecycle } from './use-agent-lifecycle';
import { isGuidedDrift } from './guided-recreate';
import { useGuidedRecreate } from './use-guided-recreate';
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
  const agent = target?.resource === 'agent' ? [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])]
    .find((row) => row.tenant_id === target.tenant_id && row.alias === target.alias) : undefined;
  const draftAgent = isRegistryDraftRow(agent);
  const [kind, setKind] = useState<Kind>(initialKind ?? (target && !draftAgent ? 'update' : 'create'));
  const [draft, setDraft] = useState(() => initialDraft ?? agentLifecycleDraft(snapshot, target));
  const [key, setKey] = useState(newKey);
  const [validated, setValidated] = useState<{ input: FleetOperationRequest; receipt: FleetOperationPreview }>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [inventoryNotice, setInventoryNotice] = useState<string>();
  const [typedAlias, setTypedAlias] = useState('');
  const previousRevision = useRef(snapshot.revision);
  const flow = useAgentLifecycle(open, target, () => { void reloadSnapshot(); });
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const dirty = useRef(false);
  const currentFingerprint = useRef('');
  const canWrite = !sessionInvalid && !access.loading && !access.error && access.data?.permissions?.includes('config.write') === true;
  const available = flow.capability?.available === true && flow.capability.actions.includes(kind);
  const scopeGap = kind === 'create' ? undefined : fleetScopeGap(snapshot, target);
  const draftKind = kind === 'create' || kind === 'update';
  const prepared = draftKind ? agentLifecycleRequest(draft, snapshot, flow.capability, kind, key, target)
    : simpleRequest();
  const input = prepared.request;
  currentFingerprint.current = JSON.stringify(input);
  const samePreview = !!input && !!validated && JSON.stringify(input) === JSON.stringify(validated.input);
  const guidedKind: 'create' | 'update' = draftAgent ? 'create' : 'update';
  const guidedPrepared = target?.resource === 'agent'
    ? agentLifecycleRequest(draft, snapshot, flow.capability, guidedKind, key, target)
    : { error: 'El camino guiado solo recrea agentes.' };
  const guided = useGuidedRecreate({
    client: api, operation: flow.operation,
    buildRequest: () => guidedPrepared.request ? { request: guidedPrepared.request } : { error: guidedPrepared.error },
    accept: (operation) => flow.accept(operation),
    translateError: (message) => translateFleetOperationError(message, draft.primaryRoomId) ?? fleetErrorText(message, flow.operation, guidedKind),
  });
  const driftGuided = isGuidedDrift(flow.operation);
  const busy = sending || flow.busy || guided.busy;
  const inProgress = !!flow.operation && ['queued', 'running', 'awaiting_auth', 'cancelling'].includes(flow.operation.status);
  const blocked = !!blockingOperation(flow.operation, kind);
  const aliasConfirmed = kind !== 'purge' || target?.resource !== 'agent' || typedAlias === target.alias;
  const confirmationTarget = target?.resource === 'agent' ? JSON.stringify([target.tenant_id, target.alias]) : '';
  useEffect(() => {
    generation.current += 1; setValidated(undefined); setKey(newKey()); setTypedAlias('');
  }, [open, kind, confirmationTarget]);
  useEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (previousRevision.current === snapshot.revision) return;
    previousRevision.current = snapshot.revision; generation.current += 1; setValidated(undefined); setKey(newKey()); setTypedAlias('');
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
    const parameters = kind === 'purge' && target.resource === 'agent' ? { confirm_alias: typedAlias } : {};
    const result = FleetOperationSubmissionSchema.safeParse({ kind, target, parameters, expected_revision: snapshot.revision, idempotency_key: key });
    return result.success ? { request: result.data } : { error: 'Falta una identidad o revisión durable válida.' };
  }
  function edit(patch: Partial<AgentLifecycleDraft>) {
    generation.current += 1; dirty.current = true; onDirtyChange?.(true); setDraft((previous) => ({ ...previous, ...patch }));
    setKey(newKey()); setValidated(undefined); setError(undefined);
  }
  async function preview() {
    if (!canWrite || !available || busy || inProgress || blocked || scopeGap) return;
    if (!input) { setError(prepared.error); return; }
    const expected = JSON.stringify(input);
    const sequence = ++generation.current;
    setSending(true); setPreviewing(true); setError(undefined); setValidated(undefined);
    try {
      const receipt = await api.previewFleetOperation(input);
      if (sequence === generation.current && expected === currentFingerprint.current) setValidated({ input, receipt });
    } catch (cause) { if (sequence === generation.current) setError(cause instanceof Error ? (translateFleetOperationError(cause.message, draft.primaryRoomId) ?? fleetErrorText(cause.message, flow.operation, kind)) : 'No se pudo previsualizar la operación.'); }
    finally { setSending(false); setPreviewing(false); }
  }
  async function enqueue() {
    if (!canWrite || !available || busy || inProgress || blocked || !samePreview || !validated.receipt.can_apply || !aliasConfirmed) return;
    const sequence = ++generation.current;
    setSending(true); setError(undefined);
    try {
      const operation = await api.enqueueFleetOperation(validated.input);
      if (sequence === generation.current) { flow.accept(operation); setValidated(undefined); setKey(newKey()); setTypedAlias(''); onDirtyChange?.(false); }
    } catch (cause) {
      if (sequence === generation.current) setError(cause instanceof Error ? (translateFleetOperationError(cause.message, draft.primaryRoomId) ?? fleetErrorText(cause.message, flow.operation, kind)) : 'No se pudo confirmar el encolado. Reintenta con la misma solicitud.');
    } finally { setSending(false); }
  }
  async function revalidate() {
    const result = await access.reload();
    if (result.data) { setSessionInvalid(false); setError(undefined); if (!embedded) setOpen(false); onClose?.(); }
    else setError('No se pudo acreditar la sesión actual. Reintenta la lectura de permisos.');
  }
  async function reloadSnapshot() {
    if (!onReloaded) return undefined;
    try { onReloaded(await api.getConfiguration()); return undefined; }
    catch {
      const error = new Error('No se pudo releer el inventario. El recibo operativo se conserva.');
      setError(error.message);
      return { error };
    }
  }
  const purgeAlias = target?.resource === 'agent' ? target.alias : '';
  const previewBlock = !canWrite ? 'No se acreditó permiso para operar agentes desde esta cuenta.' : scopeGap ?? (
    !available ? `Esta acción no está disponible: ${fleetCapabilityReasonText(flow.capability?.reason)}.`
      : blocked ? blockingText(flow.operation, kind)
        : inProgress ? 'Hay una operación en ejecución. Espera a que termine o cancélala desde el panel de la operación.'
          : busy ? 'Espera a que termine la operación en curso.'
            : !aliasConfirmed ? `Escribe el alias ${purgeAlias} para confirmar.` : undefined);
  const enqueueBlock = previewBlock ?? (!samePreview ? 'Previsualiza la operación para poder encolarla.'
    : !validated.receipt.can_apply ? 'La previsualización no permite aplicar esta operación. Revisa los motivos de la previsualización.' : undefined);
  return <div className="agent-lifecycle-panel" data-open={String(open)}>
    {hideTrigger ? null : <Button ref={trigger}
      onClick={() => { setOpen((value) => !value); }} aria-expanded={open}
      aria-label={triggerLabel ?? (target?.resource === 'agent' ? `Operar agente ${target.tenant_id}/${target.alias}` : 'Preparar agente')}>
      {triggerLabel ?? (target ? 'Operar agente' : 'Preparar agente')}
    </Button>}
    {open ? <section className="settings-context" aria-label={target?.resource === 'agent' ? `Operación de ${target.tenant_id}/${target.alias}` : 'Alta operativa de agente'}>
      <div className="settings-context-heading"><h3 ref={heading} tabIndex={-1}>{target ? 'Ejecución y ciclo de vida' : 'Preparar nuevo agente'}</h3>
        {embedded ? null : <Button onClick={() => { setOpen(false); trigger.current?.focus(); onClose?.(); }}>Cerrar operaciones</Button>}
      </div>
      {flow.operation && needsAttention(flow.operation) ? <div className="notice grid gap-1" role="status" aria-label="Operación en curso">
        <span className="flex flex-wrap items-center gap-2"><OperationStatusPill operation={flow.operation} /><strong className="text-sm">{operationTitle(flow.operation)}</strong></span>
        <span className="text-sm">{driftGuided ? guidedDriftHeadline() : operationHeadline(flow.operation)}</span>
      </div> : null}
      {fixedKind ? null : <p>Preparar no exige una ejecución activa. La operación guarda su intención y acredita cada paso antes de admitir entregas.</p>}
      {agent ? <p>{typeof agent.lifecycle_state === 'string'
        ? <span title={agent.lifecycle_state}>Estado del agente: {lifecycleLabel(agent.lifecycle_state)}.</span>
        : 'Estado del agente sin publicar en esta lectura.'}</p> : null}
      {!canWrite ? <p className="notice">No se acreditó permiso para operar agentes desde esta cuenta.</p> : null}
      {sessionInvalid ? <Button onClick={() => { void revalidate(); }}>Revalidar sesión y cerrar borrador</Button> : null}
      {!flow.capability && !flow.capabilityError ? <p role="status">Leyendo capacidades de flota…</p> : null}
      {inventoryNotice ? <p className="notice" role="note">{inventoryNotice}</p> : null}
      {draftKind && flow.capability?.available && !flow.capability.placements.length ? <p className="notice">El ejecutor no publicó hosts permitidos para preparar agentes.</p> : null}
      {flow.capabilityError ? <p className="notice">{flow.capabilityError}</p> : null}
      {scopeGap ? <p className="notice" role="note">{scopeGap}</p> : null}
      {flow.capability && !available ? <p className="notice">Esta acción no está disponible en el ejecutor publicado: {fleetCapabilityReasonText(flow.capability.reason)}.</p> : null}
      {target && !fixedKind ? <label>Acción operativa<select value={kind} disabled={busy || inProgress} onChange={(event) => {
        setKind(event.target.value as Kind); setKey(newKey()); setValidated(undefined); setError(undefined); generation.current += 1;
      }}>{Object.entries(ACTION_LABELS).filter(([action]) => (action === 'create') === draftAgent).map(([action, label]) =>
        <option key={action} value={action}>{label}</option>)}</select></label> : null}
      {draftKind ? <AgentLifecycleFields draft={draft} snapshot={snapshot} capability={flow.capability} target={target}
        disabled={busy || inProgress || !canWrite || !available} edit={edit} /> : null}
      {kind === 'purge' ? <p className="notice">La purga elimina el registro retirado. El servidor exige ausencia de dependencias antes de aplicar.</p> : null}
      {kind === 'purge' && target?.resource === 'agent' ? <section aria-label="Recursos que se borrarán" className="grid gap-2">
        <p className="m-0">Escribe el alias y previsualiza la operación: el servidor lista los recursos físicos que la purga va a tocar. No se puede deshacer.</p>
        <p className="m-0"><a href={`/messages/${encodeURIComponent(target.tenant_id)}/${encodeURIComponent(target.alias)}?view=context`}>Descargar copia</a>
          {' '}del espacio antes de purgar.</p>
        <label>Escribe el alias <code>{target.alias}</code> para confirmar
          <input value={typedAlias} autoComplete="off" onChange={(event) => {
            generation.current += 1; setValidated(undefined); setKey(newKey()); setTypedAlias(event.target.value);
          }} /></label>
      </section> : null}
      {driftGuided ? <p className="notice" role="note">El contenedor quedó desfasado. Usa «Recrear contenedor e iniciar sesión» en la operación de abajo: cancela la operación anterior, reprepara el agente con la intención de arriba y abre el inicio de sesión en un solo camino.</p> : <>
        <div className="flex flex-wrap items-center gap-2"><Button disabled={busy || inProgress || blocked || !canWrite || !available || !aliasConfirmed || !!scopeGap} title={previewBlock}
          aria-busy={previewing} onClick={() => { void preview(); }}>{previewing ? 'Previsualizando…' : 'Previsualizar operación'}</Button>
          <Button variant="primary" disabled={busy || inProgress || blocked || !canWrite || !available || !samePreview || !validated.receipt.can_apply || !aliasConfirmed || !!scopeGap} title={enqueueBlock}
            onClick={() => { void enqueue(); }}>Encolar operación</Button></div>
        {!samePreview && !blocked && !previewing ? <p className="m-0 text-xs text-muted">Previsualiza la operación para poder encolarla.</p> : null}
      </>}
      {error ? (isPrimaryMembershipError(error)
        ? <p className="notice" role="alert"><Button onClick={() => { focusPrimaryMembershipCheckbox(); }}>{error} Ir a la casilla «Habilitar membresía».</Button></p>
        : <p className="notice" role="alert">{error}</p>) : null}
      {samePreview ? <><AgentFleetPreview preview={validated.receipt} />
        <details><summary>Detalles técnicos de la solicitud</summary><pre>{JSON.stringify(validated.input, null, 2)}</pre></details></> : null}
      {flow.operation ? <><AgentFleetOperation operation={flow.operation} busy={busy} current={!flow.readError && canWrite && !!flow.capability?.available}
        onAuthRefreshed={flow.accept} intended={kind} stale={flow.stale} hostId={draft.hostId || undefined}
        guided={{ state: guided.state, onStart: guided.start, onRetry: guided.retry }}
        control={(action) => { void flow.control(action); }} />
        {flow.readError ? <p className="notice" role="alert">{flow.readError}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton size="sm" variant="ghost" className="underline underline-offset-2" label="Releer operación" disabled={busy} announceError={false} action={() => flow.refresh()} />
          {onReloaded ? <ActionButton size="sm" variant="ghost" className="underline underline-offset-2" label="Releer inventario" announceError={false} action={() => reloadSnapshot()} /> : null}
        </div></> : null}
      <details><summary>Historial de operaciones</summary>
        {flow.historyError ? <p className="notice">{flow.historyError}</p> : null}
        {flow.history?.length ? (() => {
          const { attention, finished } = partitionOperations(flow.history);
          const row = (operation: (typeof flow.history)[number]) => <li key={operation.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line p-3">
            <OperationLine operation={operation} />
            <Button size="sm" aria-label={`Ver detalle de ${operationTitle(operation)}`}
              disabled={busy} onClick={() => { flow.accept(operation); }}>Ver</Button>
          </li>;
          return <div className="grid gap-2">
            {attention.length ? <ul className="m-0 grid list-none gap-2 p-0">{attention.map(row)}</ul> : null}
            {finished.length ? <details><summary className="cursor-pointer text-sm">Terminadas ({finished.length})</summary>
              <ul className="m-0 mt-2 grid list-none gap-2 p-0">{finished.map(row)}</ul></details> : null}
          </div>;
        })()
          : <p>{target ? 'Todavía no hay operaciones para este agente.' : 'El historial de este agente se podrá ver desde su registro guardado.'}</p>}
      </details>
    </section> : null}
  </div>;
}
