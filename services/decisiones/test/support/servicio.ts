import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceConfig } from '../../src/config.js';
import { startService, type RunningService } from '../../src/server.js';
import { FakeJev } from './fake-jev.js';
import { createTestPki, writeIdentities, type IdentityEntry, type TestPki } from './pki.js';

export const TEST_KEY = 'tsk_prueba_0123456789abcdefghijklmnop';

export interface Harness {
  readonly pki: TestPki;
  readonly jev: FakeJev;
  readonly service: RunningService;
  readonly directory: string;
  readonly auditFile: string;
  readonly keyFile: string;
  readonly identitiesFile: string;
  call(client: { cert: string; key: string; ca?: string } | undefined, method: 'GET' | 'POST', path: string, body?: unknown):
    Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  readonly identities?: (pki: TestPki) => IdentityEntry[];
  readonly config?: Partial<ServiceConfig>;
  readonly limits?: Partial<ServiceConfig['limits']>;
  readonly jev?: Partial<ServiceConfig['jev']>;
}

/** The real service on loopback: TLS with mandatory client certs, the test CA and a fake Jev. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pki = createTestPki();
  const directory = mkdtempSync(join(tmpdir(), 'cauce-decisiones-'));
  const jev = new FakeJev();
  await jev.start();
  const keyFile = join(directory, 'typesafe-jev.key');
  writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 });
  const identitiesFile = join(directory, 'mtls_identities.json');
  writeIdentities(identitiesFile, options.identities?.(pki) ?? [{ fingerprint: pki.client('zeus').fingerprint, alias: 'zeus' }]);
  const auditFile = join(directory, 'auditoria', 'auditoria.jsonl');
  const config: ServiceConfig = {
    host: '127.0.0.1', port: 0, healthPort: 0,
    tlsCertFile: pki.serverCert, tlsKeyFile: pki.serverKey, clientCaFile: pki.caCert,
    identitiesFile, allowedAliases: new Set(['*']), allowedTenants: new Set(['Steven']), enabledTemplates: new Set(),
    catalogDir: fileURLToPath(new URL('../../catalogo/', import.meta.url)),
    auditFile, auditMaxBytes: 10 * 1024 * 1024, redact: true,
    jev: { url: jev.url, keyFile, model: 'jev-latest', totalTimeoutMs: 3_000, attemptTimeoutMs: 1_000, maxRounds: 2, hedgeAfterMs: 0, ...(options.jev ?? {}) },
    limits: { perMinute: 600, burst: 100, dailyInputTokens: 1_000_000, dailyInputTokensTotal: 10_000_000, concurrency: 8, concurrencyPerAlias: 8, ...(options.limits ?? {}) },
    ...(options.config ?? {}),
  };
  const service = await startService(config);
  return {
    pki, jev, service, directory, auditFile, keyFile, identitiesFile,
    call(client, method, path, body) {
      return new Promise((resolve, reject) => {
        const outgoing = request({
          host: '127.0.0.1', port: service.port, path, method,
          ca: readFileSync(client?.ca ?? pki.caCert),
          ...(client === undefined ? {} : { cert: readFileSync(client.cert), key: readFileSync(client.key) }),
          headers: { 'content-type': 'application/json' },
        }, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { text += chunk; });
          response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(text || '{}') as Record<string, unknown> }); });
        });
        outgoing.on('error', reject);
        outgoing.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
    async stop() {
      await service.close();
      await jev.stop();
    },
  };
}
