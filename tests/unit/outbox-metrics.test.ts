import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const outboxMetricsPath = join(repositoryRoot, 'deploy/outbox-metrics.mjs');
const runtimePackageSmokePath = join(repositoryRoot, 'deploy/runtime-package-smoke.mjs');
const runtimeDockerfilePath = join(repositoryRoot, 'deploy/Dockerfile');

interface PostgresDouble {
  server: Server;
  port: number;
  sockets: Set<Socket>;
  tlsRequests: () => number;
}

interface RunningOutbox {
  child: ChildProcessWithoutNullStreams;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stdout: string; stderr: string };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function postgresMessage(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.write(type, 0, 1, 'ascii');
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function postgresReadyMessages(): Buffer {
  const authentication = Buffer.alloc(4);
  authentication.writeInt32BE(0);
  return Buffer.concat([
    postgresMessage('R', authentication),
    postgresMessage('Z', Buffer.from('I')),
  ]);
}

function postgresQueryMessages(): Buffer {
  const field = Buffer.alloc(18);
  field.writeInt32BE(0, 0);
  field.writeInt16BE(0, 4);
  field.writeInt32BE(16, 6);
  field.writeInt16BE(1, 10);
  field.writeInt32BE(-1, 12);
  field.writeInt16BE(0, 16);
  const fieldCount = Buffer.alloc(2);
  fieldCount.writeInt16BE(1);
  const rowDescription = Buffer.concat([fieldCount, Buffer.from('ssl\0'), field]);
  const dataRow = Buffer.alloc(7);
  dataRow.writeInt16BE(1, 0);
  dataRow.writeInt32BE(1, 2);
  dataRow.write('t', 6, 1, 'ascii');
  return Buffer.concat([
    postgresMessage('T', rowDescription),
    postgresMessage('D', dataRow),
    postgresMessage('C', Buffer.from('SELECT 1\0')),
    postgresMessage('Z', Buffer.from('I')),
  ]);
}

function servePostgresProtocol(socket: TLSSocket): void {
  let pending = Buffer.alloc(0);
  let startupComplete = false;
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= (startupComplete ? 5 : 4)) {
      if (!startupComplete) {
        const length = pending.readInt32BE(0);
        if (length < 8) {
          socket.destroy(new Error('invalid PostgreSQL startup packet'));
          return;
        }
        if (pending.length < length) return;
        pending = pending.subarray(length);
        startupComplete = true;
        socket.write(postgresReadyMessages());
        continue;
      }

      const length = pending.readInt32BE(1);
      if (length < 4) {
        socket.destroy(new Error('invalid PostgreSQL message'));
        return;
      }
      const messageLength = length + 1;
      if (pending.length < messageLength) return;
      const type = pending.toString('ascii', 0, 1);
      pending = pending.subarray(messageLength);
      if (type === 'Q') socket.write(postgresQueryMessages());
      if (type === 'X') socket.end();
    }
  });
}

async function startTlsPostgresDouble(directory: string): Promise<PostgresDouble & { certificatePath: string }> {
  const certificatePath = join(directory, 'postgres-ca.crt');
  const keyPath = join(directory, 'postgres-server.key');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certificatePath,
  ], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const secureContext = createSecureContext({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  });
  const sockets = new Set<Socket>();
  let tlsRequests = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    const receiveSslRequest = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 8) return;
      socket.off('data', receiveSslRequest);
      if (pending.readInt32BE(0) !== 8 || pending.readInt32BE(4) !== 80_877_103) {
        socket.destroy(new Error('expected PostgreSQL SSL request'));
        return;
      }
      tlsRequests += 1;
      socket.write('S');
      const secureSocket = new TLSSocket(socket, { isServer: true, secureContext });
      secureSocket.on('error', () => secureSocket.destroy());
      servePostgresProtocol(secureSocket);
    };
    socket.on('data', receiveSslRequest);
  });
  const port = await listen(server);
  return { server, port, certificatePath, sockets, tlsRequests: () => tlsRequests };
}

async function startPlainPostgresDouble(): Promise<PostgresDouble> {
  const sockets = new Set<Socket>();
  let tlsRequests = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (message: Buffer) => {
      if (message.length >= 8 && message.readInt32BE(0) === 8 && message.readInt32BE(4) === 80_877_103) {
        tlsRequests += 1;
        socket.end('N');
      } else {
        socket.destroy(new Error('expected PostgreSQL SSL request'));
      }
    });
  });
  const port = await listen(server);
  return { server, port, sockets, tlsRequests: () => tlsRequests };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function startOutboxMetrics(options: {
  directory: string;
  databaseUrl: string;
  postgresCa: string;
}): Promise<RunningOutbox> {
  const loaderPath = await writeStoreLoader(options.directory);
  const port = await reservePort();
  const child = spawn(process.execPath, [
    '--no-warnings', '--experimental-loader', loaderPath, outboxMetricsPath,
  ], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'production',
      NODE_NO_WARNINGS: '1',
      DATABASE_URL: options.databaseUrl,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: options.postgresCa,
      PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, port, exited, output: () => ({ stdout, stderr }) };
}

