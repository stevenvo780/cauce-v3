import { schemaBarrierReply } from '../../../../tests/helpers/schema-barrier.js';
import { describe, expect, it, vi } from 'vitest';
import { CauceRepository, StoreError, type DatabasePool } from '../index.js';
import type { CompanyAuthority } from '../company-authority.js';

const LETTER = '3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99';
const EVIDENCE = 'b'.repeat(64);
const platform: CompanyAuthority = Object.freeze({
  humanId: '6a5b4c3d-2e1f-4a0b-8c9d-1e2f3a4b5c6d', homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar',
  actingCompany: 'praxis', role: 'platform_admin', scope: 'platform', platformOverride: true,
});
const tenantPage = { schemaVersion: 1, items: [], total: 0, truncated: false, nextCursor: null };
const platformPage = { ...tenantPage, total: 1 };
const receipt = {
  schemaVersion: 1, suite: 'cauce-v3-dlq-no-replay-resolution', phase: 'resolved', appliedCount: 1,
  alreadyApplied: false, evidenceSha256: EVIDENCE, reasonSha256: 'c'.repeat(64),
  possibleDuplicateAcknowledged: true, possibleNoDeliveryAcknowledged: true,
};
const request = {
  target: 'delivery' as const, id: LETTER, evidenceSha256: EVIDENCE, reason: 'Nunca llegó; retomado por el dueño',
  possibleDuplicateAcknowledged: true, possibleNoDeliveryAcknowledged: true,
};

function repositoryFor(answers: { controlled?: boolean; reached?: boolean } = {}) {
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    const schema = schemaBarrierReply(sql, params);
    if (schema) return schema;
    const rows: Record<string, unknown>[] = sql.includes('cauce_list_dlq_platform_098') ? [{ value: platformPage }]
      : sql.includes('cauce_list_dlq_030') ? [{ value: tenantPage }]
        : sql.includes('cauce_dlq_can_control_tenant_030') ? (answers.controlled === true ? [{}] : [])
          : sql.includes('cauce_dlq_platform_reach_098') ? (answers.reached === true ? [{}] : [])
            : sql.includes('cauce_resolve_dlq_without_replay') ? [{ value: receipt }]
              : [];
    return { rows, rowCount: rows.length };
  });
  const pool = { connect: async () => ({ query, release: vi.fn(), on: vi.fn(), off: vi.fn() }) } as unknown as DatabasePool;
  return { repository: new CauceRepository(pool), query };
}

const called = (query: ReturnType<typeof repositoryFor>['query'], fragment: string) =>
  query.mock.calls.filter(([sql]) => sql.includes(fragment));

describe('operational DLQ platform company reach (098)', () => {
  it('lists the acting company for a verified platform administrator, bound to the person', async () => {
    const { repository, query } = repositoryFor();
    await expect(repository.listOperationalDlq('Steven', 'kant', 50, null, async () => platform)).resolves.toEqual(platformPage);
    expect(called(query, 'cauce_list_dlq_platform_098')[0]?.[1]).toEqual(['Steven', 'kant', 'praxis', platform.humanId, 50, null]);
    expect(called(query, 'cauce_list_dlq_030')).toHaveLength(0);
  });

  it.each([
    ['no source at all', undefined],
    ['a session that cannot vouch for a person', async () => { throw new StoreError('not_found', 'no person'); }],
    ['a forbidden authority', async () => { throw new StoreError('forbidden', 'company authority is unavailable'); }],
    ['a company owner', async () => ({ ...platform, role: 'company_owner' as const, scope: 'company' as const })],
    ['an agent without a person', async () => ({ ...platform, humanId: null })],
    ['another actor', async () => ({ ...platform, alias: 'zeus' })],
  ])('keeps the 030 tenant list for %s', async (_label, source) => {
    const { repository, query } = repositoryFor();
    await expect(repository.listOperationalDlq('Steven', 'kant', 50, null, source)).resolves.toEqual(tenantPage);
    expect(called(query, 'cauce_list_dlq_platform_098')).toHaveLength(0);
  });

  it('propagates an unexpected authority failure instead of silently narrowing or widening', async () => {
    const { repository } = repositoryFor();
    await expect(repository.listOperationalDlq('Steven', 'kant', 50, null,
      async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
  });

  it('resolves a letter the control scope sees through 030 without consulting the platform', async () => {
    const { repository, query } = repositoryFor({ controlled: true });
    const source = vi.fn(async () => platform);
    await expect(repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', request, source)).resolves.toEqual(receipt);
    expect(source).not.toHaveBeenCalled();
    expect(called(query, 'cauce_resolve_dlq_without_replay_030(')).toHaveLength(1);
    expect(called(query, 'cauce_resolve_dlq_without_replay_platform_098')).toHaveLength(0);
  });

  it('resolves a letter of the acting company through 098 with the person, company and home company', async () => {
    const { repository, query } = repositoryFor({ reached: true });
    await expect(repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', request, async () => platform))
      .resolves.toEqual(receipt);
    expect(called(query, 'cauce_resolve_dlq_without_replay_platform_098')[0]?.[1]).toEqual([
      'delivery', LETTER, EVIDENCE, request.reason, 'Steven', 'kant', 'praxis', platform.humanId, 'humanizar', true, true,
    ]);
  });

  it.each([
    ['no platform source', undefined, true],
    ['a tenant operator', async () => ({ ...platform, role: 'tenant_operator' as const, scope: 'tenant' as const }), true],
    ['a letter outside the acting company', async () => platform, false],
  ])('keeps a letter outside the control scope absent for %s', async (_label, source, reached) => {
    const { repository, query } = repositoryFor({ reached });
    await expect(repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', request, source))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(called(query, 'cauce_resolve_dlq_without_replay')).toHaveLength(0);
  });
});
