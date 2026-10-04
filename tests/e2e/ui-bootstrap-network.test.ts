import { chmod, lstat, mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { isolatedBrowserNetwork, restrictedBrowserProxy } from './ui-bootstrap-network.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
const proxies: Awaited<ReturnType<typeof restrictedBrowserProxy>>[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
});

async function listener() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.pipe(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing own test listener');
  return { port: address.port, connections: () => connections };
}

async function connect(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function bytes(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let collected = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      collected = Buffer.concat([collected, chunk]);
      if (collected.length >= count) {
        socket.off('data', receive);
        socket.off('error', reject);
        resolve(collected);
      }
    };
    socket.on('data', receive);
    socket.once('error', reject);
  });
}

function request(host: string, port: number): Buffer {
  const encoded = Buffer.from(host);
  const frame = Buffer.alloc(7 + encoded.length);
  frame.set([5, 1, 0, 3, encoded.length]);
  encoded.copy(frame, 5);
  frame.writeUInt16BE(port, 5 + encoded.length);
  return frame;
}

async function setup() {
  const first = await listener();
  const second = await listener();
  const proxy = await restrictedBrowserProxy('127.0.0.1', [first.port, second.port]);
  proxies.push(proxy);
  return { first, second, proxy };
}

it('relays exact fixture loopback traffic through a fragmented SOCKS handshake', async () => {
  const { first, second, proxy } = await setup();
  const socket = await connect(proxy.port);
  const greeting = bytes(socket, 2);
  socket.write(Buffer.from([5]));
  socket.write(Buffer.from([1, 0]));
  expect(await greeting).toEqual(Buffer.from([5, 0]));
  const reply = bytes(socket, 10);
  const frame = request('localhost', first.port);
  for (const byte of frame) socket.write(Buffer.from([byte]));
  expect((await reply)[1]).toBe(0);
  const echoed = bytes(socket, 7);
  socket.write('own-tcp');
  expect((await echoed).toString()).toBe('own-tcp');
  expect(first.connections()).toBe(1);
  expect(second.connections()).toBe(0);
});

it.each(['external-host', 'foreign-port'])('rejects %s without contacting a target', async (kind) => {
  const { first, second, proxy } = await setup();
  const foreign = await listener();
  const socket = await connect(proxy.port);
  const greeting = bytes(socket, 2);
  socket.write(Buffer.from([5, 1, 0]));
  await greeting;
  const reply = bytes(socket, 10);
  socket.write(request(kind === 'external-host' ? 'foreign.invalid' : 'localhost', kind === 'foreign-port' ? foreign.port : first.port));
  expect((await reply)[1]).not.toBe(0);
  expect(first.connections()).toBe(0);
  expect(second.connections()).toBe(0);
  expect(foreign.connections()).toBe(0);
});

it('closes pending handshakes and its listener during cleanup', async () => {
  const { proxy } = await setup();
  const socket = await connect(proxy.port);
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve(); }); });
  socket.write(Buffer.from([5]));
  await proxy.close();
  proxies.splice(proxies.indexOf(proxy), 1);
  await closed;
  await expect(connect(proxy.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

it('carries fragmented SOCKS traffic over a private Unix socket and removes pending clients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-test-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'proxy.sock');
  const first = await listener();
  const second = await listener();
  const proxy = await restrictedBrowserProxy({ socketPath: path }, [first.port, second.port]);
  try {
    const metadata = await lstat(path);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    const socket = createConnection(path);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const greeting = bytes(socket, 2);
    socket.write(Buffer.from([5, 1, 0]));
    await greeting;
    const accepted = bytes(socket, 10);
    for (const byte of request('localhost', first.port)) socket.write(Buffer.from([byte]));
    expect((await accepted)[1]).toBe(0);
    const echo = bytes(socket, 7);
    socket.write('private');
    expect((await echo).toString()).toBe('private');
    expect(second.connections()).toBe(0);
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve(); }); });
    await proxy.close();
    await closed;
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if ((await readdir(directory)).length > 0) await proxy.close();
    await rmdir(directory);
  }
});

it('cleans an owned network when create succeeds but its response is lost', async () => {
  let ownName = '';
  let owner = '';
  let removed = false;
  const commands: string[][] = [];
  const docker = async (args: string[]) => {
    commands.push(args);
    if (args[1] === 'create') {
      ownName = args.at(-1) ?? '';
      owner = (args[args.indexOf('--label') + 1] ?? '').split('=')[1] ?? '';
      throw new Error('Own create response lost');
    }
    if (args[1] === 'rm') { expect(args[2]).toBe('own-network-id'); removed = true; return { stdout: '' }; }
    if (removed) throw Object.assign(new Error('Own absence'), { code: 1, stderr: `Error: No such network: ${ownName}` });
    return { stdout: JSON.stringify([{ Id: 'own-network-id', Labels: { 'cauce.e2e.owner': owner }, Containers: {} }]) };
  };
  await expect(isolatedBrowserNetwork(docker, [12340, 12341])).rejects.toThrow('Own create response lost');
  expect(removed).toBe(true);
  expect(commands.filter((args) => args[1] === 'rm')).toHaveLength(1);
});

it('preserves a foreign network after a partial create error', async () => {
  const removed: string[][] = [];
  const docker = async (args: string[]) => {
    if (args[1] === 'create') throw new Error('Own create failed');
    if (args[1] === 'rm') removed.push(args);
    return { stdout: JSON.stringify([{ Id: 'foreign-id', Labels: { 'cauce.e2e.owner': 'foreign' }, Containers: {} }]) };
  };
  await expect(isolatedBrowserNetwork(docker, [12340, 12341])).rejects.toThrow('setup and cleanup failed');
  expect(removed).toEqual([]);
});
