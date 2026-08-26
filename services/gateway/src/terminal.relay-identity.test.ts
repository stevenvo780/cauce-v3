import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { DatabasePool } from '@cauce/store';
import type { Principal } from './auth.js';
import type { TerminalConfig } from './terminal/config.js';
import { registerTerminalControlPlane } from './terminal/plugin.js';

const RELAY_TOKEN = 'relay-token-that-is-long-enough-for-mtls-test';
const RELAY_BOOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BOOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = await readFile(new URL('./test-fixtures/mtls-server-private.pem', import.meta.url));
const certificate = await readFile(new URL('./test-fixtures/mtls-server-certificate.pem', import.meta.url));
const instanceId = createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');

interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

function post(port: number, payload: Record<string, unknown>, withCertificate = true): Promise<HttpResponse> {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/v3/terminal/relay/agents',
      method: 'POST',
      ca: certificate,
      rejectUnauthorized: true,
      ...(withCertificate ? { cert: certificate, key } : {}),
      headers: {
        authorization: `Bearer ${RELAY_TOKEN}`,
        'content-type': 'application/json',
        'content-length': body.byteLength,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('authenticated terminal-relay identity', () => {
  it('derives the instance id from the verified TLS leaf and fences body claims and duplicate boots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-gateway-relay-mtls-'));
    const grantsFile = join(directory, 'grants.json');
    await writeFile(grantsFile, '{"version":1,"grants":[]}');
    const config: TerminalConfig = {
      wsPath: '/v3/console/terminal/ws',
      ticketKey: Buffer.alloc(32),
      relayToken: RELAY_TOKEN,
      relayInstanceIds: new Set([instanceId]),
      grantsFile,
      ticketTtlSeconds: 30,
      sessionTtlSeconds: 900,
      claimLeaseSeconds: 150,
      maxSessionsPerOperator: 2,
      operatorHeader: 'x-cauce-operator',
      operators: new Set(),
    };
    const principal: Principal = {
      tenant_id: 'Steven', alias: 'kant', session_id: 'test', channel: 'console',
      roles: ['operator'], permissions: ['route', 'read', 'control'],
    };
    const app = Fastify({
      logger: false,
      https: {
        cert: certificate,
        key,
        ca: certificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
    });
    await app.register(registerTerminalControlPlane, {
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DatabasePool,
      authProvider: {
        name: 'test', mode: 'test',
        authenticateHttp: async () => principal,
        authenticateHello: async () => principal,
      },
      config,
      repository: {
        assertPermission: async () => undefined,
        authorizeAgentTarget: async () => undefined,
      },
      measuredFacts: { factsFor: async () => undefined },
      governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'unused' }) },
    });

    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const accepted = await post(port, {
        agents: [], relay_instance_id: instanceId, relay_boot_id: RELAY_BOOT,
      });
      expect(accepted.status).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({
        ok: true, relay_instance_id: instanceId, relay_boot_id: RELAY_BOOT,
      });

      const forgedBody = await post(port, {
        agents: [], relay_instance_id: 'b'.repeat(64), relay_boot_id: RELAY_BOOT,
      });
      expect(forgedBody).toEqual({ status: 401, body: '' });

      const extraField = await post(port, {
        agents: [], relay_instance_id: instanceId, relay_boot_id: RELAY_BOOT, extra: true,
      });
      expect(extraField.status).toBe(400);

      const duplicateBoot = await post(port, {
        agents: [], relay_instance_id: instanceId, relay_boot_id: OTHER_BOOT,
      });
      expect(duplicateBoot.status).toBe(409);
      expect(JSON.parse(duplicateBoot.body)).toEqual({ ok: false, reason: 'relay_boot_conflict' });

      await expect(post(port, {
        agents: [], relay_instance_id: instanceId, relay_boot_id: RELAY_BOOT,
      }, false)).rejects.toThrow(/certificate|socket|tls|reset/i);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
