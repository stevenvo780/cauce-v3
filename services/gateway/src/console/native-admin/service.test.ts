import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { createNativeAdminService, type NativeAdminActor } from './service.js';
import type { AgentFactsProbe } from '../agent-documents.routes.js';

function fixture() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("pg_settings") ? [{ timeout_ms: 0 }] : [], rowCount: 1 }));
  const client = { query, release: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() }; const pool = { connect: async () => client } as unknown as DatabasePool;
  const target = vi.fn(async () => ({ tenant_id: 'Steven' as const, alias: 'zeus', enabled: true, harness_id: 'codex', home_directory: '/home/dev' }));
  const factsFor = vi.fn<AgentFactsProbe['factsFor']>(); const nativeAdmin = vi.fn<NonNullable<AgentFactsProbe['nativeAdmin']>>();
  const service = createNativeAdminService({ pool, repository: { assertPermission: vi.fn(), authorizeAgentTarget: target },
    probe: { factsFor, nativeAdmin, readGovernanceDocument: vi.fn(), listMemoryDirectory: vi.fn() },
    readContext: vi.fn(), readRuntimeExpectation: vi.fn() });
  const actor: NativeAdminActor = { tenant_id: 'Steven', alias: 'kant', subject: 'console:human',
    humanAuthority: async () => ({ humanId: 'human', tenantId: 'Steven', actorAlias: 'kant' }) };
  return { service, actor, factsFor, nativeAdmin, target, client };
}
describe('native runtime identity and durable authority', () => {
  it('refuses revoked or mismatched human authority before observing the runtime', async () => {
    const f = fixture();
    await expect(f.service.read({ ...f.actor, humanAuthority: async () => { throw new Error('revoked'); } }, 'Steven', 'zeus', 'skill')).rejects.toThrow();
    await expect(f.service.read({ ...f.actor, subject: 'console:other' }, 'Steven', 'zeus', 'skill')).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.factsFor).not.toHaveBeenCalled(); expect(f.nativeAdmin).not.toHaveBeenCalled();
  });
  it('refuses configured facts and shared HOME roots rather than guessing native paths', async () => {
    const f = fixture(); const facts = { harness: 'codex' as const, home: '/home/dev', codexHome: '/home/dev/private', generation: 'gen', containerId: 'container', writerInstanceId: '00000000-0000-4000-8000-000000000061', features: ['native_admin_v1'] };
    f.factsFor.mockResolvedValueOnce({ source: 'registry', facts });
    await expect(f.service.read(f.actor, 'Steven', 'zeus', 'skill')).rejects.toMatchObject({ code: 'unsupported' });
    f.factsFor.mockResolvedValueOnce({ source: 'measured', facts: { ...facts, codexHome: facts.home } });
    await expect(f.service.read(f.actor, 'Steven', 'zeus', 'skill')).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.nativeAdmin).not.toHaveBeenCalled();
  });
  it('checks target permission with both coordinates inside the human transaction', async () => {
    const f = fixture(); f.target.mockResolvedValueOnce(undefined as never);
    await expect(f.service.read(f.actor, 'Other', 'zeus', 'skill')).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.target).toHaveBeenCalledWith('Steven', 'kant', 'Other', 'zeus', 'read', f.client);
    expect(f.nativeAdmin).not.toHaveBeenCalled();
  });
});
