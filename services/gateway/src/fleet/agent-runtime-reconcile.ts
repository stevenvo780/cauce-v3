import { assertFleetOperationAuthority, FleetOperationError, preparedState, publicFleetOperation,
  type DatabaseClient, type FleetOperationRow } from '@cauce/store';
import { assertProviderAuthSealedScope } from '../console/provider-auth-binding.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { readFleetProviderAccounts } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';
import { fleetHostInputs } from './coordinator.js';
import type { FleetExecution } from './executor.js';

export interface RuntimeDriftFence {
  operation_id: string; operation_epoch: number; prepared_revision: number; scope_sha256: string;
}
export interface RuntimeDriftReceipt extends RuntimeDriftFence { error: 'RUNTIME_DRIFT' }
interface Host { host_id: string; company_id: string }
interface Inspection { fence: RuntimeDriftFence; execution: FleetExecution }
const pending = `company_id=$1 AND executor_host=$2 AND status='awaiting_auth' AND NOT cancel_requested
  AND target->>'resource'='agent' AND kind IN ('create','update','start','restore')
  AND error->>'code' IS DISTINCT FROM 'RUNTIME_DRIFT'`;

async function inspect(client: DatabaseClient, host: Host, row: FleetOperationRow): Promise<Inspection | undefined> {
  try {
    await assertFleetOperationAuthority(client, row);
    if (row.target.resource !== 'agent' || row.desired_revision === null) return;
    const agent = (await client.query<Record<string, unknown>>(`SELECT * FROM agents
      WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 AND host_id=$4 AND runtime_mode='container'
        AND retired_at IS NULL AND purged_at IS NULL FOR SHARE`,
    [row.target.tenant_id, row.target.alias, host.company_id, host.host_id])).rows[0];
    if (!agent) return;
    const sealed = await assertProviderAuthSealedScope(client, row, agent);
    if (sealed.host_id !== host.host_id || sealed.placement_role === 'source') return;
    const prepared = await preparedState(client, row.id);
    const agents = await trustedFleetBaseline(client, sealed.agents);
    const previous_agents = await trustedFleetBaseline(client, prepared.previous_agents.filter(value => value.host_id === host.host_id));
    return { fence: { operation_id: row.id, operation_epoch: Number(row.epoch),
      prepared_revision: Number(row.desired_revision), scope_sha256: sealed.target_sha256 },
    execution: { operation: publicFleetOperation(row), request: row.request,
      ...fleetHostInputs(sealed.targets, { ...prepared, previous_agents }),
      snapshot: { agents, memberships: [], rolePolicies: [] }, trusted_accounts: await readFleetProviderAccounts(client, agents) } };
  } catch (error) {
    if (error instanceof FleetOperationError || error instanceof ProviderAuthError) return;
    throw error;
  }
}

export async function reconcileAgentRuntimes(client: DatabaseClient, host: Host, receipts: RuntimeDriftReceipt[], after?: string): Promise<{ inspections: Inspection[]; cursor: string | null }> {
  for (const receipt of receipts) {
    const row = (await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations
      WHERE ${pending} AND id=$3 FOR UPDATE`, [host.company_id, host.host_id, receipt.operation_id])).rows[0];
    if (!row) continue;
    const current = await inspect(client, host, row);
    if (current?.fence.operation_epoch !== receipt.operation_epoch
        || current.fence.prepared_revision !== receipt.prepared_revision || current.fence.scope_sha256 !== receipt.scope_sha256) continue;
    const updated = (await client.query<{ version: string }>(`UPDATE fleet_operations
      SET error='{"code":"RUNTIME_DRIFT","step":"authenticate","retryable":false}'::jsonb,
        version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND version=$2 AND status='awaiting_auth' AND NOT cancel_requested RETURNING version`, [row.id, row.version])).rows[0];
    if (updated) await client.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
      VALUES($1,$2,'step_completed',$3::jsonb)`, [row.id, updated.version,
    JSON.stringify({ step: 'authenticate', runtime_drift: receipt })]);
  }
  const select = (cursor?: string) => client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE ${pending}
    AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 8 FOR UPDATE SKIP LOCKED`, [host.company_id, host.host_id, cursor ?? null]);
  let rows = (await select(after)).rows;
  if (rows.length === 0 && after !== undefined) rows = (await select()).rows;
  const inspections: Inspection[] = [];
  for (const row of rows) {
    const current = await inspect(client, host, row);
    if (current) inspections.push(current);
  }
  return { inspections, cursor: rows.at(-1)?.id ?? null };
}
