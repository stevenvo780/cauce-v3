import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { FleetCapabilitySchema, matchingFleetRuntime, type FleetCapability, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationError, type DatabasePool } from '@cauce/store';

export function configuredFleetCapability(env: NodeJS.ProcessEnv = process.env): FleetCapability {
  if (env.CAUCE_FLEET_OPERATIONS_ENABLED === undefined || env.CAUCE_FLEET_OPERATIONS_ENABLED === '0') {
    return { available: false, actions: [], placements: [], reason: 'executor_unconfigured' };
  }
  if (env.CAUCE_FLEET_OPERATIONS_ENABLED !== '1' || !env.CAUCE_FLEET_CAPABILITY_FILE?.startsWith('/')) {
    throw new Error('fleet operations require an explicit absolute capability file');
  }
  const filename = env.CAUCE_FLEET_CAPABILITY_FILE;
  if (!isAbsolute(filename) || normalize(filename) !== filename) throw new Error('fleet capability path is invalid');
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262_144 || (stat.mode & 0o022) !== 0
        || ![0, process.geteuid?.()].includes(stat.uid)) throw new Error('fleet capability ownership is invalid');
    const capability = FleetCapabilitySchema.parse(JSON.parse(readFileSync(descriptor, 'utf8')));
    if (capability.available && capability.placements.some(host => !host.runtimes?.length)) {
      throw new Error('fleet capability requires an approved runtime catalog');
    }
    return capability;
  } finally { closeSync(descriptor); }
}

export function assertFleetPlacement(capability: FleetCapability, request: FleetOperationRequest): void {
  if (!capability.available || !capability.actions.includes(request.kind)) {
    throw new FleetOperationError('forbidden', 'fleet action is unavailable');
  }
  if (request.kind !== 'create' && request.kind !== 'update') return;
  const { placement, runtime_key: key } = request.parameters;
  const host = capability.placements.find((candidate) => candidate.host_id === placement.host_id);
  if (host?.runtimes !== undefined && matchingFleetRuntime(capability, request) === undefined) {
    throw new FleetOperationError('forbidden', 'runtime is outside the approved host templates');
  }
  if (!host || !host.modes.includes(placement.mode) || !host.runtime_users.includes(placement.runtime_user)
      || (placement.systemd_user !== undefined && !host.systemd_users.includes(placement.systemd_user))
      || !host.home_roots.includes(placement.home_directory)
      || !host.state_roots.some((root) => placement.state_directory === `${root.replace(/\/$/u, '')}/${key}`)) {
    throw new FleetOperationError('forbidden', 'placement is outside the configured host authority');
  }
}

export async function assertFleetProviderAccount(pool: DatabasePool, capability: FleetCapability, request: FleetOperationRequest): Promise<void> {
  if (request.kind !== 'create' && request.kind !== 'update') return;
  const runtime = matchingFleetRuntime(capability, request);
  if (!runtime) throw new FleetOperationError('forbidden', 'runtime has no current approved provider capability');
  const accountId = request.parameters.primary_account_id;
  if (!accountId) throw new FleetOperationError('forbidden', 'runtime requires an explicit provider account');
  const result = await pool.query<{ provider: string }>(`SELECT provider FROM provider_accounts
    WHERE id=$1 AND enabled AND (payer_tenant_id=$2 OR shared_with_pool)`, [accountId, request.target.tenant_id]);
  if (result.rows.length !== 1 || result.rows[0]?.provider !== runtime.provider) {
    throw new FleetOperationError('forbidden', 'provider account is outside the approved runtime capability');
  }
}
