import type { ConsoleAuthorityRole, ConsoleAuthorityScope } from '../types/auth';
import type { RequestFn } from './system-client';
import { companyInventory, consolePreferences, officeLayout, registrationReceipt } from './v4-responses';
import { companyPurgeError, companyPurgeReceipt, type CompanyPurgeReceipt } from './company-purge';

export interface CompanyRecord { id: string; name: string; state: 'enabled' | 'disabled' | 'retired'; version: number }
export interface CompanyInventory {
  home_company: string; acting_company: string; role: ConsoleAuthorityRole; scope: ConsoleAuthorityScope;
  platform_override: boolean; companies: CompanyRecord[];
}
export interface ConsolePreferences { version: number; pinned_quota_accounts: string[] }
export interface CompanyAdmin { user_id: string; email: string; display_name: string; role: 'owner' | 'admin'; version: number }
export interface CompanyAdmins { company_id: string; items: CompanyAdmin[]; capabilities: { grant_admin: boolean; grant_owner: boolean; revoke: boolean } }
export interface OfficePart { id: string; label: string; x: number; y: number; width: number; height: number }
export interface OfficeRoom {
  tenant_id: string; room_id: string; x: number; y: number; width: number; height: number; parts: OfficePart[];
}
export interface OfficeLayout { company_id: string; version: number; rooms: OfficeRoom[]; available?: { tenant_id: string; room_id: string }[] }
export interface RegistrationInput { email: string; name: string; password: string; company: { slug: string; name: string } }
export interface RegistrationResult {
  user: { id: string; username: string; email: string; name: string };
  company: { id: string; name: string; slug: string }; hub: { id: string; name: string };
}
export interface CompanyClient {
  getCompanies(): Promise<CompanyInventory>;
  createCompany(input: RegistrationInput): Promise<RegistrationResult>;
  updateCompany(id: string, input: { expected_version: number; name?: string; state?: CompanyRecord['state'] }): Promise<CompanyRecord>;
  retireCompany(id: string, version: number): Promise<CompanyRecord>;
  purgeCompany(id: string, confirmation: string): Promise<CompanyPurgeReceipt>;
  getCompanyAdmins(id: string): Promise<CompanyAdmins>;
  saveCompanyAdmin(id: string, input: { user_id: string; role: 'owner' | 'admin' | null; expected_version: number }): Promise<unknown>;
  getConsolePreferences(): Promise<ConsolePreferences>;
  saveConsolePreferences(input: { expected_version: number; pinned_quota_accounts: string[] }): Promise<ConsolePreferences>;
  getOfficeLayout(): Promise<OfficeLayout>;
  saveOfficeLayout(input: { expected_version: number; rooms: OfficeRoom[] }): Promise<OfficeLayout>;
}

export function companyClient(request: RequestFn): CompanyClient {
  const base = '/v3/console';
  const read = <T>(path: string) => request<T>(`${base}/${path}`, { cache: 'no-store' });
  const write = <T>(path: string, method: string, input: unknown) => request<T>(`${base}/${path}`, {
    method, body: JSON.stringify(input), cache: 'no-store',
  });
  return {
    getCompanies: async () => companyInventory(await read('companies')),
    createCompany: async input => registrationReceipt(await write('companies', 'POST', input)),
    updateCompany: (id, input) => write<CompanyRecord>(`companies/${encodeURIComponent(id)}`, 'PATCH', input),
    retireCompany: (id, version) => request<CompanyRecord>(`${base}/companies/${encodeURIComponent(id)}?expected_version=${String(version)}`, { method: 'DELETE' }),
    purgeCompany: async (id, confirmation) => companyPurgeReceipt(await request(`${base}/companies/${encodeURIComponent(id)}/purge`, {
      method: 'POST', body: JSON.stringify({ confirmation }), cache: 'no-store',
    }, { mapError: companyPurgeError }), id),
    getCompanyAdmins: id => read<CompanyAdmins>(`companies/${encodeURIComponent(id)}/admins`),
    saveCompanyAdmin: (id, input) => write(`companies/${encodeURIComponent(id)}/admins`, 'PUT', input),
    getConsolePreferences: async () => consolePreferences(await read('preferences')),
    saveConsolePreferences: async input => consolePreferences(await write('preferences', 'PUT', input)),
    getOfficeLayout: async () => officeLayout(await read('office/layout')),
    saveOfficeLayout: async input => officeLayout(await write('office/layout', 'PUT', input)),
  };
}
