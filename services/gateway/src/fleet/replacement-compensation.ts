import { canRestoreFleetUpdate, validateFleetCompensationSnapshot, fleetReplacementRuntimeDigest, isFleetContainerReplacement, isFleetUpdateRestoration } from '@cauce/store';
import type { FleetEvidence } from '@cauce/protocol';
import type { FleetExecution } from './executor.js';
import { FleetExecutionFailure } from './recovery-host-command.js';
import type { FleetOperationClaim } from '@cauce/store';
import type { FleetCoordinatorRepository } from './coordinator.js';

export function replacementCompensationSnapshot(execution: FleetExecution) {
  const previous = execution.previous_agents ?? [];
  if (!isFleetUpdateRestoration(execution.request, previous)) return undefined;
  if (execution.snapshot?.compensation_snapshot === undefined && !isFleetContainerReplacement(execution.request, previous)
      && canRestoreFleetUpdate(execution.operation, execution.request, previous)) return undefined;
  try {
    return validateFleetCompensationSnapshot(execution.snapshot?.compensation_snapshot, execution.operation);
  } catch { throw new FleetExecutionFailure('replacement_snapshot_missing'); }
}

export function verifyReplacementCompensation(execution: FleetExecution, evidence: FleetEvidence): void {
  const snapshot = replacementCompensationSnapshot(execution);
  if (snapshot === undefined) return;
  const proof = evidence.replacement_restored;
  if (proof?.snapshot_sha256 !== snapshot.snapshot_sha256
      || proof.runtime_digest !== evidence.runtime_digest || proof.runtime_digest !== fleetReplacementRuntimeDigest(proof)
      || evidence.stopped_verified !== true || evidence.revocation_verified !== true) {
    throw new FleetExecutionFailure('replacement_original_unverified');
  }
}

export async function recordReplacementCompensation(
  repository: Pick<FleetCoordinatorRepository, 'hostSlices' | 'completeHostStep'>,
  claim: FleetOperationClaim, host: string, evidence: FleetEvidence,
): Promise<void> {
  if (evidence.replacement_restored === undefined) return;
  const slices = await repository.hostSlices(claim);
  const slice = slices[0];
  if (slices.length !== 1 || slice?.host_id !== host || slice.placement_role !== undefined) {
    throw new FleetExecutionFailure('replacement_original_unverified');
  }
  await repository.completeHostStep(claim, 'compensate', host, slice.target_sha256, evidence);
}
