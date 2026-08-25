import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const probe = join(repository, 'ops/scripts/gate-roundtrip-probe.mjs');
const scratch: string[] = [];
const servers: Server[] = [];

function openssl(arguments_: string[], cwd: string) {
  execFileSync('openssl', arguments_, { cwd, stdio: 'pipe' });
}

async function certificate(
  directory: string,
  name: string,
  commonName: string,
  purpose: 'clientAuth' | 'serverAuth',
  san = '',
) {
  openssl([
    'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', `/CN=${commonName}`, '-keyout', `${name}.key`, '-out', `${name}.csr`,
  ], directory);
  await writeFile(join(directory, `${name}.ext`), [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    `extendedKeyUsage=${purpose}`,
    ...(san ? [`subjectAltName=${san}`] : []),
    '',
  ].join('\n'));
  openssl([
    'x509', '-req', '-sha256', '-days', '2', '-in', `${name}.csr`,
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-extfile', `${name}.ext`, '-out', `${name}.crt`,
  ], directory);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-gate-probe-'));
  scratch.push(directory);
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
    '-subj', '/CN=Cauce Gate Test CA', '-keyout', 'ca.key', '-out', 'ca.crt',
  ], directory);
  await certificate(directory, 'server', 'localhost', 'serverAuth', 'DNS:localhost,IP:127.0.0.1');
  await certificate(directory, 'client', 'quota-collector-gate-test', 'clientAuth');
  await chmod(join(directory, 'client.key'), 0o600);
  const inventory = join(directory, 'inventory.json');
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    aliases: { kant: { tenant: 'Steven', room: 'grp.steven' } },
  })}\n`);
  return {
    directory,
    inventory,
    ca: join(directory, 'ca.crt'),
    cert: join(directory, 'client.crt'),
    key: join(directory, 'client.key'),
    output: join(directory, 'evidence.json'),
  };
}

function run(arguments_: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn('node', [probe, ...arguments_], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function gateway(value: Awaited<ReturnType<typeof fixture>>, response = { delivery_ids: ['00000000-0000-4000-8000-000000000001'] }) {
  let received: Record<string, unknown> | undefined;
  const server = createServer({
    key: await readFile(join(value.directory, 'server.key')),
    cert: await readFile(join(value.directory, 'server.crt')),
    ca: await readFile(value.ca),
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        request.destroy(new TypeError('test HTTPS request emitted a non-binary chunk'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      reply.writeHead(202, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(response));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test HTTPS server has no TCP address');
  return { origin: `https://127.0.0.1:${address.port}`, received: () => received };
}

function environment(value: Awaited<ReturnType<typeof fixture>>, origin: string) {
  return {
    CAUCE_GATE_INVENTORY_FILE: value.inventory,
    CAUCE_GATE_PROBE_URL: origin,
    CAUCE_GATE_PROBE_CA_FILE: value.ca,
    CAUCE_GATE_PROBE_CERT_FILE: value.cert,
    CAUCE_GATE_PROBE_KEY_FILE: value.key,
    CAUCE_GATE_PROBE_HTTP_TIMEOUT_MS: '5000',
    CAUCE_GATE_ROUNDTRIP_TIMEOUT_MS: '5000',
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('authentic mTLS round-trip probe', () => {
  test('publishes one bounded delivery and writes only private correlation evidence', async () => {
    const value = await fixture();
    const endpoint = await gateway(value);
    const result = await run(['kant', value.output], environment(value, endpoint.origin));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('model-free system.gate.probe accepted for kant\n');
    expect(result.stdout).not.toContain('00000000-0000-4000-8000-000000000001');

    const evidence = JSON.parse(await readFile(value.output, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(evidence).sort()).toEqual([
      'alias', 'deliveryId', 'nonce', 'schemaVersion', 'startedAt', 'tenant',
    ]);
    expect((await lstat(value.output)).mode & 0o077).toBe(0);
    const published = endpoint.received() as {
      recipients: Array<{ tenant_id: string; alias: string }>;
      body: { type: string; nonce: string; timeout_ms: number };
      lane: string;
      priority: number;
    };
    expect(published.recipients).toEqual([{ tenant_id: 'Steven', alias: 'kant' }]);
    expect(published.body).toEqual({ type: 'system.gate.probe', nonce: evidence.nonce, timeout_ms: 5000 });
    expect(published.body.timeout_ms).toBe(5000);
    expect(published.lane).toBe('interactive');
    expect(published.priority).toBe(-100);
  });

  test('rejects non-HTTPS origins and exposed private keys without creating evidence', async () => {
    const value = await fixture();
    let result = await run(['kant', value.output], environment(value, 'http://127.0.0.1:1'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('credential-free HTTPS origin');
    expect(await lstat(value.output).catch(() => undefined)).toBeUndefined();

    await chmod(value.key, 0o644);
    result = await run(['kant', value.output], environment(value, 'https://127.0.0.1:1'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must not be group/world accessible');
    expect(await lstat(value.output).catch(() => undefined)).toBeUndefined();
  });

  test('rejects ambiguous acceptance instead of choosing a delivery silently', async () => {
    const value = await fixture();
    const endpoint = await gateway(value, {
      delivery_ids: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    });
    const result = await run(['kant', value.output], environment(value, endpoint.origin));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('did not accept exactly one gate delivery');
    expect(await lstat(value.output).catch(() => undefined)).toBeUndefined();
  });
});
