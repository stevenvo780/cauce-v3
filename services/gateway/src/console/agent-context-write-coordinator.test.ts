import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StoreError } from '@cauce/store';
import type { DatabaseClient, DatabasePool, ContextWriteDescriptor, ContextWriterQuiescence, reserveAgentContextWrite, authorizeAgentContextDispatch, resolveAgentContextWrite } from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import type { AgentFactsProbe } from './agent-documents.routes.js';
import { TerminalRelayFactsProbe } from './agent-documents/relay-probe.js';
import { AgentContextWriteCoordinator } from './agent-context-write-coordinator.js';
import { SondaCompartida, sondaDiferida } from './sonda-compartida.js';

const store = vi.hoisted(() => ({ reserve: vi.fn<typeof reserveAgentContextWrite>(), authorize: vi.fn<typeof authorizeAgentContextDispatch>(), resolve: vi.fn<typeof resolveAgentContextWrite>() }));
vi.mock('@cauce/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cauce/store')>(),
  reserveAgentContextWrite: store.reserve,
  authorizeAgentContextDispatch: store.authorize,
  resolveAgentContextWrite: store.resolve,
}));

function fixture(options: { text?: string; state?: string; feature?: boolean; receiptText?: string } = {}) {
  const text = options.text ?? 'owned file bytes';
  const receiptText = options.receiptText ?? text;
  const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
  const facts = { harness: 'claude' as const, home: '/home/fixture', generation: 'generation-1',
    containerId: 'container-1', writerInstanceId: randomUUID(),
    features: options.feature === false ? [] : ['write_quiescence_v1'] };
  let descriptor: ContextWriteDescriptor;
  const persisted = vi.fn<(client: DatabaseClient, proof: ContextWriterQuiescence, value: string) => Promise<void>>(async () => undefined);
  const dispatched = vi.fn(async () => 'value');
  store.reserve.mockImplementation(async (_pool, input) => {
    const snapshot = { revision: null, profileSha256: null, agentSha256: 'a'.repeat(64), expectation: null };
    descriptor = { ...input, version: 1, before: snapshot, after: snapshot, dispatch: 'reserved', completion: null };
    return descriptor;
  });
  store.authorize.mockImplementation(async (_pool, input) => input);
  store.resolve.mockImplementation(async (_pool, expected, proof, persist) => {
    const client = {} as DatabaseClient;
    const result = await proof(client);
    if (result.documents[0]?.sha === expected.documents[0]?.targetSha) {
      await persist(client, result);
      return 'target';
    }
    return 'old';
  });
  const read = vi.fn(async () => ({ text, bytes: Buffer.byteLength(text), truncated: false,
    sha: hash(text), modified_at: new Date(0).toISOString() }));
  const probe = {
    factsFor: vi.fn(async () => ({ source: 'measured' as const, facts })),
    readGovernanceDocument: read,
    writeStatus: vi.fn(async () => ({
      operation_id: descriptor.operationId, operation_generation: descriptor.generation,
      request_id: descriptor.operationId, runtime_generation: facts.generation,
      writer_instance_id: facts.writerInstanceId, tenant_id: 'TenantA', alias: 'agent',
      container_id: facts.containerId, state: options.state ?? 'done',
      files: [{ path: '/home/fixture/CLAUDE.md', sha: hash(receiptText), bytes: Buffer.byteLength(receiptText) }],
    })) as unknown as NonNullable<AgentFactsProbe['writeStatus']>,
    listMemoryDirectory: vi.fn(),
  };
  const input = { tenantId: 'TenantA' as Tenant, alias: 'agent', expectedRevision: null,
    expectedExpectation: null, documents: [{ name: 'governed-directive', path: '/home/fixture/CLAUDE.md',
      beforeSha: hash('old'), targetSha: hash(text) }], dispatch: dispatched, persistTarget: persisted };
  return { coordinator: new AgentContextWriteCoordinator({} as DatabasePool, probe),
    input, probe, persisted, dispatched, facts };
}

