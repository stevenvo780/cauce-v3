import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';

interface DockerResult { stdout: string }
type Docker = (args: string[]) => Promise<DockerResult>;

export async function restrictedBrowserProxy(host: string | { socketPath: string }, ports: readonly number[]) {
  if (ports.length !== 2 || new Set(ports).size !== 2
      || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Browser proxy requires two exact fixture ports');
  }
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); });
    socket.on('error', () => { socket.destroy(); });
  };
  const server = createServer((socket) => {
    track(socket);
    socket.setTimeout(5_000, () => { socket.destroy(); });
    let greeting = false;
    let buffered = Buffer.alloc(0);
    const reject = () => { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); };
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 512) { socket.destroy(); return; }
      if (!greeting) {
        if (buffered.length < 2) return;
        const count = buffered[1] ?? 0;
        if (buffered.length < 2 + count) return;
        if (buffered[0] !== 5 || !buffered.subarray(2, 2 + count).includes(0)) {
          socket.end(Buffer.from([5, 255])); return;
        }
        buffered = buffered.subarray(2 + count);
        greeting = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (buffered.length < 4) return;
      if (buffered[0] !== 5 || buffered[1] !== 1 || buffered[2] !== 0) { reject(); return; }
      let address: string;
      let end: number;
      if (buffered[3] === 3) {
        if (buffered.length < 5) return;
        end = 5 + (buffered[4] ?? 0);
        if (buffered.length < end + 2) return;
        address = buffered.subarray(5, end).toString('utf8');
      } else if (buffered[3] === 1) {
        end = 8;
        if (buffered.length < end + 2) return;
        address = [...buffered.subarray(4, end)].join('.');
      } else if (buffered[3] === 4) {
        end = 20;
        if (buffered.length < end + 2) return;
        address = buffered.subarray(4, end).equals(Buffer.from('00000000000000000000000000000001', 'hex')) ? '::1' : 'foreign';
      } else { reject(); return; }
      const port = buffered.readUInt16BE(end);
      if (!['localhost', '127.0.0.1', '::1'].includes(address) || !ports.includes(port)) { reject(); return; }
      socket.off('data', receive);
      socket.pause();
      const upstream = createConnection({ host: '127.0.0.1', port });
      track(upstream);
      upstream.setTimeout(5_000, () => { upstream.destroy(); socket.destroy(); });
      upstream.once('error', () => { socket.destroy(); });
      socket.once('close', () => { upstream.destroy(); });
      upstream.once('close', () => { socket.destroy(); });
      upstream.once('connect', () => {
        socket.setTimeout(0);
        upstream.setTimeout(0);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (buffered.length > end + 2) upstream.write(buffered.subarray(end + 2));
        buffered = Buffer.alloc(0);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
    };
    socket.on('data', receive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof host === 'string') server.listen(0, host, resolve);
    else server.listen(host.socketPath, resolve);
  });
  const address = server.address();
  if (address === null) throw new Error('Browser proxy did not bind its exact interface');
  if (typeof host !== 'string') await chmod(host.socketPath, 0o600);
  return { port: typeof address === 'string' ? 0 : address.port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  } };
}

