import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProviderAuthHost } from './agent-provider-auth-host.js';
import type { AgentAuthFence } from './agent-provider-auth-contracts.js';
import * as providerLogin from './provider-login.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function gaps(calls: readonly number[]): number[] {
  return calls.slice(1).map((time, index) => time - (calls[index] ?? time));
}

describe('enrolled host provider authentication polling', () => {
  it.each(['RUNTIME_DRIFT', 'HOST_UNAVAILABLE'] as const)('reconciles awaiting operations without login and reports only %s drift', async code => {
    vi.useFakeTimers();
    const operationId = randomUUID(); const target = { resource: 'agent', tenant_id: 'Test', alias: 'worker' };
    const now = new Date().toISOString();
    const execution = { operation: { id: operationId, request_sha256: 'a'.repeat(64), status: 'awaiting_auth', version: 1,
      target, kind: 'start', actor: { tenant_id: 'Test', alias: 'owner' }, expected_revision: 0, desired_revision: 1,
      applied_revision: null, steps: [], error: null, created_at: now, updated_at: now },
    request: { kind: 'start', target, parameters: {}, expected_revision: 0, idempotency_key: 'synthetic-start' },
    fenced_targets: [target], snapshot: { agents: [], memberships: [], rolePolicies: [] }, trusted_accounts: [] };
    const fence = { operation_id: operationId, operation_epoch: 1, prepared_revision: 1, scope_sha256: 'b'.repeat(64) };
    const query = vi.spyOn(providerLogin, 'queryProviderLoginBinding').mockRejectedValue(new ProviderAuthError(code));
    const receipts: unknown[] = [];
    const channel = { request: vi.fn((_method, _path, payload: { action: string; receipts?: unknown[] }) => {
      if (payload.action === 'reconcile') {
        receipts.push(...payload.receipts ?? []);
        return Promise.resolve({ cursor: operationId, inspections: payload.receipts?.length ? [] : [{ fence, execution }] });
      }
      return Promise.resolve({ commands: [], active_sessions: [] });
    }) };
    const command = { python: '/usr/bin/python3', executable: '/nonexistent/executor', policyFile: '/nonexistent/policy.json' };
    const host = new AgentProviderAuthHost(channel, { authPolicyFile: '/nonexistent/auth.json', projectRoot: '/',
      hostConfig: { host: 'north-host', command } });
    host.start(); await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledWith({ ...command, timeoutMs: 5000 }, execution, expect.any(AbortSignal));
    expect(receipts).toEqual(code === 'RUNTIME_DRIFT' ? [{ ...fence, error: code }] : []);
    await host.shutdown();
  });
  it('backs off to five seconds while idle and polls every 100 ms only while a session is open', async () => {
    vi.useFakeTimers();
    const fence: AgentAuthFence = { operation_id: randomUUID(), session_id: randomUUID(), operation_epoch: 1, prepared_revision: 0,
      scope_sha256: 'a'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() };
    let sessions: AgentAuthFence[] = [];
    const calls: number[] = [];
    const channel = { request: vi.fn((_method, _path, payload: { action: string }) => {
      if (payload.action === 'reconcile') return Promise.resolve({ cursor: null, inspections: [] });
      calls.push(Date.now()); return Promise.resolve({ commands: [], active_sessions: sessions });
    }) };
    const host = new AgentProviderAuthHost(channel, { authPolicyFile: '/nonexistent/auth.json', projectRoot: '/',
      hostConfig: { host: 'north-host', command: { python: '/usr/bin/python3', executable: '/nonexistent/executor', policyFile: '/nonexistent/policy.json' } } });
    host.start();
    await vi.advanceTimersByTimeAsync(17_500);
    expect(gaps(calls)).toEqual([1000, 2000, 4000, 5000, 5000]);
    sessions = [fence];
    await vi.advanceTimersByTimeAsync(5000);
    const opened = calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length - opened).toBe(10);
    expect(gaps(calls.slice(opened - 1))).toEqual(Array.from({ length: 10 }, () => 100));
    sessions = [];
    await vi.advanceTimersByTimeAsync(4000);
    expect(gaps(calls).slice(-2)).toEqual([1000, 2000]);
    await host.shutdown();
  });
});
