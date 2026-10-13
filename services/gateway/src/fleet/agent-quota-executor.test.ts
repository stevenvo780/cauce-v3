import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentQuotaClaim, AgentQuotaExecution, AgentQuotaReceipt } from '@cauce/protocol';
import { AgentQuotaExecutor, HostChannelAgentQuotaRepository, type AgentQuotaExecutionRepository } from './agent-quota-executor.js';
import { QuotaHostTransportError } from './quota-executor.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';

const stderr = vi.fn<typeof process.stderr.write>().mockReturnValue(true);
beforeEach(() => { stderr.mockClear(); vi.spyOn(process.stderr, 'write').mockImplementation(stderr); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const claim: AgentQuotaClaim = { id: randomUUID(), tenant_id: 'Canary', alias: 'agent', worker_id: 'host-canary',
    claim_token: randomUUID(), claim_epoch: 1 };
  const execution: AgentQuotaExecution = { operation_id: claim.id, action: 'query', agent: {
    operation_id: claim.id, expected_revision: 0, company_id: 'canary', tenant_id: claim.tenant_id, alias: claim.alias,
    harness_id: 'codex', host_id: 'canary', runtime_mode: 'container', container_name: 'zz-canary-quota', runtime_user: 'dev',
    home_directory: '/home/dev', state_directory: '/home/dev/.cauce/canary', runtime_key: 'canary', systemd_user: 'stev', primary_account_id: null,
  } };
  const receipt: AgentQuotaReceipt = { status: 'measured', operation_id: claim.id, tenant: claim.tenant_id, alias: claim.alias,
    host_id: 'canary', container_name: execution.agent.container_name, harness: 'codex', captured_at: new Date().toISOString(),
    provider: 'codex', identity_hash: 'a'.repeat(64), observation_status: 'ok', provider_report: {
      provider: 'codex', ok: true, available: true, available_groups: [], limiting_groups: [], windows: [],
    } };
  const source = { claim: vi.fn().mockResolvedValue(claim), renew: vi.fn().mockResolvedValue(true),
    execution: vi.fn().mockResolvedValue(execution), finish: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    fail: vi.fn().mockResolvedValue({ status: 'failed' }) } satisfies AgentQuotaExecutionRepository;
  return { claim, execution, receipt, source };
}
describe('agent quota executor fenced completion', () => {
  it('rereads its authorized execution and finishes the intact receipt', async () => {
    const { claim, receipt, source } = fixture(); const perform = vi.fn().mockResolvedValue(receipt);
    const worker = new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', perform });
    expect(await worker.runOnce()).toBe(true);
    expect(source.execution).toHaveBeenCalledTimes(2); expect(source.finish).toHaveBeenCalledWith(claim, receipt);
    expect(source.fail).not.toHaveBeenCalled();
  });
  it('rejects placement changes between the reader and durable finish', async () => {
    const { execution, receipt, source } = fixture();
    source.execution.mockResolvedValueOnce(execution).mockResolvedValueOnce({ ...execution,
      agent: { ...execution.agent, container_name: 'replaced' } });
    const worker = new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', perform: async () => receipt });
    expect(await worker.runOnce()).toBe(true); expect(source.finish).not.toHaveBeenCalled();
    expect(source.fail).toHaveBeenCalledWith(expect.anything(), 'STEP_FAILED');
  });
  it('aborts a running reader after lease loss and accepts no terminal writes', async () => {
    vi.useFakeTimers(); const { source } = fixture(); source.renew.mockResolvedValue(false);
    let signal: AbortSignal | undefined;
    let ready: (() => void) | undefined;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const worker = new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', leaseMs: 1000,
      perform: async (_execution, abort) => {
        signal = abort; ready?.();
        return new Promise((_resolve, reject) => { abort.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true }); });
      } });
    const run = worker.runOnce(); await started; await vi.advanceTimersByTimeAsync(334); await run;
    expect(signal?.aborted).toBe(true); expect(source.finish).not.toHaveBeenCalled(); expect(source.fail).not.toHaveBeenCalled();
  });
  it('keeps renewing through a slow terminal acknowledgement and transport retry', async () => {
    vi.useFakeTimers(); const { receipt, source } = fixture();
    let terminalStarted: (() => void) | undefined; let acknowledge: (() => void) | undefined;
    const started = new Promise<void>(resolve => { terminalStarted = resolve; });
    const terminal = new Promise<void>(resolve => { acknowledge = resolve; });
    source.finish.mockImplementation(async () => { terminalStarted?.(); await terminal; return { status: 'succeeded' }; });
    const run = new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', leaseMs: 1000,
      perform: async () => receipt }).runOnce();
    await started; await vi.advanceTimersByTimeAsync(2500);
    expect(source.renew.mock.calls.length).toBeGreaterThan(5);
    acknowledge?.(); await run; expect(source.fail).not.toHaveBeenCalled();
    const renewals = source.renew.mock.calls.length; await vi.advanceTimersByTimeAsync(1000);
    expect(source.renew).toHaveBeenCalledTimes(renewals);
  });
  it('does no work on shutdown and rejects a claim for another target', async () => {
    const { claim, receipt, source } = fixture(); const abort = new AbortController(); abort.abort();
    const options = { worker: 'host-canary', host: 'canary', perform: async () => receipt };
    expect(await new AgentQuotaExecutor(source, { ...options, signal: abort.signal }).runOnce()).toBe(false);
    expect(source.claim).not.toHaveBeenCalled();
    source.claim.mockResolvedValue({ ...claim, alias: 'other' });
    expect(await new AgentQuotaExecutor(source, options).runOnce()).toBe(true); expect(source.finish).not.toHaveBeenCalled();
  });
  it.each([
    [new ProviderAuthError('HOST_UNAVAILABLE'), 'RUNTIME_UNAVAILABLE', 'ProviderAuthError'],
    [new QuotaHostTransportError(), 'RUNTIME_UNAVAILABLE', 'QuotaHostTransportError'],
    [new ProviderAuthError('FUNCTIONAL_CHECK_FAILED'), 'PROVIDER_UNAVAILABLE', 'ProviderAuthError'],
    [new z.ZodError([{ code: 'custom', path: [], message: 'sensitive-validation-message' }]), 'STEP_FAILED', 'ZodError'],
    [Object.assign(new Error('sensitive-provider-response'), { name: 'sensitive-error-name' }), 'PROVIDER_UNAVAILABLE', 'Error'],
  ] as const)('classifies reader failures without logging messages: %s', async (error, code, errorClass) => {
    const { claim, source } = fixture();
    const worker = new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary',
      perform: async () => { throw error; } });
    expect(await worker.runOnce()).toBe(true);
    expect(source.finish).not.toHaveBeenCalled(); expect(source.fail).toHaveBeenCalledWith(claim, code);
    expect(stderr.mock.calls).toEqual([[`${errorClass}\n`]]);
  });
  it.each(['execution', 'recheck', 'finish'] as const)('classifies repository %s rejections as failed steps', async phase => {
    const { claim, execution, receipt, source } = fixture(); const rejection = new Error('sensitive-storage-message');
    if (phase === 'recheck') source.execution.mockResolvedValueOnce(execution).mockRejectedValueOnce(rejection);
    else source[phase].mockRejectedValue(rejection);
    expect(await new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', perform: async () => receipt }).runOnce()).toBe(true);
    expect(source.fail).toHaveBeenCalledWith(claim, 'STEP_FAILED');
    expect(stderr.mock.calls).toEqual([['Error\n']]);
  });
  it.each(['execution', 'recheck', 'finish'] as const)('keeps repository %s transport failures classified as unavailable runtime', async phase => {
    const { claim, execution, receipt, source } = fixture(); const unavailable = new QuotaHostTransportError();
    if (phase === 'recheck') source.execution.mockResolvedValueOnce(execution).mockRejectedValueOnce(unavailable);
    else source[phase].mockRejectedValue(unavailable);
    expect(await new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary', perform: async () => receipt }).runOnce()).toBe(true);
    expect(source.fail).toHaveBeenCalledWith(claim, 'RUNTIME_UNAVAILABLE');
    expect(stderr.mock.calls).toEqual([['QuotaHostTransportError\n']]);
  });
  it('reports a rejected failure receipt without disclosing either error message', async () => {
    const { source } = fixture(); source.fail.mockRejectedValue(new QuotaHostTransportError());
    expect(await new AgentQuotaExecutor(source, { worker: 'host-canary', host: 'canary',
      perform: async () => { throw new Error('sensitive-provider-response'); } }).runOnce()).toBe(true);
    expect(stderr.mock.calls).toEqual([['Error\n'], ['QuotaHostTransportError\n']]);
  });
});
describe('agent quota signed channel completion retry', () => {
  it('retries the same terminal receipt once after an ambiguous transport failure', async () => {
    const { claim, receipt } = fixture();
    const request = vi.fn().mockRejectedValueOnce(new QuotaHostTransportError()).mockResolvedValue({ status: 'succeeded' });
    const source = new HostChannelAgentQuotaRepository({ request }, 'canary');
    await source.finish(claim, receipt); expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });
  it('does not retry a host authorization rejection or accept a mismatched host claim', async () => {
    const { claim, receipt } = fixture(); const request = vi.fn().mockRejectedValue(new Error('forbidden'));
    const source = new HostChannelAgentQuotaRepository({ request }, 'canary');
    await expect(source.finish(claim, receipt)).rejects.toThrow('forbidden'); expect(request).toHaveBeenCalledTimes(1);
    await expect(source.claim('worker', 'other')).rejects.toThrow('differs'); expect(request).toHaveBeenCalledTimes(1);
  });
});
