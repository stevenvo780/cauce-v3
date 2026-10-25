import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNginxMcpFixture, type NginxMcpFixture } from './mcp-nginx-mtls.fixtures.js';

const execute = promisify(execFile);
const run = randomUUID().slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/l1-login-dispositivo-1025');
const control = `zz-canary-device-log-control-${run}`;
const secretValues = ['QWXR-7K9Z', 'PQRS-2345', 'WXYZ-6789'];
let fixture: NginxMcpFixture | undefined;
let deviceCode = ''; let userCode = '';

function active(): NginxMcpFixture {
  if (!fixture) throw new Error('Device ingress fixture is not initialized');
  return fixture;
}

function responseObject(body: string): Record<string, unknown> {
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { throw new Error('Device ingress returned a non-JSON response'); }
}

async function combinedLogs(kind: 'primary' | 'wrong-ca'): Promise<{ access: string; diagnostics: string }> {
  const own = active();
  const id = own.dockerContainerIds[kind === 'primary' ? 0 : 1];
  if (id === undefined) throw new Error('Owned Nginx container is not initialized');
  try {
    const access = await execute('docker', ['exec', id, 'cat', '/var/log/nginx/access.log'],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    return { diagnostics: await own.nginxLogs(kind), access: access.stdout };
  } catch { throw new Error('Could not read the owned Nginx ingress logs'); }
}

beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  fixture = await startNginxMcpFixture({ passwordAuth: true });
  console.info('DEVICE_NGINX_SOURCE', JSON.stringify({ owner: fixture.owner,
    sourceConfigSha256: fixture.sourceConfigSha256, runtimeConfigSha256: fixture.runtimeConfigSha256,
    dockerContainerIds: fixture.dockerContainerIds, postgresContainerId: fixture.postgresContainerId }));
}, 240_000);

afterAll(async () => { await fixture?.close(); }, 120_000);

describe('device authorization through the real TLS Nginx ingress', () => {
  it('serves both device page variants without redirect and keeps anonymous lookups protected', async () => {
    for (const path of ['/dispositivo', '/dispositivo/']) {
      const response = await active().requestNginx(active().primaryOrigin, `${path}?code=${secretValues[0] ?? ''}`);
      expect(response.status).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/text\/html/u);
    }
    const lookup = await active().requestNginx(active().primaryOrigin, `/v3/auth/device/${secretValues[0] ?? ''}`);
    expect(lookup.status).toBe(401);
  });

  it('creates a real device request and returns polling errors without exposing its codes to logging', async () => {
    const own = active();
    const created = await own.requestNginx(own.primaryOrigin, '/v3/auth/device', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: own.primaryOrigin },
      body: JSON.stringify({ client_name: `zz-canary-device-ingress-${run}` }),
    });
    expect(created.status).toBe(200);
    const grant = responseObject(created.body);
    if (typeof grant.device_code !== 'string' || typeof grant.user_code !== 'string') {
      throw new Error('Device ingress did not return valid authorization codes');
    }
    deviceCode = grant.device_code; userCode = grant.user_code;
    secretValues.push(deviceCode, userCode, userCode.replaceAll('-', ''));
    const lookup = await own.requestNginx(own.primaryOrigin, `/v3/auth/device/${userCode}`);
    expect(lookup.status).toBe(401);
    const page = await own.requestNginx(own.primaryOrigin, `/dispositivo?code=${userCode}`);
    expect(page.status).toBe(200);
    for (const code of [deviceCode, 'A'.repeat(43)]) {
      const polled = await own.requestNginx(own.primaryOrigin, '/v3/auth/device/token', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: own.primaryOrigin },
        body: JSON.stringify({ device_code: code }),
      });
      expect(polled.status).toBe(400);
      const payload = responseObject(polled.body);
      expect(['slow_down', 'authorization_pending', 'invalid_grant'].includes(String(payload.error))).toBe(true);
    }
  });

  it('suppresses sensitive upstream TLS errors while other ingress diagnostics remain available', async () => {
    const own = active();
    const response = await own.requestNginx(own.wrongCaOrigin, `/v3/auth/device/${userCode}`);
    expect(response.status).toBe(502);
    const polled = await own.requestNginx(own.wrongCaOrigin, '/v3/auth/device/token', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: own.wrongCaOrigin },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    expect(polled.status).toBe(502);
    const ordinary = await own.requestNginx(own.primaryOrigin, `/${control}`);
    expect(ordinary.status).toBe(200);
    const diagnostic = await own.requestNginx(own.wrongCaOrigin, `/.well-known/oauth-protected-resource/mcp?control=${control}`);
    expect(diagnostic.status).toBe(502);
  });

  it('rejects oversized headers and malformed URIs before resolving the device location', async () => {
    const own = active();
    const oversized = await own.requestNginx(own.primaryOrigin, `/dispositivo?code=${secretValues[1] ?? ''}`, {
      headers: { cookie: `zz-canary=${'x'.repeat(128 * 1024)}` },
    });
    expect([400, 431].includes(oversized.status)).toBe(true);
    const malformed = await own.requestNginx(own.primaryOrigin, `/dispositivo/%ZZ?code=${secretValues[2] ?? ''}`);
    expect(malformed.status).toBe(400);
    console.info('DEVICE_NGINX_PARSE_ERRORS', JSON.stringify({ oversizedStatus: oversized.status, malformedStatus: malformed.status }));
  });

  it('keeps synthetic and real authorization codes absent from access, error and container logs', async () => {
    const results: Record<string, unknown> = {};
    for (const kind of ['primary', 'wrong-ca'] as const) {
      const channels = await combinedLogs(kind);
      const logs = `${channels.access}\n${channels.diagnostics}`;
      const containsCode = secretValues.map(value => logs.includes(value) || logs.includes(encodeURIComponent(value)));
      const checked = { logControlPresent: logs.includes(control), codesAbsent: containsCode.every(found => !found),
        syntheticAbsent: !containsCode[0], oversizedAbsent: !containsCode[1], malformedAbsent: !containsCode[2],
        realCodesAbsent: containsCode.slice(3).every(found => !found),
        accessCodesAbsent: secretValues.every(value => !channels.access.includes(value)),
        diagnosticCodesAbsent: secretValues.every(value => !channels.diagnostics.includes(value)) };
      results[kind] = checked;
      console.info(`DEVICE_NGINX_LOG_PRIVACY_${kind}`, JSON.stringify(checked));
    }
    await writeFile(join(evidence, `nginx-privacy-${run}.json`), JSON.stringify(results, null, 2));
    for (const result of Object.values(results)) {
      const checked = result as { logControlPresent: boolean; codesAbsent: boolean };
      expect(checked.logControlPresent).toBe(true);
      expect(checked.codesAbsent).toBe(true);
    }
  });
});
