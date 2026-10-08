import { FleetOperationRequestSchema, FleetOperationSchema, FleetPlacementSchema, RuntimeKeySchema,
  type FleetCapability, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { fleetRequestHash, type FleetOperationsClient } from '../../api/client/fleet-operations-client';
import type { NativeAdminClient } from './native-admin/client';
import { NativeRuntimeIdentitySchema } from '@cauce/protocol/native-admin';

export interface NativeReloadTarget { resource: 'agent'; tenant_id: string; alias: string }
type ReloadClient = FleetOperationsClient & Pick<NativeAdminClient, 'readNativePieces'>;
const unavailable = () => new Error('No se acreditó autoridad, capacidad o identidad física para reiniciar este agente.');
const interrupted = () => new Error('Se interrumpió la verificación. Consulta el historial durable antes de reintentar; una operación enviada puede continuar.');

export function nativeReloadBinding(snapshot: ConfigurationSnapshot, capability: FleetCapability, target: NativeReloadTarget, running: boolean) {
  if (snapshot.capabilities?.actor.can_control !== true || !Number.isSafeInteger(snapshot.revision)
    || Number(snapshot.revision) < 0 || !capability.available || !capability.actions.includes('stop') || !capability.actions.includes('start')) return undefined;
  const rows = snapshot.agents?.filter(row => row.tenant_id === target.tenant_id && row.alias === target.alias);
  const row = rows?.length === 1 ? rows[0] : undefined;
  if (row?.enabled !== running || row.retired_at != null || typeof row.harness_id !== 'string'
    || typeof row.primary_account_id !== 'string' || !row.primary_account_id) return undefined;
  const key = RuntimeKeySchema.safeParse(row.runtime_key);
  const source = row.placement && typeof row.placement === 'object' && !Array.isArray(row.placement)
    ? row.placement as Record<string, unknown> : row;
  const parsed = FleetPlacementSchema.safeParse({ host_id: source.host_id, mode: source.mode ?? source.runtime_mode,
    runtime_user: source.runtime_user, home_directory: source.home_directory, state_directory: source.state_directory,
    ...(source.container_name != null ? { container_name: source.container_name } : {}),
    ...(source.systemd_user != null ? { systemd_user: source.systemd_user } : {}) });
  if (!key.success || !parsed.success) return undefined;
  const placement = parsed.data;
  const host = capability.placements.find(value => value.host_id === placement.host_id);
  if (!host?.modes.includes(placement.mode) || !host.runtime_users.includes(placement.runtime_user)
    || (placement.systemd_user && !host.systemd_users.includes(placement.systemd_user))
    || !host.home_roots.includes(placement.home_directory)
    || !host.state_roots.some(root => placement.state_directory === `${root.replace(/\/$/u, '')}/${key.data}`)) return undefined;
  const runtime = host.runtimes?.find(value => value.mode === placement.mode && value.harness_id === row.harness_id
    && value.runtime_user === placement.runtime_user && (value.systemd_user ?? null) === (placement.systemd_user ?? null)
    && value.home_directory === placement.home_directory
    && placement.state_directory === `${value.state_root.replace(/\/$/u, '')}/${key.data}`
    && (value.mode !== 'container' || placement.container_name === (value.container_name ?? `${value.container_prefix ?? ''}${key.data}`))
    && (row.reasoning_effort == null || value.reasoning_efforts?.includes(row.reasoning_effort as never) === true));
  if (!runtime) return undefined;
  return { runtime_key: key.data, harness_id: row.harness_id, placement,
    primary_account_id: row.primary_account_id, model_id: row.model_id ?? null, reasoning_effort: row.reasoning_effort ?? null };
}

function bounded<T>(load: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted());
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('Se agotó el plazo de verificación. Consulta el historial durable antes de reintentar.'));
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); settle(); };
    const abort = () => { finish(() => { reject(interrupted()); }); };
    const timer = setTimeout(() => { finish(() => { reject(new Error('Se agotó el plazo de verificación. Consulta el historial durable antes de reintentar.')); }); }, remaining);
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return load(); }).then(
      value => { finish(() => { resolve(value); }); }, (cause: unknown) => { finish(() => { reject(cause instanceof Error ? cause : new Error('No se acreditó la operación de reinicio.')); }); });
  });
}
function pause(milliseconds: number, signal: AbortSignal, deadline: number) {
  return bounded(() => new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(interrupted()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(milliseconds, Math.max(0, deadline - Date.now())));
    signal.addEventListener('abort', abort, { once: true });
  }), signal, deadline);
}
function exactOperation(value: FleetOperation, request: FleetOperationRequest, hash: string, previous?: FleetOperation) {
  const parsed = FleetOperationSchema.safeParse(value);
  if (!parsed.success || value.target.resource !== 'agent' || request.target.resource !== 'agent'
    || value.target.tenant_id !== request.target.tenant_id || value.target.alias !== request.target.alias
    || value.kind !== request.kind || value.expected_revision !== request.expected_revision || value.request_sha256 !== hash
    || (previous && (value.id !== previous.id || value.version < previous.version
      || JSON.stringify(value.actor) !== JSON.stringify(previous.actor) || value.created_at !== previous.created_at
      || (value.version === previous.version && JSON.stringify(value) !== JSON.stringify(previous))))) {
    throw new Error('El estado durable no coincide con el recibo de este reinicio.');
  }
  return value;
}
function success(operation: FleetOperation) {
  if (operation.error || operation.applied_revision === null || operation.desired_revision !== operation.applied_revision
    || operation.applied_revision <= operation.expected_revision || !operation.steps.length
    || operation.steps.some(step => step.status !== 'succeeded')) throw new Error('El recibo no acredita el efecto completo del reinicio.');
  const proof = (name: string) => operation.steps.find(step => step.name === name)?.evidence;
  if (operation.kind === 'stop' ? proof('stop')?.stopped_verified !== true
    : !proof('runtime')?.runtime_digest || proof('authenticate')?.provider_verified !== true
      || proof('profile')?.profile_verified !== true || proof('verify')?.bootstrap_verified !== true
      || proof('verify')?.roundtrip_verified !== true || proof('admission')?.authority_verified !== true) {
    throw new Error('El recibo no acredita la parada o el arranque verificado.');
  }
}
async function execute(api: ReloadClient, request: FleetOperationRequest, signal: AbortSignal, deadline: number, pollMilliseconds: number) {
  const hash = await bounded(() => fleetRequestHash(request), signal, deadline);
  const preview = await bounded(() => api.previewFleetOperation(request), signal, deadline);
  if (!preview.can_apply || preview.request_sha256 !== hash || preview.kind !== request.kind
    || preview.expected_revision !== request.expected_revision || preview.target.resource !== 'agent'
    || request.target.resource !== 'agent' || preview.target.tenant_id !== request.target.tenant_id || preview.target.alias !== request.target.alias) throw unavailable();
  let operation = exactOperation(await bounded(() => api.enqueueFleetOperation(request), signal, deadline), request, hash);
  while (operation.status === 'queued' || operation.status === 'running') {
    await pause(pollMilliseconds, signal, deadline);
    operation = exactOperation(await bounded(() => api.getFleetOperation(operation.id), signal, deadline), request, hash, operation);
  }
  if (operation.status !== 'succeeded') throw new Error(`La operación ${operation.id} quedó en ${operation.status}. Verifica su historial antes de continuar.`);
  success(operation);
  return operation;
}

