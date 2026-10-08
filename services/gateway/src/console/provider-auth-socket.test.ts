import { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, type AuthProvider } from '../auth.js';
import { ProviderAuthManager } from './provider-auth.sessions.js';
import { attachProviderAuthSocket } from './provider-auth-socket.js';

class Browser extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: unknown[] = []; reason = '';
  send(data: unknown) { this.sent.push(data); }
  close(_code?: number, reason?: string) { this.reason = reason ?? ''; this.readyState = 3; this.emit('close'); }
  message(value: unknown, binary = false) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), binary); }
}
const actor = { tenant_id: 'Steven', alias: 'kant', subject: 'console:human-1' };
const input = { operation_id: '00000000-0000-4000-8000-000000000050', expected_operation_version: 2, request_id: 'auth-request-one',
  provider_id: 'codex', account_id: 'codex-main', harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'codex-main' };
async function fixture() {
  let emit: ((bytes: Uint8Array) => void) | undefined;
  let revoked = false; let started = false; let written = '';
  const manager = new ProviderAuthManager({ authorize: async () => { if (revoked) throw new Error('revoked'); }, reserve: async () => ({
    stopAdapter: async () => ({ stopped: true }), openLogin: async () => ({ method: 'device', subscribeOutput: listener => { emit = listener; return () => { emit = undefined; }; },
      start: async () => { started = true; emit?.(Buffer.from('SYNTHETIC_PRIVATE_LIVE')); }, write: async bytes => { written += Buffer.from(bytes).toString(); },
      resize: async () => undefined, close: async () => ({ stopped: true }) }), verify: async () => ({ identity_matches: true, functional_call_verified: true }), release: async () => undefined,
  }), audit: async () => undefined }, { ttlMs: 1000 });
  const auth: AuthProvider = { name: 'fixture', mode: 'test', authenticateHello: async () => { throw new AuthError(); }, authenticateHttp: async request => {
    if (revoked || request.headers.cookie !== 'signed-human-cookie') throw new AuthError('PRIVATE_INTERNAL_ERROR');
    return { tenant_id: 'Steven', alias: 'kant', session_id: 'web', channel: 'console', permissions: ['control'], roles: ['operator'],
      operator_profile: { id: actor.subject, display_name: 'Person' } };
  } };
  const session = await manager.start(actor, input); const browser = new Browser();
  const request = { headers: { origin: 'https://cauce.example', cookie: 'signed-human-cookie' }, params: { id: session.session_id }, url: '/private-stream' };
  const connect = () => attachProviderAuthSocket(browser as unknown as WebSocket, request as unknown as FastifyRequest,
    auth, manager, ['https://cauce.example']);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
  return { auth, manager, session, browser, request, connect, tick, revoke: () => { revoked = true; }, state: () => ({ started, written }) };
}
afterEach(() => { vi.useRealTimers(); });
describe('private provider auth websocket', () => {
  it('requires the CSRF-issued one-use ticket before starting login or sending any private output', async () => {
    const f = await fixture(); await f.connect(); expect(f.browser.sent).toEqual([]); expect(f.state().started).toBe(false);
    const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    f.browser.message({ type: 'auth', ticket: ticket.ticket }); await f.tick();
    expect(f.state().started).toBe(true); expect(f.browser.sent.some(value => Buffer.isBuffer(value) && value.toString().includes('PRIVATE'))).toBe(true);
    await expect(f.manager.consumeSocketTicket(actor, f.session.session_id, ticket.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    f.browser.close();
  });
  it.each(['origin', 'cookie', 'query'] as const)('rejects an untrusted %s without private output', async condition => {
    const f = await fixture();
    if (condition === 'origin') f.request.headers.origin = 'https://foreign.example';
    if (condition === 'cookie') f.request.headers.cookie = '';
    if (condition === 'query') f.request.url += '?token=FORGED';
    await f.connect(); expect(f.browser.readyState).toBe(3); expect(f.browser.sent).toEqual([]); expect(f.state().started).toBe(false);
    await f.manager.shutdown();
  });
  it('closes premature binary input and never reflects private admission exceptions', async () => {
    const f = await fixture(); await f.connect(); f.browser.message('PRIVATE_PASSWORD', true); await f.tick();
    expect(f.browser.readyState).toBe(3); expect(f.browser.sent).toEqual([]); expect(f.browser.reason).toBe('provider_auth_closed');
    await f.manager.shutdown();
  });
  it('revalidates the cookie and current scope before sensitive input after admission', async () => {
    const f = await fixture(); const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    await f.connect(); f.browser.message({ type: 'auth', ticket: ticket.ticket }); await f.tick();
    f.revoke(); f.browser.message('PRIVATE_PASSWORD', true); await f.tick();
    expect(f.state().written).toBe(''); expect(f.browser.readyState).toBe(3); await f.manager.shutdown();
  });
  it('expires unused tickets and does not replay earlier output into a second browser', async () => {
    const f = await fixture(); const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 10_001);
    await expect(f.manager.consumeSocketTicket(actor, f.session.session_id, ticket.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(f.browser.sent).toEqual([]); await f.manager.shutdown();
  });
  it('rejects JSON null control without letting an exception escape the socket listener', async () => {
    const f = await fixture(); const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    await f.connect(); f.browser.message({ type: 'auth', ticket: ticket.ticket }); await f.tick();
    expect(() => { f.browser.message('null'); }).not.toThrow(); await f.tick();
    expect(f.browser.readyState).toBe(3); await f.manager.shutdown();
  });
  it('captures the initial ticket while human-cookie authorization is still pending', async () => {
    const f = await fixture(); const original = f.auth.authenticateHttp.bind(f.auth);
    const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    let unlock: (() => void) | undefined;
    let once = true;
    f.auth.authenticateHttp = async request => {
      if (once) { once = false; await new Promise<void>(resolve => { unlock = resolve; }); }
      return original(request);
    };
    const pending = f.connect(); f.browser.message({ type: 'auth', ticket: ticket.ticket });
    unlock?.(); await pending; await f.tick();
    expect(f.state().started).toBe(true); f.browser.close(); await f.manager.shutdown();
  });
  it('closes an idle browser after server-side operation revocation', async () => {
    const f = await fixture(); const ticket = await f.manager.issueSocketTicket(actor, f.session.session_id);
    await f.connect(); f.browser.message({ type: 'auth', ticket: ticket.ticket }); await f.tick();
    await f.manager.revokeOperation(input.operation_id);
    await new Promise(resolve => setTimeout(resolve, 1010));
    expect(f.browser.readyState).toBe(3); expect(f.state().written).toBe(''); await f.manager.shutdown();
  });
});
