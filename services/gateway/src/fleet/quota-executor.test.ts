import { describe, expect, it, vi } from 'vitest';
import type { QuotaOperationClaim, QuotaOperationExecution } from '@cauce/store';
import { HostChannelQuotaRepository, QuotaExecutor, QuotaHostTransportError, type QuotaExecutionRepository } from './quota-executor.js';
import type { QuotaEffect } from './quota-host-command.js';

const claim: QuotaOperationClaim = { id: '21000000-0000-4000-8000-000000000001', environment_id: '21000000-0000-4000-8000-000000000002',
  claim_token: '21000000-0000-4000-8000-000000000003', claim_epoch: 1, worker_id: 'worker' };
const environment = { id: claim.environment_id, company_id: 'fixture', account_id: 'fixture-account', host_id: 'fixture-host',
  provider: 'codex', container_name: 'cauce-quota-21000000000040008000000000000002' };
const execution: QuotaOperationExecution = { operation_id: claim.id, action: 'create', consent: false, environment };
const created: QuotaEffect = { runtime_verified: true, container_name: environment.container_name, cli_version: 'codex-cli 1.2.3' };
const login: NonNullable<QuotaEffect['login_plan']> = { operation_id: claim.id, command: ['/usr/local/bin/codex','login','--device-auth'],
  runtime_user: 'node', home: '/home/node', cwd: '/home/node', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, backend: 'container',
  state_root: '/fixture/login', account_scope: 'fixture-account', ttl_seconds: 600,
  container_binding: { container_id: 'a'.repeat(64), generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64),
    python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' } };
function fixture(input = execution) {
  const repository = { claim: vi.fn(async () => claim), renew: vi.fn(async () => true),
    execution: vi.fn(async () => input), resumeAuthentication: vi.fn(async () => true),
    finish: vi.fn(async () => ({})), fail: vi.fn(async () => undefined) } satisfies QuotaExecutionRepository;
  return repository;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe('quota work inside the existing fleet host loop', () => {
  it.each(['create', 'authenticate'] as const)('never publishes %s after shutdown during its final authority read', async action => {
    const input = { ...execution, action, consent: action === 'authenticate' };
    const repository = fixture(input); const current = deferred<QuotaOperationExecution>(); const reading = deferred<undefined>();
    repository.execution.mockResolvedValueOnce(input).mockImplementationOnce(async () => { reading.resolve(undefined); return current.promise; });
    const shutdown = new AbortController(); const beginAuthentication = vi.fn();
    const worker = new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', signal: shutdown.signal,
      perform: async () => action === 'create' ? created : { awaiting_auth: true, login_plan: login }, beginAuthentication });
    const running = worker.runOnce(); await reading.promise;
    shutdown.abort(); current.resolve(input); await running;
    expect(repository.finish).not.toHaveBeenCalled(); expect(repository.fail).not.toHaveBeenCalled();
    expect(beginAuthentication).not.toHaveBeenCalled();
  });
  it('never starts an external effect after shutdown during the initial authority read', async () => {
    const repository = fixture(); const current = deferred<QuotaOperationExecution>(); const reading = deferred<undefined>();
    repository.execution.mockImplementationOnce(async () => { reading.resolve(undefined); return current.promise; });
    const shutdown = new AbortController(); const perform = vi.fn(async () => created);
    const running = new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', signal: shutdown.signal, perform }).runOnce();
    await reading.promise; shutdown.abort(); current.resolve(execution); await running;
    expect(perform).not.toHaveBeenCalled(); expect(repository.finish).not.toHaveBeenCalled(); expect(repository.fail).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'create' as const, valid: true }, { action: 'create' as const, valid: false },
    { action: 'authenticate' as const, valid: true }, { action: 'authenticate' as const, valid: false },
  ])('drains renewal before $action completion and preserves only a valid auth handoff ($valid)', async ({ action, valid }) => {
    vi.useFakeTimers();
    try {
      const input = { ...execution, action, consent: action === 'authenticate' }; const repository = fixture(input);
      const renewal = deferred<boolean>(); const renewing = deferred<undefined>(); const effect = deferred<QuotaEffect>(); const performing = deferred<undefined>();
      repository.renew.mockImplementationOnce(async () => { renewing.resolve(undefined); return renewal.promise; });
      const handle = { public_result: { expires_at: new Date(Date.now() + 600_000).toISOString() }, close: vi.fn(async () => undefined) };
      const running = new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', leaseMs: 1000,
        perform: async () => { performing.resolve(undefined); return effect.promise; }, beginAuthentication: async () => handle }).runOnce();
      await performing.promise; await vi.advanceTimersByTimeAsync(334); await renewing.promise;
      effect.resolve(action === 'create' ? created : { awaiting_auth: true, login_plan: login });
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.finish).not.toHaveBeenCalled();
      renewal.resolve(valid); await running;
      expect(repository.finish).toHaveBeenCalledTimes(valid ? 1 : 0);
      expect(repository.fail).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledTimes(action === 'authenticate' && !valid ? 1 : 0);
    } finally { vi.useRealTimers(); }
  });
  it('rechecks the execution and persists only the scoped create receipt', async () => {
    const repository = fixture();
    const worker = new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', perform: async () => created });
    expect(await worker.runOnce()).toBe(true);
    expect(repository.execution).toHaveBeenCalledTimes(2);
    expect(repository.finish).toHaveBeenCalledWith(claim, created);
    expect(repository.fail).not.toHaveBeenCalled();
  });
  it('refuses incomplete effects and an execution that changes while the command runs', async () => {
    const incomplete = fixture();
    await new QuotaExecutor(incomplete, { worker: 'worker', host: 'fixture-host', perform: async () => ({}) }).runOnce();
    expect(incomplete.finish).not.toHaveBeenCalled(); expect(incomplete.fail).toHaveBeenCalledWith(claim,'STEP_FAILED');
    const changed = fixture();
    vi.mocked(changed.execution).mockResolvedValueOnce(execution).mockResolvedValueOnce({ ...execution, action: 'delete' });
    await new QuotaExecutor(changed, { worker: 'worker', host: 'fixture-host', perform: async () => created }).runOnce();
    expect(changed.finish).not.toHaveBeenCalled(); expect(changed.fail).toHaveBeenCalled();
  });
  it('cancels the running command when the claim loses its lease and never publishes its receipt', async () => {
    vi.useFakeTimers();
    try {
      const repository = fixture(); vi.mocked(repository.renew).mockResolvedValue(false);
      const worker = new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', leaseMs: 1000,
        perform: (_execution, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { resolve(created); }, { once: true }); }) });
      const running = worker.runOnce(); await vi.advanceTimersByTimeAsync(334); await running;
      expect(repository.finish).not.toHaveBeenCalled(); expect(repository.fail).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('does not fabricate an auth session when the broker callback is unavailable', async () => {
    const repository = fixture({ ...execution, action: 'authenticate', consent: true });
    await new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host',
      perform: async () => ({ awaiting_auth: true, login_plan: login }) }).runOnce();
    expect(repository.finish).not.toHaveBeenCalled(); expect(repository.fail).toHaveBeenCalledWith(claim,'PROVIDER_UNAVAILABLE');
  });
  it('publishes only public broker data and closes an auth session whose receipt could not be persisted', async () => {
    const input = { ...execution, action: 'authenticate' as const, consent: true }; const repository = fixture(input);
    const handle = { public_result: { login_url: 'https://provider.fixture.invalid/device', user_code: 'EXAMPLE-123',
      expires_at: new Date(Date.now()+600_000).toISOString() }, close: vi.fn(async () => undefined) };
    const options = { worker: 'worker', host: 'fixture-host', perform: async () => ({ awaiting_auth: true as const, login_plan: login }),
      beginAuthentication: vi.fn(async () => handle) };
    await new QuotaExecutor(repository, options).runOnce();
    expect(repository.finish).toHaveBeenCalledWith(claim, handle.public_result, true); expect(handle.close).not.toHaveBeenCalled();
    vi.mocked(repository.finish).mockRejectedValue(new Error('fence replaced'));
    await new QuotaExecutor(repository, options).runOnce(); expect(handle.close).toHaveBeenCalledTimes(1);
  });
  it('keeps the signed route shapes and sends no browser worker identity', async () => {
    const request = vi.fn(async (_method: 'POST', _path: string, payload: Record<string, unknown>): Promise<unknown> => {
      if (payload.action === 'claim') return { claim };
      if (payload.action === 'execution') return execution;
      if (payload.action === 'renew') return { renewed: true };
      if (payload.action === 'resume_auth') return { resumed: true };
      return {};
    });
    const repository = new HostChannelQuotaRepository({ request },'fixture-host');
    expect(await repository.claim('ignored','fixture-host')).toEqual(claim);
    expect(request).toHaveBeenLastCalledWith('POST','/v3/fleet/hosts/fixture-host/channel',
      { resource: 'quota_environment', action: 'claim', lease_ms: 30_000 });
    expect(await repository.execution(claim)).toEqual(execution); expect(await repository.renew(claim)).toBe(true);
    expect(await repository.resumeAuthentication(claim)).toBe(true);
    await repository.finish(claim, created);
    expect(request.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'finish', result: created, awaiting_auth: false });
  });
  it('repeats only the create receipt after its committed response is lost without repeating the external effect', async () => {
    let committed = 0; let finished = 0;
    const request = vi.fn(async (_method: 'POST', _path: string, payload: Record<string, unknown>): Promise<unknown> => {
      if (payload.action === 'claim') return { claim };
      if (payload.action === 'execution') return execution;
      if (payload.action === 'finish') {
        finished += 1;
        expect(payload).toMatchObject({ claim, result: created, awaiting_auth: false });
        if (committed === 0) { committed += 1; throw new QuotaHostTransportError(); }
        return { operation_id: claim.id, status: 'done' };
      }
      throw new Error('unexpected host command');
    });
    const repository = new HostChannelQuotaRepository({ request },'fixture-host');
    const perform = vi.fn(async () => created);
    await new QuotaExecutor(repository, { worker: 'worker', host: 'fixture-host', perform }).runOnce();
    expect(perform).toHaveBeenCalledTimes(1); expect(committed).toBe(1); expect(finished).toBe(2);
    expect(request.mock.calls.some(call => call[2].action === 'fail')).toBe(false);
  });
  it('repeats the same fenced failure receipt once on transport loss', async () => {
    const request = vi.fn<(_method: 'POST', _path: string, payload: Record<string, unknown>) => Promise<unknown>>()
      .mockRejectedValueOnce(new QuotaHostTransportError()).mockResolvedValueOnce({ operation_id: claim.id, status: 'failed' });
    const repository = new HostChannelQuotaRepository({ request },'fixture-host');
    expect(await repository.fail(claim, 'STEP_FAILED')).toEqual({ operation_id: claim.id, status: 'failed' });
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });
  it('never retries an authorization/validation error or exceeds one retry on transport failure', async () => {
    for (const error of [new Error('authorization rejected'), new QuotaHostTransportError()]) {
      const request = vi.fn(async (): Promise<unknown> => { throw error; });
      const repository = new HostChannelQuotaRepository({ request },'fixture-host');
      await expect(repository.finish(claim, created)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(error instanceof QuotaHostTransportError ? 2 : 1);
    }
  });
});
