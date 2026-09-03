import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSelfSignedCert } from '../../../tests/terminal-pty/certs.mjs';
import { HttpsTerminalGatewayClient } from './gateway-client.js';
import { createRelayHealthServer, RelayHealthState } from './health.js';
import { TerminalRelayMetrics } from './metrics.js';
import { relayInstanceIdFromCertificate, type RelayProcessIdentity } from './relay-identity.js';

const cleanup: (() => Promise<void>)[] = [];

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
    const metrics = new TerminalRelayMetrics({
      readiness: () => state.ready,
      presenceAcceptedAt: () => state.presenceAcceptedAt,
    });
    const server = createRelayHealthServer(state, {
      port: 0, host: '127.0.0.1', metrics: () => metrics.render(),
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => { resolve(); })));
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const request = async (path = '/health/ready'): Promise<Response> => fetch(
      `http://127.0.0.1:${String(address.port)}${path}`,
    );

    expect(await (await request()).json()).toEqual({ status: 'not_ready', reason: 'listener_down' });
    listeners = true;
    expect(await (await request()).json()).toEqual({
      status: 'not_ready', reason: 'presence_not_published',
    });

    state.presenceAccepted();
    expect((await request()).status).toBe(200);
    expect(await (await request('/metrics')).text()).toContain('cauce_terminal_ready 1');
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
    const scrape = await request('/metrics');
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const exposition = await scrape.text();
    expect(exposition).toContain('cauce_terminal_ready 0');
    expect(exposition).toContain('cauce_terminal_sessions_open{mode="harness_rw"} 0');
    expect(exposition).toContain('# TYPE cauce_terminal_bytes_out_total counter');
    expect(exposition).not.toMatch(/alias|tenant|operator|session_id/u);
    expect((await request('/no-such-route')).status).toBe(404);
    const rejected = await fetch(`http://127.0.0.1:${String(address.port)}/health/live`, {
      method: 'POST',
    });
    expect(rejected.status).toBe(405);
    expect(await rejected.json()).toEqual({ status: 'method_not_allowed' });
  });

  it('deja el listener de salud alcanzable desde el contenedor de Prometheus y sin puerto publicado', async () => {
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(
      /createRelayHealthServer\(healthState, \{\s*port: config\.healthPort,\s*metrics:/u,
    );
    expect(main).not.toMatch(/host: '127\.0\.0\.1'/u);
    expect(main).not.toMatch(/healthServer\.listen\(/u);
    const compose = await readFile(new URL('../../../deploy/compose.yaml', import.meta.url), 'utf8');
    expect(compose).not.toMatch(/:8085:8085/u);

    const prometheus = await readFile(
      new URL('../../../ops/observability/prometheus.yaml', import.meta.url), 'utf8',
    );
    const relayJob = prometheus.slice(prometheus.indexOf('- job_name: cauce-relay'));
    const relayBlock = relayJob.slice(0, relayJob.indexOf('\n  - job_name:'));
    expect(relayBlock).toMatch(/dns_sd_configs:[\s\S]*?names: \[terminal-relay\][\s\S]*?port: 8085/u);
    expect(relayBlock).not.toContain('static_configs');
    const alerts = await readFile(
      new URL('../../../ops/observability/alerts.yaml', import.meta.url), 'utf8',
    );
    const fromTerminal = alerts.slice(alerts.indexOf('- name: cauce-v3-terminal'));
    const terminalGroup = fromTerminal.slice(0, fromTerminal.indexOf('\n  - name:'));
    expect(terminalGroup).toContain('alert: CauceTerminalTargetDown');
    expect(terminalGroup.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n'))
      .not.toContain('absent(');

    const state = new RelayHealthState({ listenersReady: () => true, presenceMaxStaleMs: 30_000 });
    const server = createRelayHealthServer(state, { port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    cleanup.push(async () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }));
    expect((server.address() as AddressInfo).address).not.toBe('127.0.0.1');
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
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => { resolve(); })));
    const gateway = new HttpsTerminalGatewayClient({
      gatewayUrl: `https://localhost:${String(port)}`,
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
