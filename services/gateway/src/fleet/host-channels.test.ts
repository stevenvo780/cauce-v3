import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthDependencies } from '../console/provider-auth.types.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { startFleetAuthoritySocket } from './authority/socket.js';
import type { FleetControllerConfig } from './controller-config.js';
import { startFleetHostChannels } from './host-channels.js';
import type { FleetSshTransport } from './host-transport.js';

const execute = promisify(execFile); const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
let directory: string; let daemon: ChildProcess | undefined; let transport: FleetSshTransport;
const cleanup: (() => Promise<unknown>)[] = [];
async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
}
async function availablePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); }); return address.port;
}
beforeAll(async () => {
  directory = await mkdtemp(join(userInfo().homedir, '.cauce-channels-')); const port = await availablePort();
  for (const name of ['server-key', 'client-key']) await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 });
  const settings = `Port ${String(port)}\nListenAddress 127.0.0.1\nHostKey ${join(directory, 'server-key')}\nPidFile ${join(directory, 'sshd.pid')}\nAuthorizedKeysFile ${join(directory, 'authorized_keys')}\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin prohibit-password\nAllowUsers ${userInfo().username}\nAllowStreamLocalForwarding yes\nStreamLocalBindMask 0177\nStreamLocalBindUnlink no\nLogLevel ERROR\n`;
  await writeFile(join(directory, 'sshd.conf'), settings, { mode: 0o600 });
  daemon = spawn('/usr/bin/sshd', ['-D', '-f', join(directory, 'sshd.conf')], { detached: true, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error('Fixture daemon exited');
    const ready = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('connect', () => { socket.destroy(); resolve(true); });
    });
    if (ready) break; if (attempt === 99) throw new Error('Fixture daemon did not listen'); await delay(20);
  }
  const key = (await readFile(join(directory, 'server-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const known = `[127.0.0.1]:${String(port)} ${key}\n`; await writeFile(join(directory, 'known_hosts'), known, { mode: 0o600 });
  transport = { executable: '/usr/bin/ssh', executable_sha256: hash(await readFile('/usr/bin/ssh')),
    destination: `${userInfo().username}@127.0.0.1`, port, known_hosts_file: join(directory, 'known_hosts'), known_hosts_sha256: hash(known),
    identity_file: join(directory, 'client-key'), identity_sha256: hash(await readFile(join(directory, 'client-key'))) };
}, 15_000);
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
afterAll(async () => {
  if (daemon?.exitCode === null) {
    const exited = new Promise<void>(resolve => { daemon?.once('exit', () => { resolve(); }); }); daemon.kill('SIGTERM'); await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(remoteAuth = true) {
  const path = await mkdtemp(join(directory, 'case-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  for (const name of ['controller', 'central', 'reverse', 'local-auth', 'remote-auth']) await mkdir(join(path, name), { mode: 0o700 });
  await chmod(join(path, 'local-auth'), 0o2750);
  const controllerSocket = join(path, 'controller', 'authority.sock'); const centralSocket = join(path, 'central', 'authority.sock');
  const reverseSocket = join(path, 'reverse', 'authority.sock'); const authSocket = join(path, 'local-auth', 'auth.sock');
  const remoteAuthSocket = join(path, 'remote-auth', 'auth.sock');
  let effects = 0;
  let stopAuth: (() => Promise<void>) | undefined;
  for (const [socket, host] of [[controllerSocket, 'controller'], [centralSocket, 'remote']] as const) {
    const app = await startFleetAuthoritySocket(socket, { execute: async () => { effects += 1; throw new Error('Unexpected authority action'); } },
      { ownerUid: process.geteuid?.() ?? 0, host_id: host }); cleanup.push(() => app.close());
  }
  if (remoteAuth) {
    const manager = new ProviderAuthManager({ authorize: async () => { effects += 1; throw new Error('Unexpected provider action'); },
      audit: async () => undefined, reserve: async () => { effects += 1; throw new Error('Unexpected provider reservation'); } } satisfies ProviderAuthDependencies);
    const app = await startAuthBridge(remoteAuthSocket, manager, { ownerUid: process.geteuid?.() ?? 0, groupGid: 1000 });
    stopAuth = () => app.close(); cleanup.push(stopAuth);
  }
  const command = { python: '/usr/bin/python3', executable: '/private/executor.py', policyFile: '/private/policy.json' };
  const config: FleetControllerConfig = { version: 1, controller_host: 'controller',
    authority_command: { python: '/usr/bin/python3', executable: '/private/authority.py', sha256: 'a'.repeat(64),
      policy_file: '/private/authority.json', policy_sha256: 'b'.repeat(64) },
    hosts: [{ host_id: 'controller', command, authority_socket: controllerSocket },
      { host_id: 'remote', command: { ...command, transport }, authority_socket: centralSocket, authority_remote_socket: reverseSocket,
        auth_socket: authSocket, auth_remote_socket: remoteAuthSocket }] };
  return { config, authSocket, reverseSocket, path, effects: () => effects, stopAuth };
}
async function foreignSocket(filename: string): Promise<Server> {
  const server = createServer(socket => { socket.destroy(); }); await listen(server, filename); await chmod(filename, 0o600);
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); })); return server;
}
describe('persistent fleet SSH Unix channels with real endpoints', () => {
  it('proves both HTTP round trips before readiness and creates exact socket permissions', async () => {
    const f = await fixture(); const channels = await startFleetHostChannels(f.config, { startupTimeoutMs: 5000 }); cleanup.push(channels.close);
    const local = await lstat(f.authSocket); const remote = await lstat(f.reverseSocket);
    expect(local.mode & 0o777).toBe(0o660); expect(local.gid).toBe(1000);
    expect(remote.mode & 0o777).toBe(0o600); expect(f.effects()).toBe(0);
    await channels.close(); await channels.close();
    await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.reverseSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails closed when the forwarded provider endpoint is absent', async () => {
    const f = await fixture(false);
    await expect(startFleetHostChannels(f.config, { startupTimeoutMs: 250 })).rejects.toThrow('private channel');
    expect(f.effects()).toBe(0); await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves an occupied local socket instead of unlinking it', async () => {
    const f = await fixture(); await foreignSocket(f.authSocket); const before = await lstat(f.authSocket);
    await expect(startFleetHostChannels(f.config, { startupTimeoutMs: 250 })).rejects.toThrow('private channel');
    expect((await lstat(f.authSocket)).ino).toBe(before.ino);
  });
  it('preserves an occupied remote socket when SSH rejects the reverse bind', async () => {
    const f = await fixture(); await foreignSocket(f.reverseSocket); const before = await lstat(f.reverseSocket);
    await expect(startFleetHostChannels(f.config, { startupTimeoutMs: 250 })).rejects.toThrow('private channel');
    expect((await lstat(f.reverseSocket)).ino).toBe(before.ino);
  });
  it('rejects unsafe local parent modes before forwarding', async () => {
    const f = await fixture(); await chmod(join(f.path, 'local-auth'), 0o2770);
    await expect(startFleetHostChannels(f.config)).rejects.toThrow('private channel');
    await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects an authority reverse socket in a parent with broader access', async () => {
    const f = await fixture(); await chmod(join(f.path, 'reverse'), 0o750);
    await expect(startFleetHostChannels(f.config, { startupTimeoutMs: 250 })).rejects.toThrow('private channel'); expect(f.effects()).toBe(0);
  });
  it('rejects changed SSH pins without falling back to another identity', async () => {
    const f = await fixture(); const host = f.config.hosts[1]; if (!host) throw new Error('Fixture host absent');
    host.command.transport = { ...transport, known_hosts_sha256: 'f'.repeat(64) };
    await expect(startFleetHostChannels(f.config)).rejects.toThrow('private channel');
    await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects colon or control characters in forwarding socket paths', async () => {
    const f = await fixture(); const host = f.config.hosts[1]; if (!host) throw new Error('Fixture host absent');
    host.auth_socket = '/private/injected:forward'; await expect(startFleetHostChannels(f.config)).rejects.toThrow();
    host.auth_socket = '/private/injected\nforward'; await expect(startFleetHostChannels(f.config)).rejects.toThrow();
  });
  it('honors an already aborted startup without creating sockets', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(startFleetHostChannels(f.config, { signal: abort.signal })).rejects.toThrow('private channel');
    await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves a replacement socket whose inode differs at shutdown', async () => {
    const f = await fixture(); const channels = await startFleetHostChannels(f.config); cleanup.push(channels.close);
    await unlink(f.authSocket); await foreignSocket(f.authSocket); await chmod(f.authSocket, 0o660);
    const replacement = await lstat(f.authSocket); await channels.close();
    expect((await lstat(f.authSocket)).ino).toBe(replacement.ino);
  });
  it('preserves a replacement reverse socket whose inode differs at shutdown', async () => {
    const f = await fixture(); const channels = await startFleetHostChannels(f.config); cleanup.push(channels.close);
    await unlink(f.reverseSocket); await foreignSocket(f.reverseSocket);
    const replacement = await lstat(f.reverseSocket); await channels.close();
    expect((await lstat(f.reverseSocket)).ino).toBe(replacement.ino);
  });
  it('detects a vanished endpoint while the SSH session is still connected', async () => {
    const f = await fixture(); let markLost: (() => void) | undefined;
    const lost = new Promise<void>(resolve => { markLost = resolve; });
    const channels = await startFleetHostChannels(f.config, { onLost: () => { markLost?.(); } }); cleanup.push(channels.close);
    if (!f.stopAuth) throw new Error('Fixture provider endpoint absent'); await f.stopAuth();
    await Promise.race([lost, delay(12_000).then(() => { throw new Error('Endpoint loss was not reported'); })]);
    await channels.close();
  });
  it('aborts established channels and reports loss once', async () => {
    const f = await fixture(); const abort = new AbortController(); let lost = 0;
    const channels = await startFleetHostChannels(f.config, { signal: abort.signal, onLost: () => { lost += 1; } }); cleanup.push(channels.close);
    abort.abort(); await channels.close(); expect(lost).toBe(1);
    await expect(lstat(f.authSocket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports SSH disconnection so the controller can abort pending receipts', async () => {
    const f = await fixture(); let markLost: (() => void) | undefined;
    const lost = new Promise<void>(resolve => { markLost = resolve; });
    const channels = await startFleetHostChannels(f.config, { onLost: () => { markLost?.(); } }); cleanup.push(channels.close);
    if (!daemon?.pid) throw new Error('Fixture daemon absent');
    await execute('/usr/bin/pkill', ['-TERM', '-P', String(daemon.pid)]);
    await Promise.race([lost, delay(5000).then(() => { throw new Error('SSH loss was not reported'); })]);
    await channels.close();
  });
});
