import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = join(repository, 'ops/scripts/validate-terminal-release.py');
const scratch: string[] = [];
const hasOpenSsl = spawnSync('openssl', ['version']).status === 0;

function openssl(arguments_: string[], cwd: string) {
  const result = spawnSync('openssl', arguments_, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function certificate(directory: string, name: string, commonName: string, purpose: 'clientAuth' | 'serverAuth') {
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${commonName}`, '-keyout', `${name}.key`, '-out', `${name}.csr`], directory);
  await writeFile(
    join(directory, `${name}.ext`),
    `extendedKeyUsage=${purpose}\nsubjectAltName=DNS:${commonName}\n`,
  );
  openssl([
    'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-days', '2', '-extfile', `${name}.ext`, '-out', `${name}.crt`,
  ], directory);
  await chmod(join(directory, `${name}.key`), 0o400);
  await chmod(join(directory, `${name}.crt`), 0o444);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-release-'));
  scratch.push(directory);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.crt'], directory);
  await certificate(directory, 'gateway-relay-client', 'gateway-relay-client', 'clientAuth');
  await certificate(directory, 'relay-client', 'terminal-relay-client', 'clientAuth');
  await certificate(directory, 'gateway-server', 'gateway', 'serverAuth');
  await certificate(directory, 'relay-server', 'terminal-relay', 'serverAuth');
  const document = {
    services: {
      gateway: {
        environment: {
          CAUCE_TERMINAL_ENABLED: '1',
          CAUCE_TERMINAL_RELAY_URL: 'https://terminal-relay:8446',
        },
        secrets: [
          { source: 'gateway_tls_cert' },
          { source: 'gateway_tls_key' },
          { source: 'gateway_relay_client_cert' },
          { source: 'gateway_relay_client_key' },
        ],
      },
      'terminal-relay': {
        environment: {
          CAUCE_TERMINAL_RELAY_CONSOLE_CN: 'console-client,gateway-relay-client',
          CAUCE_TERMINAL_CLOSE_SPOOL_FILE: '/var/lib/cauce-terminal/close-reports.json',
        },
        volumes: [
          { type: 'volume', source: 'terminal_close_spool', target: '/var/lib/cauce-terminal' },
        ],
        secrets: [
          { source: 'terminal_relay_tls_cert' },
          { source: 'terminal_relay_tls_key' },
          { source: 'terminal_gateway_client_cert' },
          { source: 'terminal_gateway_client_key' },
          { source: 'gateway_client_ca' },
        ],
      },
    },
    secrets: {
      gateway_relay_client_cert: { file: join(directory, 'gateway-relay-client.crt') },
      gateway_relay_client_key: { file: join(directory, 'gateway-relay-client.key') },
      terminal_gateway_client_cert: { file: join(directory, 'relay-client.crt') },
      terminal_gateway_client_key: { file: join(directory, 'relay-client.key') },
      gateway_client_ca: { file: join(directory, 'ca.crt') },
      gateway_tls_cert: { file: join(directory, 'gateway-server.crt') },
      gateway_tls_key: { file: join(directory, 'gateway-server.key') },
      terminal_relay_tls_cert: { file: join(directory, 'relay-server.crt') },
      terminal_relay_tls_key: { file: join(directory, 'relay-server.key') },
    },
  };
  const compose = join(directory, 'compose.json');
  await writeFile(compose, `${JSON.stringify(document)}\n`);
  return { directory, compose, document };
}

function run(compose: string) {
  return spawnSync('python3', [gate, '--compose-json', compose], { encoding: 'utf8' });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!hasOpenSsl)('terminal production release gate', () => {
  test('accepts distinct CA-verified clientAuth identities and the exact CN list', async () => {
    const { compose } = await fixture();
    const result = run(compose);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('terminal release gate passed');
  });

  test('rejects a CN list that drops the console principal or duplicates gateway-relay-client', async () => {
    const { compose, document } = await fixture();
    document.services['terminal-relay'].environment.CAUCE_TERMINAL_RELAY_CONSOLE_CN = 'gateway-relay-client,gateway-relay-client';
    await writeFile(compose, `${JSON.stringify(document)}\n`);
    const result = run(compose);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unique safe comma-separated names');
  });

  test('rejects a certificate without clientAuth EKU', async () => {
    const { directory, compose, document } = await fixture();
    await certificate(directory, 'wrong-purpose', 'gateway-relay-client', 'serverAuth');
    document.secrets.gateway_relay_client_cert.file = join(directory, 'wrong-purpose.crt');
    document.secrets.gateway_relay_client_key.file = join(directory, 'wrong-purpose.key');
    await writeFile(compose, `${JSON.stringify(document)}\n`);
    const result = run(compose);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OpenSSL certificate validation failed');
  });

  test('rejects an ephemeral close-report spool', async () => {
    const { compose, document } = await fixture();
    document.services['terminal-relay'].volumes = [];
    await writeFile(compose, `${JSON.stringify(document)}\n`);
    const result = run(compose);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('writable named volume');
  });

  test('rejects a relay server certificate without the internal DNS SAN', async () => {
    const { directory, compose, document } = await fixture();
    await certificate(directory, 'wrong-relay-server', 'wrong-relay', 'serverAuth');
    document.secrets.terminal_relay_tls_cert.file = join(directory, 'wrong-relay-server.crt');
    document.secrets.terminal_relay_tls_key.file = join(directory, 'wrong-relay-server.key');
    await writeFile(compose, `${JSON.stringify(document)}\n`);
    const result = run(compose);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('certificate SAN does not match terminal-relay');
  });
});
