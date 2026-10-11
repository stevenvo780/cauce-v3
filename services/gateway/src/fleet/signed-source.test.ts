import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SignedHostRequestSchema, hostRequestMessage } from '@cauce/store';
import { SignedHostChannel } from './signed-source.js';
import { QuotaHostTransportError } from './quota-executor.js';

let directory: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => { server?.close(error => { if (error) reject(error); else resolve(); }); });
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined; directory = undefined;
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
