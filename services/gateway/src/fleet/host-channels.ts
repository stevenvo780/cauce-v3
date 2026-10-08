import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertAuthBridgeParent } from './auth-bridge-socket.js';
import { assertAuthoritySocket } from './authority/socket.js';
import { FleetControllerConfigSchema, type FleetControllerConfig } from './controller-config.js';
import { fleetSshArguments, type FleetSshTransport } from './host-transport.js';

interface Identity { dev: number; ino: number }
interface Channel {
  host: FleetControllerConfig['hosts'][number]; transport: FleetSshTransport; child: ChildProcess;
  local?: Identity; remote?: Identity;
}
export interface FleetHostChannelOptions {
  onLost?(): void; signal?: AbortSignal; startupTimeoutMs?: number; authGroupGid?: number;
}
function unavailable(): Error { return new Error('Fleet host private channel is unavailable'); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function alive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
async function stop(child: ChildProcess): Promise<void> {
  if (!alive(child) || !child.pid) return;
  const exit = new Promise<void>(resolve => { child.once('exit', () => { resolve(); }); });
  const terminate = (signal: NodeJS.Signals) => {
    try { process.kill(-(child.pid ?? 0), signal); } catch { child.kill(signal); }
  };
  terminate('SIGTERM');
  const timer = setTimeout(() => { terminate('SIGKILL'); }, 500); timer.unref();
  await exit; clearTimeout(timer);
}
async function response(socketPath: string, route: string, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const outgoing = request({ socketPath, method: 'POST', path: route,
      headers: { 'content-type': 'application/json', 'content-length': '2' } }, incoming => {
      let bytes = 0; const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024) { incoming.destroy(); outgoing.destroy(unavailable()); } else chunks.push(chunk);
      });
      incoming.once('error', reject);
      incoming.once('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (incoming.statusCode !== 409 || typeof value !== 'object' || value === null
            || !('error' in value) || value.error !== expected) throw unavailable();
          resolve();
        } catch { reject(unavailable()); }
      });
    });
    outgoing.setTimeout(1000, () => { outgoing.destroy(unavailable()); });
    outgoing.once('error', reject); outgoing.end('{}');
  });
}
const REMOTE_PARENT = `import http.client,json,os,socket,stat,sys
p=sys.argv[1]; parent=os.path.dirname(p); ancestor=parent
while True:
 s=os.lstat(ancestor); temporary=ancestor!=parent and ancestor in ('/tmp','/var/tmp') and s.st_uid==0 and s.st_mode&stat.S_ISVTX
 assert stat.S_ISDIR(s.st_mode) and s.st_uid in (0,os.geteuid()) and (s.st_mode&0o022==0 or temporary)
 if ancestor==parent: assert s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700
 if ancestor=='/': break
 ancestor=os.path.dirname(ancestor)
`;
const REMOTE_PREPARE = `${REMOTE_PARENT}assert not os.path.lexists(p)
`;
const REMOTE_PROBE = `${REMOTE_PARENT}
s=os.lstat(p); assert stat.S_ISSOCK(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o600
ready=False
try:
 c=http.client.HTTPConnection('localhost',timeout=1); c.sock=socket.socket(socket.AF_UNIX); c.sock.settimeout(1); c.sock.connect(p)
 c.request('POST','/authority',body='{}',headers={'content-type':'application/json'}); r=c.getresponse()
 ready=r.status==409 and json.loads(r.read(1025))=={'error':'INVALID_REQUEST'}; c.close()
except (OSError,ValueError,http.client.HTTPException): pass
print(json.dumps({'dev':s.st_dev,'ino':s.st_ino,'ready':ready}))
`;
const REMOTE_CLEANUP = `import json,os,stat,sys
p=sys.argv[1]; expected=json.loads(sys.argv[2])
try: s=os.lstat(p)
except FileNotFoundError: sys.exit(0)
if stat.S_ISSOCK(s.st_mode) and s.st_uid==os.geteuid() and s.st_dev==expected['dev'] and s.st_ino==expected['ino']: os.unlink(p)
`;
async function remote(channel: Pick<Channel, 'host' | 'transport'>, script: string, args: string[], signal?: AbortSignal): Promise<string> {
  const base = await fleetSshArguments(channel.transport);
  if (signal?.aborted) throw unavailable();
  const child = spawn(channel.transport.executable, [...base, channel.transport.destination,
    [channel.host.command.python, '-c', script, ...args].map(quote).join(' ')], { detached: true,
    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
  const aborted = () => { void stop(child); };
  signal?.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(aborted, 3000); timer.unref();
  try {
    return await new Promise<string>((resolve, reject) => {
      let bytes = 0; const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024) { aborted(); } else chunks.push(chunk);
      });
      child.once('error', () => { reject(unavailable()); });
      child.once('exit', code => {
        if (code !== 0 || signal?.aborted || bytes > 1024) reject(unavailable());
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}
async function localIdentity(channel: Channel, gid: number): Promise<Identity | undefined> {
  const filename = channel.host.auth_socket; if (filename === undefined) return undefined;
  await assertAuthBridgeParent(filename, { ownerUid: process.geteuid?.() ?? 0 });
  const parent = await lstat(dirname(filename));
  if ((parent.mode & 0o7777) !== 0o2750 || parent.gid !== gid) throw unavailable();
  const stat = await lstat(filename);
  if (!stat.isSocket() || stat.uid !== (process.geteuid?.() ?? 0) || stat.gid !== gid || (stat.mode & 0o777) !== 0o660) throw unavailable();
  const identity = { dev: stat.dev, ino: stat.ino };
  if (channel.local && (channel.local.dev !== identity.dev || channel.local.ino !== identity.ino)) throw unavailable();
  channel.local = identity;
  await response(filename, '/auth', 'HOST_UNAVAILABLE'); return identity;
}
async function probe(channel: Channel, gid: number, signal?: AbortSignal): Promise<void> {
  if (!alive(channel.child) || signal?.aborted) throw unavailable();
  if (channel.host.authority_remote_socket !== undefined) {
    const value: unknown = JSON.parse(await remote(channel, REMOTE_PROBE, [channel.host.authority_remote_socket], signal));
    if (typeof value !== 'object' || value === null || !('dev' in value) || !('ino' in value)
      || typeof value.dev !== 'number' || typeof value.ino !== 'number' || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino)) throw unavailable();
    const identity = { dev: value.dev, ino: value.ino };
    if (channel.remote && (channel.remote.dev !== identity.dev || channel.remote.ino !== identity.ino)) throw unavailable();
    channel.remote = identity;
    if (!('ready' in value) || value.ready !== true) throw unavailable();
  }
  const identity = await localIdentity(channel, gid);
  if (identity && channel.local && (channel.local.dev !== identity.dev || channel.local.ino !== identity.ino)) throw unavailable();
  if (identity) channel.local = identity;
  if (!alive(channel.child) || signal?.aborted) throw unavailable();
}
async function cleanup(channel: Channel): Promise<void> {
  await stop(channel.child);
  if (channel.host.auth_socket !== undefined && channel.local) {
    try {
      await assertAuthBridgeParent(channel.host.auth_socket, { ownerUid: process.geteuid?.() ?? 0 });
      const current = await lstat(channel.host.auth_socket);
      if (current.isSocket() && current.dev === channel.local.dev && current.ino === channel.local.ino) await unlink(channel.host.auth_socket);
    } catch { /* Cleanup preserves sockets whose identity cannot be established. */ }
  }
  if (channel.host.authority_remote_socket !== undefined && channel.remote) {
    try { await remote(channel, REMOTE_CLEANUP, [channel.host.authority_remote_socket, JSON.stringify(channel.remote)]); }
    catch { /* Remote cleanup requires the original pinned transport. */ }
  }
}
export async function startFleetHostChannels(input: FleetControllerConfig, options: FleetHostChannelOptions = {}) {
  const config = FleetControllerConfigSchema.parse(input); const channels: Channel[] = [];
  const gid = options.authGroupGid ?? 1000; const timeout = options.startupTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(gid) || gid < 0 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw unavailable();
  let closed = false; let ready = false; let lost = false; let checking = false;
  const isClosed = () => closed;
  let closing: Promise<void> | undefined;
  let interval: NodeJS.Timeout | undefined;
  const loss = () => { if (!closed && ready && !lost) { lost = true; options.onLost?.(); } };
  const close = async () => {
    if (closing) return closing; closed = true;
    if (interval) clearInterval(interval);
    options.signal?.removeEventListener('abort', abort);
    closing = Promise.all(channels.map(cleanup)).then(() => undefined);
    return closing;
  };
  const abort = () => { loss(); void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const host of config.hosts) {
      if (options.signal?.aborted || isClosed()) throw unavailable();
      if (host.host_id === config.controller_host || (host.authority_socket === undefined && host.auth_socket === undefined)) continue;
      const transport = host.command.transport; if (!transport) throw unavailable();
      if (host.authority_socket !== undefined) await assertAuthoritySocket(host.authority_socket, { ownerUid: process.geteuid?.() ?? 0, host_id: host.host_id });
      if (host.authority_remote_socket !== undefined) await remote({ host, transport }, REMOTE_PREPARE, [host.authority_remote_socket], options.signal);
      if (host.auth_socket !== undefined) {
        await assertAuthBridgeParent(host.auth_socket, { ownerUid: process.geteuid?.() ?? 0 });
        const parent = await lstat(dirname(host.auth_socket));
        if ((parent.mode & 0o7777) !== 0o2750 || parent.gid !== gid) throw unavailable();
        try { await lstat(host.auth_socket); throw unavailable(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(); }
      }
      const args = await fleetSshArguments(transport, { clearForwardings: false });
      args.push('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
        '-o', 'StreamLocalBindUnlink=no', '-o', 'StreamLocalBindMask=0117');
      if (host.authority_socket !== undefined && host.authority_remote_socket !== undefined) args.push('-R', `${host.authority_remote_socket}:${host.authority_socket}`);
      if (host.auth_socket !== undefined && host.auth_remote_socket !== undefined) args.push('-L', `${host.auth_socket}:${host.auth_remote_socket}`);
      args.push(transport.destination);
      if (options.signal?.aborted || isClosed()) throw unavailable();
      const child = spawn(transport.executable, args, { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
      child.once('error', loss); child.once('exit', loss);
      const channel: Channel = { host, transport, child }; channels.push(channel);
      const deadline = Date.now() + timeout;
      for (;;) {
        try { await probe(channel, gid, options.signal); break; }
        catch { if (!alive(child) || options.signal?.aborted || isClosed() || Date.now() >= deadline) throw unavailable(); }
        await delay(25);
      }
    }
    if (options.signal?.aborted || isClosed()) throw unavailable();
    ready = true;
    if (channels.some(channel => !alive(channel.child))) throw unavailable();
    interval = setInterval(() => {
      if (checking || closed || lost) return; checking = true;
      void Promise.all(channels.map(channel => probe(channel, gid, options.signal))).catch(loss).finally(() => { checking = false; });
    }, 10_000); interval.unref();
    return { close };
  } catch { await close(); throw unavailable(); }
}
