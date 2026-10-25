import { canonicallyEqual, FleetReplacementCommitSchema, sha256Hex, type FleetEvidence } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationRow } from './fleet-operation-contracts.js';
import { isFleetContainerReplacement } from './fleet-operation-compensation.js';
import { lockPreparedFleetRevision } from './fleet-operation-slice.js';

export type FleetReplacementCommit = ReturnType<typeof FleetReplacementCommitSchema.parse>;

export async function fleetReplacementCommit(client: DatabaseClient, operationId: string): Promise<FleetReplacementCommit | undefined> {
  const event = (await client.query<{ commit: unknown; seal: unknown }>(`SELECT metadata->'replacement_commit' AS commit,
    metadata->>'target_slice_sha256' AS seal
    FROM fleet_operation_events WHERE operation_id=$1 AND event='step_completed' AND metadata ? 'replacement_commit'
    ORDER BY id LIMIT 1`, [operationId])).rows[0];
  if (!event) return undefined;
  const parsed = FleetReplacementCommitSchema.safeParse(event.commit);
  if (!parsed.success) throw new FleetOperationError('conflict', 'replacement commit is invalid');
  const { commit_canonical, commit_sha256, ...body } = parsed.data;
  try {
    if (body.operation_id !== operationId || event.seal !== body.target_slice_sha256 || sha256Hex(commit_canonical) !== commit_sha256
        || !canonicallyEqual(JSON.parse(commit_canonical), body)) throw new Error();
  } catch { throw new FleetOperationError('conflict', 'replacement commit binding changed'); }
  return parsed.data;
}

export async function assertFleetReplacementCommitBinding(client: DatabaseClient, row: FleetOperationRow) {
  const commit = await fleetReplacementCommit(client, row.id);
  if (commit !== undefined) {
    if (row.status !== 'running' || row.cancel_requested || commit.company_id !== row.company_id
        || commit.request_sha256 !== row.request_hash || commit.applied_revision !== Number(row.applied_revision)) {
      throw new FleetOperationError('conflict', 'replacement commit is outside its current operation');
    }
  }
  return commit;
}

export async function assertFleetReplacementCommit(client: DatabaseClient, row: FleetOperationRow) {
  const commit = await assertFleetReplacementCommitBinding(client, row);
  if (commit !== undefined) await lockPreparedFleetRevision(client, row, true);
  return commit;
}

export function replacementRetirementRequired(row: FleetOperationRow, previous: readonly Record<string, unknown>[]): boolean {
  return isFleetContainerReplacement(row.request, previous);
}

export function assertFleetRetirementEvidence(commit: FleetReplacementCommit, previous: Record<string, unknown>, evidence: FleetEvidence): void {
  const proof = evidence.replacement_retired;
  if (proof?.commit_sha256 !== commit.commit_sha256 || proof.original_container_id !== commit.original_container_id
      || proof.replacement_container_id !== commit.replacement_container_id || proof.runtime_digest !== commit.runtime_digest
      || evidence.stopped_verified !== true || !canonicallyEqual(evidence.removed,
        [{ type: 'container', name: previous.container_name }])) {
    throw new FleetOperationError('conflict', 'replacement retirement has not demonstrated the committed physical effect');
  }
}
