import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { FleetSshTransport } from '../../services/gateway/src/fleet/host-transport.js';

const execute = promisify(execFile);
const hash = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');

export async function contents(filename: string): Promise<string> {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
}

async function children(pid: number): Promise<number[]> {
  const list = await contents(`/proc/${String(pid)}/task/${String(pid)}/children`);
  const direct = list.trim().split(/\s+/u).filter(Boolean).map(Number);
  const nested = await Promise.all(direct.map(children));
  return [...direct, ...nested.flat()];
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

export interface PrivateSshFixture {
  directory: string;
  transport: FleetSshTransport;
  start(): Promise<void>;
  interrupt(): Promise<number[]>;
  close(): Promise<void>;
}

export async function privateSshFixture(): Promise<PrivateSshFixture> {
  const directory = await mkdtemp(join(userInfo().homedir, 'zz-canary-ssh-'));
  let daemon: ChildProcess | undefined;
  let diagnostics = '';
  const close = async () => {
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const descendants = await children(daemon.pid);
      for (const pid of descendants.reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      await stopProcess(daemon);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const server = createServer();
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Private SSH fixture port is absent');
    const port = address.port;
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    for (const name of ['server-key', 'client-key']) {
      await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
    }
    await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
    const config = [
      `Port ${String(port)}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'server-key')}`,
      `PidFile ${join(directory, 'sshd.pid')}`, `AuthorizedKeysFile ${join(directory, 'authorized_keys')}`,
      'StrictModes yes', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', `AllowUsers ${userInfo().username}`, 'LogLevel ERROR', '',
    ].join('\n');
    await writeFile(join(directory, 'sshd.conf'), config, { mode: 0o600 });
    const hostKey = (await readFile(join(directory, 'server-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    const knownHosts = `[127.0.0.1]:${String(port)} ${hostKey}\n`;
    await writeFile(join(directory, 'known_hosts'), knownHosts, { mode: 0o600 });
    const transport: FleetSshTransport = {
      executable: '/usr/bin/ssh', executable_sha256: hash(await readFile('/usr/bin/ssh')),
      destination: `${userInfo().username}@127.0.0.1`, port,
      known_hosts_file: join(directory, 'known_hosts'), known_hosts_sha256: hash(knownHosts),
      identity_file: join(directory, 'client-key'), identity_sha256: hash(await readFile(join(directory, 'client-key'))),
    };
    const start = async () => {
      daemon = spawn('/usr/bin/sshd', ['-D', '-f', join(directory, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
      daemon.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`Private SSH fixture exited: ${diagnostics}`);
        const ready = await new Promise<boolean>(resolve => {
          const socket = connect(port, '127.0.0.1');
          socket.once('error', () => { socket.destroy(); resolve(false); });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
        });
        if (ready) return;
        await delay(20);
      }
      throw new Error(`Private SSH fixture did not listen: ${diagnostics}`);
    };
    const interrupt = async () => {
      if (!daemon?.pid || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Private SSH daemon is absent');
      const interrupted = [daemon.pid, ...await children(daemon.pid)];
      for (const pid of interrupted.slice(1).reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      await stopProcess(daemon);
      return interrupted;
    };
    await start();
    return { directory, transport, start, interrupt, close };
  } catch (error) { await close(); throw error; }
}