export async function measureNativeReload(api: ReloadClient, snapshot: ConfigurationSnapshot, target: NativeReloadTarget) {
  const capability = await api.getFleetCapability();
  const binding = nativeReloadBinding(snapshot, capability, target, true);
  if (!binding) throw unavailable();
  const read = await api.readNativePieces(target.tenant_id, target.alias, 'skill');
  if (read.tenant_id !== target.tenant_id || read.alias !== target.alias || !read.can_write || read.harness !== binding.harness_id
    || !NativeRuntimeIdentitySchema.safeParse(read.identity).success
    || read.outcome.type !== 'inventory' || read.outcome.kind !== 'skill') throw unavailable();
  return binding;
}

export async function reloadNativeAgent(api: ReloadClient, configuration: Resource<ConfigurationSnapshot>, target: NativeReloadTarget,
  signal: AbortSignal, options: { timeoutMilliseconds?: number; pollMilliseconds?: number } = {}) {
  const deadline = Date.now() + (options.timeoutMilliseconds ?? 120_000);
  const fresh = async () => {
    const result = await bounded(() => configuration.reload(), signal, deadline);
    if (!result.data) throw new Error('No se acreditó una lectura fresca de configuración para el CAS.');
    return result.data;
  };
  const snapshot = await fresh();
  const before = await bounded(() => measureNativeReload(api, snapshot, target), signal, deadline);
  const request = (kind: 'stop' | 'start', revision: number) => FleetOperationRequestSchema.parse({ kind, target,
    expected_revision: revision, idempotency_key: `native_${kind}_${crypto.randomUUID()}`, parameters: {} });
  const stopped = await execute(api, request('stop', Number(snapshot.revision)), signal, deadline, options.pollMilliseconds ?? 2500);
  const afterStop = await fresh();
  const capability = await bounded(() => api.getFleetCapability(), signal, deadline);
  const after = nativeReloadBinding(afterStop, capability, target, false);
  if (!after || Number(afterStop.revision) < Number(stopped.applied_revision)
    || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('La identidad física o la revisión cambió después de detener. El agente queda detenido; relee su historial.');
  const started = await execute(api, request('start', Number(afterStop.revision)), signal, deadline, options.pollMilliseconds ?? 2500);
  const afterStart = await fresh();
  const restarted = nativeReloadBinding(afterStart, capability, target, true);
  if (!restarted || Number(afterStart.revision) < Number(started.applied_revision)
    || JSON.stringify(before) !== JSON.stringify(restarted)) throw new Error('El arranque devolvió un recibo, pero la configuración actual no acredita este runtime. Relee su historial.');
}
