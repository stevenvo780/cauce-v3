import { FleetOperationSchema, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol';
import type { FleetMembershipIntent } from './fleet-operation-lifecycle.js';

export class FleetOperationError extends Error {
  constructor(readonly code: 'forbidden' | 'conflict' | 'not_found' | 'invalid_input', message: string) {
    super(message);
    this.name = 'FleetOperationError';
  }
}

export interface FleetOperationRow {
  id: string; actor_tenant: string; actor_alias: string; actor_subject?: string;
  target: FleetOperation['target']; kind: FleetOperation['kind']; request: FleetOperationRequest;
  request_hash: string; cohort_key: string; status: FleetOperation['status']; version: string;
  expected_revision: string; desired_revision: string | null; applied_revision: string | null;
  steps: FleetOperation['steps']; error: FleetOperation['error'];
  created_at: Date; updated_at: Date; worker_id: string | null; claim_token: string | null;
  epoch: string; lease_expires_at: Date | null; cancel_requested: boolean;
}

export function publicFleetOperation(row: FleetOperationRow): FleetOperation {
  return FleetOperationSchema.parse({
    id: row.id, actor: { tenant_id: row.actor_tenant, alias: row.actor_alias,
      ...(row.actor_subject === undefined ? {} : { actor_subject: row.actor_subject }) },
    target: row.target, kind: row.kind, status: row.status, version: Number(row.version),
    request_sha256: row.request_hash,
    expected_revision: Number(row.expected_revision),
    desired_revision: row.desired_revision === null ? null : Number(row.desired_revision),
    applied_revision: row.applied_revision === null ? null : Number(row.applied_revision),
    steps: row.steps, error: row.error,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  });
}

export interface FleetOperationClaim {
  operation: FleetOperation;
  request: FleetOperationRequest;
  worker_id: string;
  claim_token: string;
  epoch: number;
}

export type FencedFleetTarget = Extract<FleetOperation['target'], { resource: 'agent' }>;
export interface FleetExecutionState {
  operation: FleetOperation;
  request: FleetOperationRequest;
  fenced_targets: FencedFleetTarget[];
  previous_agents: Array<Record<string, unknown>>;
  desired_memberships: FleetMembershipIntent[];
}
