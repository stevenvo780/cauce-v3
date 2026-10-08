import { z } from 'zod';
import { RuntimeKeySchema } from '@cauce/protocol';
import { FleetOperationsRepository, lockFleetClaim, lockFleetRevision, preparedState, publicFleetOperation, withTransaction,
  type DatabasePool, type FleetOperationClaim, type FleetExecutionState } from '@cauce/store';
import { readFleetProviderAccounts, scopedFleetProviderAgents, type FleetProviderAccounts } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';

const SnapshotSchema = z.object({
  agents: z.array(z.record(z.string(), z.unknown())),
  memberships: z.array(z.record(z.string(), z.unknown())),
  rolePolicies: z.array(z.record(z.string(), z.unknown())),
  purgedRuntimeKeys: z.array(RuntimeKeySchema).max(1000).refine(keys => new Set(keys).size === keys.length).optional(),
}).strict().refine(snapshot => !snapshot.agents.some(agent => typeof agent.runtime_key === 'string'
  && snapshot.purgedRuntimeKeys?.includes(agent.runtime_key)), { message: 'Purged runtime keys overlap current agents' });
export interface FleetHostExecution extends FleetExecutionState {
  snapshot: z.infer<typeof SnapshotSchema>;
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
      const revision = await lockFleetRevision(client, row.status === 'cancelling' ? undefined : Number(row.desired_revision ?? row.expected_revision));
      const prepared = await preparedState(client, row.id);
      const result = await client.query<{ jsonb_build_object: unknown }>(this.hostOptions.snapshotQuery);
      if (result.rows.length !== 1) throw new Error('Fleet host snapshot is unavailable');
      const snapshot = SnapshotSchema.parse(result.rows[0]?.jsonb_build_object);
      snapshot.agents = await trustedFleetBaseline(client, snapshot.agents);
      prepared.previous_agents = await trustedFleetBaseline(client, prepared.previous_agents);
      const trusted_accounts = await readFleetProviderAccounts(client, scopedFleetProviderAgents(
        row.request, prepared.fenced_targets, prepared.previous_agents, snapshot.agents));
      await lockFleetClaim(client, claim, true);
      return { operation: publicFleetOperation(row), request: row.request, ...prepared, snapshot, snapshot_revision: revision, trusted_accounts };
    });
  }
}
