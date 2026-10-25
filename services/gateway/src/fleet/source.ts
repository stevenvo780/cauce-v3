import { z } from 'zod';
import { RuntimeKeySchema } from '@cauce/protocol';
import { FleetOperationsRepository, lockFleetClaim, lockFleetRevision, lockPreparedFleetRevision, isFleetUpdateRestoration, preparedState, publicFleetOperation, withTransaction, assertFleetReplacementCommit,
  type DatabasePool, type FleetOperationClaim, type FleetExecutionState } from '@cauce/store';
import { readFleetProviderAccounts, scopedFleetProviderAgents, type FleetProviderAccounts } from './accounts.js';
import { desiredFleetExtensions, fleetSharedHumans, trustedFleetBaseline } from './baseline.js';

const SnapshotSchema = z.object({
  agents: z.array(z.record(z.string(), z.unknown())),
  memberships: z.array(z.record(z.string(), z.unknown())),
  rolePolicies: z.array(z.record(z.string(), z.unknown())),
  purgedRuntimeKeys: z.array(RuntimeKeySchema).max(1000).refine(keys => new Set(keys).size === keys.length).optional(),
}).strict().refine(snapshot => !snapshot.agents.some(agent => typeof agent.runtime_key === 'string'
  && snapshot.purgedRuntimeKeys?.includes(agent.runtime_key)), { message: 'Purged runtime keys overlap current agents' });
export interface FleetHostExecution extends FleetExecutionState {
  snapshot: z.infer<typeof SnapshotSchema> & { compensation_snapshot?: unknown; replacement_commit?: unknown };
  snapshot_revision: number;
  trusted_accounts: FleetProviderAccounts;
}

export class FleetHostSource extends FleetOperationsRepository {
  constructor(pool: DatabasePool, private readonly hostOptions: { snapshotQuery: string; controllerHost?: string; coordinatorEnabled?: boolean; coordinatorHosts?: readonly string[] }) {
    super(pool, hostOptions);
  }
  override async execution(claim: FleetOperationClaim): Promise<FleetHostExecution> {
    return withTransaction(this.pool, async (client) => {
      const row = await lockFleetClaim(client, claim, true);
      const committed = await assertFleetReplacementCommit(client, row);
      const revision = await lockFleetRevision(client, row.status === 'cancelling' || committed !== undefined ? undefined : Number(row.desired_revision ?? row.expected_revision),
        row.company_id);
      const prepared = await preparedState(client, row.id);
      if (row.status === 'cancelling' && isFleetUpdateRestoration(row.request, prepared.previous_agents)) {
        await lockPreparedFleetRevision(client, row, true);
      }
      const result = await client.query<{ jsonb_build_object: unknown }>(this.hostOptions.snapshotQuery);
      if (result.rows.length !== 1) throw new Error('Fleet host snapshot is unavailable');
      const snapshot: FleetHostExecution['snapshot'] = SnapshotSchema.parse(result.rows[0]?.jsonb_build_object);
      const tenants=new Set((await client.query<{id:string}>('SELECT id FROM tenants WHERE company_id=$1',[row.company_id])).rows.map(tenant=>tenant.id));
      if (!tenants.has(row.target.tenant_id)) throw new Error('Fleet company snapshot is unavailable');
      // Every host materializes the whole company fleet it receives, so the snapshot keeps the agents of every host.
      snapshot.agents=snapshot.agents.filter(agent=>tenants.has(String(agent.tenant_id)));
      const identities=new Set(snapshot.agents.map(agent=>JSON.stringify([agent.tenant_id,agent.alias])));
      snapshot.memberships=snapshot.memberships.filter(member=>identities.has(JSON.stringify([member.tenant_id,member.alias])));
      snapshot.purgedRuntimeKeys=(await client.query<{runtime_key:string}>(`SELECT DISTINCT runtime_key FROM agents
        WHERE company_id=$1 AND purged_at IS NOT NULL AND runtime_key IS NOT NULL ORDER BY runtime_key`,
      [row.company_id])).rows.map(agent=>agent.runtime_key);
      if (prepared.previous_agents.some(agent=>!tenants.has(String(agent.tenant_id)))||prepared.fenced_targets.some(target=>!tenants.has(target.tenant_id))) {
        throw new Error('Fleet prepared scope is outside the company');
      }
      snapshot.agents = await fleetSharedHumans(client, row.company_id,
        await desiredFleetExtensions(client, await trustedFleetBaseline(client, snapshot.agents)));
      prepared.previous_agents = await trustedFleetBaseline(client, prepared.previous_agents);
      if (prepared.compensation_snapshot !== undefined) snapshot.compensation_snapshot = prepared.compensation_snapshot;
      if (committed !== undefined) snapshot.replacement_commit = committed;
      const trusted_accounts = await readFleetProviderAccounts(client, scopedFleetProviderAgents(
        row.request, prepared.fenced_targets, prepared.previous_agents, snapshot.agents));
      await lockFleetClaim(client, claim, true);
      const { compensation_snapshot: _compensation, ...execution } = prepared;
      return { operation: publicFleetOperation(row), request: row.request, ...execution, snapshot, snapshot_revision: revision, trusted_accounts };
    });
  }
}
