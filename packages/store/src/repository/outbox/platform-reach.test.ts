import { describe, expect, it, vi } from 'vitest';
import type { CompanyAuthority } from '../../company-authority.js';
import type { DatabaseClient } from '../../db.js';
import { platformAudit, platformCompanyReach } from './platform-reach.js';

const platform: CompanyAuthority = Object.freeze({
  humanId: '78c81e05-0c18-427b-b02b-346d7e8c8508', homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar',
  actingCompany: 'praxis', role: 'platform_admin', scope: 'platform', platformOverride: true,
});
const praxisDelivery = { tenant_id: 'Hospital', recipient_tenant: 'Hospital' };

function client(companies: Record<string, string>) {
  const query = vi.fn(async (_sql: string, values: [string[]]) => ({
    rows: values[0].flatMap((tenant) => companies[tenant] === undefined ? [] : [{ company_id: companies[tenant] }]),
  }));
  return { client: { query } as unknown as DatabaseClient, query };
}

describe('platform company reach for operator replay and cancel', () => {
  it('reaches a delivery whose tenants all belong to the acting company', async () => {
    const { client: db, query } = client({ Hospital: 'praxis' });
    await expect(platformCompanyReach(db, 'Steven', 'kant', praxisDelivery, async () => platform)).resolves.toBe(platform);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'), [['Hospital']]);
  });

  it('refuses a delivery that crosses into a tenant of another company', async () => {
    const { client: db } = client({ Hospital: 'praxis', Steven: 'humanizar' });
    await expect(platformCompanyReach(db, 'Steven', 'kant',
      { tenant_id: 'Steven', recipient_tenant: 'Hospital' }, async () => platform)).resolves.toBeUndefined();
  });

  it('refuses a tenant the database no longer has', async () => {
    const { client: db } = client({});
    await expect(platformCompanyReach(db, 'Steven', 'kant', praxisDelivery, async () => platform)).resolves.toBeUndefined();
  });

  it.each([
    ['a company owner', { role: 'company_owner', scope: 'company' }],
    ['a tenant operator', { role: 'tenant_operator', scope: 'tenant' }],
    ['an agent without a person', { humanId: null }],
    ['another actor tenant', { homeTenant: 'Miguel' }],
    ['another actor alias', { alias: 'zeus' }],
  ] as const)('keeps the tenant scope for %s', async (_label, change) => {
    const { client: db, query } = client({ Hospital: 'praxis' });
    await expect(platformCompanyReach(db, 'Steven', 'kant', praxisDelivery,
      async () => ({ ...platform, ...change }))).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates a failure of the authority source instead of granting', async () => {
    const { client: db } = client({ Hospital: 'praxis' });
    await expect(platformCompanyReach(db, 'Steven', 'kant', praxisDelivery,
      async () => { throw new Error('authority unavailable'); })).rejects.toThrow('authority unavailable');
  });

  it('audits the person and the acting company only when the platform reach was used', () => {
    expect(platformAudit(undefined)).toEqual({ company: null, human: null, metadata: {} });
    expect(platformAudit(platform)).toEqual({
      company: 'praxis', human: platform.humanId,
      metadata: { acting_company: 'praxis', home_company: 'humanizar', platform_override: true },
    });
  });
});
