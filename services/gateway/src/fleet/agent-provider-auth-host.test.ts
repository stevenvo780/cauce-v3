import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProviderAuthHost } from './agent-provider-auth-host.js';
import type { AgentAuthFence } from './agent-provider-auth-contracts.js';

afterEach(() => { vi.useRealTimers(); });

function gaps(calls: readonly number[]): number[] {
  return calls.slice(1).map((time, index) => time - (calls[index] ?? time));
}

describe('enrolled host provider authentication polling', () => {
  it('backs off to five seconds while idle and polls every 100 ms only while a session is open', async () => {
    vi.useFakeTimers();
    const fence: AgentAuthFence = { operation_id: randomUUID(), session_id: randomUUID(), operation_epoch: 1, prepared_revision: 0,
      scope_sha256: 'a'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() };
    let sessions: AgentAuthFence[] = [];
    const calls: number[] = [];
    const channel = { request: vi.fn(() => { calls.push(Date.now()); return Promise.resolve({ commands: [], active_sessions: sessions }); }) };
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
