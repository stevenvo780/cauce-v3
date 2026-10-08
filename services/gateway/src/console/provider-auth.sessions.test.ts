import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthManager } from './provider-auth.sessions.js';
import type { ProviderAuthDependencies, ProviderAuthRequest } from './provider-auth.types.js';

const actor = { tenant_id: 'Steven', alias: 'kant', subject: 'console:human-1' };
const input: ProviderAuthRequest = { operation_id: '00000000-0000-4000-8000-000000000050', expected_operation_version: 2, request_id: 'auth-request-one',
  provider_id: 'codex', account_id: 'codex-main', harness_id: 'codex', host_id: 'kratos', runtime_user: 'dev', profile_id: 'codex-main' };
function fixture(options: { stopped?: boolean; loginStopped?: boolean; identity?: boolean; functional?: boolean } = {}) {
  let output: ((bytes: Uint8Array) => void) | undefined;
  let closeCount = 0;
  let released = false;
  let started = false;
  let written = '';
  const audits: unknown[] = [];
  const deps: ProviderAuthDependencies = {
    authorize: async () => undefined,
    reserve: async () => ({
      stopAdapter: async () => ({ stopped: options.stopped ?? true }),
      openLogin: async () => ({ method: 'device', subscribeOutput: (listener) => { output = listener; return () => { output = undefined; }; },
        start: async () => { started = true; }, write: async (bytes) => { written += new TextDecoder().decode(bytes); },
        resize: async () => undefined, close: async () => { closeCount += 1; return { stopped: options.loginStopped ?? true }; } }),
      verify: async () => ({ identity_matches: options.identity ?? true, functional_call_verified: options.functional ?? true }),
      release: async () => { released = true; },
    }),
    audit: async (metadata) => { audits.push(metadata); },
  };
  const manager = new ProviderAuthManager(deps, { ttlMs: 1000 });
  return { manager, deps, audits, emit: (value: string) => { output?.(new TextEncoder().encode(value)); },
    state: () => ({ closeCount, released, started, written }) };
}
afterEach(() => { vi.useRealTimers(); });

