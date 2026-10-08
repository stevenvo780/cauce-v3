import { z } from 'zod';
import type { DatabaseClient } from '@cauce/store';
import type { FleetOperationRequest } from '@cauce/protocol';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const FleetProviderAccountsSchema = z.array(z.object({
  id: Identifier, provider: z.string().min(1).max(64), external_account_id: z.string().min(1).max(4096),
  payer_tenant_id: z.string().min(1).max(64), shared_with_pool: z.boolean(), enabled: z.boolean(),
}).strict()).max(1000);
export type FleetProviderAccounts = z.infer<typeof FleetProviderAccountsSchema>;

export function scopedFleetProviderAgents(
  request: FleetOperationRequest, targets: readonly { tenant_id: string; alias: string }[],
  previous: readonly Record<string, unknown>[], snapshot: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const key = (tenant: unknown, alias: unknown) => JSON.stringify([tenant, alias]);
  const identities = new Set(targets.map(target => key(target.tenant_id, target.alias)));
  if (request.target.resource === 'agent') identities.add(key(request.target.tenant_id, request.target.alias));
  const agents = [...previous, ...snapshot].filter(agent => identities.has(key(agent.tenant_id, agent.alias)));
  if (request.kind === 'create' || request.kind === 'update') agents.push({ primary_account_id: request.parameters.primary_account_id });
  return agents;
}

export async function readFleetProviderAccounts(client: DatabaseClient, agents: readonly Record<string, unknown>[]): Promise<FleetProviderAccounts> {
  const ids = [...new Set(agents.map(agent => agent.primary_account_id).filter((id): id is string => typeof id === 'string'))];
  if (ids.length > 1000 || ids.some(id => !Identifier.safeParse(id).success)) throw new Error('Fleet account scope is invalid');
  if (ids.length === 0) return [];
  const result = await client.query(`SELECT id,provider,external_account_id,payer_tenant_id,shared_with_pool,enabled
    FROM provider_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, [ids]);
  const accounts = FleetProviderAccountsSchema.parse(result.rows);
  if (accounts.length !== ids.length) throw new Error('Fleet account scope is unavailable');
  return accounts;
}