export async function publishBrowserCdp(host: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    const upstream = createConnection({ host, port: 9223 });
    for (const channel of [socket, upstream]) {
      sockets.add(channel);
      channel.once('close', () => { sockets.delete(channel); socket.destroy(); upstream.destroy(); });
      channel.on('error', () => { socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Private CDP publication failed');
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  } };
}

function absentNetwork(error: unknown, name: string): boolean {
  let current = error;
  let stderr: string | undefined;
  let code: unknown;
  while (current !== null && typeof current === 'object') {
    if ('stderr' in current && typeof current.stderr === 'string') stderr ??= current.stderr.trim();
    if ('code' in current) code = current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return code === 1 && (stderr === `Error response from daemon: network ${name} not found`
    || stderr === `Error: No such network: ${name}` || stderr === `error: no such network: ${name}`);
}

export async function isolatedBrowserNetwork(docker: Docker, ports: readonly number[]) {
  const owner = randomUUID();
  const name = `cauce-ui-network-${owner}`;
  const directory = await mkdtemp(join(tmpdir(), 'cui-'));
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'proxy.sock');
  if (Buffer.byteLength(socketPath) > 107) { await rmdir(directory); throw new Error('Private browser transport path exceeds Unix socket limit'); }
  let socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let id: string | undefined;
  let proxy: Awaited<ReturnType<typeof restrictedBrowserProxy>> | undefined;
  let transportCleanup: Promise<void> | undefined;
  const closeTransport = () => {
    transportCleanup ??= (async () => {
      if (socketIdentity !== undefined) {
        const current = await lstat(socketPath);
        if (!current.isSocket() || current.ino !== socketIdentity.ino || current.dev !== socketIdentity.dev
          || current.uid !== process.getuid?.()) throw new Error('Browser transport socket changed ownership');
      }
      await proxy?.close();
    })();
    return transportCleanup;
  };
  let cleanup: Promise<void> | undefined;
  const close = () => {
    cleanup ??= (async () => {
      const errors: unknown[] = [];
      try {
        await closeTransport();
        if ((await readdir(directory)).length !== 0) throw new Error('Browser transport directory contains foreign resources');
        await rmdir(directory);
      } catch (error) { errors.push(error); }
      try {
        const inspected = JSON.parse((await docker(['network', 'inspect', name])).stdout) as {
          Id: string; Labels: Record<string, string>; Containers: Record<string, unknown>;
        }[];
        const actual = inspected[0];
        if (actual?.Labels['cauce.e2e.owner'] !== owner || (id !== undefined && actual.Id !== id)
            || Object.keys(actual.Containers).length !== 0) throw new Error('Browser network ownership or empty-state differs');
        await docker(['network', 'rm', actual.Id]);
        try { await docker(['network', 'inspect', name]); throw new Error('Owned browser network remains after removal'); }
        catch (error) { if (!absentNetwork(error, name)) throw error; }
        process.stdout.write(`E2E browser network removed: id=${actual.Id} owner=${owner}\n`);
      } catch (error) { if (!absentNetwork(error, name)) errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Owned browser network cleanup incomplete');
    })();
    return cleanup;
  };
  try {
    id = (await docker(['network', 'create', '--internal', '--label', `cauce.e2e.owner=${owner}`, name])).stdout.trim();
    const inspected = JSON.parse((await docker(['network', 'inspect', name])).stdout) as {
      Id: string; Internal: boolean; Labels: Record<string, string>; IPAM: { Config: { Gateway: string }[] };
    }[];
    const actual = inspected[0];
    const gateway = actual?.IPAM.Config[0]?.Gateway;
    if (actual?.Id !== id || !actual.Internal || actual.Labels['cauce.e2e.owner'] !== owner
        || gateway === undefined || !/^\d+\.\d+\.\d+\.\d+$/u.test(gateway)) throw new Error('Browser network identity differs');
    proxy = await restrictedBrowserProxy({ socketPath }, ports);
    socketIdentity = await lstat(socketPath);
    if (!socketIdentity.isSocket() || socketIdentity.uid !== process.getuid?.() || (socketIdentity.mode & 0o777) !== 0o600) throw new Error('Private browser transport metadata differs');
    process.stdout.write(`E2E browser transport: uid=${String(socketIdentity.uid)} dev=${String(socketIdentity.dev)} ino=${String(socketIdentity.ino)} mode=600\n`);
    process.stdout.write(`E2E browser network: id=${id} owner=${owner} mode=internal\n`);
    return { name, id, owner, directory, socketIdentity, proxyUrl: 'socks5://127.0.0.1:1080', close, closeTransport };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser network setup and cleanup failed'); }
    throw error;
  }
}
