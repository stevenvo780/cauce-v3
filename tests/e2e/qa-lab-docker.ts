import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, unlink } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';

const OWNER = 'qa0-entorno-exploracion-1025';
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker object required');
  return value as JsonObject;
}

function labels(value: unknown, name: string): JsonObject {
  return { ...(value === undefined || value === null ? {} : object(value)),
    'cauce.e2e.owner': OWNER, 'cauce.qa.name': name };
}

function ownedName(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && (value === prefix || value.startsWith(`${prefix}-`));
}

async function readBody(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of message) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Docker create request exceeds the laboratory limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function daemonIdentity(socketPath: string): Promise<{ Name: string; ID: string }> {
  return new Promise((resolve, reject) => {
    const pending = request({ socketPath, path: '/info', timeout: 10_000 }, response => {
      void readBody(response).then(body => {
        const info = object(JSON.parse(body.toString()) as unknown);
        if (response.statusCode !== 200 || typeof info.Name !== 'string' || typeof info.ID !== 'string') {
          throw new Error('Laboratory Docker identity is unavailable');
        }
        resolve({ Name: info.Name, ID: info.ID });
      }).catch(reject);
    });
    pending.on('error', reject);
    pending.on('timeout', () => { pending.destroy(new Error('Laboratory Docker identity timed out')); });
    pending.end();
  });
}

function createBody(path: string, url: URL, body: Buffer, prefix: string, name: string): Buffer {
  const value = object(JSON.parse(body.toString()) as unknown);
  value.Labels = labels(value.Labels, name);
  if (path === '/containers/create') {
    const postgres = typeof value.Image === 'string' && /(?:^|\/)postgres(?=[:@]|$)/u.test(value.Image);
    const existing = url.searchParams.get('name');
    if (!ownedName(existing, prefix)) {
      url.searchParams.set('name', postgres ? `${prefix}-postgres` : `${prefix}-helper-${randomUUID().slice(0, 8)}`);
    }
    if (postgres) {
      const host = value.HostConfig === undefined ? {} : object(value.HostConfig);
      const tmpfs = host.Tmpfs === undefined || host.Tmpfs === null ? {} : object(host.Tmpfs);
      value.HostConfig = { ...host, Tmpfs: { ...tmpfs, '/var/lib/postgresql/data': 'rw,nosuid,nodev,size=1g' } };
    }
  } else if (!ownedName(value.Name, prefix)) {
    throw new Error('Docker resource name is outside the laboratory prefix');
  }
  return Buffer.from(JSON.stringify(value));
}

export async function startQaDocker(prefix: string, directory: string): Promise<{ socket: string; close(): Promise<void> }> {
  const name = process.env.QA_LAB_NAME;
  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(name) || prefix !== `zz-canary-qa-${name}` || !isAbsolute(directory)) {
    throw new Error('Laboratory Docker ownership is invalid');
  }
  const runtime = join('/tmp', `${prefix}-runtime`);
  const raw = process.env.QA_LAB_RAW_SOCKET;
  const socket = join(runtime, 'docker.sock');
  if (raw !== join(runtime, 'raw/docker.sock')) throw new Error('Laboratory raw Docker socket path is invalid');
  if (!(await lstat(raw)).isSocket()) throw new Error('Laboratory raw Docker socket is unavailable');
  const identity = await daemonIdentity(raw);
  if (!identity.Name.startsWith(`${prefix}-`) || !identity.ID || identity.ID === process.env.QA_LAB_OUTER_DAEMON_ID) {
    throw new Error('Docker daemon is outside the dedicated laboratory');
  }
  const sockets = new Set<Socket>();
  const track = (connection: Socket) => {
    if (sockets.has(connection)) return;
    sockets.add(connection);
    connection.on('error', () => { connection.destroy(); });
    connection.once('close', () => { sockets.delete(connection); });
  };
  const fail = (response: ServerResponse, status = 502) => {
    if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Laboratory Docker request failed' }));
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/u, '');
      const headers = { ...incoming.headers };
      let body: Buffer | undefined;
      if (incoming.method === 'POST' && ['/containers/create', '/networks/create', '/volumes/create'].includes(path)) {
        body = createBody(path, url, await readBody(incoming), prefix, name);
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
      }
      if (incoming.method === 'POST' && path === '/build') {
        const existing = url.searchParams.get('labels');
        url.searchParams.set('labels', JSON.stringify(labels(existing ? JSON.parse(existing) as unknown : undefined, name)));
      }
      const upstream = request({ socketPath: raw, path: `${url.pathname}${url.search}`, method: incoming.method, headers }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        outgoing.flushHeaders();
        response.on('error', () => { outgoing.destroy(); });
        response.pipe(outgoing);
      });
      upstream.on('socket', track);
      upstream.on('error', () => { fail(outgoing); });
      incoming.once('aborted', () => { upstream.destroy(); });
      outgoing.once('close', () => { if (!outgoing.writableEnded) upstream.destroy(); });
      if (body) upstream.end(body);
      else incoming.pipe(upstream);
    })().catch(() => { fail(outgoing, 400); });
  });
  server.on('connection', track);
  server.on('upgrade', (incoming, client, head) => {
    const remote = createConnection({ path: raw });
    track(remote);
    remote.on('error', () => { client.destroy(); });
    client.once('close', () => { remote.destroy(); });
    remote.once('close', () => { client.destroy(); });
    remote.once('connect', () => {
      const headers = incoming.rawHeaders.reduce((result, value, index) =>
        result + (index % 2 === 0 ? `${value}: ` : `${value}\r\n`), '');
      remote.write(`${incoming.method ?? 'POST'} ${incoming.url ?? '/'} HTTP/${incoming.httpVersion}\r\n${headers}\r\n`);
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  const socketIdentity = await lstat(socket);
  try { await chown(socket, -1, 65432); await chmod(socket, 0o660); }
  catch (error) {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    throw error;
  }
  let closed = false;
  return { socket, close: async () => {
    if (closed) return;
    closed = true;
    for (const connection of sockets) connection.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    try {
      const current = await lstat(socket);
      if (current.ino !== socketIdentity.ino || current.dev !== socketIdentity.dev) throw new Error('Laboratory Docker socket identity changed');
      await unlink(socket);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  } };
}