async function writeStoreLoader(directory: string): Promise<string> {
  const loaderPath = join(directory, 'store-loader.mjs');
  const storeUrl = pathToFileURL(join(repositoryRoot, 'packages/store/src/db.ts')).href;
  await writeFile(loaderPath, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../packages/store/dist/db.js') return { url: ${JSON.stringify(storeUrl)}, shortCircuit: true };
  return nextResolve(specifier, context);
}\n`);
  return loaderPath;
}

async function waitForReady(process: RunningOutbox): Promise<Response> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.child.exitCode !== null) {
      throw new Error(`outbox metrics exited before readiness: ${process.output().stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${process.port}/health/ready`);
      if (response.status === 200) return response;
    } catch {
      // Startup includes a separate PostgreSQL TLS assertion before HTTP listen.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`outbox metrics did not become ready: ${process.output().stderr}`);
}

async function stop(process: RunningOutbox): Promise<void> {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('outbox metrics did not stop')), 5_000).unref();
  });
  await Promise.race([process.exited, timeout]);
}

async function closePostgres(postgres: PostgresDouble): Promise<void> {
  for (const socket of postgres.sockets) socket.destroy();
  await close(postgres.server);
}

describe('outbox metrics PostgreSQL TLS', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-outbox-metrics-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('imports the compiled store by runtime layout and keeps the hardened TLS pool', async () => {
    const source = await readFile(outboxMetricsPath, 'utf8');
    const dockerfile = await readFile(runtimeDockerfilePath, 'utf8');
    expect(source).toContain("import { createPool } from '../packages/store/dist/db.js';");
    expect(source).not.toContain("from '@cauce/store'");
    expect(dockerfile).toContain('/app/dist/packages/store/src ./packages/store/dist');
    expect(dockerfile).toContain('RUN node deploy/runtime-package-smoke.mjs');
    expect(source).toContain('createPool(connectionString, { max: 2 })');
    expect(source).toContain('await assertProductionPostgresTls();');
    expect(source).toContain('await pool.end();');
    expect(source).not.toMatch(/new\s+Pool\s*\(/u);
  });

  it('is imported and validated by the runtime smoke without starting the server', async () => {
    const smokeSource = await readFile(runtimePackageSmokePath, 'utf8');
    expect(smokeSource).toContain("['outbox metrics', './outbox-metrics.mjs', 'startOutboxMetrics']");

    const loaderPath = await writeStoreLoader(directory);
    const moduleUrl = pathToFileURL(outboxMetricsPath).href;
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--no-warnings',
      '--experimental-loader', loaderPath,
      '--input-type=module',
      '--eval',
      `const runtimeModule = await import(${JSON.stringify(moduleUrl)});
       if (typeof runtimeModule.startOutboxMetrics !== 'function') process.exit(2);
       process.stdout.write('outbox metrics import passed\\n');`,
    ], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
      },
      timeout: 5_000,
    });
    expect(stdout).toBe('outbox metrics import passed\n');
    expect(stderr).toBe('');
  });

  it('keeps readiness on verify-full with a self-signed CA for both database connections', async () => {
    const postgres = await startTlsPostgresDouble(directory);
    const hiddenPassword = randomUUID();
    const outbox = await startOutboxMetrics({
      directory,
      databaseUrl: `postgresql://metrics:${hiddenPassword}@localhost:${postgres.port}/metrics`,
      postgresCa: postgres.certificatePath,
    });
    try {
      const response = await waitForReady(outbox);
      expect(await response.json()).toEqual({ status: 'ready' });
      expect(postgres.tlsRequests()).toBeGreaterThanOrEqual(2);
      expect(outbox.output().stdout).not.toContain(hiddenPassword);
      expect(outbox.output().stderr).not.toContain(hiddenPassword);
    } finally {
      await stop(outbox);
      await closePostgres(postgres);
    }
  }, 15_000);

  it('rejects a PostgreSQL endpoint that refuses TLS', async () => {
    const postgres = await startPlainPostgresDouble();
    const certificatePath = join(directory, 'unused-ca.crt');
    await writeFile(certificatePath, 'unused because the server refuses TLS\n');
    const hiddenPassword = randomUUID();
    const outbox = await startOutboxMetrics({
      directory,
      databaseUrl: `postgresql://metrics:${hiddenPassword}@localhost:${postgres.port}/metrics`,
      postgresCa: certificatePath,
    });
    try {
      const result = await Promise.race([
        outbox.exited,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('outbox metrics accepted plaintext PostgreSQL')), 5_000).unref();
        }),
      ]);
      expect(result.code).not.toBe(0);
      expect(postgres.tlsRequests()).toBe(1);
      expect(outbox.output().stdout).not.toContain(hiddenPassword);
      expect(outbox.output().stderr).not.toContain(hiddenPassword);
    } finally {
      if (outbox.child.exitCode === null && outbox.child.signalCode === null) outbox.child.kill('SIGKILL');
      await closePostgres(postgres);
    }
  }, 10_000);
});
