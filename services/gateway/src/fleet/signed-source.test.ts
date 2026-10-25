import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPACE_BACKUP_CHUNK_BYTES, SignedHostRequestSchema, hostRequestMessage } from '@cauce/store';
import { SignedHostChannel } from './signed-source.js';
import { QuotaHostTransportError } from './quota-executor.js';

let directory: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server?.close(error => { if (error) reject(error); else resolve(); }); });
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined; directory = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(gateway: string) {
  directory = await mkdtemp(join(tmpdir(), 'cauce-signed-channel-'));
  const key = generateKeyPairSync('ed25519');
  const der = key.publicKey.export({ type: 'spki', format: 'der' });
  await writeFile(join(directory, 'private.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ enrollment_id: 'ab000000-0000-4000-8000-000000000001',
    company_id: 'company-a', host_id: 'local-a', gateway, state: 'enrolled', executor_ready: false,
    key_fingerprint: createHash('sha256').update(der).digest('hex') }), { mode: 0o600 });
  return { directory, key: createPublicKey({ key: der, format: 'der', type: 'spki' }) };
}
describe('outgoing host channel', () => {
  it('allows a signed 4 MiB backup append only on its exact route and preserves every other body cap', async () => {
    const received: unknown[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      request.on('end', () => { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); response.end('{"offset":4194304}'); });
    });
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const local = await fixture(`http://127.0.0.1:${String(address.port)}`); const channel = await SignedHostChannel.load(local.directory);
    const path = '/v3/fleet/hosts/local-a/space-backups';
    const claim = { id: 'ab000000-0000-4000-8000-000000000002', claim_token: 'ab000000-0000-4000-8000-000000000003', claim_epoch: 1 };
    const append = { action: 'append', claim, offset: 3 * 1024 ** 3, data: Buffer.alloc(SPACE_BACKUP_CHUNK_BYTES, 90).toString('base64') };
    expect(await channel.request('POST', path, append)).toEqual({ offset: SPACE_BACKUP_CHUNK_BYTES });
    const packet = SignedHostRequestSchema.parse(received[0]);
    expect(verify(null, Buffer.from(hostRequestMessage('POST', path, packet)), local.key, Buffer.from(packet.proof, 'base64'))).toBe(true);
    for (const other of ['/v3/fleet/hosts/local-a/channel', `${path}/extra`, '/v3/fleet/hosts/foreign/space-backups']) {
      await expect(channel.request('POST', other, append)).rejects.toThrow('could not be verified');
    }
    await expect(channel.request('POST', path, { ...append, data: Buffer.alloc(SPACE_BACKUP_CHUNK_BYTES + 1, 90).toString('base64') })).rejects.toThrow();
    await expect(channel.request('POST', path, { action: 'finish', claim, padding: 'x'.repeat(262_144) })).rejects.toThrow();
    await expect(channel.request('POST', '/v3/fleet/hosts/local-a/channel', { data: 'x'.repeat(262_144) })).rejects.toThrow();
    expect(received).toHaveLength(1);
  });
  it('extends only a valid own backup finish timeout and propagates caller cancellation', async () => {
    const local = await fixture('https://example.org'); const channel = await SignedHostChannel.load(local.directory);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init); return Response.json({ ready: true }); }));
    const claim = { id: 'ab000000-0000-4000-8000-000000000002', claim_token: 'ab000000-0000-4000-8000-000000000003', claim_epoch: 1 };
    const abort = new AbortController();
    await channel.request('POST', '/v3/fleet/hosts/local-a/space-backups', { action: 'finish', claim }, abort.signal);
    await channel.request('POST', '/v3/fleet/hosts/local-a/channel', { action: 'finish', claim });
    await channel.request('POST', '/v3/fleet/hosts/local-a/space-backups/extra', { action: 'finish', claim });
    await channel.request('POST', '/v3/fleet/hosts/local-a/space-backups', { action: 'finish' });
    expect(timeout.mock.calls.map(call => call[0])).toEqual([1_800_000, 30_000, 30_000, 30_000]);
    abort.abort(); expect(calls[0]?.signal?.aborted).toBe(true);
  });
  it('classifies transport loss separately from HTTP rejection and malformed receipts', async () => {
    let behavior: 'forbidden' | 'invalid' | 'disconnect' = 'forbidden';
    server = createServer((request, response) => {
      if (behavior === 'disconnect') { request.socket.destroy(); return; }
      response.statusCode = behavior === 'forbidden' ? 403 : 200;
      response.end(behavior === 'forbidden' ? '{"error":"forbidden"}' : 'invalid-json');
    });
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const local = await fixture(`http://127.0.0.1:${String(address.port)}`);
    const channel = await SignedHostChannel.load(local.directory); const path = '/v3/fleet/hosts/local-a/channel';
    await expect(channel.request('POST', path, {})).rejects.not.toBeInstanceOf(QuotaHostTransportError);
    behavior = 'invalid';
    await expect(channel.request('POST', path, {})).rejects.not.toBeInstanceOf(QuotaHostTransportError);
    behavior = 'disconnect';
    await expect(channel.request('POST', path, {})).rejects.toBeInstanceOf(QuotaHostTransportError);
  });
  it('sends interoperable signed numbers and fresh nonces without a database credential', async () => {
    const received: unknown[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        response.setHeader('Content-Type', 'application/json'); response.end('{"accepted":true}');
      });
    });
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const local = await fixture(`http://127.0.0.1:${String(address.port)}`);
    const channel = await SignedHostChannel.load(local.directory);
    const path = '/v3/fleet/hosts/local-a/channel';
    for (let index = 0; index < 2; index++) expect(await channel.request('POST', path,
      { action: 'result', remaining_percent: 1.0, tiny: 1e-7, zero: -0 })).toEqual({ accepted: true });
    const packets = received.map(value => SignedHostRequestSchema.parse(value));
    expect(packets[0]?.nonce).not.toBe(packets[1]?.nonce);
    for (const packet of packets) {
      expect(packet.company_id).toBe('company-a'); expect(packet.host_id).toBe('local-a');
      expect(verify(null, Buffer.from(hostRequestMessage('POST', path, packet)), local.key, Buffer.from(packet.proof, 'base64'))).toBe(true);
    }
    await expect(channel.request('POST', '/v3/fleet/hosts/foreign/channel', {})).rejects.toThrow('could not be verified');
    expect(received).toHaveLength(2);
  });
  it('rejects changed keys and public files before attempting a request', async () => {
    const local = await fixture('https://example.org');
    await chmod(join(local.directory, 'private.pem'), 0o644);
    await expect(SignedHostChannel.load(local.directory)).rejects.toThrow('could not be verified');
    await chmod(join(local.directory, 'private.pem'), 0o600);
    const other = generateKeyPairSync('ed25519');
    await writeFile(join(local.directory, 'private.pem'), other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await expect(SignedHostChannel.load(local.directory)).rejects.toThrow('could not be verified');
  });
  it.each(['http://example.org', 'https://user:password@example.org', 'https://example.org/path', 'https://example.org/?token=hidden'])(
    'rejects a gateway with insecure transport or embedded credentials', async gateway => {
      const local = await fixture(gateway);
      await expect(SignedHostChannel.load(local.directory)).rejects.toThrow('could not be verified');
    });
});
