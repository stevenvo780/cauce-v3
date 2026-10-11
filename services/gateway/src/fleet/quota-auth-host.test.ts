import { describe, expect, it, vi } from 'vitest';
import type { QuotaOperationClaim, QuotaOperationExecution } from '@cauce/store';
import type { ProviderAuthLogin } from '../console/provider-auth.types.js';
import type { QuotaExecutionRepository } from './quota-executor.js';
import type { QuotaEffect } from './quota-host-command.js';
import { QuotaHostAuthentication } from './quota-auth-host.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const claim: QuotaOperationClaim = { id: '23000000-0000-4000-8000-000000000001',
  environment_id: '23000000-0000-4000-8000-000000000002', claim_token: '23000000-0000-4000-8000-000000000003',
  claim_epoch: 1, worker_id: 'worker' };
const execution: QuotaOperationExecution = { operation_id: claim.id, action: 'authenticate', consent: true,
  environment: { id: claim.environment_id, company_id: 'fixture', account_id: 'fixture-account', host_id: 'fixture-host',
    provider: 'codex', container_name: 'cauce-quota-23000000000040008000000000000002' } };
const plan: NonNullable<QuotaEffect['login_plan']> = { operation_id: claim.id, account_scope: 'fixture-account',
  command: ['/usr/local/bin/codex', 'login', '--device-auth'], runtime_user: 'node', home: '/home/node', cwd: '/home/node',
  env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, backend: 'container', state_root: '/fixture/login', ttl_seconds: 600,
  container_binding: { container_id: 'a'.repeat(64), generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64),
    python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' } };
function fixture(verify: (input: QuotaOperationExecution, signal: AbortSignal) => Promise<{
  authenticated_verified: true; account_identity: string;
}>) {
  const repository = { claim: vi.fn(async () => null), renew: vi.fn(async () => true),
    resumeAuthentication: vi.fn(async () => true), execution: vi.fn(async () => execution),
    finish: vi.fn(async () => ({})), fail: vi.fn(async () => ({})) } satisfies QuotaExecutionRepository;
  const login = { method: 'device', close: vi.fn(async () => ({ stopped: true })), start: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), subscribeOutput: () => () => undefined } satisfies ProviderAuthLogin;
  const runtime = new QuotaHostAuthentication({ request: async (_method, _path, payload) => {
    if (payload.action === 'register') return { registered: true };
    return { commands: [{ id: '23000000-0000-4000-8000-000000000004', type: 'verify' }], output_sequence: 0, finished: true };
  } }, repository, { host: 'fixture-host', command: { python: '/usr/bin/python3', executable: '/fixture/fleet-executor.py', policyFile: '/fixture/policy.json' },
    projectRoot: '/fixture', createLogin: async () => login, loginConfiguration: async packet => ({ python: '/usr/bin/python3',
      helper: { executable: '/fixture/helper.py', sha256: 'a'.repeat(64) }, stateRoot: packet.state_root, packet, method: 'device' }), verify });
  return { repository, login, runtime };
}
const proof = { authenticated_verified: true as const, account_identity: 'SYNTHETIC_UNIT_IDENTITY' };
describe('quota authentication host cancellation', () => {
  it('never commits a verified receipt when shutdown starts during the final execution read', async () => {
    const readStarted = deferred<undefined>(); const finalRead = deferred<QuotaOperationExecution>();
    const f = fixture(async () => proof);
    f.repository.execution.mockResolvedValueOnce(execution).mockImplementationOnce(() => {
      readStarted.resolve(undefined); return finalRead.promise;
    });
    await f.runtime.begin(execution, plan, claim, new AbortController().signal);
    await readStarted.promise;
    const shuttingDown = f.runtime.shutdown();
    finalRead.resolve(execution); await shuttingDown;
    expect(f.repository.finish).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledWith(claim, 'STEP_FAILED');
    expect(f.login.close).toHaveBeenCalled();
  });
  it('drains the pending renewal and refuses a lost fence before committing provider proof', async () => {
    vi.useFakeTimers();
    try {
      const verifying = deferred<undefined>(); const verification = deferred<typeof proof>();
      const renewal = deferred<boolean>(); const finalRead = deferred<undefined>(); const failed = deferred<undefined>();
      const f = fixture(async () => { verifying.resolve(undefined); return verification.promise; });
      f.repository.renew.mockImplementationOnce(() => renewal.promise);
      f.repository.fail.mockImplementationOnce(async () => { failed.resolve(undefined); return {}; });
      f.repository.execution.mockResolvedValueOnce(execution).mockImplementationOnce(async () => { finalRead.resolve(undefined); return execution; });
      const handle = await f.runtime.begin(execution, plan, claim, new AbortController().signal);
      await verifying.promise; await vi.advanceTimersByTimeAsync(5000);
      expect(f.repository.renew).toHaveBeenCalledTimes(1);
      verification.resolve(proof); await finalRead.promise;
      expect(f.repository.finish).not.toHaveBeenCalled();
      renewal.resolve(false); await failed.promise; await handle.close();
      expect(f.repository.finish).not.toHaveBeenCalled();
      expect(f.repository.fail).toHaveBeenCalledWith(claim, 'STEP_FAILED');
    } finally { vi.useRealTimers(); }
  });
});
