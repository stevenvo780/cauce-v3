import { COMPANY_ID_PATTERN, type CompanyAuthority } from './company-authority.js';
import { StoreError } from './repository/errors.js';
import type { DatabaseClient } from './db.js';

export interface CompanySummary { id: string; name: string; state: 'enabled' | 'disabled' | 'retired'; version: number }
export async function updateCompany(
  client: DatabaseClient, authority: CompanyAuthority, company: string,
  input: { expected_version: number; name?: string | undefined; state?: CompanySummary['state'] | undefined },
): Promise<CompanySummary> {
  if (!COMPANY_ID_PATTERN.test(company) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new StoreError('invalid_input', 'invalid company update');
  }
  if (authority.humanId === null || (authority.role !== 'platform_admin'
    && (authority.role !== 'company_owner' || authority.actingCompany !== company))) {
    throw new StoreError('forbidden', 'company owner authority is required');
  }
  try {
    const row = (await client.query<Omit<CompanySummary, 'version'> & { version: string }>(
      'SELECT id,name,state,version::text FROM cauce_update_company($1,$2,$3,$4,$5)',
      [company, authority.humanId, input.expected_version, input.name ?? null, input.state ?? null],
    )).rows[0];
    if (!row) throw new StoreError('conflict', 'company has no durable receipt');
    return { ...row, version: Number(row.version) };
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === '42501') throw new StoreError('forbidden', 'company owner authority is required');
    if (code === '40001') throw new StoreError('conflict', 'company version changed; reload and retry');
    if (code === '40P01') throw new StoreError('conflict', 'company changed concurrently; reload and retry');
    if (code === 'P0002') throw new StoreError('not_found', 'company is unavailable');
    if (code === '22023') throw new StoreError('invalid_input', 'invalid company update');
    throw error;
  }
}

export async function setCompanyAdmin(client: DatabaseClient, authority: CompanyAuthority, company: string,
  input: { user_id: string; role: 'owner' | 'admin' | null; expected_version: number }): Promise<{ user_id: string; role: string | null; version: number }> {
  if (authority.humanId === null || (authority.role !== 'platform_admin'
    && (authority.role !== 'company_owner' || authority.actingCompany !== company))) {
    throw new StoreError('forbidden', 'company owner authority is required');
  }
  try {
    const row = (await client.query<{ version: string }>('SELECT cauce_set_company_admin($1,$2,$3,$4,$5)::text AS version',
      [company,authority.humanId,input.user_id,input.role,input.expected_version])).rows[0];
    if (!row) throw new StoreError('conflict','administrator has no durable receipt');
    return { user_id: input.user_id,role:input.role,version:Number(row.version) };
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === '42501') throw new StoreError('forbidden','company owner authority is required');
    if (code === '40001') throw new StoreError('conflict','administrator version changed; reload and retry');
    if (code === '40P01') throw new StoreError('conflict','administrator changed concurrently; reload and retry');
    if (code === 'P0002') throw new StoreError('not_found','company person is unavailable');
    if (code === '23514') throw new StoreError('conflict','company must retain a qualified owner');
    throw error;
  }
}
