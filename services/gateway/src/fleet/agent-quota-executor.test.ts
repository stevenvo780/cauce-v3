import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentQuotaClaim, AgentQuotaExecution, AgentQuotaReceipt } from '@cauce/protocol';
import { AgentQuotaExecutor, HostChannelAgentQuotaRepository, type AgentQuotaExecutionRepository } from './agent-quota-executor.js';
import { QuotaHostTransportError } from './quota-executor.js';

afterEach(() => { vi.useRealTimers(); });
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
