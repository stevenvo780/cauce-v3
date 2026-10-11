import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@cauce/protocol';
import { parseCompanyTransferBundle, type CompanyTransferBundle, type CompanyTransferPayload } from './company-transfer-model.js';
import { buildCompanyTransferPlan } from './company-transfer-plan.js';

function bundle(): CompanyTransferBundle {
  const payload: CompanyTransferPayload = { format: 'cauce-company-configuration', version: 1, company_id: 'praxis', schema_version: '060_test',
    source_revision: 0, mode: 'upsert_only', records: { tenants: [{ id: 'Praxis', display_name: 'Praxis', is_hub: true, enabled: true }],
      rooms: [], agents: [], memberships: [], acl_edges: [] } };
  return { ...payload, bundle_sha256: sha256Hex(payload) };
}
function seal(changed: CompanyTransferBundle): CompanyTransferBundle {
  const { bundle_sha256: _discard, ...payload } = changed;
  return { ...payload, bundle_sha256: sha256Hex(payload) };
}
describe('company configuration transfer boundary', () => {
  it('checks the canonical checksum before computing a plan', () => {
    const valid = bundle(); expect(parseCompanyTransferBundle(valid)).toEqual(valid);
    expect(() => parseCompanyTransferBundle({ ...valid, source_revision: 8 })).toThrow('checksum');
  });
  it('rejects all fields outside the structural allowlist, even with a checksum', () => {
    for (const excluded of ['credential_ref', 'password_hash', 'provider_accounts', 'sessions', 'messages', 'profile']) {
      expect(() => parseCompanyTransferBundle({ ...bundle(), [excluded]: 'private' })).toThrow('excluded');
    }
    const value = bundle();
    expect(() => parseCompanyTransferBundle({ ...value, records: { ...value.records, tenants: [{ ...value.records.tenants[0], secret: 'private' }] } })).toThrow('excluded');
  });
  it('rejects cross tenant references and duplicate identities', () => {
    const value = bundle();
    expect(() => parseCompanyTransferBundle(seal({ ...value, records: { ...value.records,
      acl_edges: [{ from_tenant: 'Praxis', to_tenant: 'Steven', enabled: true, allow_route: true, allow_read: true, allow_control: false }] } }))).toThrow('outside');
    expect(() => parseCompanyTransferBundle(seal({ ...value, records: { ...value.records,
      tenants: [...value.records.tenants, ...value.records.tenants] } }))).toThrow('duplicate');
  });
  it('never clones into a different company or ignores schema and CAS mismatches', () => {
    const value = bundle();
    expect(() => buildCompanyTransferPlan(value, { ...value, company_id: 'humanizar' }, 0)).toThrow('another company');
    expect(() => buildCompanyTransferPlan(value, { ...value, schema_version: '059' }, 0)).toThrow('schema version');
    expect(() => buildCompanyTransferPlan(value, value, 1)).toThrow('changed');
  });
  it('does not invent deletions or configuration history for identical records', () => {
    const value = bundle(); const plan = buildCompanyTransferPlan(value, value, 0);
    expect(plan.mutations).toEqual([]); expect(plan.fleet_requests).toEqual([]);
    expect(plan.plan_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
