import { z } from 'zod';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import type { CompanyAuthority } from './company-authority.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { StoreError } from './repository/errors.js';

export const CompanyPreferencesUpdateSchema = z.object({
  expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pinned_quota_accounts: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)).max(100)
    .refine(ids => new Set(ids).size === ids.length),
}).strict();
export interface CompanyPreferences { version: number; pinned_quota_accounts: string[] }
function authorize(authority: CompanyAuthority): void {
  if (authority.humanId === null || authority.role === 'none') throw new StoreError('forbidden', 'a console person is required');
}
async function visibleAccounts(client: DatabaseClient, authority: CompanyAuthority): Promise<Set<string>> {
  const ids = await client.query<{ id: string }>(`SELECT account.id FROM provider_accounts account
    JOIN tenants payer ON payer.id=account.payer_tenant_id WHERE payer.company_id=$1
      AND ($2::text IS NULL OR account.payer_tenant_id=$2 OR (account.shared_with_pool AND EXISTS
        (SELECT 1 FROM agent_account_bindings binding WHERE binding.account_id=account.id AND binding.tenant_id=$2)))`,
  [authority.actingCompany, authority.scope === 'company' || authority.scope === 'platform' ? null : authority.homeTenant]);
  return new Set(ids.rows.map(row => row.id));
}
async function read(client: DatabaseClient, authority: CompanyAuthority): Promise<CompanyPreferences> {
  const row = (await client.query<{ version: string; pinned_quota_accounts: string[] }>(
    'SELECT version::text,pinned_quota_accounts FROM console_company_preferences WHERE company_id=$1 AND human_id=$2',
    [authority.actingCompany, authority.humanId])).rows[0];
  const visible = await visibleAccounts(client, authority);
  return { version: Number(row?.version ?? 0), pinned_quota_accounts: (row?.pinned_quota_accounts ?? []).filter(id => visible.has(id)) };
}
export async function readCompanyPreferences(pool: DatabasePool, source: CompanyAuthoritySource): Promise<CompanyPreferences> {
  return withTransaction(pool, async client => { const authority = await source(client); authorize(authority); return read(client, authority); });
}
export async function writeCompanyPreferences(pool: DatabasePool, source: CompanyAuthoritySource, value: unknown): Promise<CompanyPreferences> {
  const input = CompanyPreferencesUpdateSchema.parse(value);
  return withTransaction(pool, async client => {
    const authority = await source(client); authorize(authority);
    const visible = await visibleAccounts(client, authority);
    if (input.pinned_quota_accounts.some(id => !visible.has(id))) throw new StoreError('forbidden', 'quota account is unavailable');
    const values = [authority.actingCompany, authority.humanId, input.pinned_quota_accounts, input.expected_version];
    const result = input.expected_version === 0
      ? await client.query(`INSERT INTO console_company_preferences(company_id,human_id,pinned_quota_accounts)
          VALUES($1,$2,$3) ON CONFLICT (company_id,human_id) DO NOTHING RETURNING version`, values.slice(0,3))
      : await client.query(`UPDATE console_company_preferences SET pinned_quota_accounts=$3,version=version+1,updated_at=now()
          WHERE company_id=$1 AND human_id=$2 AND version=$4 RETURNING version`, values);
    if (!result.rowCount) throw new StoreError('conflict', 'preferences version changed; reload and retry');
    return read(client, authority);
  });
}
