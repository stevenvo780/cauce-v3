import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const composeUrl = new URL('../../deploy/compose.yaml', import.meta.url);
const dockerfileUrl = new URL('../../deploy/Dockerfile', import.meta.url);
const nginxUrl = new URL('../../deploy/console/nginx-console-tls.conf', import.meta.url);
const localProbeUrl = new URL('../../deploy/runtime/local-readiness-probe.mjs', import.meta.url);

async function runProbe(
  url: string,
  timeoutMs = '3000',
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [localProbeUrl.pathname, url, 'ready'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        HEALTH_TIMEOUT_MS: timeoutMs,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

describe('production terminal relay operability contract', () => {
  it('uses semantic loopback readiness and pins one claim lease on both sides', async () => {
    const [compose, dockerfile] = await Promise.all([
      readFile(composeUrl, 'utf8'),
      readFile(dockerfileUrl, 'utf8'),
    ]);
    expect(compose).toContain('CAUCE_TERMINAL_RELAY_HEALTH_PORT: "8085"');
    expect(compose).toContain(
      'test: ["CMD", "node", "deploy/local-readiness-probe.mjs", "http://127.0.0.1:8085/health/ready", "ready"]',
    );
    expect(compose).not.toContain("for(const p of [8445,8446])");
    expect(compose.match(/CAUCE_TERMINAL_CLAIM_LEASE_SECONDS: "150"/gu)).toHaveLength(2);
    expect(dockerfile).toContain('deploy/runtime/readiness-probe.mjs deploy/runtime/local-readiness-probe.mjs');
  });

  it('ships one manifest-pinned relay route and no wildcard/client-selected upstream', async () => {
    const [compose, dockerfile, nginx] = await Promise.all([
      readFile(composeUrl, 'utf8'),
      readFile(dockerfileUrl, 'utf8'),
      readFile(nginxUrl, 'utf8'),
    ]);
    expect(compose).toMatch(/terminal-relay:[\s\S]*?deploy:\n\s+replicas: 1/u);
    expect(compose).toContain('io.cauce.terminal-relay.routing: single-authenticated-instance-v1');
    expect(compose.match(/^\s+CAUCE_TERMINAL_RELAY_INSTANCE_ID:/gmu)).toHaveLength(2);
    expect(nginx).toContain(
      'location = "/v3/console/terminal/relays/${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/ws"',
    );
    expect(nginx).not.toMatch(/location\s+~[\s\S]*terminal\/relays/u);
    expect(nginx).toContain('set $cauce_terminal_relay terminal-relay;');
    expect(nginx).not.toMatch(/proxy_pass[^\n]*(?:\$uri|\$request_uri|\$arg_|\$host)/u);
    expect(dockerfile).toContain('ARG CAUCE_TERMINAL_RELAY_INSTANCE_ID=""');
    expect(dockerfile).toContain('LABEL io.cauce.terminal-relay.instance-id=${CAUCE_TERMINAL_RELAY_INSTANCE_ID}');
    expect(dockerfile).toContain('ARG CAUCE_SCHEMA_COMPATIBLE_THROUGH=037_console_publish_intent_indexes.sql');

    const instanceId = 'a'.repeat(64);
    const rendered = nginx.replaceAll('${CAUCE_TERMINAL_RELAY_INSTANCE_ID}', instanceId);
    expect(rendered).toContain(`location = "/v3/console/terminal/relays/${instanceId}/ws"`);
    expect(rendered).not.toContain(`/v3/console/terminal/relays/${'b'.repeat(64)}/ws`);
  });

  it('executes the DB-free local probe in production mode and rejects false green bodies', async () => {
    let body = '{"status":"ready"}\n';
    let status = 200;
    let hang = false;
    const server = createServer((_request, response) => {
      if (hang) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`))
        .resolves.toEqual({ code: 0, stderr: '' });
      body = '{"status":"live"}\n';
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`))
        .resolves.toMatchObject({ code: 1 });
      body = '{"status":"ready","stale":true}\n';
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`))
        .resolves.toMatchObject({ code: 1 });
      body = '{"status":"ready"';
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`))
        .resolves.toMatchObject({ code: 1 });
      status = 201;
      body = '{"status":"ready"}\n';
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`))
        .resolves.toMatchObject({ code: 1 });
      await expect(runProbe(`http://example.invalid:${port}/health/ready`))
        .resolves.toMatchObject({ code: 1 });
      status = 200;
      hang = true;
      await expect(runProbe(`http://127.0.0.1:${port}/health/ready`, '50'))
        .resolves.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
