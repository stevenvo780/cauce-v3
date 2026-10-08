import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performHostCommand } from './host-command.js';
import { fleetHostSpawn } from './host-transport.js';
import type { FleetExecution } from './executor.js';

const execute = promisify(execFile); const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
let directory: string; let daemon: ChildProcess | undefined; let port: number;
let config: Parameters<typeof fleetHostSpawn>[0];
let diagnostic = '';
const execution = { request: { kind: 'stop', target: { resource: 'agent', tenant_id: 'Steven', alias: 'fixture' },
  expected_revision: 0, idempotency_key: 'ssh-physical-fixture', parameters: {} },
  operation: { id: '72000000-0000-4000-8000-000000000001' }, fenced_targets: [] } as unknown as FleetExecution;

async function availablePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); }); return address.port;
}
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (daemon?.exitCode !== null) throw new Error('Fixture SSH daemon exited');
    const listening = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1'); socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
    });
    if (listening) return;
    await new Promise(resolve => { setTimeout(resolve, 20); });
  }
  throw new Error('Fixture SSH daemon did not listen');
}
beforeAll(async () => {
  directory = await mkdtemp(join(userInfo().homedir, '.cauce-fleet-ssh-')); port = await availablePort();
  for (const name of ['server-key', 'client-key']) await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  const publicKey = (await readFile(join(directory, 'client-key.pub'), 'utf8')).trim();
  await writeFile(join(directory, 'authorized_keys'), publicKey + '\n', { mode: 0o600 });
  const settings = `Port ${String(port)}\nListenAddress 127.0.0.1\nHostKey ${join(directory, 'server-key')}\nPidFile ${join(directory, 'sshd.pid')}\nAuthorizedKeysFile ${join(directory, 'authorized_keys')}\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin prohibit-password\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`;
  await writeFile(join(directory, 'sshd.conf'), settings, { mode: 0o600 });
  daemon = spawn('/usr/bin/sshd', ['-D', '-E', join(directory, 'sshd.log'), '-f', join(directory, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr?.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); }); await ready();
  const hostKey = (await readFile(join(directory, 'server-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = `[127.0.0.1]:${String(port)} ${hostKey}\n`; await writeFile(join(directory, 'known_hosts'), knownHosts, { mode: 0o600 });
  const executable = join(directory, "executor 'quoted;$fixture.py"); const policyFile = join(directory, "policy 'quoted;$fixture.json");
  await writeFile(executable, `import json,sys\nx=json.load(sys.stdin)\nassert sys.argv[2]==${JSON.stringify(policyFile)}\nassert x['request']['target']['alias']=='fixture'\nassert sys.argv[-1]=='stop'\nprint(json.dumps({'evidence':{'stopped_verified':True}}))\n`, { mode: 0o600 });
  config = { python: '/usr/bin/python3', executable, policyFile, transport: { executable: '/usr/bin/ssh',
    executable_sha256: hash(await readFile('/usr/bin/ssh')), destination: `${userInfo().username}@127.0.0.1`, port,
    known_hosts_file: join(directory, 'known_hosts'), known_hosts_sha256: hash(knownHosts),
    identity_file: join(directory, 'client-key'), identity_sha256: hash(await readFile(join(directory, 'client-key'))) } };
}, 15_000);
afterAll(async () => {
  if (daemon?.exitCode === null) {
    const exited = new Promise<void>(resolve => { daemon?.once('exit', () => { resolve(); }); }); daemon.kill('SIGTERM'); await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe('fleet SSH transport with a real private fixture daemon', () => {
  it('transmits structured stdin and quotes every approved remote argument', async () => {
    try {
      expect(await performHostCommand({ ...config, timeoutMs: 5000 }, 'stop', execution, new AbortController().signal))
        .toEqual({ evidence: { stopped_verified: true } });
    } catch { throw new Error(`Private SSH fixture failed: ${diagnostic}`); }
  });
  it('rejects a changed host key pin before spawning a remote command', async () => {
    if (!config.transport) throw new Error('Fixture transport absent');
    await expect(fleetHostSpawn({ ...config, transport: { ...config.transport, known_hosts_sha256: 'f'.repeat(64) } }, 'stop')).rejects.toThrow('pin changed');
  });
  it('rejects unsafe private key permissions without falling back to another identity', async () => {
    if (!config.transport?.identity_file) throw new Error('Fixture identity absent');
    await chmod(config.transport.identity_file, 0o644);
    try { await expect(fleetHostSpawn(config, 'stop')).rejects.toThrow('pin is invalid'); }
    finally { await chmod(config.transport.identity_file, 0o600); }
  });
  it('rejects a syntactically unsafe destination', async () => {
    if (!config.transport) throw new Error('Fixture transport absent');
    await expect(fleetHostSpawn({ ...config, transport: { ...config.transport, destination: 'host;touch /tmp/foreign' } }, 'stop')).rejects.toThrow();
  });
  it('rejects a private key beneath a writable parent', async () => {
    if (!config.transport?.identity_file) throw new Error('Fixture identity absent');
    const parent = join(directory, 'writable-parent'); await mkdir(parent, { mode: 0o700 });
    const filename = join(parent, 'key'); await writeFile(filename, await readFile(config.transport.identity_file), { mode: 0o600 });
    await chmod(parent, 0o777);
    await expect(fleetHostSpawn({ ...config, transport: { ...config.transport, identity_file: filename } }, 'stop')).rejects.toThrow();
  });
  it('rejects a private key reached through a symbolic link parent', async () => {
    if (!config.transport?.identity_file) throw new Error('Fixture identity absent');
    const parent = join(directory, 'linked-parent'); await symlink(directory, parent);
    await expect(fleetHostSpawn({ ...config, transport: { ...config.transport,
      identity_file: join(parent, 'client-key') } }, 'stop')).rejects.toThrow();
  });
});