describe('durable context coordinator physical readback', () => {
  it('never dispatches when reservation commit readback is uncertain', async () => {
    const f = fixture();
    store.authorize.mockClear();
    store.reserve.mockRejectedValueOnce(new Error('readback unavailable'));
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'effect_unknown' });
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(store.authorize).not.toHaveBeenCalled();
  });

  it('preserves known CAS conflict before dispatch', async () => {
    const f = fixture();
    store.reserve.mockRejectedValueOnce(new StoreError('conflict', 'snapshot changed'));
    await expect(f.coordinator.coordinate(f.input)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('returns recovery id for a typed uncertain committed reservation', async () => {
    const f = fixture();
    store.reserve.mockRejectedValueOnce(new StoreError('conflict', 'readback unavailable', 'context_write_commit_unverified'));
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'effect_unknown' });
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('requires feature before any reservation or dispatch', async () => {
    const f = fixture({ feature: false });
    store.reserve.mockClear();
    await expect(f.coordinator.coordinate(f.input)).rejects.toThrow('unavailable');
    expect(store.reserve).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('rejects a deferred legacy transport before reserving despite authentic writer feature', async () => {
    const f = fixture();
    const slot = new SondaCompartida();
    slot.instalar({ factsFor: f.probe.factsFor, readGovernanceDocument: f.probe.readGovernanceDocument,
      listMemoryDirectory: f.probe.listMemoryDirectory });
    store.reserve.mockClear();
    const coordinator = new AgentContextWriteCoordinator({} as DatabasePool, sondaDiferida(slot));
    await expect(coordinator.coordinate(f.input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('rejects the mounted relay probe with legacy underlying client before reservation or desired changes', async () => {
    const f = fixture();
    const legacy = { readFile: vi.fn(async () => ({ error: 'unavailable' as const, reason: 'not used' })) };
    const realProbe = new TerminalRelayFactsProbe({ factsFor: f.probe.factsFor }, legacy);
    const slot = new SondaCompartida();
    slot.instalar(realProbe);
    store.reserve.mockClear();
    const updateDesired = vi.fn(async () => undefined);
    const coordinator = new AgentContextWriteCoordinator({} as DatabasePool, sondaDiferida(slot));
    await expect(coordinator.coordinate({ ...f.input, updateDesired })).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(updateDesired).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(legacy.readFile).not.toHaveBeenCalled();
  });

  it('rejects malformed non-null expectation before reservation', async () => {
    const f = fixture();
    store.reserve.mockClear();
    await expect(f.coordinator.coordinate({ ...f.input,
      expectedExpectation: { revision: 0, generation: 'generation-1', documents: [] },
    })).rejects.toThrow('expectation is invalid');
    expect(store.reserve).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('keeps quarantine when complete readback is truncated', async () => {
    const f = fixture();
    f.probe.readGovernanceDocument.mockImplementationOnce(async () => ({ text: 'owned file bytes',
      bytes: 16, truncated: true, sha: f.input.documents[0]?.targetSha ?? '', modified_at: new Date(0).toISOString() }));
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'effect_unknown' });
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it('keeps quarantine if request aborts during physical readback', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.probe.readGovernanceDocument.mockImplementationOnce(async () => {
      controller.abort();
      return { text: 'owned file bytes', bytes: 16, truncated: false,
        sha: f.input.documents[0]?.targetSha ?? '', modified_at: new Date(0).toISOString() };
    });
    expect(await f.coordinator.coordinate({ ...f.input, signal: controller.signal })).toMatchObject({ state: 'effect_unknown' });
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it('maps descriptor names and reads actual complete bytes after receipt', async () => {
    const f = fixture();
    const result = await f.coordinator.coordinate(f.input);
    expect(result).toEqual({ state: 'committed', resolution: 'target', value: 'value' });
    expect(f.probe.readGovernanceDocument).toHaveBeenCalledOnce();
    expect(f.persisted.mock.calls[0]?.[1].documents).toEqual([{ name: 'governed-directive',
      path: '/home/fixture/CLAUDE.md', sha: f.input.documents[0]?.targetSha }]);
  });

  it('retains quarantine when journal matches target but physical bytes differ', async () => {
    const f = fixture({ receiptText: 'different journal bytes' });
    const result = await f.coordinator.coordinate(f.input);
    expect(result.state).toBe('effect_unknown');
    if (result.state === 'effect_unknown') expect(result.operation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it.each(['writing', 'unknown', 'failed_before_effect'])('never releases for state %s', async (state) => {
    const f = fixture({ state });
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'effect_unknown' });
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it('refuses writer replacement during physical read', async () => {
    const f = fixture();
    f.probe.factsFor.mockImplementationOnce(async () => ({ source: 'measured', facts: f.facts }))
      .mockImplementationOnce(async () => ({ source: 'measured', facts: f.facts }))
      .mockImplementationOnce(async () => ({ source: 'measured', facts: { ...f.facts, writerInstanceId: randomUUID() } }));
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'effect_unknown' });
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it('separates all-old resolution from success', async () => {
    const f = fixture({ text: 'old' });
    const document = f.input.documents[0];
    if (document === undefined) throw new Error('missing fixture document');
    document.targetSha = createHash('sha256').update('new').digest('hex');
    expect(await f.coordinator.coordinate(f.input)).toMatchObject({ state: 'not_applied' });
    expect(f.persisted).not.toHaveBeenCalled();
  });

  it('does not dispatch after an already-aborted request', async () => {
    const f = fixture();
    store.reserve.mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(f.coordinator.coordinate({ ...f.input, signal: controller.signal })).rejects.toThrow();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
  });
});
