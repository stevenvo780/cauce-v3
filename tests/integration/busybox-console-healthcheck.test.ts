import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const busyboxImage = process.env.CAUCE_BUSYBOX_TEST_IMAGE ?? 'nginxinc/nginx-unprivileged:1.27-alpine';
const caPath = '/run/secrets/console_tls_ca';
const tlsWgetCommand = `SSL_CERT_FILE=${caPath} wget -q -O /dev/null`;
const healthcheckCommand = `test -r ${caPath} && ${tlsWgetCommand}`;

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('BusyBox console healthcheck runtime', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-console-health-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('trusts the mounted self-signed CA through SSL_CERT_FILE and rejects it without that trust', async () => {
    const certificatePath = join(directory, 'console-ca.crt');
    const caKeyPath = join(directory, 'console-ca.key');
    const serverCertificatePath = join(directory, 'console.crt');
    const serverKeyPath = join(directory, 'console.key');
    const signingRequestPath = join(directory, 'console.csr');
    const extensionsPath = join(directory, 'console.ext');
    const dockerNetwork = process.env.CAUCE_TEST_DOCKER_NETWORK;
    const targetHost = dockerNetwork
      ? (await execFileAsync('docker', [
        'inspect', '--format', `{{with index .NetworkSettings.Networks "${dockerNetwork}"}}{{.IPAddress}}{{end}}`,
        process.env.HOSTNAME ?? '',
      ])).stdout.trim()
      : 'localhost';
    if (!targetHost) throw new Error('could not resolve the test runner address for the Docker network');
    const subjectAlternativeName = isIP(targetHost) ? `IP:${targetHost}` : `DNS:${targetHost}`;
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-subj', '/CN=Cauce console test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', caKeyPath, '-out', certificatePath,
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    await execFileAsync('openssl', [
      'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-subj', `/CN=${targetHost}`, '-keyout', serverKeyPath, '-out', signingRequestPath,
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    await writeFile(extensionsPath, [
      `subjectAltName=${subjectAlternativeName}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'));
    await execFileAsync('openssl', [
      'x509', '-req', '-in', signingRequestPath,
      '-CA', certificatePath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-sha256', '-days', '1', '-extfile', extensionsPath, '-out', serverCertificatePath,
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const server = createServer({
      cert: await readFile(serverCertificatePath),
      key: await readFile(serverKeyPath),
    }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok\n');
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('test HTTPS server did not expose a TCP address'));
          return;
        }
        resolve(address.port);
      });
    });
    const certificate = await readFile(certificatePath, 'utf8');
    const commonArguments = [
      'run', '--rm', '--network', dockerNetwork ?? 'host',
      '--tmpfs', '/run/secrets:rw,noexec,nosuid,mode=0777,size=1m',
      '--env', `CAUCE_TEST_CONSOLE_CA=${certificate}`,
      '--entrypoint', 'sh', busyboxImage, '-c',
    ];
    const installCa = `printf '%s' "$CAUCE_TEST_CONSOLE_CA" > ${caPath} && chmod 0444 ${caPath} && `;
    const targetUrl = `https://${targetHost}:${port}/`;
    try {
      await expect(execFileAsync('docker', [
        ...commonArguments,
        `${installCa}${healthcheckCommand} ${targetUrl}`,
      ], { timeout: 30_000 })).resolves.toBeDefined();
      await expect(execFileAsync('docker', [
        ...commonArguments,
        `${healthcheckCommand} ${targetUrl}`,
      ], { timeout: 30_000 })).rejects.toBeDefined();
      await expect(execFileAsync('docker', [
        ...commonArguments,
        `${tlsWgetCommand} ${targetUrl}`,
      ], { timeout: 30_000 })).rejects.toBeDefined();
      await expect(execFileAsync('docker', [
        ...commonArguments,
        `${installCa}wget -q -O /dev/null ${targetUrl}`,
      ], { timeout: 30_000 })).rejects.toBeDefined();
    } finally {
      await close(server);
    }
  }, 90_000);
});
