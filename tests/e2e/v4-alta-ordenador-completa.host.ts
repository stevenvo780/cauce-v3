import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, Socket, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { plazo } from '../helpers/plazos.js';
import { createNetworkWithFallback } from './docker-network-subnet.js';
import { connectXOuterDocker } from './v4-agentes-x-docker-isolation.js';

const OWNER = 'h11-alta-ordenador-completa-1025';
const SOCKET = 'unix:///var/run/docker.sock';
const USER = 'cauce';
const UID = 1500;
const OWNER_LABEL = 'cauce.e2e.owner';
const RUN_LABEL = 'cauce.e2e.run';
type ResourceKind = 'container' | 'network' | 'image';
interface Resource { kind: ResourceKind; name: string; id?: string }
export interface ComputerCommandOptions { input?: string; timeout?: number }
export interface ComputerCommandResult { code: number; stdout: string; stderr: string }
export interface CompleteComputerOptions { runId: string; evidenceDirectory: string; gatewayUrl: string; additionalGatewayUrls?: string[] }
export interface CompleteComputer {
  name: string; containerId: string; image: string; imageId: string;
  networkName: string; networkId: string; innerDaemonId: string;
  root(args: string[], options?: ComputerCommandOptions): Promise<ComputerCommandResult>;
  user(args: string[], options?: ComputerCommandOptions): Promise<ComputerCommandResult>;
  dockercmd(args: string[], options?: ComputerCommandOptions): Promise<string>;
  copyIn(source: string, destination: string): Promise<void>;
  proof(): Promise<Record<string, unknown>>;
  close(): Promise<Record<string, unknown>>;
}

