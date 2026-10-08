import { beforeEach, expect, it, vi } from 'vitest';
import { StoreError, type ContextWriteDescriptor, type ContextWriteSnapshot, type DatabasePool } from '@cauce/store';
import type { NativeAdminOutcome, NativePieceMutation } from '@cauce/protocol';
import { createNativeAdminService, NativeAdminError, type NativeAdminActor, type NativeAdminServiceDeps } from './service.js';
import type { AgentFactsProbe } from '../agent-documents.routes.js';

const store = vi.hoisted(() => ({ reserve: vi.fn(), authorize: vi.fn(), resolve: vi.fn(), read: vi.fn() }));
vi.mock('@cauce/store', async importOriginal => ({ ...await importOriginal<typeof import('@cauce/store')>(),
  reserveAgentContextWrite: store.reserve, authorizeAgentContextDispatch: store.authorize,
  resolveAgentContextWrite: store.resolve, readAgentContextWrite: store.read }));
const operationId = '00000000-0000-4000-8000-000000000065';
const identity = { generation: 'fixture-generation', container_id: 'fixture-container', writer_instance_id: '00000000-0000-4000-8000-000000000062' };
const path = '/home/dev/account/skills/native-proof/SKILL.md';
const content = '---\nname: native-proof\ndescription: Valid fixture\n---\nRead.\n';
const mutation: NativePieceMutation = { kind: 'skill', id: 'native-proof', action: 'put', expected_sha: null, value: { content } };
const actor: NativeAdminActor = { tenant_id: 'Steven', alias: 'kant', subject: 'console:fixture-human',
  humanAuthority: async () => ({ humanId: 'fixture-human', tenantId: 'Steven', actorAlias: 'kant' }) };
const descriptor = (dispatch: 'reserved' | 'authorized' = 'authorized'): ContextWriteDescriptor => ({ version: 1, operationId,
  token: '00000000-0000-4000-8000-000000000066', generation: '00000000-0000-4000-8000-000000000067', tenantId: 'Steven', alias: 'zeus',
  writer: { runtimeGeneration: identity.generation, containerId: identity.container_id, writerInstanceId: identity.writer_instance_id },
  before: {} as ContextWriteSnapshot, after: {} as ContextWriteSnapshot, dispatch, completion: null,
  documents: [{ name: 'native:skill:native-proof', path, beforeSha: null, targetSha: 'b'.repeat(64) }] });
const receipt = (sha: string | null = 'b'.repeat(64)): Extract<NativeAdminOutcome, { type: 'receipt' }> => ({ type: 'receipt', state: 'done', operation_id: operationId,
  operation_generation: descriptor().generation, identity, kind: 'skill', id: 'native-proof', path, sha, bytes: sha === null ? 0 : Buffer.byteLength(content),
  backup_id: '00000000-0000-4000-8000-000000000068' });
