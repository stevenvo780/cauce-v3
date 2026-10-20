import type { DatabaseClient } from '@cauce/store';
import { ExtensionsSchema } from '@cauce/protocol';

/** The adapter's exact `tenant:uuid` shape for a human who may share an agent's canonical session. */
const SHARED_HUMAN = /^[A-Za-z][A-Za-z0-9_-]{0,63}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * OpenClaw has no isolated human session, so a console message reaches its canonical session only from a human listed
 * in CAUCE_SHARED_HUMAN_IDS. The list is the active owners and admins of the agent's own company: never another company.
 */
export async function fleetSharedHumans(client: DatabaseClient, companyId: string,
  agents: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!agents.some(agent => agent.harness_id === 'openclaw')) return agents;
  const humans = [...new Set((await client.query<{ entry: string }>(`SELECT DISTINCT human.tenant_id||':'||lower(human.id::text) AS entry
    FROM company_admins admin JOIN console_users human ON human.id::text=admin.human_id::text
    WHERE admin.company_id=$1 AND admin.role IN ('owner','admin') AND human.active AND human.company_id=$1
    ORDER BY 1`, [companyId])).rows.map(row => row.entry))].filter(entry => SHARED_HUMAN.test(entry)).slice(0, 32);
  if (humans.length === 0) return agents;
  return agents.map(agent => agent.harness_id === 'openclaw' ? { ...agent, shared_human_ids: humans } : agent);
}

export async function desiredFleetExtensions(client: DatabaseClient, agents: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const rows = (await client.query<{ tenant_id: string; alias: string; extensions: unknown }>(`SELECT agent.tenant_id,agent.alias,agent.extensions
    FROM agents agent JOIN unnest($1::text[],$2::text[]) AS wanted(tenant_id,alias)
      ON agent.tenant_id=wanted.tenant_id AND agent.alias=wanted.alias FOR SHARE OF agent`,
  [agents.map(agent => agent.tenant_id), agents.map(agent => agent.alias)])).rows;
  const extensions = new Map(rows.map(row => [JSON.stringify([row.tenant_id, row.alias]), ExtensionsSchema.parse(row.extensions)]));
  return agents.map(agent => {
    const value = extensions.get(JSON.stringify([agent.tenant_id, agent.alias]));
    if (value === undefined) throw new Error('Fleet agent extensions are unavailable');
    return { ...agent, extensions: value };
  });
}

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
