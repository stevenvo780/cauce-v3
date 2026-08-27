import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const probePath = join(repositoryRoot, 'deploy/runtime/readiness-probe.mjs');

interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ProbeEnvironment {
  nodeEnv?: string;
  databaseUrl?: string;
  databaseUrlFile?: string;
  postgresCa?: string;
  postgresSslMode?: string;
}

function runProbe(healthUrl: string, environment: ProbeEnvironment): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: environment.nodeEnv ?? 'production',
      HEALTH_TIMEOUT_MS: '3000'
    };
    if (environment.databaseUrl !== undefined) env.DATABASE_URL = environment.databaseUrl;
    if (environment.databaseUrlFile !== undefined) env.DATABASE_URL_FILE = environment.databaseUrlFile;
    if (environment.postgresCa !== undefined) env.PGSSLROOTCERT = environment.postgresCa;
    if (environment.postgresSslMode !== undefined) env.PGSSLMODE = environment.postgresSslMode;

    const child = spawn(process.execPath, [probePath, healthUrl, 'ready'], {
      cwd: repositoryRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assertValueWasNotPrinted(result: ProbeResult, value: string): void {
  if (result.stdout.includes(value) || result.stderr.includes(value)) {
    throw new Error('readiness probe printed a database URL');
  }
}

function listen(server: HttpServer | NetServer): Promise<number> {
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

function close(server: HttpServer | NetServer): Promise<void> {
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
    postgresMessage('Z', Buffer.from('I'))
  ]);
}

function postgresSslResultMessages(): Buffer {
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
    postgresMessage('Z', Buffer.from('I'))
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
      if (type === 'Q') socket.write(postgresSslResultMessages());
      if (type === 'X') socket.end();
    }
  });
}

async function startTlsPostgresDouble(directory: string): Promise<{
  server: NetServer;
  port: number;
  certificatePath: string;
  sockets: Set<Socket>;
}> {
  const certificatePath = join(directory, 'postgres-ca.crt');
  const keyPath = join(directory, 'postgres-server.key');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certificatePath
  ], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  });
  const secureContext = createSecureContext({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath)
  });
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
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
      socket.write('S');
      const secureSocket = new TLSSocket(socket, { isServer: true, secureContext });
      secureSocket.on('error', () => secureSocket.destroy());
      servePostgresProtocol(secureSocket);
    };
    socket.on('data', receiveSslRequest);
  });
  const port = await listen(server);
  return { server, port, certificatePath, sockets };
}

