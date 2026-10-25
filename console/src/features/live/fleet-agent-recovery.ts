import { FleetOperationSchema, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { type NativeRuntimeIdentity, type AgentSessionOutcome } from '@cauce/protocol/native-admin';
import { fleetRequestHash, type FleetOperationsClient } from '../../api/client/fleet-operations-client';

export interface FleetRecoveryTarget { tenant_id: string; alias: string }
export interface FleetRecoveryPreview {
  identity: NativeRuntimeIdentity;
  session: AgentSessionOutcome;
  in_flight: number;
  expected_revision: number;
}
type Parameters = Extract<FleetOperationRequest, { kind: 'recover' }>['parameters'];
const uncertain = (id: string) => new Error(`La operación ${id} sigue registrada. Consulta su historial antes de intentar otro reinicio.`);

function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new Error('Se interrumpió la consulta. Revisa el historial antes de reintentar.')); };
    const timer = setTimeout(() => { finish(); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function exact(value: FleetOperation, input: FleetOperationRequest, hash: string, previous?: FleetOperation) {
  const operation = FleetOperationSchema.parse(value);
  if (operation.kind !== 'recover' || operation.target.resource !== 'agent' || input.target.resource !== 'agent'
    || operation.target.tenant_id !== input.target.tenant_id || operation.target.alias !== input.target.alias
    || operation.expected_revision !== input.expected_revision || operation.request_sha256 !== hash
    || previous && (operation.id !== previous.id || operation.version < previous.version
      || JSON.stringify(operation.actor) !== JSON.stringify(previous.actor) || operation.created_at !== previous.created_at
      || operation.version === previous.version && JSON.stringify(operation) !== JSON.stringify(previous))) {
    throw new Error('El recibo no acredita esta recuperación ni su conversación.');
  }
  return operation;
}

export async function executeFleetRecovery(api: FleetOperationsClient, target: FleetRecoveryTarget, revision: number,
  parameters: Parameters, signal: AbortSignal): Promise<FleetRecoveryPreview> {
  const input: FleetOperationRequest = { kind: 'recover', target: { resource: 'agent', ...target }, parameters,
    expected_revision: revision, idempotency_key: `recover_${crypto.randomUUID()}` };
  signal.throwIfAborted();
  const hash = await fleetRequestHash(input);
  signal.throwIfAborted();
  const plan = await api.previewFleetOperation(input);
  if (!plan.can_apply || plan.request_sha256 !== hash || plan.kind !== input.kind || plan.expected_revision !== revision
    || plan.target.resource !== 'agent' || plan.target.tenant_id !== target.tenant_id || plan.target.alias !== target.alias) {
    throw new Error('La consulta previa no acredita esta recuperación.');
  }
  signal.throwIfAborted();
  let operation = exact(await api.enqueueFleetOperation(input), input, hash);
  const deadline = Date.now() + 120_000;
  while (operation.status === 'queued' || operation.status === 'running') {
    if (Date.now() >= deadline) throw uncertain(operation.id);
    await pause(signal);
    operation = exact(await api.getFleetOperation(operation.id), input, hash, operation);
  }
  signal.throwIfAborted();
  const runtime = operation.steps.find(step => step.name === 'runtime')?.evidence;
  const verified = operation.steps.find(step => step.name === 'verify')?.evidence;
  const recovery = verified?.recovery;
  if (operation.status !== 'succeeded' || operation.error || !operation.steps.length
    || operation.steps.some(step => step.status !== 'succeeded') || operation.applied_revision === null
    || operation.applied_revision !== operation.desired_revision || operation.applied_revision < revision
    || !runtime?.runtime_digest || runtime.runtime_digest !== verified?.runtime_digest || !recovery
    || JSON.stringify(runtime.recovery) !== JSON.stringify(recovery)) {
    throw uncertain(operation.id);
  }
  if (parameters.action === 'apply' && (JSON.stringify(recovery.identity) !== JSON.stringify(parameters.identity)
    || recovery.session.fingerprint !== parameters.expected_fingerprint || !recovery.session.resumable
    || !['resumed', 'recreated'].includes(recovery.session.state))) throw uncertain(operation.id);
  return { identity: recovery.identity, session: recovery.session, in_flight: 0, expected_revision: operation.applied_revision };
}
