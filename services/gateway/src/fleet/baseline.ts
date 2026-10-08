import type { DatabaseClient } from '@cauce/store';

export async function trustedFleetBaseline(client: DatabaseClient, agents: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const keys = [...new Set(agents.map(agent => agent.runtime_key).filter((key): key is string => typeof key === 'string'))];
  const identities = (await client.query<{ runtime_key: string; tenant_id: string; alias: string; baseline: boolean }>(
    'SELECT runtime_key,tenant_id,alias,baseline FROM fleet_runtime_identities WHERE runtime_key=ANY($1::text[])', [keys])).rows;
  return agents.map(agent => {
    const { fleet_baseline: _untrusted, ...record } = agent;
    if (agent.runtime_key === undefined || agent.runtime_key === null) return record;
    const matches = identities.filter(identity => identity.runtime_key === agent.runtime_key
      && identity.tenant_id === agent.tenant_id && identity.alias === agent.alias);
    if (matches.length !== 1 || typeof matches[0]?.baseline !== 'boolean') throw new Error('Fleet runtime baseline authority is unavailable');
    return { ...record, fleet_baseline: matches[0].baseline };
  });
}
