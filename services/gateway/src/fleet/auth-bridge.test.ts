import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthDependencies, ProviderAuthRequest } from '../console/provider-auth.types.js';
import { HostProviderAuthService } from './auth-bridge-client.js';
import { startAuthBridge } from './auth-bridge-server.js';

const actor = { subject: 'console:11111111-1111-4111-8111-111111111111', tenant_id: 'Steven', alias: 'operator' };
const input: ProviderAuthRequest = { operation_id: '22222222-2222-4222-8222-222222222222', expected_operation_version: 0,
  request_id: 'bridge-test', provider_id: 'codex', account_id: 'account', harness_id: 'codex', host_id: 'fixture',
  runtime_user: 'dev', profile_id: 'profile' };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-bridge-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let output: ((bytes: Uint8Array) => void) | undefined;
  let stopped = false; let inputBytes = ''; let allowed = true;
  const dependencies: ProviderAuthDependencies = {
    authorize: async who => { if (!allowed || who.subject !== actor.subject) throw new Error('denied'); },
    audit: async () => undefined,
    reserve: async () => ({
      stopAdapter: async () => ({ stopped: true }),
      verify: async () => ({ identity_matches: true, functional_call_verified: true }),
      release: async () => { stopped = true; },
      openLogin: async () => ({ method: 'device',
        subscribeOutput: listener => { output = listener; return () => { output = undefined; }; },
        start: async () => undefined,
        write: async bytes => { inputBytes += Buffer.from(bytes).toString(); },
        resize: async () => undefined, close: async () => ({ stopped: true }) }),
    }),
  };
  const manager = new ProviderAuthManager(dependencies);
  const socketPath = join(directory, 'api.sock');
  const app = await startAuthBridge(socketPath, manager); cleanup.push(() => app.close());
  const client = new HostProviderAuthService(socketPath, { ownerUid: (process.geteuid?.() ?? -1) }); cleanup.push(() => client.shutdown());
  return { client, emit: (value: string) => { output?.(Buffer.from(value)); }, revoke: () => { allowed = false; },
    state: () => ({ stopped, inputBytes }) };
}
describe('private host authentication transport', () => {
  it('rejects writable ancestry before sending the human identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-bridge-writable-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await chmod(directory, 0o777);
    let received = false;
    const socketPath = join(directory, 'api.sock');
    const server = createServer((_request, response) => { received = true; response.end('{}'); });
    await new Promise<void>(resolve => { server.listen(socketPath, resolve); });
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); }));
    await chmod(socketPath, 0o666);
    const client = new HostProviderAuthService(socketPath, { ownerUid: (process.geteuid?.() ?? -1) });
    await expect(client.start(actor, input)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(received).toBe(false);
    await expect(startAuthBridge(join(directory, 'other.sock'), new ProviderAuthManager({} as ProviderAuthDependencies)))
      .rejects.toThrow('socket');
  });
  it('rejects a symlink in the socket path', async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'fleet-bridge-link-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await symlink('/var/tmp', join(directory, 'alias'));
    const client = new HostProviderAuthService(join(directory, 'alias', 'api.sock'), { ownerUid: (process.geteuid?.() ?? -1) });
    await expect(client.start(actor, input)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await f.client.shutdown();
  });
  it('carries a session and transient terminal bytes over a real Unix socket with current authority', async () => {
    const f = await fixture(); const session = await f.client.start(actor, input);
    const ticket = await f.client.issueSocketTicket(actor, session.session_id);
    await f.client.consumeSocketTicket(actor, session.session_id, ticket.ticket);
    await expect(f.client.consumeSocketTicket(actor, session.session_id, ticket.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    let bytes = '';
    const channel = await f.client.attach(actor, session.session_id, output => { bytes += Buffer.from(output).toString(); });
    await channel.input(Buffer.from('PRIVATE_INPUT'));
    f.emit('PRIVATE_OUTPUT');
    await expect.poll(() => f.state().inputBytes).toBe('PRIVATE_INPUT');
    await expect.poll(() => bytes).toBe('PRIVATE_OUTPUT');
    f.revoke();
    await expect(f.client.verify(actor, session.session_id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect.poll(() => f.state().stopped).toBe(true);
    await channel.close();
  });
  it('rejects a different human and reports an unavailable host without leaking payloads', async () => {
    const f = await fixture(); const session = await f.client.start(actor, input);
    await expect(f.client.get({ ...actor, subject: 'console:33333333-3333-4333-8333-333333333333' }, session.session_id))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const missing = new HostProviderAuthService('/var/tmp/cauce-fleet-nonexistent.sock');
    await expect(missing.start(actor, input)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});
