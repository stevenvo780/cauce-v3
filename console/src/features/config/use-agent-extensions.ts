import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentExtensionsSchema } from '@cauce/protocol/agent-extensions';
import {
  FleetOperationRequestSchema, type FleetOperation, type FleetOperationPreview,
  type FleetOperationRequest, type FleetTarget,
} from '@cauce/protocol/fleet-operation';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { ApiError } from '../../api/client/core';
import type { ConfigurationSnapshot } from '../../api/types';
import type { AgentExtension } from './ampliaciones';
import { agentLifecycleDraft, agentLifecycleRequest, fleetScopeGap } from './agent-lifecycle-model';
import { blockingText, fleetErrorText, isUnresolved, operationSummary } from './fleet-operation-text';
import { useAgentLifecycle } from './use-agent-lifecycle';

type AgentTarget = Extract<FleetTarget, { resource: 'agent' }>;
type ExtensionRequest = Extract<FleetOperationRequest, { kind: 'create' | 'update' }>;
interface Options {
  snapshot: ConfigurationSnapshot; target: AgentTarget;
  extensions: readonly AgentExtension[]; known: readonly AgentExtension[]; dirty: boolean;
  fullControlConfirmed?: boolean;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onApplied: (operation: FleetOperation) => void;
}
interface Validated {
  input: ExtensionRequest; receipt: FleetOperationPreview; fingerprint: string;
}
interface Submission {
  input: ExtensionRequest; requestHash: string; extensionsHash: string;
  draft: string; scope: string; epoch: number; uncertain: boolean; operationId?: string;
}
const newKey = () => `fleet_${crypto.randomUUID()}`;
const sameTarget = (operation: FleetOperation, target: AgentTarget) => operation.target.resource === 'agent'
  && operation.target.tenant_id === target.tenant_id && operation.target.alias === target.alias;
const terminal = (operation: FleetOperation) => ['succeeded', 'failed', 'cancelled'].includes(operation.status);