function fixture() {
  const discoveries: { ids: string[] } = { ids: [] };
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => ({ rows: sql.includes('AS operation_id')
    ? discoveries.ids.map(operation_id => ({ operation_id })) : sql.includes('pg_settings') ? [{ timeout_ms: 0 }] : [], rowCount: 1 }));
  const client = { query, release: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  const pool = { connect: async () => client } as unknown as DatabasePool;
  const factsFor = vi.fn<AgentFactsProbe['factsFor']>().mockResolvedValue({ source: 'measured', facts: { harness: 'codex', home: '/home/dev', codexHome: '/home/dev/account',
    generation: identity.generation, containerId: identity.container_id, writerInstanceId: identity.writer_instance_id, features: ['native_admin_v1'] } });
  const nativeAdmin = vi.fn<NonNullable<AgentFactsProbe['nativeAdmin']>>(async (_tenant, _alias, command) => command.op === 'prepare'
    ? { type: 'plan', kind: 'skill', id: 'native-proof', path, before_sha: null, target_sha: 'b'.repeat(64), bytes: Buffer.byteLength(content) }
    : receipt());
  const service = createNativeAdminService({ pool, repository: { assertPermission: vi.fn(), authorizeAgentTarget: vi.fn(async () => ({ tenant_id: 'Steven', alias: 'zeus' })) } as unknown as NativeAdminServiceDeps['repository'],
    probe: { factsFor, nativeAdmin, readGovernanceDocument: vi.fn(), listMemoryDirectory: vi.fn() },
    readContext: vi.fn<NativeAdminServiceDeps['readContext']>().mockResolvedValue({ revision: null } as Awaited<ReturnType<NativeAdminServiceDeps['readContext']>>),
    readRuntimeExpectation: vi.fn<NativeAdminServiceDeps['readRuntimeExpectation']>().mockResolvedValue(undefined) });
  store.reserve.mockImplementation(async (_pool, input: { operationId: string; token: string; generation: string }) => ({ ...descriptor('reserved'), operationId: input.operationId, token: input.token, generation: input.generation }));
  store.authorize.mockImplementation(async (_pool, value: ContextWriteDescriptor) => ({ ...value, dispatch: 'authorized' }));
  store.read.mockResolvedValue(descriptor());
  store.resolve.mockImplementation(async (_pool, value: ContextWriteDescriptor, proof: (client: unknown) => Promise<{ documents: { sha: string | null }[] }>, persist: (client: unknown) => Promise<void>) => {
    const received = await proof(client);
    if (received.documents[0]?.sha === value.documents[0]?.targetSha) { await persist(client); return 'target'; }
    if (received.documents[0]?.sha === value.documents[0]?.beforeSha) return 'old';
    throw new StoreError('conflict', 'fixture unexpected disk state');
  });
  return { service, client, nativeAdmin, factsFor, discoveries };
}
beforeEach(() => { vi.resetAllMocks(); });
it('retains the operation id when reservation readback cannot confirm the durable commit', async () => {
  const f = fixture(); store.reserve.mockRejectedValueOnce(new StoreError('conflict', 'PRIVATE_SENTINEL', 'context_write_commit_unverified'));
  await expect(f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia', identity)).rejects.toSatisfy((error: unknown) =>
    error instanceof NativeAdminError && error.code === 'unavailable' && /^[a-f0-9-]{36}$/u.test(error.operationId ?? ''));
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['prepare']);
});
it('retains the operation id after failed dispatch instead of encouraging another mutation', async () => {
  const f = fixture(); store.authorize.mockRejectedValueOnce(new StoreError('conflict', 'dispatch fixture failure'));
  await expect(f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia', identity)).rejects.toSatisfy((error: unknown) =>
    error instanceof NativeAdminError && error.code === 'unavailable' && /^[a-f0-9-]{36}$/u.test(error.operationId ?? ''));
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['prepare']);
});
it('rejects a prepared path outside the measured native profile before reserving a write', async () => {
  const f = fixture(); f.nativeAdmin.mockResolvedValueOnce({ type: 'plan', kind: 'skill', id: 'native-proof', path: '/tmp/auth.json', before_sha: null, target_sha: 'b'.repeat(64), bytes: Buffer.byteLength(content) });
  await expect(f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia', identity)).rejects.toMatchObject({ code: 'unavailable' });
  expect(store.reserve).not.toHaveBeenCalled();
});
it('resolves a native write only after matching the reservation and a second authenticated receipt', async () => {
  const f = fixture();
  f.nativeAdmin.mockImplementation(async (_tenant, _alias, command) => {
    if (command.op === 'prepare') return { type: 'plan', kind: 'skill', id: 'native-proof', path, before_sha: null, target_sha: 'b'.repeat(64), bytes: Buffer.byteLength(content) };
    if (command.op !== 'mutate' && command.op !== 'status') return { type: 'error', error: 'invalid_input' };
    return { ...receipt(), operation_id: command.operation.operation_id, operation_generation: command.operation.operation_generation };
  });
  expect(await f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia', identity)).toMatchObject({ state: 'written_pending_reload' });
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['prepare', 'mutate', 'status']);
  expect(store.resolve).toHaveBeenCalledOnce();
});
it('reconciles an undispatched reservation through status and old without issuing mutate', async () => {
  const f = fixture(); store.read.mockResolvedValueOnce(descriptor('reserved')); f.nativeAdmin.mockResolvedValueOnce(receipt(null));
  expect(await f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).toMatchObject({ state: 'not_applied', operation_id: operationId });
  expect(store.authorize).toHaveBeenCalledOnce(); expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['status']);
});
it('recovers target and records metadata without saving document text', async () => {
  const f = fixture(); expect(await f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).toMatchObject({ state: 'written_pending_reload', receipt: receipt() });
  const audit = f.client.query.mock.calls.find(call => call[0].includes('INSERT INTO audit_events'));
  expect(audit).toBeDefined(); expect(JSON.stringify(audit)).not.toContain(content);
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['status']);
});
it('rechecks completed operation receipts idempotently without resolving or replaying the write', async () => {
  const f = fixture(); store.read.mockResolvedValue({ ...descriptor(), completion: { resolution: 'target', proofSha256: 'a'.repeat(64) } });
  for (let index = 0; index < 2; index += 1) expect(await f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).toMatchObject({ state: 'written_pending_reload' });
  expect(store.resolve).not.toHaveBeenCalled(); expect(store.authorize).not.toHaveBeenCalled();
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['status', 'status']);
});
it('rejects private fields in recovery replies before resolving the durable reservation', async () => {
  const f = fixture(); f.nativeAdmin.mockResolvedValueOnce({ ...receipt(), raw_config: 'PRIVATE_SENTINEL' } as unknown as NativeAdminOutcome);
  await expect(f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.client.query.mock.calls.some(call => call[0].includes('INSERT INTO audit_events'))).toBe(false);
});
it('refuses recovery after writer generation changes or for a different native piece', async () => {
  const f = fixture(); store.read.mockResolvedValueOnce({ ...descriptor(), writer: { ...descriptor().writer, runtimeGeneration: 'replaced' } });
  await expect(f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.service.recover(actor, 'Steven', 'zeus', operationId, { ...mutation, id: 'other' })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.nativeAdmin).not.toHaveBeenCalled();
});
it('refuses an original draft identity that was replaced by another account with the same absent piece', async () => {
  const f = fixture();
  await expect(f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia',
    { ...identity, container_id: 'another-account' }, operationId)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.nativeAdmin).not.toHaveBeenCalled(); expect(store.reserve).not.toHaveBeenCalled();
});
it('rejects an incompatible public operation id before prepare or durable reservation for direct service callers', async () => {
  const f = fixture(); const incompatible = '00000000-0000-1000-8000-000000000065';
  await expect(f.service.write(actor, 'Steven', 'zeus', mutation, 'Crear pieza nativa con evidencia', identity, incompatible)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(f.service.discover(actor, 'Steven', 'zeus', mutation, identity, incompatible)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(f.service.recover(actor, 'Steven', 'zeus', incompatible, mutation)).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.nativeAdmin).not.toHaveBeenCalled(); expect(store.reserve).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled();
});
it('binds provider recognition to the original or freshly reloaded writer even when the piece hash is unchanged', async () => {
  const f = fixture();
  await expect(f.service.recognize(actor, 'Steven', 'zeus', 'skill', 'native-proof', 'b'.repeat(64),
    { ...identity, writer_instance_id: '00000000-0000-4000-8000-000000000069' })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.nativeAdmin).not.toHaveBeenCalled();
  f.nativeAdmin.mockResolvedValueOnce({ type: 'recognition', kind: 'skill', id: 'native-proof', sha: 'b'.repeat(64),
    state: 'available_for_new_session', reason: 'provider_read_verified' });
  expect(await f.service.recognize(actor, 'Steven', 'zeus', 'skill', 'native-proof', 'b'.repeat(64), identity)).toMatchObject({ identity,
    outcome: { state: 'available_for_new_session' } });
});
it('discovers only scoped native document and measured writer metadata without exposing the reservation token', async () => {
  const f = fixture(); f.discoveries.ids = [operationId];
  const discovered = await f.service.discover(actor, 'Steven', 'zeus', mutation, identity);
  expect(discovered).toEqual({ tenant_id: 'Steven', alias: 'zeus', identity, state: 'pending', operation_id: operationId });
  expect(JSON.stringify(discovered)).not.toContain(descriptor().token);
  const query = f.client.query.mock.calls.find(call => call[0].includes('AS operation_id'));
  expect(query?.[1]).toEqual(['Steven', 'zeus', 'native:skill:native-proof', path, null,
    identity.generation, identity.container_id, identity.writer_instance_id, null]);
  expect(query?.[0]).toContain("($9::uuid IS NULL AND status='running')"); expect(store.reserve).not.toHaveBeenCalled();
});
it('discovers a completed original id without selecting another historical operation', async () => {
  const f = fixture(); f.discoveries.ids = [operationId];
  store.read.mockResolvedValueOnce({ ...descriptor(), completion: { resolution: 'target', proofSha256: 'a'.repeat(64) } });
  expect(await f.service.discover(actor, 'Steven', 'zeus', mutation, identity, operationId)).toMatchObject({ operation_id: operationId });
  expect(f.client.query.mock.calls.find(call => call[0].includes('AS operation_id'))?.[1]?.[8]).toBe(operationId);
  expect(f.nativeAdmin).not.toHaveBeenCalled();
});
it('fences a request that never reached reservation using its same public id and status old without issuing mutate', async () => {
  const f = fixture(); store.read.mockResolvedValue(descriptor('reserved'));
  expect(await f.service.discover(actor, 'Steven', 'zeus', mutation, identity, operationId)).toMatchObject({ state: 'pending', operation_id: operationId });
  const reserveInput: unknown = store.reserve.mock.calls[0]?.[1]; expect(reserveInput).toMatchObject({ operationId });
  f.nativeAdmin.mockResolvedValueOnce(receipt(null));
  expect(await f.service.recover(actor, 'Steven', 'zeus', operationId, mutation)).toMatchObject({ state: 'not_applied' });
  expect(f.nativeAdmin.mock.calls.map(call => call[2].op)).toEqual(['prepare', 'status']);
});
it('refuses ambiguous matches, revoked human authority, identity drift and mismatched native reservations', async () => {
  const f = fixture(); f.discoveries.ids = [operationId, '00000000-0000-4000-8000-000000000069'];
  await expect(f.service.discover(actor, 'Steven', 'zeus', mutation, identity)).rejects.toMatchObject({ code: 'conflict' });
  f.discoveries.ids = [operationId]; store.read.mockResolvedValueOnce({ ...descriptor(), writer: { ...descriptor().writer, writerInstanceId: '00000000-0000-4000-8000-000000000069' } });
  await expect(f.service.discover(actor, 'Steven', 'zeus', mutation, identity, operationId)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.service.discover(actor, 'Steven', 'zeus', mutation, { ...identity, generation: 'replaced' }, operationId)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.service.discover({ ...actor, humanAuthority: async () => { throw new Error('revoked'); } }, 'Steven', 'zeus', mutation, identity)).rejects.toThrow('revoked');
  expect(f.nativeAdmin).not.toHaveBeenCalled();
});