describe('database-aware readiness probe', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-readiness-probe-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps inline DATABASE_URL support for test probes', async () => {
    const hiddenUrl = `postgresql://probe:${randomUUID()}@invalid.test/probe`;
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ready"}');
    });
    const port = await listen(server);
    try {
      const result = await runProbe(`http://127.0.0.1:${port}/health/ready`, {
        nodeEnv: 'test',
        databaseUrl: hiddenUrl
      });
      assertValueWasNotPrinted(result, hiddenUrl);
      expect(result).toEqual({ code: 0, signal: null, stdout: '', stderr: '' });
    } finally {
      await close(server);
    }
  });

  it('fails closed when inline and file database URLs are both configured', async () => {
    const inlineUrl = `postgresql://probe:${randomUUID()}@invalid.test/inline`;
    const fileUrl = `postgresql://probe:${randomUUID()}@invalid.test/file`;
    const databaseUrlFile = join(directory, 'database-url');
    await writeFile(databaseUrlFile, fileUrl, { mode: 0o600 });
    const result = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrl: inlineUrl,
      databaseUrlFile
    });
    assertValueWasNotPrinted(result, inlineUrl);
    assertValueWasNotPrinted(result, fileUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('readiness failed: DATABASE_URL and DATABASE_URL_FILE cannot both be set\n');
  });

  it('rejects empty and multiline database URL files without printing their contents', async () => {
    const databaseUrlFile = join(directory, 'database-url');
    await writeFile(databaseUrlFile, '', { mode: 0o600 });
    const empty = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrlFile
    });
    expect(empty.code).toBe(1);
    expect(empty.stderr).toBe('readiness failed: DATABASE_URL_FILE is empty\n');

    const firstUrl = `postgresql://probe:${randomUUID()}@invalid.test/first`;
    const secondUrl = `postgresql://probe:${randomUUID()}@invalid.test/second`;
    await writeFile(databaseUrlFile, `${firstUrl}\n${secondUrl}\n`, { mode: 0o600 });
    const multiline = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrlFile
    });
    assertValueWasNotPrinted(multiline, firstUrl);
    assertValueWasNotPrinted(multiline, secondUrl);
    expect(multiline.code).toBe(1);
    expect(multiline.stderr).toBe('readiness failed: DATABASE_URL_FILE must contain exactly one line\n');
  });

  it('rejects symlinks, non-regular files, unreadable files, and unsafe permissions', async () => {
    const hiddenUrl = `postgresql://probe:${randomUUID()}@invalid.test/probe`;
    const databaseUrlFile = join(directory, 'database-url');
    const link = join(directory, 'database-url-link');
    await writeFile(databaseUrlFile, hiddenUrl, { mode: 0o600 });
    await symlink(databaseUrlFile, link);

    const linked = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrlFile: link
    });
    assertValueWasNotPrinted(linked, hiddenUrl);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toBe('readiness failed: DATABASE_URL_FILE must not be a symbolic link\n');

    const nonRegular = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrlFile: directory
    });
    expect(nonRegular.code).toBe(1);
    expect(nonRegular.stderr).toBe('readiness failed: DATABASE_URL_FILE must be a regular file\n');

    await chmod(databaseUrlFile, 0o000);
    const unreadable = await runProbe('http://127.0.0.1:9/health/ready', {
      nodeEnv: 'test',
      databaseUrlFile
    });
    assertValueWasNotPrinted(unreadable, hiddenUrl);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toBe('readiness failed: DATABASE_URL_FILE is not readable\n');

    if (process.platform !== 'win32') {
      await chmod(databaseUrlFile, 0o644);
      const unsafe = await runProbe('http://127.0.0.1:9/health/ready', {
        nodeEnv: 'test',
        databaseUrlFile
      });
      assertValueWasNotPrinted(unsafe, hiddenUrl);
      expect(unsafe.code).toBe(1);
      expect(unsafe.stderr).toBe('readiness failed: DATABASE_URL_FILE permissions allow group or other access\n');
    }
  });

  it('does not relax verify-full for a file-backed production URL', async () => {
    const hiddenUrl = `postgresql://probe:${randomUUID()}@127.0.0.1:9/probe?sslmode=require`;
    const databaseUrlFile = join(directory, 'database-url');
    const postgresCa = join(directory, 'postgres-ca.crt');
    await writeFile(databaseUrlFile, hiddenUrl, { mode: 0o600 });
    await writeFile(postgresCa, 'not consulted for a rejected sslmode\n', { mode: 0o600 });
    const result = await runProbe('http://127.0.0.1:9/health/ready', {
      databaseUrlFile,
      postgresCa
    });
    assertValueWasNotPrinted(result, hiddenUrl);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('readiness failed: production PostgreSQL requires sslmode=verify-full\n');
  });

  it('passes a product-like file-backed production TLS and HTTP readiness smoke', async () => {
    const postgres = await startTlsPostgresDouble(directory);
    const healthServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ready"}');
    });
    const healthPort = await listen(healthServer);
    const hiddenUrl = `postgresql://probe:${randomUUID()}@localhost:${postgres.port}/probe`;
    const databaseUrlFile = join(directory, 'database-url');
    await writeFile(databaseUrlFile, `${hiddenUrl}\n`, { mode: 0o600 });
    try {
      const result = await runProbe(`http://127.0.0.1:${healthPort}/health/ready`, {
        databaseUrlFile,
        postgresCa: postgres.certificatePath,
        postgresSslMode: 'verify-full'
      });
      assertValueWasNotPrinted(result, hiddenUrl);
      expect(result).toEqual({ code: 0, signal: null, stdout: '', stderr: '' });
    } finally {
      for (const socket of postgres.sockets) socket.destroy();
      await Promise.all([close(healthServer), close(postgres.server)]);
    }
  }, 15_000);
});
