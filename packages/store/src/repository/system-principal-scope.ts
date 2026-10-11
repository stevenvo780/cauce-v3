import type { ConfigMutation } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { ConfigurationError } from '../configuration/contracts.js';

function reference(value: string): string {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(value)) throw new Error('invalid principal scope reference');
  return value;
}

export function runtimePrincipalScopeSql(tenant: string, alias: string): string {
  return `NOT EXISTS(SELECT 1 FROM company_system_principals principal
    WHERE principal.tenant_id=${reference(tenant)} AND principal.principal_alias=${reference(alias)}
      AND to_jsonb(principal)->>'delivery_source_only'='true')`;
}

export async function isDeliverySourceOnly(client: Pick<DatabaseClient, 'query'>, tenant: string, alias: string): Promise<boolean> {
  return (await client.query<{ source_only: boolean }>(`SELECT NOT ${runtimePrincipalScopeSql('target.tenant_id', 'target.alias')} AS source_only
    FROM (SELECT $1::text AS tenant_id,$2::text AS alias) target`, [tenant, alias])).rows[0]?.source_only === true;
}

export async function assertEditablePrincipalMutation(client: DatabaseClient, mutation: ConfigMutation): Promise<void> {
  if (mutation.resource === 'batch') {
    for (const leaf of mutation.mutations) await assertEditablePrincipalMutation(client, leaf);
    return;
  }
  if (!('tenant_id' in mutation)) return;
  const alias = 'alias' in mutation ? mutation.alias : 'agent_alias' in mutation ? mutation.agent_alias : undefined;
  if (alias !== undefined && await isDeliverySourceOnly(client, mutation.tenant_id, alias)) {
    throw new ConfigurationError('forbidden', 'delivery source principal is not an editable agent');
  }
}
