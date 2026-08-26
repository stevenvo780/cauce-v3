import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSelfSignedCert } from '../../../tests/terminal-pty/certs.mjs';
import { HttpsTerminalGatewayClient } from './gateway-client.js';
import { createRelayHealthServer, RelayHealthState } from './health.js';
import { relayInstanceIdFromCertificate, type RelayProcessIdentity } from './relay-identity.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

describe('terminal relay readiness', () => {
  it('requires both listeners and a fresh accepted presence, fails on rejection and shutdown', async () => {
    let now = 1_000;
    let listeners = false;
    const state = new RelayHealthState({
      listenersReady: () => listeners,
      presenceMaxStaleMs: 30_000,
      now: () => now,
    });
    const server = createRelayHealthServer(state);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const request = async (path = '/health/ready'): Promise<Response> => fetch(
      `http://127.0.0.1:${address.port}${path}`,
    );

    expect(await (await request()).json()).toEqual({ status: 'not_ready', reason: 'listener_down' });
    listeners = true;
    expect(await (await request()).json()).toEqual({
      status: 'not_ready', reason: 'presence_not_published',
    });

    state.presenceAccepted();
    expect((await request()).status).toBe(200);
    state.presenceFailed();
    expect(await (await request()).json()).toEqual({
      status: 'not_ready', reason: 'presence_publish_failed',
    });

    state.presenceAccepted();
    now += 30_001;
    expect(await (await request()).json()).toEqual({ status: 'not_ready', reason: 'presence_stale' });
    now += 1;
    state.presenceAccepted();
    state.beginShutdown();
    expect(await (await request()).json()).toEqual({ status: 'not_ready', reason: 'stopping' });
    expect((await request('/health/live')).status).toBe(200);
  });

  it('binds the production health endpoint to loopback, never to the published data interfaces', async () => {
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain("healthServer.listen(config.healthPort, '127.0.0.1'");
    expect(main).not.toMatch(/healthServer\.listen\([^\n]*'0\.0\.0\.0'/u);
  });
});

describe('gateway-accepted presence publication', () => {
  it('accepts only the gateway success contract and surfaces HTTP/body rejection to readiness', async () => {
    const fixture = createSelfSignedCert();
    cleanup.push(async () => rm(fixture.directory, { recursive: true, force: true }));
    const tokenFile = join(fixture.directory, 'relay-token');
    await writeFile(tokenFile, `${'t'.repeat(64)}\n`, { mode: 0o600 });
    const identity: RelayProcessIdentity = {
      relayInstanceId: relayInstanceIdFromCertificate(fixture.cert),
      relayBootId: '11111111-1111-4111-8111-111111111111',
    };
    let response: { readonly status: number; readonly body: string } = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        relay_instance_id: identity.relayInstanceId,
        relay_boot_id: identity.relayBootId,
      }),
    };
    const server = createHttpsServer({ cert: fixture.cert, key: fixture.key }, (request, reply) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v3/terminal/relay/agents');
      expect(request.headers.authorization).toBe(`Bearer ${'t'.repeat(64)}`);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({
          agents: [],
          relay_instance_id: identity.relayInstanceId,
          relay_boot_id: identity.relayBootId,
        });
        reply.writeHead(response.status, { 'content-type': 'application/json' });
        reply.end(response.body);
      });
    });
    const port = await listen(server);
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const gateway = new HttpsTerminalGatewayClient({
      gatewayUrl: `https://localhost:${port}`,
      tokenFile,
      ca: fixture.cert,
      clientCert: fixture.cert,
      clientKey: fixture.key,
      identity,
    });

    await expect(gateway.publishPresence([])).resolves.toBeUndefined();
    response = { status: 200, body: '{"ok":false}' };
    await expect(gateway.publishPresence([])).rejects.toThrow(/did not accept terminal presence/u);
    response = { status: 503, body: '{"ok":true}' };
    await expect(gateway.publishPresence([])).rejects.toThrow(/HTTP 503/u);
    response = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        relay_instance_id: 'b'.repeat(64),
        relay_boot_id: identity.relayBootId,
      }),
    };
    await expect(gateway.publishPresence([])).rejects.toThrow(/did not accept terminal presence/u);
    response = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        relay_instance_id: identity.relayInstanceId,
        relay_boot_id: identity.relayBootId,
        stale: true,
      }),
    };
    await expect(gateway.publishPresence([])).rejects.toThrow(/did not accept terminal presence/u);
    response = { status: 204, body: '' };
    await expect(gateway.publishPresence([])).rejects.toThrow(/HTTP 204/u);
  });
});
