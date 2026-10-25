import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol';

export function canRestoreFleetUpdate(
  operation: Pick<FleetOperation, 'desired_revision' | 'steps'>, request: FleetOperationRequest,
  previous: readonly Record<string, unknown>[],
): boolean {
  if (request.kind !== 'update' || operation.desired_revision === null || previous.length !== 1
      || !operation.steps.some(step => step.name === 'prepare' && step.status === 'succeeded')
      || operation.steps.some(step => !['prepare', 'stop'].includes(step.name) && step.status !== 'pending')) return false;
  const agent = previous[0];
  const { target, parameters } = request;
  const placement = parameters.placement;
  return agent?.tenant_id === target.tenant_id && agent.alias === target.alias
    && agent.runtime_key === parameters.runtime_key && agent.runtime_mode === 'container'
    && placement.mode === 'container' && agent.host_id === placement.host_id
    && agent.container_name === placement.container_name && agent.runtime_user === placement.runtime_user
    && agent.home_directory === placement.home_directory && agent.state_directory === placement.state_directory;
}