describe('sensitive provider bootstrap', () => {
  it('opens without an agent or routing admission and starts only when its exclusive channel attaches', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    expect(session).toMatchObject({ status: 'awaiting_login', method: 'device', operation_id: input.operation_id });
    expect(f.state().started).toBe(false);
    await f.manager.attach(actor, session.session_id, () => undefined);
    expect(f.state().started).toBe(true);
    await f.manager.cancel(actor, session.session_id);
  });
  it('retries an identical request without creating another reservation and rejects changed identity', async () => {
    const f = fixture(); const first = await f.manager.start(actor, input);
    expect(await f.manager.start(actor, input)).toEqual(first);
    await expect(f.manager.start(actor, { ...input, account_id: 'other-account' })).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await f.manager.cancel(actor, first.session_id);
  });
  it('refuses credential interaction when stopping the adapter was not demonstrated', async () => {
    const f = fixture({ stopped: false }); const session = await f.manager.start(actor, input);
    expect(session).toMatchObject({ status: 'failed', error: 'STOP_UNCONFIRMED' });
    expect(f.state()).toMatchObject({ started: false, released: true });
    await expect(f.manager.attach(actor, session.session_id, () => undefined)).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  });
  it('retains only metadata while forwarding live sensitive input/output', async () => {
    const f = fixture(); const received: string[] = []; const session = await f.manager.start(actor, input);
    const channel = await f.manager.attach(actor, session.session_id, (bytes) => { received.push(new TextDecoder().decode(bytes)); });
    await channel.input(new TextEncoder().encode('SYNTHETIC_PRIVATE_PASSWORD'));
    f.emit('SYNTHETIC_PRIVATE_TOKEN');
    expect(received).toEqual(['SYNTHETIC_PRIVATE_TOKEN']);
    expect(f.state().written).toBe('SYNTHETIC_PRIVATE_PASSWORD');
    expect(JSON.stringify(await f.manager.get(actor, session.session_id))).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify(f.audits)).not.toContain('SYNTHETIC_PRIVATE');
    await channel.close();
  });
  it('rejects a second controller and a different human sharing the same alias', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    await f.manager.attach(actor, session.session_id, () => undefined);
    await expect(f.manager.attach(actor, session.session_id, () => undefined)).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await expect(f.manager.get({ ...actor, subject: 'console:human-2' }, session.session_id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await f.manager.cancel(actor, session.session_id);
  });
  it('serializes the same profile across different account requests', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    await expect(f.manager.start(actor, { ...input, request_id: 'auth-request-two', account_id: 'codex-other' })).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await f.manager.cancel(actor, session.session_id);
  });
  it.each([{ identity: false, functional: true, code: 'IDENTITY_MISMATCH' }, { identity: true, functional: false, code: 'FUNCTIONAL_CHECK_FAILED' }])('does not mark authenticated when $code', async (options) => {
    const f = fixture(options); const session = await f.manager.start(actor, input);
    await f.manager.attach(actor, session.session_id, () => undefined);
    expect(await f.manager.verify(actor, session.session_id)).toMatchObject({ status: 'failed', error: options.code });
    expect(f.state().released).toBe(true);
  });
  it('marks authenticated only after identity, a functional call and login process stop are demonstrated', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    await f.manager.attach(actor, session.session_id, () => undefined);
    expect(await f.manager.verify(actor, session.session_id)).toMatchObject({ status: 'authenticated', cleanup_pending: false, error: null });
    expect(f.state()).toMatchObject({ closeCount: 1, released: true });
  });
  it('expires a live channel and refuses further input without extending the deadline', async () => {
    vi.useFakeTimers(); const f = fixture(); const session = await f.manager.start(actor, input);
    const channel = await f.manager.attach(actor, session.session_id, () => undefined);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await f.manager.get(actor, session.session_id)).toMatchObject({ status: 'expired', error: 'SESSION_EXPIRED' });
    await expect(channel.input(new Uint8Array([1]))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(f.state()).toMatchObject({ closeCount: 1, released: true });
  });
  it('revalidates authority on sensitive input and closes revoked sessions', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    const channel = await f.manager.attach(actor, session.session_id, () => undefined);
    f.deps.authorize = async () => { throw new Error('SYNTHETIC_SECRET_IN_AUTH_ERROR'); };
    await expect(channel.input(new Uint8Array([1]))).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(f.state().written).toBe('');
    expect(f.state()).toMatchObject({ closeCount: 1, released: true });
    expect(JSON.stringify(f.audits)).not.toContain('SYNTHETIC_SECRET');
  });
  it('keeps the profile reserved when cancellation cannot confirm login termination', async () => {
    const f = fixture({ loginStopped: false }); const session = await f.manager.start(actor, input);
    await f.manager.attach(actor, session.session_id, () => undefined);
    expect(await f.manager.cancel(actor, session.session_id)).toMatchObject({ status: 'failed', error: 'STOP_UNCONFIRMED', cleanup_pending: true });
    expect(f.state().released).toBe(false);
    await expect(f.manager.start(actor, { ...input, request_id: 'auth-request-two' })).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  });
  it.each(['shutdown', 'revokeOperation'] as const)('retries pending termination during %s', async action => {
    const options = { loginStopped: false };
    const f = fixture(options); const session = await f.manager.start(actor, input);
    await f.manager.attach(actor, session.session_id, () => undefined);
    await f.manager.cancel(actor, session.session_id);
    options.loginStopped = true;
    if (action === 'shutdown') await f.manager.shutdown(); else await f.manager.revokeOperation(input.operation_id);
    expect(f.state().released).toBe(true);
    expect(f.state().closeCount).toBe(2);
  });
  it('rejects arbitrary commands and profile paths before reserving a host', async () => {
    const f = fixture();
    await expect(f.manager.start(actor, { ...input, command: 'sudo sh' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.manager.start(actor, { ...input, profile_id: '/root/.codex' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('does not overwrite demonstrated authentication when the browser channel closes afterwards', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    const channel = await f.manager.attach(actor, session.session_id, () => undefined);
    await f.manager.verify(actor, session.session_id);
    await channel.close();
    expect(await f.manager.get(actor, session.session_id)).toMatchObject({ status: 'authenticated' });
    expect(f.state().closeCount).toBe(1);
  });
  it('releases a reservation that arrives after the opening deadline already expired', async () => {
    vi.useFakeTimers(); const f = fixture(); const original = f.deps.reserve.bind(f.deps);
    let unlock: (() => void) | undefined;
    f.deps.reserve = async (...args) => { await new Promise<void>((resolve) => { unlock = resolve; }); return original(...args); };
    const pending = f.manager.start(actor, input);
    await vi.advanceTimersByTimeAsync(1001);
    unlock?.();
    expect(await pending).toMatchObject({ status: 'expired' });
    expect(f.state()).toMatchObject({ started: false, released: true });
  });
  it('revokes the operation server-side even when its browser has stopped sending input', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    const channel = await f.manager.attach(actor, session.session_id, () => undefined);
    await f.manager.revokeOperation(input.operation_id);
    await expect(channel.input(new Uint8Array([1]))).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    expect(await f.manager.get(actor, session.session_id)).toMatchObject({ status: 'failed', error: 'AUTHORITY_REVOKED' });
    expect(f.state()).toMatchObject({ released: true });
  });
  it('invalidates the previous unused socket ticket when the same human requests a replacement', async () => {
    const f = fixture(); const session = await f.manager.start(actor, input);
    const prior = await f.manager.issueSocketTicket(actor, session.session_id);
    const latest = await f.manager.issueSocketTicket(actor, session.session_id);
    await expect(f.manager.consumeSocketTicket(actor, session.session_id, prior.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await f.manager.consumeSocketTicket(actor, session.session_id, latest.ticket);
    await f.manager.cancel(actor, session.session_id);
  });
});