export function useAgentExtensions(options: Options) {
  const { snapshot, target, extensions, known, dirty, fullControlConfirmed } = options;
  const api = useApi();
  const access = useConsoleAccess();
  const flow = useAgentLifecycle(true, target);
  const [key, setKey] = useState(newKey);
  const [validated, setValidated] = useState<Validated>();
  const [submission, setSubmission] = useState<Submission>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [hashes, setHashes] = useState<{ identity: string; draft: string; saved: string }>();
  const epoch = useRef(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const reloadInFlight = useRef(false);
  const submitted = useRef<Submission | undefined>(undefined);
  const seenTerminal = useRef('');
  const scope = JSON.stringify([target.tenant_id, target.alias]);
  const draft = JSON.stringify(extensions);
  const fingerprint = JSON.stringify([scope, snapshot.revision, agentLifecycleDraft(snapshot, target), extensions, dirty]);
  const hashIdentity = JSON.stringify([scope, extensions, known]);
  const latest = useRef({ ...options, scope, draft, fingerprint });
  latest.current = { ...options, scope, draft, fingerprint };
  const lifecycle = useRef(flow);
  lifecycle.current = flow;
  const operation = flow.operation && sameTarget(flow.operation, target) ? flow.operation : undefined;
  const unresolved = [operation, ...(flow.history ?? []).filter(item => sameTarget(item, target))].find(isUnresolved);
  const canWrite = !sessionInvalid && !access.loading && !access.error && access.data?.permissions?.includes('config.write') === true;
  const available = flow.capability?.available === true && flow.capability.actions.includes('update');
  const base = agentLifecycleRequest(agentLifecycleDraft(snapshot, target), snapshot, flow.capability, 'update', key, target);
  const parsed = base.request?.kind === 'update' ? FleetOperationRequestSchema.safeParse({ ...base.request,
    parameters: { ...base.request.parameters, extensions } }) : undefined;
  const input = parsed?.success && parsed.data.kind === 'update' ? parsed.data : undefined;
  const inputError = base.error ?? (!input ? 'Las ampliaciones no cumplen el contrato de esta ejecución.' : undefined);
  const scopeGap = fleetScopeGap(snapshot, target);
  const confirmationRequired = extensions.some(item => item.type === 'full_control') && fullControlConfirmed !== true;
  const samePreview = !!validated && validated.fingerprint === fingerprint
    && JSON.stringify(validated.input) === JSON.stringify(input);
  const busy = sending || previewing || reloading || flow.busy || !!unresolved || !!submission;
  const previewBlock = !canWrite ? 'No se acreditó permiso actual para cambiar la ejecución del agente.'
    : !available ? 'El servidor no acredita la actualización operativa de este agente.'
      : flow.history === undefined || flow.historyError || flow.readError ? 'Relee el historial operativo antes de enviar cambios.'
        : unresolved ? blockingText(unresolved, 'update')
          : submission ? 'La solicitud enviada conserva su recibo; resuélvela antes de preparar otra.'
            : busy ? 'Espera a que termine la operación en curso.'
              : scopeGap ?? (confirmationRequired ? 'Escribe el alias para confirmar el control total.'
                : !dirty ? 'Prepara un cambio de ampliaciones antes de previsualizar.' : inputError);
  const canRetry = canWrite && available && !sending && !previewing && !reloading && !flow.busy
    && submission?.uncertain === true && submission.scope === scope && submission.epoch === epoch.current
    && (!unresolved || unresolved.request_sha256 === submission.requestHash);
  const canPreview = previewBlock === undefined && !!input;
  const canEnqueue = canRetry || (canPreview && samePreview && validated.receipt.can_apply);

  const clear = useCallback(() => {
    sequence.current += 1;
    setValidated(undefined); setError(undefined);
    if (!submitted.current) setKey(newKey());
  }, []);
  useEffect(clear, [clear, fingerprint]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; epoch.current += 1; };
  }, []);
  useEffect(() => api.onAuthGenerationChange(() => {
    epoch.current += 1; clear(); setSessionInvalid(true);
    setError('La sesión cambió. Cierra y vuelve a abrir las ampliaciones para releer permisos y capacidades.');
  }), [api, clear]);
  useEffect(() => {
    let active = true;
    const value: unknown = JSON.parse(hashIdentity);
    const rows: unknown[] = Array.isArray(value) ? value : [];
    const saved = AgentExtensionsSchema.safeParse(rows[2]);
    const proposed = AgentExtensionsSchema.safeParse(rows[1]);
    if (saved.success && proposed.success) void Promise.all([fleetRequestHash(proposed.data), fleetRequestHash(saved.data)])
      .then(([draftHash, savedHash]) => { if (active) setHashes({ identity: hashIdentity, draft: draftHash, saved: savedHash }); })
      .catch(() => { if (active) setHashes(undefined); });
    return () => { active = false; };
  }, [hashIdentity]);

  const reload = useCallback(async (observed?: FleetOperation) => {
    if (reloadInFlight.current) return;
    const expectedScope = latest.current.scope;
    const expectedEpoch = epoch.current;
    const current = () => mounted.current && expectedScope === latest.current.scope && expectedEpoch === epoch.current;
    reloadInFlight.current = true; setReloading(true);
    try {
      const fresh = await api.getConfiguration();
      if (!current()) return;
      latest.current.onReloaded(fresh);
      const sent = submitted.current;
      if (!observed || sent?.scope !== expectedScope || sent.epoch !== expectedEpoch
        || observed.request_sha256 !== sent.requestHash || (sent.operationId && observed.id !== sent.operationId)) return;
      if (observed.status === 'failed') { setError(operationSummary(observed)); return; }
      if (observed.status === 'cancelled') {
        submitted.current = undefined; setSubmission(undefined); clear();
        return;
      }
      if (observed.status !== 'succeeded') return;
      const row = fresh.agents?.find(item => item.tenant_id === sent.input.target.tenant_id && item.alias === sent.input.target.alias);
      const saved = AgentExtensionsSchema.safeParse(row?.extensions);
      if (observed.applied_revision === null || !Number.isSafeInteger(fresh.revision)
        || Number(fresh.revision) < observed.applied_revision || !saved.success
        || await fleetRequestHash(saved.data) !== sent.extensionsHash) {
        throw new Error('La operación terminó, pero la relectura no acredita las ampliaciones aplicadas. Se conserva el borrador.');
      }
      if (!current()) return;
      submitted.current = undefined; setSubmission(undefined); clear();
      if (latest.current.draft === sent.draft) latest.current.onApplied(observed);
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : 'No se pudo releer el inventario. Se conserva el borrador.');
      }
    } finally {
      reloadInFlight.current = false;
      if (mounted.current) setReloading(false);
    }
  }, [api, clear]);
  useEffect(() => {
    if (!operation || !terminal(operation) || reloading) return;
    const identity = `${scope}:${String(epoch.current)}:${operation.id}:${String(operation.version)}`;
    if (seenTerminal.current === identity) return;
    seenTerminal.current = identity;
    void reload(operation);
  }, [operation, reload, reloading, scope]);
  useEffect(() => {
    const sent = submitted.current;
    if (!sent?.uncertain || sent.scope !== scope || sent.epoch !== epoch.current) return;
    const recovered = flow.history?.find(item => sameTarget(item, target) && item.request_sha256 === sent.requestHash);
    if (!recovered) return;
    const accepted = { ...sent, uncertain: false, operationId: recovered.id };
    submitted.current = accepted; setSubmission(accepted); setValidated(undefined);
    lifecycle.current.accept(recovered);
  }, [flow.history, scope, target]);

  async function preview() {
    if (!canPreview || inFlight.current) return;
    const read = ++sequence.current;
    const expectedEpoch = epoch.current;
    inFlight.current = true; setPreviewing(true); setError(undefined); setValidated(undefined);
    try {
      const receipt = await api.previewFleetOperation(input);
      if (mounted.current && read === sequence.current && expectedEpoch === epoch.current
        && latest.current.fingerprint === fingerprint) setValidated({ input, receipt, fingerprint });
    } catch (cause) {
      if (mounted.current && read === sequence.current && expectedEpoch === epoch.current && latest.current.fingerprint === fingerprint) {
        setError(cause instanceof Error ? fleetErrorText(cause.message, operation, 'update') : 'No se pudo previsualizar la actualización.');
      }
    } finally { inFlight.current = false; if (mounted.current) setPreviewing(false); }
  }
  async function enqueue() {
    if (!canEnqueue || inFlight.current) return;
    const read = sequence.current;
    const expectedEpoch = epoch.current;
    inFlight.current = true; setSending(true); setError(undefined);
    try {
      let sent = submitted.current;
      if (!sent) {
        if (!validated || !samePreview || !validated.receipt.can_apply) return;
        const extensionsHash = await fleetRequestHash(validated.input.parameters.extensions ?? []);
        if (!mounted.current || read !== sequence.current || expectedEpoch !== epoch.current || latest.current.fingerprint !== fingerprint) return;
        sent = { input: validated.input, requestHash: validated.receipt.request_sha256, extensionsHash,
          draft, scope, epoch: expectedEpoch, uncertain: true };
        submitted.current = sent; setSubmission(sent);
      }
      const recovered = lifecycle.current.history?.find(item => sameTarget(item, target) && item.request_sha256 === sent.requestHash);
      const receipt = recovered ?? await api.enqueueFleetOperation(sent.input);
      if (!mounted.current || expectedEpoch !== epoch.current || latest.current.scope !== sent.scope) return;
      if (!lifecycle.current.accept(receipt)) throw new Error('El seguimiento rechazó el recibo. Relee la operación antes de continuar.');
      const accepted = { ...sent, uncertain: false, operationId: receipt.id };
      submitted.current = accepted; setSubmission(accepted); setValidated(undefined);
      if (latest.current.draft !== sent.draft) setError('El borrador cambió mientras se enviaba. La operación conserva su intención original.');
    } catch (cause) {
      if (mounted.current && expectedEpoch === epoch.current && latest.current.scope === scope) {
        if (cause instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(cause.status)
          && cause.code !== 'session_changed') {
          submitted.current = undefined; setSubmission(undefined); setValidated(undefined); setKey(newKey());
        }
        setError(cause instanceof Error ? fleetErrorText(cause.message, operation, 'update')
          : 'No se confirmó el encolado. Reintenta exactamente la solicitud conservada.');
      }
    } finally { inFlight.current = false; if (mounted.current) setSending(false); }
  }

  const savedHash = !sessionInvalid && hashes?.identity === hashIdentity && hashes.draft === hashes.saved ? hashes.saved : undefined;
  const receipts = [operation, ...(flow.history ?? [])].filter((item): item is FleetOperation => !!item
    && sameTarget(item, target) && item.status === 'succeeded').sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const sshReceipt = savedHash ? receipts.flatMap(item => item.steps.flatMap(step => {
    const receipt = step.evidence?.extensions_receipt;
    return step.status === 'succeeded' && (step.name === 'runtime' || step.name === 'admission')
      && receipt?.extensions_sha256 === savedHash && receipt.ssh ? [{ ...receipt.ssh, operationId: item.id }] : [];
  })).at(0) : undefined;
  return {
    previewReceipt: samePreview ? validated.receipt : undefined,
    request: samePreview ? validated.input : undefined,
    submittedRequest: submission?.input,
    error: error ?? flow.readError ?? flow.historyError ?? flow.capabilityError
      ?? (operation?.status === 'failed' ? operationSummary(operation) : undefined),
    canWrite, available, busy, previewing, sending, reloading, sessionInvalid, canPreview, canEnqueue, canRetry,
    previewBlock, enqueueBlock: canEnqueue ? undefined : previewBlock ?? 'Previsualiza exactamente este borrador antes de aplicar.',
    flow, sshPublic: sshReceipt, preview, enqueue, clear, reload: () => reload(operation),
  };
}