function command(args: string[], options: ComputerCommandOptions = {}): Promise<ComputerCommandResult> {
  return new Promise(resolveResult => {
    const child = execFile('docker', ['--host', SOCKET, ...args], {
      encoding: 'utf8', timeout: options.timeout ?? plazo(180_000), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', DOCKER_HOST: SOCKET },
    }, (error, stdout, stderr) => { resolveResult({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }); });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}

function requireSuccess(result: ComputerCommandResult, stage: string): string {
  if (result.code !== 0) throw new Error(`owned computer ${stage} failed (exit ${String(result.code)})`);
  return result.stdout.trim();
}

function lines(value: string): string[] { return value.split('\n').map(line => line.trim()).filter(Boolean); }
function absent(result: ComputerCommandResult, name: string): boolean {
  return result.code === 1 && result.stderr.includes(name) && /no such|not found/iu.test(result.stderr);
}

async function ready(check: () => Promise<boolean>, stage: string): Promise<void> {
  const deadline = performance.now() + plazo(120_000);
  while (performance.now() < deadline) {
    if (await check()) return;
    await pause(250);
  }
  throw new Error(`owned computer ${stage} did not become ready`);
}

function ipv4Range(cidr: string): [number, number] {
  const [address, mask] = cidr.split('/');
  const octets = (address ?? '').split('.').map(Number);
  const bits = Number(mask);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)
    || !Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error('owned computer network CIDR is invalid');
  const size = 2 ** (32 - bits), start = Math.floor(octets.reduce((sum, part) => sum * 256 + part, 0) / size) * size;
  return [start, start + size - 1];
}

function assertSeparateSubnet(cidr: string): void {
  const outer = ipv4Range(cidr);
  for (const cidr of ['10.240.0.0/16', '10.241.0.0/24']) {
    const inner = ipv4Range(cidr);
    if (inner[0] <= outer[1] && outer[0] <= inner[1]) throw new Error('owned computer Docker networks overlap its external bridge');
  }
}

async function closeProxies(servers: Server[], sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  const errors: unknown[] = [];
  for (const server of servers) {
    try {
      if (server.listening) await new Promise<void>((resolveClosed, reject) => {
        server.close(error => { if (error) reject(error); else resolveClosed(); });
      });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'owned computer proxy cleanup failed');
}

export async function startCompleteComputer(options: CompleteComputerOptions): Promise<CompleteComputer> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(options.runId)) throw new Error('owned computer run id is invalid');
  const gateways = [options.gatewayUrl, ...options.additionalGatewayUrls ?? []].map(value => new URL(value));
  if (gateways.length > 2 || new Set(gateways.map(value => value.port)).size !== gateways.length) {
    throw new Error('owned computer requires at most two distinct gateway ports');
  }
  for (const gateway of gateways) {
    if (gateway.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(gateway.hostname)
      || !gateway.port || Number(gateway.port) < 1 || gateway.username || gateway.password
      || gateway.pathname !== '/' || gateway.search || gateway.hash) {
      throw new Error('owned computer requires loopback laboratory HTTPS gateways');
    }
  }
  const outer = await connectXOuterDocker();
  const outerDaemonId = await outer.docker(['info', '--format', '{{.ID}}']);
  const prefix = `zz-canary-${OWNER}-${options.runId}`;
  const name = `${prefix}-computer`, image = `${prefix}:computer`, networkName = `${prefix}-network`;
  const resources: Resource[] = [], labels = ['--label', `${OWNER_LABEL}=${OWNER}`, '--label', `${RUN_LABEL}=${options.runId}`];
  const evidence = resolve(options.evidenceDirectory);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  let innerDaemonId = '', containerId = '', imageId = '', networkId = '', closed = false;
  const proxies: Server[] = [];
  const sockets = new Set<Socket>();
  const receipt: Record<string, unknown> = { owner: OWNER, run: options.runId, outerDaemonId, runner: outer.runner, resources };
  const record = async (file: string, value: unknown) => writeFile(join(evidence, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const checked = async (args: string[], stage: string, settings?: ComputerCommandOptions) => requireSuccess(await command(args, settings), stage);
  const root = (args: string[], settings?: ComputerCommandOptions) => command(['exec', '-i', name, ...args], settings);
  const user = (args: string[], settings?: ComputerCommandOptions) => root(['runuser', '-u', USER, '--', 'env',
    `HOME=/home/${USER}`, `USER=${USER}`, `LOGNAME=${USER}`, `PATH=/home/${USER}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    `XDG_RUNTIME_DIR=/run/user/${String(UID)}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${String(UID)}/bus`, ...args], settings);
  const dockercmd = async (args: string[], settings?: ComputerCommandOptions) => requireSuccess(await user(['docker', ...args], settings), 'internal Docker command');
  const identify = async (resource: Resource): Promise<boolean> => {
    const field = resource.kind === 'network' ? '.Labels' : '.Config.Labels';
    const result = await command([resource.kind, 'inspect', '--format',
      `{{.Id}}\t{{index ${field} "${OWNER_LABEL}"}}\t{{index ${field} "${RUN_LABEL}"}}`, resource.name]);
    if (absent(result, resource.name)) return false;
    const [id, owner, run] = requireSuccess(result, 'resource identity').split('\t');
    if (!id || owner !== OWNER || run !== options.runId || resource.id !== undefined && id !== resource.id) {
      throw new Error(`owned computer ${resource.kind} identity changed`);
    }
    resource.id = id;
    return true;
  };
  const proof = async (): Promise<Record<string, unknown>> => {
    if (await outer.docker(['info', '--format', '{{.ID}}']) !== outerDaemonId) throw new Error('owned computer outer daemon identity changed');
    const facts = (await checked(['container', 'inspect', '--format',
      '{{.Id}}\t{{.Image}}\t{{.HostConfig.Privileged}}\t{{.HostConfig.NetworkMode}}\t{{.HostConfig.PidMode}}\t{{.HostConfig.IpcMode}}\t{{.HostConfig.CgroupnsMode}}\t{{len .Mounts}}', name], 'namespace proof')).split('\t');
    const [id, currentImage, privileged, network, pidMode, ipcMode, cgroupMode, mounts] = facts;
    if (id !== containerId || currentImage !== imageId || privileged !== 'true' || network !== networkName
      || !['', 'private'].includes(pidMode ?? '') || ipcMode !== 'private' || cgroupMode !== 'private' || mounts !== '0') {
      throw new Error('owned computer namespaces or zero-mount boundary changed');
    }
    const daemonId = await dockercmd(['info', '--format', '{{.ID}}']);
    if (!daemonId || daemonId === outerDaemonId || innerDaemonId && daemonId !== innerDaemonId) throw new Error('owned computer daemon is not dedicated');
    const pid1 = requireSuccess(await root(['cat', '/proc/1/comm']), 'PID1 proof');
    if (pid1 !== 'systemd') throw new Error('owned computer PID1 is not systemd');
    const userUid = requireSuccess(await user(['id', '-u']), 'normal user proof');
    const linger = requireSuccess(await root(['loginctl', 'show-user', USER, '--property=Linger', '--value']), 'linger proof');
    const dockerService = requireSuccess(await root(['systemctl', 'is-active', 'docker.service']), 'dockerd service proof');
    if (userUid !== String(UID) || linger !== 'yes' || dockerService !== 'active') throw new Error('owned computer user or dockerd service is not ready');
    return { containerId, imageId, networkId, innerDaemonId: daemonId, outerDaemonId, pid1,
      privileged: true, mounts: 0, network: networkName, pidMode, ipcMode, cgroupMode,
      userUid, linger, dockerService };
  };
  const inventory = async () => ({ containers: lines(await dockercmd(['ps', '-aq', '--no-trunc'])),
    volumes: lines(await dockercmd(['volume', 'ls', '-q'])), networks: lines(await dockercmd(['network', 'ls', '--format', '{{.Name}}'])),
    images: [...new Set(lines(await dockercmd(['image', 'ls', '-q', '--no-trunc'])))] });
  const close = async (): Promise<Record<string, unknown>> => {
    if (closed) return receipt;
    const failures: Error[] = [];
    const observations: { kind: ResourceKind; name: string; id: string | null; absent: boolean }[] = [];
    if (innerDaemonId) {
      try {
        await proof();
        const units = lines(requireSuccess(await user(['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend',
          'cauce-v3-host-executor-*.service']), 'executor cleanup inventory')).map(line => line.split(/\s+/u)[0]);
        for (const unit of units) {
          if (!unit || !/^cauce-v3-host-executor-[A-Za-z0-9_.-]+\.service$/u.test(unit)) throw new Error('owned computer executor unit is invalid');
          requireSuccess(await user(['systemctl', '--user', 'stop', unit]), 'executor cleanup stop');
        }
        const before = await inventory(); receipt.innerBeforeCleanup = before;
        for (const id of before.containers) await dockercmd(['rm', '-f', id]);
        for (const network of before.networks.filter(value => !['bridge', 'host', 'none'].includes(value))) await dockercmd(['network', 'rm', network]);
        for (const volume of before.volumes) await dockercmd(['volume', 'rm', volume]);
        for (const id of before.images) {
          if ((await user(['docker', 'image', 'inspect', id])).code === 0) await dockercmd(['image', 'rm', '-f', id]);
        }
        const after = await inventory(); receipt.innerAfterCleanup = after;
        if (after.containers.length || after.volumes.length || after.images.length
          || after.networks.some(value => !['bridge', 'host', 'none'].includes(value))) throw new Error('owned computer inner Docker cleanup has residue');
      } catch (error) { failures.push(error instanceof Error ? error : new Error('owned computer inner cleanup failed')); }
    }
    try { await closeProxies(proxies, sockets); } catch { failures.push(new Error('owned computer gateway proxy cleanup failed')); }
    if (await outer.docker(['info', '--format', '{{.ID}}']) !== outerDaemonId) throw new Error('owned computer cleanup daemon changed');
    for (const resource of [...resources].reverse()) {
      try {
        if (await identify(resource)) await checked([resource.kind, 'rm', ...(resource.kind === 'container' ? ['-f'] : []), resource.id ?? resource.name], 'exact resource cleanup');
        const result = await command([resource.kind, 'inspect', resource.name]);
        if (!absent(result, resource.name)) throw new Error(`owned computer ${resource.kind} absence is unconfirmed`);
        observations.push({ kind: resource.kind, name: resource.name, id: resource.id ?? null, absent: true });
      } catch (error) {
        observations.push({ kind: resource.kind, name: resource.name, id: resource.id ?? null, absent: false });
        failures.push(error instanceof Error ? error : new Error('owned computer exact cleanup failed'));
      }
    }
    receipt.closed = failures.length === 0;
    receipt.cleanupResourceObservations = observations;
    receipt.cleanupErrors = failures.map(error => error.message);
    await record('computer-cleanup.json', receipt);
    if (failures.length) throw new AggregateError(failures, 'owned computer cleanup failed');
    closed = true;
    return receipt;
  };
  try {
    for (const [kind, resource] of [['image', image], ['network', networkName], ['container', name]] as const) {
      if (!absent(await command([kind, 'inspect', resource]), resource)) throw new Error(`owned computer ${kind} name is not free`);
    }
    const recipe = join(process.cwd(), 'tests/e2e/v4-alta-ordenador-completa.Dockerfile');
    const recipeSource = await readFile(recipe, 'utf8');
    receipt.dockerfileSha256 = createHash('sha256').update(recipeSource).digest('hex');
    const imageResource: Resource = { kind: 'image', name: image }; resources.push(imageResource);
    const build = await command(['build', '--progress=plain', '--tag', image, ...labels, '-'], { input: recipeSource, timeout: plazo(600_000) });
    await writeFile(join(evidence, 'computer-build.log'), build.stdout + build.stderr, { mode: 0o600 });
    requireSuccess(build, 'image build'); await identify(imageResource); imageId = imageResource.id ?? '';
    const networkResource: Resource = { kind: 'network', name: networkName }; resources.push(networkResource);
    networkId = await createNetworkWithFallback(args => checked([...args], 'network create'), labels, networkName);
    networkResource.id = networkId; await identify(networkResource);
    const subnets = await checked(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{println .Subnet}}{{end}}', networkName], 'external subnet');
    for (const subnet of lines(subnets).filter(value => !value.includes(':'))) assertSeparateSubnet(subnet);
    const bridge = (await checked(['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', networkName], 'bridge gateway')).trim();
    const forwards: { gatewayPort: number; proxyPort: number }[] = [];
    for (const gateway of gateways) {
      const proxy = createServer(socket => {
        sockets.add(socket);
        const upstream = new Socket(); sockets.add(upstream);
        const clear = () => { sockets.delete(socket); sockets.delete(upstream); socket.destroy(); upstream.destroy(); };
        socket.on('error', clear); upstream.on('error', clear); socket.on('close', clear); upstream.on('close', clear);
        upstream.connect(Number(gateway.port), '127.0.0.1'); socket.pipe(upstream); upstream.pipe(socket);
      });
      proxies.push(proxy);
      await new Promise<void>((resolveListening, reject) => { proxy.once('error', reject); proxy.listen(0, bridge, resolveListening); });
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('owned computer proxy address is unavailable');
      forwards.push({ gatewayPort: Number(gateway.port), proxyPort: address.port });
    }
    const computerResource: Resource = { kind: 'container', name }; resources.push(computerResource);
    containerId = await checked(['run', '--detach', '--name', name, ...labels, '--privileged', '--cgroupns=private', '--ipc=private',
      '--network', networkName, '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp', imageId], 'systemd start');
    computerResource.id = containerId; await identify(computerResource);
    await ready(async () => (await root(['test', '-S', '/run/dbus/system_bus_socket'])).code === 0, 'system bus');
    requireSuccess(await root(['loginctl', 'enable-linger', USER]), 'enable linger');
    requireSuccess(await root(['systemctl', 'start', `user@${String(UID)}.service`]), 'user manager');
    await ready(async () => (await user(['systemctl', '--user', 'is-system-running'])).code === 0, 'normal user systemd');
    await ready(async () => (await user(['docker', 'info', '--format', '{{.ID}}'])).code === 0, 'dedicated dockerd');
    innerDaemonId = await dockercmd(['info', '--format', '{{.ID}}']);
    const forward = 'const n=require("node:net"),s=n.createServer(a=>{const b=n.connect(Number(process.argv[2]),process.argv[1]);'
      + 'const c=()=>{a.destroy();b.destroy()};a.on("error",c);b.on("error",c);a.on("close",c);b.on("close",c);a.pipe(b);b.pipe(a)});'
      + 's.listen(Number(process.argv[3]),"127.0.0.1");';
    for (const item of forwards) {
      await checked(['exec', '--detach', name, 'node', '-e', forward, bridge, String(item.proxyPort), String(item.gatewayPort)], 'loopback gateway forward');
      await ready(async () => (await root(['python3', '-c', 'import socket,sys;s=socket.create_connection(("127.0.0.1",int(sys.argv[1])),2);s.close()', String(item.gatewayPort)])).code === 0, 'loopback gateway');
    }
    receipt.gatewayForwards = forwards;
    const initial = await inventory();
    if (initial.containers.length || initial.volumes.length || initial.images.length) throw new Error('owned computer dockerd is not initially empty');
    receipt.initial = initial; receipt.proof = await proof();
    await record('computer-started.json', receipt);
    return { name, containerId, image, imageId, networkName, networkId, innerDaemonId, root, user, dockercmd, proof, close,
      copyIn: async (source, destination) => {
        const details = await lstat(source);
        if (!details.isFile() || !/^\/(?:opt\/h11|tmp|home\/cauce|usr\/local\/share\/ca-certificates)(?:\/|$)/u.test(destination)
          || destination.split('/').includes('..') || source.split('/').some(part => ['credentials', 'auth.json', 'settings.local.json'].includes(part)
            || part.startsWith('.env') || part.endsWith('.key'))) throw new Error('owned computer copy requires a public regular file and a private destination');
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(source) as AsyncIterable<Buffer>) digest.update(chunk);
        await checked(['cp', source, `${name}:${destination}`], 'public artifact copy');
        const observed = requireSuccess(await root(['sha256sum', '--', destination]), 'public artifact copy verification').split(/\s+/u)[0];
        if (observed !== digest.digest('hex')) throw new Error('owned computer copied public artifact SHA-256 differs');
      } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'owned computer startup and cleanup failed'); }
    throw error;
  }
}
