import { sha256Hex, type FleetEvidence, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { FleetOperationError, type FleetOperationRow } from './fleet-operation-contracts.js';

export function isFleetRecoveryProbe(request: FleetOperationRequest): boolean {
  return request.kind === 'recover' && request.parameters.action === 'probe';
}

export async function assertFleetRecoveryIdle(client: DatabaseClient, request: FleetOperationRequest): Promise<void> {
  if (request.kind !== 'recover' || request.parameters.action !== 'apply') return;
  const work = await client.query(`SELECT 1 FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
    AND status IN ('leased','accepted','started') LIMIT 1`, [request.target.tenant_id, request.target.alias]);
  if (work.rowCount) throw new FleetOperationError('conflict', 'recovery requires no deliveries in flight');
}

export async function lockFleetRecoveryConnection(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (row.request.kind !== 'recover' || row.request.parameters.action !== 'apply') return;
  const target = row.request.target;
  const lease = (await client.query<{ instance_id: string; live: boolean }>(`SELECT instance_id,lease_until>clock_timestamp() AS live
    FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [target.tenant_id, target.alias])).rows[0];
  // A relaunch replaces the adapter process, so its preparation fences the lease instead of keeping the confirmed writer.
  if (row.request.parameters.strategy !== 'relaunch' && (!lease?.live || lease.instance_id !== row.request.parameters.identity.writer_instance_id)) {
    throw new FleetOperationError('conflict', 'recovery adapter connection differs from its confirmed identity');
  }
}

export async function prepareFleetRecovery(client: DatabaseClient, row: FleetOperationRow): Promise<void> {
  if (row.request.kind !== 'recover' || row.request.parameters.action !== 'apply') return;
  await assertFleetRecoveryIdle(client, row.request);
  await client.query(`UPDATE agents SET enabled=false,lifecycle_state='verifying',updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND alias=$2`, [row.request.target.tenant_id, row.request.target.alias]);
  if (row.request.parameters.strategy === 'relaunch') {
    await client.query(`UPDATE connection_leases SET lease_until=now(),epoch=epoch+1,connection_token=gen_random_uuid()
      WHERE tenant_id=$1 AND alias=$2`, [row.request.target.tenant_id, row.request.target.alias]);
  }
}

export async function restoreFleetRecovery(client: DatabaseClient, row: FleetOperationRow, previousAgents: Record<string, unknown>[]): Promise<void> {
  if (row.request.kind !== 'recover' || row.request.parameters.action !== 'apply' || row.desired_revision === null) return;
  const target = row.request.target;
  const previous = previousAgents.find(agent => agent.tenant_id === target.tenant_id && agent.alias === target.alias);
  if (!previous || typeof previous.enabled !== 'boolean' || typeof previous.lifecycle_state !== 'string') {
    throw new FleetOperationError('conflict', 'recovery has no durable prior admission state');
  }
  const restored = await client.query(`UPDATE agents SET enabled=$3,lifecycle_state=$4,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND alias=$2 AND purged_at IS NULL AND retired_at IS NULL`,
  [target.tenant_id, target.alias, previous.enabled, previous.lifecycle_state]);
  if (restored.rowCount !== 1) throw new FleetOperationError('conflict', 'recovery target is unavailable');
}

export async function fleetRecoveryBlocksClaims(client: DatabaseClient, tenant: string, alias: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM fleet_operations WHERE kind='recover' AND request->'parameters'->>'action'='apply'
    AND target_key=$1 AND status IN ('queued','running','cancelling','failed') LIMIT 1`,
  [sha256Hex({ resource: 'agent', tenant_id: tenant, alias })])).rowCount !== 0;
}

export function fleetRecoveryEvidence(row: FleetOperationRow, name: FleetStepName, proof: FleetEvidence): FleetEvidence {
  if (row.request.kind !== 'recover' || !['runtime', 'verify'].includes(name)) {
    throw new FleetOperationError('invalid_input', 'recovery evidence requires a recovery execution step');
  }
  const recovery = proof.recovery;
  if (!recovery || proof.runtime_digest !== sha256Hex(recovery)) throw new FleetOperationError('invalid_input', 'recovery requires its exact physical receipt');
  if (row.request.parameters.action === 'probe' && ['resumed', 'recreated'].includes(recovery.session.state)) {
    throw new FleetOperationError('invalid_input', 'a recovery probe cannot report a restarted terminal');
  }
  if (row.request.parameters.action === 'apply' && (sha256Hex(recovery.identity) !== sha256Hex(row.request.parameters.identity)
      || !recovery.session.resumable || recovery.session.fingerprint !== row.request.parameters.expected_fingerprint
      || recovery.session.state === 'resumed' && !row.request.parameters.force
      || !['resumed', 'recreated'].includes(recovery.session.state))) {
    throw new FleetOperationError('conflict', 'recovery receipt differs from the confirmed conversation or runtime');
  }
  const prior = row.steps.find(step => step.name === 'runtime')?.evidence;
  if (name === 'verify' && sha256Hex(prior) !== sha256Hex(proof)) {
    throw new FleetOperationError('conflict', 'recovery verification differs from its immutable physical receipt');
  }
  return proof;
}
