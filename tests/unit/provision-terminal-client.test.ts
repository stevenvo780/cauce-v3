import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const provisioner = join(repository, 'ops/scripts/provision-terminal-client.sh');
const scratch: string[] = [];
const hasOpenSsl = spawnSync('openssl', ['version']).status === 0;

function openssl(arguments_: string[], cwd: string) {
  const result = spawnSync('openssl', arguments_, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-pki-'));
  scratch.push(directory);
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-client-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', 'ca.key', '-out', 'ca.crt',
  ], directory);
  await chmod(join(directory, 'ca.key'), 0o400);
  const output = join(directory, 'issued');
  const environment = {
    ...process.env,
    CAUCE_CLIENT_CA_CERT: join(directory, 'ca.crt'),
    CAUCE_CLIENT_CA_KEY: join(directory, 'ca.key'),
  };
  return { directory, environment, output };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!hasOpenSsl)('terminal client provisioner', () => {
  test.each(['gateway-relay-client', 'terminal-relay-client'])('issues exact clientAuth identity %s', async (commonName) => {
    const { environment, output } = await fixture();
    const result = spawnSync('bash', [provisioner, commonName, output], { env: environment, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('BEGIN');
    const key = join(output, `${commonName}.key`);
    const certificate = join(output, `${commonName}.crt`);
    expect((await stat(key)).mode & 0o777).toBe(0o400);
    expect((await stat(certificate)).mode & 0o777).toBe(0o444);
    expect((await stat(key)).uid).toBe(1000);
    expect(openssl(['x509', '-in', certificate, '-noout', '-subject', '-nameopt', 'RFC2253'], output).trim())
      .toBe(`subject=CN=${commonName}`);
    expect(openssl(['x509', '-in', certificate, '-noout', '-text'], output))
      .toContain('TLS Web Client Authentication');
  });

  test('refuses overwrite and preserves the existing credential byte-for-byte', async () => {
    const { environment, output } = await fixture();
    const first = spawnSync('bash', [provisioner, 'gateway-relay-client', output], {
      env: environment,
      encoding: 'utf8',
    });
    expect(first.status).toBe(0);
    const certificate = join(output, 'gateway-relay-client.crt');
    const before = await readFile(certificate);
    const second = spawnSync('bash', [provisioner, 'gateway-relay-client', output], {
      env: environment,
      encoding: 'utf8',
    });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already exists');
    expect(await readFile(certificate)).toEqual(before);
  });

  test('rejects a mismatched signing key without publishing a leaf', async () => {
    const { directory, environment, output } = await fixture();
    openssl(['genpkey', '-algorithm', 'RSA', '-out', 'wrong.key', '-pkeyopt', 'rsa_keygen_bits:2048'], directory);
    await chmod(join(directory, 'wrong.key'), 0o400);
    const result = spawnSync('bash', [provisioner, 'terminal-relay-client', output], {
      env: { ...environment, CAUCE_CLIENT_CA_KEY: join(directory, 'wrong.key') },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('do not match');
    await expect(stat(join(output, 'terminal-relay-client.crt'))).rejects.toThrow();
  });
});
