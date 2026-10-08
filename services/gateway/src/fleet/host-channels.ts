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
  host: FleetControllerConfig['hosts'][number]; transport: FleetSshTransport; child?: ChildProcess | undefined;
  local?: Identity | undefined; remote?: Identity | undefined; staleRemote?: Identity | undefined;
  up: boolean; reported: boolean; busy: boolean; probing?: Promise<unknown> | undefined; backoff: number; timer?: NodeJS.Timeout; work?: Promise<unknown> | undefined; report: Promise<unknown>;
}
export type FleetHostChannelStatus = 'reachable' | 'unreachable';
export interface FleetHostChannelOptions {
  onLost?(): void; onHostDown?(hostId: string): void; onHostStatus?(hostId: string, status: FleetHostChannelStatus): void | Promise<void>;
  signal?: AbortSignal; startupTimeoutMs?: number; authGroupGid?: number;
  probeIntervalMs?: number; retryMinMs?: number; retryMaxMs?: number;
}
class LocalChannelError extends Error {}
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
async function localIdentity(channel: Channel, gid: number, open: () => boolean): Promise<Identity | undefined> {
  const filename = channel.host.auth_socket; if (filename === undefined) return undefined;
  await assertAuthBridgeParent(filename, { ownerUid: process.geteuid?.() ?? 0 });
  const parent = await lstat(dirname(filename));
  if ((parent.mode & 0o7777) !== 0o2750 || parent.gid !== gid) throw unavailable();
  const stat = await lstat(filename);
  if (!stat.isSocket() || stat.uid !== (process.geteuid?.() ?? 0) || stat.gid !== gid || (stat.mode & 0o777) !== 0o660) throw unavailable();
  const identity = { dev: stat.dev, ino: stat.ino };
  if (channel.local && (channel.local.dev !== identity.dev || channel.local.ino !== identity.ino)) throw unavailable();
  if (!open()) throw unavailable();
  channel.local = identity;
  await response(filename, '/auth', 'HOST_UNAVAILABLE'); return identity;
}
function connected(channel: Channel, signal?: AbortSignal): boolean {
  return channel.child !== undefined && alive(channel.child) && signal?.aborted !== true;
}
async function probe(channel: Channel, gid: number, signal?: AbortSignal, open: () => boolean = () => true): Promise<void> {
  if (!connected(channel, signal) || !open()) throw unavailable();
  if (channel.host.authority_remote_socket !== undefined) {
    const value: unknown = JSON.parse(await remote(channel, REMOTE_PROBE, [channel.host.authority_remote_socket], signal));
    if (typeof value !== 'object' || value === null || !('dev' in value) || !('ino' in value)
      || typeof value.dev !== 'number' || typeof value.ino !== 'number' || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino)) throw unavailable();
    const identity = { dev: value.dev, ino: value.ino };
    if (!open() || (channel.remote && (channel.remote.dev !== identity.dev || channel.remote.ino !== identity.ino))) throw unavailable();
    channel.remote = identity;
    if (!('ready' in value) || value.ready !== true) throw unavailable();
  }
  const identity = await localIdentity(channel, gid, open);
  if (identity && channel.local && (channel.local.dev !== identity.dev || channel.local.ino !== identity.ino)) throw unavailable();
  if (identity && open()) channel.local = identity;
  if (!connected(channel, signal) || !open()) throw unavailable();
}
async function cleanup(channel: Channel): Promise<void> {
  if (channel.child) await stop(channel.child);
  channel.child = undefined;
  if (channel.host.auth_socket !== undefined && channel.local) {
    try {
      await assertAuthBridgeParent(channel.host.auth_socket, { ownerUid: process.geteuid?.() ?? 0 });
      const current = await lstat(channel.host.auth_socket);
      if (current.isSocket() && current.dev === channel.local.dev && current.ino === channel.local.ino) await unlink(channel.host.auth_socket);
    } catch { /* Cleanup preserves sockets whose identity cannot be established. */ }
  }
  if (channel.host.authority_remote_socket !== undefined && channel.remote) {
    try { await remote(channel, REMOTE_CLEANUP, [channel.host.authority_remote_socket, JSON.stringify(channel.remote)]); }
    catch { channel.staleRemote = channel.remote; }
  }
  channel.local = undefined; channel.remote = undefined;
}
async function prepareLocal(channel: Channel, gid: number, signal?: AbortSignal): Promise<string[]> {
  const { host, transport } = channel;
  try {
    if (signal?.aborted) throw unavailable();
    if (host.authority_socket !== undefined) await assertAuthoritySocket(host.authority_socket, { ownerUid: process.geteuid?.() ?? 0, host_id: host.host_id });
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
    return args;
  } catch { throw new LocalChannelError(); }
}
export async function startFleetHostChannels(input: FleetControllerConfig, options: FleetHostChannelOptions = {}) {
  const config = FleetControllerConfigSchema.parse(input); const channels: Channel[] = [];
  const gid = options.authGroupGid ?? 1000; const timeout = options.startupTimeoutMs ?? 5000;
  const probeMs = options.probeIntervalMs ?? 10_000; const retryMin = options.retryMinMs ?? 10_000; const retryMax = options.retryMaxMs ?? 60_000;
  if (!Number.isSafeInteger(gid) || gid < 0 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000
    || !Number.isSafeInteger(probeMs) || probeMs < 10 || !Number.isSafeInteger(retryMin) || retryMin < 10
    || !Number.isSafeInteger(retryMax) || retryMax < retryMin) throw unavailable();
  let closed = false; let ready = false; let lost = false;
  const open = () => !closed;
  const stopped = () => closed || options.signal?.aborted === true;
  let closing: Promise<void> | undefined;
  let interval: NodeJS.Timeout | undefined;
  const loss = () => { if (!closed && ready && !lost) { lost = true; options.onLost?.(); } };
  const setUp = (channel: Channel, up: boolean) => {
    if (channel.reported && channel.up === up) return;
    channel.up = up; channel.reported = true;
    if (!up) { try { options.onHostDown?.(channel.host.host_id); } catch { /* A failing observer must not block status reporting. */ } }
    channel.report = channel.report.then(() => options.onHostStatus?.(channel.host.host_id, up ? 'reachable' : 'unreachable')).catch(() => undefined);
  };
  const connect = async (channel: Channel, args: string[]) => {
    const { host, transport } = channel; const deadline = Date.now() + timeout;
    if (channel.staleRemote && host.authority_remote_socket !== undefined) {
      await remote(channel, REMOTE_CLEANUP, [host.authority_remote_socket, JSON.stringify(channel.staleRemote)], options.signal);
      channel.staleRemote = undefined;
    }
    if (host.authority_remote_socket !== undefined) await remote(channel, REMOTE_PREPARE, [host.authority_remote_socket], options.signal);
    if (stopped()) throw unavailable();
    const child = spawn(transport.executable, args, { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
    channel.child = child;
    const exited = () => { if (channel.child === child && channel.up) down(channel); };
    child.once('error', exited); child.once('exit', exited);
    for (;;) {
      try { await probe(channel, gid, options.signal, open); return; }
      catch { if (!alive(child) || stopped() || Date.now() >= deadline) throw unavailable(); }
      await delay(25);
    }
  };
  const attempt = async (channel: Channel, args: string[]): Promise<boolean> => {
    try { await connect(channel, args); } catch {
      await cleanup(channel); setUp(channel, false); return false;
    }
    if (closed) return false;
    channel.backoff = retryMin; setUp(channel, true); return true;
  };
  const schedule = (channel: Channel) => {
    if (closed) return;
    channel.timer = setTimeout(() => {
      channel.work = (async () => {
        let ok = false;
        try { ok = await attempt(channel, await prepareLocal(channel, gid, options.signal)); } catch { setUp(channel, false); }
        if (!ok) { channel.backoff = Math.min(channel.backoff * 2, retryMax); schedule(channel); }
      })();
    }, channel.backoff);
    channel.timer.unref();
  };
  const down = (channel: Channel) => {
    if (closed || !channel.up) return;
    setUp(channel, false);
    channel.work = cleanup(channel).then(() => { schedule(channel); });
  };
  const close = async () => {
    if (closing) return closing; closed = true;
    if (interval) clearInterval(interval);
    options.signal?.removeEventListener('abort', abort);
    closing = (async () => {
      for (const channel of channels) clearTimeout(channel.timer);
      await Promise.allSettled(channels.flatMap(channel => channel.work === undefined ? [] : [channel.work]));
      const probes = Promise.allSettled(channels.flatMap(channel => channel.probing === undefined ? [] : [channel.probing]));
      await Promise.race([probes, delay(3000, undefined, { ref: false })]);
      await Promise.all(channels.map(cleanup));
      await Promise.allSettled(channels.map(channel => channel.report));
    })();
    return closing;
  };
  const abort = () => { loss(); void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const launches: { channel: Channel; args: string[] }[] = [];
    for (const host of config.hosts) {
      if (stopped()) throw unavailable();
      if (host.host_id === config.controller_host || (host.authority_socket === undefined && host.auth_socket === undefined)) continue;
      const transport = host.command.transport; if (!transport) throw unavailable();
      const channel: Channel = { host, transport, up: false, reported: false, busy: false, backoff: retryMin, report: Promise.resolve() };
      channels.push(channel); launches.push({ channel, args: await prepareLocal(channel, gid, options.signal) });
    }
    await Promise.all(launches.map(async ({ channel, args }) => { channel.work = attempt(channel, args); await channel.work; }));
    if (stopped()) throw unavailable();
    for (const channel of channels) if (!channel.up) schedule(channel);
    ready = true;
    interval = setInterval(() => {
      for (const channel of channels) {
        if (channel.busy || closed || !channel.up) continue; channel.busy = true;
        channel.probing = probe(channel, gid, options.signal, open).catch(() => { down(channel); }).finally(() => { channel.busy = false; });
      }
    }, probeMs); interval.unref();
    const find = (hostId: string) => channels.find(channel => channel.host.host_id === hostId);
    return { close,
      isHostAvailable: (hostId: string) => find(hostId)?.up ?? true,
      availableHosts: () => channels.filter(channel => channel.up).map(channel => channel.host.host_id) };
  } catch { await close(); throw unavailable(); }
}
