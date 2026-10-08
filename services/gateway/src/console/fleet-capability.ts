import { readFileSync } from 'node:fs';
import { FleetCapabilitySchema, type FleetCapability, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationError } from '@cauce/store';

export function configuredFleetCapability(env: NodeJS.ProcessEnv = process.env): FleetCapability {
  if (env.CAUCE_FLEET_OPERATIONS_ENABLED === undefined || env.CAUCE_FLEET_OPERATIONS_ENABLED === '0') {
    return { available: false, actions: [], placements: [], reason: 'executor_unconfigured' };
  }
  if (env.CAUCE_FLEET_OPERATIONS_ENABLED !== '1' || !env.CAUCE_FLEET_CAPABILITY_FILE?.startsWith('/')) {
    throw new Error('fleet operations require an explicit absolute capability file');
  }
  return FleetCapabilitySchema.parse(JSON.parse(readFileSync(env.CAUCE_FLEET_CAPABILITY_FILE, 'utf8')));
}

export function assertFleetPlacement(capability: FleetCapability, request: FleetOperationRequest): void {
  if (!capability.available || !capability.actions.includes(request.kind)) {
    throw new FleetOperationError('forbidden', 'fleet action is unavailable');
  }
  if (request.kind !== 'create' && request.kind !== 'update') return;
  const { placement, runtime_key: key } = request.parameters;
  const host = capability.placements.find((candidate) => candidate.host_id === placement.host_id);
  if (!host || !host.modes.includes(placement.mode) || !host.runtime_users.includes(placement.runtime_user)
      || (placement.systemd_user !== undefined && !host.systemd_users.includes(placement.systemd_user))
      || !host.home_roots.includes(placement.home_directory)
      || !host.state_roots.some((root) => placement.state_directory === `${root.replace(/\/$/u, '')}/${key}`)) {
    throw new FleetOperationError('forbidden', 'placement is outside the configured host authority');
  }
}
