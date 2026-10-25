import { type FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { FleetRecoveryReasonSchema, type FleetRecoveryReason } from '@cauce/protocol/fleet-recovery';
import { ConsoleFleetOperationSchema as FleetOperationSchema, type ConsoleFleetOperation as FleetOperation } from '@cauce/protocol/console-fleet-operation';
import { type NativeRuntimeIdentity, type AgentSessionOutcome } from '@cauce/protocol/native-admin';
import { fleetRequestHash, type FleetOperationsClient } from '../../api/client/fleet-operations-client';
import { isUnresolved, operationErrorHuman, STEPS } from '../config/fleet-operation-text';
import { recoveryProblem } from './recovery-problem';

export interface FleetRecoveryTarget { tenant_id: string; alias: string }
export interface FleetRecoveryPreview {
  identity: NativeRuntimeIdentity;
  session: AgentSessionOutcome;
  in_flight: number;
  expected_revision: number;
}
type Parameters = Extract<FleetOperationRequest, { kind: 'recover' }>['parameters'];
const uncertain = (id: string) => new Error(`No se ha confirmado el resultado de la operación ${id}. Consulta su historial antes de intentar otro reinicio.`);

export class FleetRecoveryFailure extends Error {
  constructor(message: string, readonly reason?: FleetRecoveryReason) {
    super(message);
  }
}

function terminalFailure(operation: FleetOperation): Error | undefined {
  if (operation.status === 'failed') {
    const reason = FleetRecoveryReasonSchema.safeParse(operation.error?.reason);
    if (reason.success) {
      const problem = recoveryProblem(reason.data);
      return new FleetRecoveryFailure(`El reinicio falló. ${problem.reason}`, reason.data);
    }
    const cause = operation.error ? operationErrorHuman(operation.error).message : 'El ejecutor no pudo completar el reinicio.';
    const step = operation.error?.step;
    return new Error(`El reinicio falló${step ? ` en «${STEPS[step]}»` : ''}. ${cause} Vuelve a comprobar el estado para conocer la acción disponible.`);
  }
  if (operation.status === 'cancelled') return new Error('El reinicio se canceló. Vuelve a comprobar el estado antes de intentarlo otra vez.');
  if (operation.status === 'awaiting_auth') return new Error('El reinicio necesita completar la autenticación. Abre su operación en el historial para continuar.');
  return undefined;
}

export async function unresolvedFleetRecovery(api: FleetOperationsClient, target: FleetRecoveryTarget): Promise<FleetOperation | undefined> {
  const operations = await api.listFleetOperations({ resource: 'agent', ...target });
  for (const row of operations) {
    const operation = FleetOperationSchema.parse(row);
    if (operation.target.resource !== 'agent' || operation.target.tenant_id !== target.tenant_id || operation.target.alias !== target.alias) {
      throw new Error('El historial no acredita las operaciones de este agente.');
    }
  }
  return operations.find(isUnresolved);
}

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
      || JSON.stringify([operation.actor.tenant_id, operation.actor.alias, operation.actor.actor_subject])
        !== JSON.stringify([previous.actor.tenant_id, previous.actor.alias, previous.actor.actor_subject]) || operation.created_at !== previous.created_at
      || operation.version === previous.version && JSON.stringify({ ...operation, actor: previous.actor }) !== JSON.stringify(previous))) {
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
  const failure = terminalFailure(operation);
  if (failure) throw failure;
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
