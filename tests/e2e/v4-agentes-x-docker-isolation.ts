import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createNetworkWithFallback } from './docker-network-subnet.js';

export const X_DIND_IMAGE = 'docker@sha256:97545b7bab66319a476800a85b008b25c06681733d484909e2a776281e41574f';
const OWNER_LABEL = 'cauce.e2e.owner';
const ISOLATION_LABEL = 'cauce.e2e.isolation';
const FORMAT = '{{.ID}}\t{{.Names}}';
const INNER_POOL = '10.240.0.0/16';
const INNER_BRIDGE = '10.241.0.1/24';
interface CommandResult { code: number; stdout: string; stderr: string }
interface ContainerRow { id: string; name: string }
type OuterKind = 'container' | 'network' | 'volume';
interface CreatedResource { kind: OuterKind; name: string; id: string }
export interface XDockerInventory { containers: ContainerRow[]; networks: string[]; volumes: string[]; images: string[] }
export interface XDockerProof { daemonId: string; outerDaemonId: string; inventory: XDockerInventory }
export interface X2Docker {
  command(args: string[], input?: string): Promise<CommandResult>;
  docker(args: string[], input?: string): Promise<string>;
}
export interface XDockerIsolation extends X2Docker {
  readonly dockerSocket: string;
  readonly hostDirectories: string[];
  readonly workRoot: string;
  readonly receipt: Record<string, unknown>;
  assertDedicated(): Promise<XDockerProof>;
  purgeOwned(): Promise<XDockerInventory>;
  cleanupRuntime(): Promise<XDockerInventory>;
  close(): Promise<Record<string, unknown>>;
}

function command(endpoint: string, args: string[], input?: string, timeout = 180_000): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = execFile('docker', ['--host', endpoint, ...args], { encoding: 'utf8', timeout,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', DOCKER_HOST: endpoint } },
    (error, stdout, stderr) => { resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0,
      stdout, stderr: error && !stderr ? error.message : stderr }); });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

async function checked(endpoint: string, args: string[], input?: string, timeout?: number): Promise<string> {
  const result = await command(endpoint, args, input, timeout);
  if (result.code !== 0) throw new Error(`isolated docker ${args[0] ?? ''} failed (${String(result.code)}): ${result.stderr.trim().slice(-1200)}`);
  return result.stdout.trim();
}

async function assertAbsent(endpoint: string, kind: OuterKind, name: string): Promise<void> {
  const observed = await command(endpoint, [kind, 'inspect', '--format', kind === 'volume' ? '{{.Name}}' : '{{.Id}}', name], undefined, 30_000);
  if (observed.code === 0) throw new Error(`isolated ${kind} already exists: ${name}`);
  const error = observed.stderr.toLowerCase();
  const absent = error.includes(`no such ${kind}`) || error.includes('no such object')
    || kind === 'network' && error.includes(`network ${name} not found`);
  if (observed.code !== 1 || !observed.stderr.includes(name) || !absent) {
    throw new Error(`cannot establish isolated ${kind} absence: ${observed.stderr.trim().slice(-1200)}`);
  }
}

async function assertOuterResource(endpoint: string, resource: CreatedResource, owner: string, token: string): Promise<void> {
  const labels = resource.kind === 'container' ? '.Config.Labels' : '.Labels';
  const observed = await checked(endpoint, [resource.kind, 'inspect', '--format',
    `${resource.kind === 'volume' ? '{{.Name}}' : '{{.Id}}'}\t{{index ${labels} "${OWNER_LABEL}"}}\t{{index ${labels} "${ISOLATION_LABEL}"}}`,
    resource.name], undefined, 30_000);
  const [identity, actualOwner, actualToken] = observed.split('\t');
  if (identity !== resource.id || actualOwner !== owner || actualToken !== token) throw new Error(`isolated ${resource.kind} ownership or identity changed`);
}

function lines(value: string): string[] { return value.split('\n').filter(Boolean); }
function range(cidr: string): [number, number] {
  const [address, bits] = cidr.split('/');
  const octets = (address ?? '').split('.').map(Number);
  const prefix = Number(bits);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)
      || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error('Docker IPv4 subnet is invalid');
  const value = octets.reduce((sum, part) => sum * 256 + part, 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(value / size) * size;
  return [start, start + size - 1];
}
async function assertAddressPools(endpoint: string): Promise<void> {
  const networks = lines(await checked(endpoint, ['network', 'ls', '-q']));
  const subnets = networks.length ? lines(await checked(endpoint, ['network', 'inspect', '--format',
    '{{range .IPAM.Config}}{{println .Subnet}}{{end}}', ...networks])).filter(value => !value.includes(':')) : [];
  const configured = JSON.parse(await checked(endpoint, ['info', '--format', '{{json .DefaultAddressPools}}'])) as { Base: string }[] | null;
  for (const subnet of [...subnets, ...(configured ?? []).map(row => row.Base)].filter(value => value && !value.includes(':'))) {
    const observed = range(subnet);
    if ([INNER_POOL, INNER_BRIDGE].some(cidr => { const inner = range(cidr); return inner[0] <= observed[1] && observed[0] <= inner[1]; })) {
      throw new Error(`outer Docker subnet overlaps the dedicated daemon pool: ${subnet}`);
    }
  }
}
async function inventory(endpoint: string): Promise<XDockerInventory> {
  const output = await Promise.all([
    checked(endpoint, ['ps', '-a', '--format', FORMAT]), checked(endpoint, ['network', 'ls', '--format', '{{.Name}}']),
    checked(endpoint, ['volume', 'ls', '--format', '{{.Name}}']), checked(endpoint, ['image', 'ls', '-q', '--no-trunc']),
  ]);
  return { containers: lines(output[0]).map(row => {
    const [id, name] = row.split('\t');
    if (!id || !name) throw new Error('isolated Docker inventory is malformed');
    return { id, name };
  }), networks: lines(output[1]), volumes: lines(output[2]), images: [...new Set(lines(output[3]))] };
}

function assertNames(value: XDockerInventory, prefix: string): void {
  const unexpected = [...value.containers.map(row => row.name), ...value.volumes,
    ...value.networks.filter(name => !['bridge', 'host', 'none'].includes(name))].filter(name => !name.startsWith(`${prefix}-`));
  if (unexpected.length) throw new Error(`isolated Docker contains resources outside its prefix: ${unexpected.join(', ')}`);
}

async function assertRunner(endpoint: string): Promise<{ daemonId: string; proof: Record<string, unknown> }> {
  const environment = { CI: process.env.CI, CAUCE_REQUIRE_TESTCONTAINERS: process.env.CAUCE_REQUIRE_TESTCONTAINERS,
    DOCKER_HOST: process.env.DOCKER_HOST, HOSTNAME: process.env.HOSTNAME };
  const predicates = { ci: environment.CI === '1', required: environment.CAUCE_REQUIRE_TESTCONTAINERS === '1',
    endpoint: environment.DOCKER_HOST === endpoint };
  const proof: Record<string, unknown> = { environment, predicates };
  try {
    if (!Object.values(predicates).every(Boolean)) throw new Error('Docker isolation requires the actual e2e-lab runner');
    const [mounts, cgroups] = await Promise.all([
      readFile('/proc/self/mountinfo', 'utf8').catch(() => ''), readFile('/proc/self/cgroup', 'utf8').catch(() => ''),
    ]);
    const candidates = new Set<string>();
    for (const line of mounts.split('\n')) {
      const fields = line.split(' ');
      if (!['/etc/hostname', '/etc/hosts', '/etc/resolv.conf'].includes(fields[4] ?? '')) continue;
      const match = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)$/u.exec(fields[3] ?? '');
      if (match?.[1]) candidates.add(match[1]);
    }
    for (const match of cgroups.matchAll(/(?:docker-|docker\/)([0-9a-f]{64})(?:\.scope)?/gu)) {
      if (match[1]) candidates.add(match[1]);
    }
    proof.candidateIds = [...candidates];
    if (candidates.size !== 1) throw new Error('runner kernel metadata does not identify one Docker container');
    const reference = [...candidates][0];
    if (!reference) throw new Error('runner Docker identity is unavailable');
    const runner = await checked(endpoint, ['inspect', '--format',
      `{{.Id}}\t{{.Name}}\t{{.Config.Image}}\t{{.HostConfig.NetworkMode}}\t{{index .Config.Labels "${OWNER_LABEL}"}}`, reference]);
    const [id, runnerName, image, mode, owner] = runner.split('\t');
    const daemon = await checked(endpoint, ['info', '--format', '{{.Name}}\t{{.ID}}']);
    const [name, identity] = daemon.split('\t');
    proof.runner = { id, name: runnerName, image, mode, owner }; proof.daemon = { name, id: identity };
    if (id !== reference || !/^cauce-e2e-lab-runner:[0-9a-f]{12}$/u.test(image ?? '') || mode !== 'host'
        || !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(owner ?? '') || !runnerName?.startsWith(`/zz-canary-e2e-${owner ?? ''}-`)
        || !/^docker-lab(?:-[23])?$/u.test(name ?? '') || !identity) throw new Error('Docker isolation is outside the laboratory VM');
    return { daemonId: identity, proof };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`${detail}; runner proof=${JSON.stringify(proof)}`, { cause: error }), { isolationReceipt: { runner: proof } });
  }
}

export async function connectXOuterDocker(): Promise<X2Docker & { runner: Record<string, unknown> }> {
  const endpoint = 'unix:///var/run/docker.sock';
  const runner = await assertRunner(endpoint);
  return { runner: runner.proof, command: (args, input) => command(endpoint, args, input),
    docker: (args, input) => checked(endpoint, args, input) };
}

export async function startXDockerIsolation(options: { prefix: string; owner: string }): Promise<XDockerIsolation> {
  const { prefix, owner } = options;
  if (!/^zz-canary-[a-z0-9-]{1,70}$/u.test(prefix) || !/^[a-z0-9-]{1,64}$/u.test(owner)) throw new Error('Docker isolation ownership is invalid');
  const outer = 'unix:///var/run/docker.sock';
  const runner = await assertRunner(outer);
  const outerDaemonId = runner.daemonId;
  await assertAddressPools(outer);
  const outerPrefix = `zz-canary-${owner}-dind-${randomUUID().slice(0, 8)}`;
  const name = `${outerPrefix}-daemon`;
  const network = `${outerPrefix}-network`;
  const volume = `${outerPrefix}-data`;
  const permissions = `${outerPrefix}-permissions`;
  for (const [kind, resource] of [['container', name], ['network', network], ['volume', volume]] as const) await assertAbsent(outer, kind, resource);
  await assertAbsent(outer, 'container', permissions);
  const directory = await mkdtemp(join('/datos', `x2-dind-${randomUUID().slice(0, 8)}-`));
  await chmod(directory, 0o755);
  const workRoot = join(directory, 'work');
  const sockets = join(directory, 'socket');
  await mkdir(workRoot, { mode: 0o755 }); await mkdir(sockets, { mode: 0o755 });
  const dockerSocket = join(sockets, 'docker.sock');
  const endpoint = `unix://${dockerSocket}`;
  const token = randomUUID();
  const labels = ['--label', `${OWNER_LABEL}=${owner}`, '--label', `${ISOLATION_LABEL}=${token}`];
  const created = new Map<OuterKind, CreatedResource>();
  const receipt: Record<string, unknown> = { image: X_DIND_IMAGE, prefix, outerPrefix, name, network, volume, permissions, dockerSocket, outerDaemonId,
    addressPool: INNER_POOL, bridge: INNER_BRIDGE, isolation: token, runner: runner.proof };
  let daemonId = '';
  let daemonCreated = false;
  let closed = false;
  const run = (args: string[], input?: string) => checked(endpoint, args, input);
  const fenceOuter = async (): Promise<void> => {
    if (created.size !== 3) throw new Error('isolated Docker outer resources were not all created and fenced');
    for (const resource of created.values()) await assertOuterResource(outer, resource, owner, token);
  };
  const retain = async (error: unknown): Promise<never> => {
    receipt.cleanupErrors = [error instanceof Error ? error.message : String(error)];
    receipt.retainedCreated = [...created.values()];
    receipt.residueObservations = await Promise.all([...created.values()].map(async resource => {
      const observed = await command(outer, [resource.kind, 'inspect', '--format',
        resource.kind === 'volume' ? '{{.Name}}' : '{{.Id}}', resource.name], undefined, 5000);
      return { ...resource, code: observed.code, observed: observed.stdout.trim(), error: observed.stderr.trim().slice(-500) };
    }));
    throw Object.assign(new AggregateError([error], 'isolated Docker cleanup is unverified; created resources retained', { cause: error }),
      { isolationReceipt: receipt });
  };
  const assertDedicated = async (): Promise<XDockerProof> => {
    await fenceOuter();
    if (closed || !daemonId || await run(['info', '--format', '{{.ID}}']) !== daemonId || daemonId === outerDaemonId) {
      throw new Error('isolated Docker daemon identity changed');
    }
    const current = await inventory(endpoint); assertNames(current, prefix);
    return { daemonId, outerDaemonId, inventory: current };
  };
  const purgeOwned = async (): Promise<XDockerInventory> => {
    const proof = await assertDedicated();
    for (const row of proof.inventory.containers) await run(['rm', '-f', row.id]);
    for (const item of proof.inventory.networks.filter(value => !['bridge', 'host', 'none'].includes(value))) await run(['network', 'rm', item]);
    for (const item of proof.inventory.volumes) await run(['volume', 'rm', item]);
    for (const image of proof.inventory.images) {
      const present = await command(endpoint, ['image', 'inspect', '--format', '{{.Id}}', image]);
      if (present.code === 0) await run(['image', 'rm', '-f', image]);
      else if (!present.stderr.includes('No such image')) throw new Error('cannot verify isolated image absence');
    }
    const remaining = await inventory(endpoint); assertNames(remaining, prefix);
    if (remaining.containers.length || remaining.volumes.length || remaining.images.length
        || remaining.networks.some(value => !['bridge', 'host', 'none'].includes(value))) throw new Error('isolated Docker resources survived cleanup');
    receipt.cleanupRuntime = remaining;
    return remaining;
  };
  const close = async (): Promise<Record<string, unknown>> => {
    if (closed) return receipt;
    if (daemonId) { try { await purgeOwned(); } catch (error) { return retain(error); } }
    for (const kind of ['container', 'network', 'volume'] as const) {
      const resource = created.get(kind);
      if (!resource) continue;
      try {
        await assertOuterResource(outer, resource, owner, token);
        await checked(outer, [kind === 'container' ? 'rm' : kind, ...(kind === 'container' ? ['-f'] : ['rm']), resource.id], undefined, 60_000);
        await assertAbsent(outer, kind, resource.name);
        created.delete(kind);
      } catch (error) { return retain(error); }
    }
    if (daemonCreated) {
      await assertAbsent(outer, 'container', permissions);
      await checked(outer, ['run', '--rm', '--name', permissions, ...labels,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--mount', `type=bind,source=${sockets},destination=/owned-run`, '--entrypoint', '/bin/sh', X_DIND_IMAGE,
      '-c', 'chown -R "$1:$2" /owned-run && chmod -R u+rwX /owned-run', '--',
      String(process.getuid?.() ?? 1000), String(process.getgid?.() ?? 1000)], undefined, 30_000);
      await assertAbsent(outer, 'container', permissions);
    }
    await rm(directory, { recursive: true });
    closed = true; receipt.closed = true;
    return receipt;
  };
  try {
    await checked(outer, ['pull', X_DIND_IMAGE]);
    const networkId = await createNetworkWithFallback(args => checked(outer, [...args]), labels, network);
    const createdNetwork: CreatedResource = { kind: 'network', name: network, id: networkId };
    await assertOuterResource(outer, createdNetwork, owner, token); created.set('network', createdNetwork);
    await checked(outer, ['volume', 'create', ...labels, volume]);
    const createdVolume: CreatedResource = { kind: 'volume', name: volume, id: volume };
    await assertOuterResource(outer, createdVolume, owner, token); created.set('volume', createdVolume);
    const id = await checked(outer, ['run', '-d', '--init', '--name', name, ...labels, '--privileged', '--network', network,
      '--cgroupns', 'private', '--ipc', 'private',
      '--mount', `type=volume,source=${volume},destination=/var/lib/docker`,
      '--mount', `type=bind,source=${directory},destination=${directory}`,
      '--mount', `type=bind,source=${sockets},destination=/var/run`, X_DIND_IMAGE, 'dockerd',
      '--host=unix:///var/run/docker.sock', '--data-root=/var/lib/docker', '--exec-root=/var/run/docker', '--pidfile=/var/run/docker.pid',
      `--default-address-pool=base=${INNER_POOL},size=24`, `--bip=${INNER_BRIDGE}`]);
    receipt.containerId = id;
    daemonCreated = true;
    const createdContainer: CreatedResource = { kind: 'container', name, id };
    await assertOuterResource(outer, createdContainer, owner, token); created.set('container', createdContainer);
    const [NetworkMode, PidMode, IpcMode, CgroupnsMode] = (await checked(outer, ['inspect', '--format',
      '{{.HostConfig.NetworkMode}}\t{{.HostConfig.PidMode}}\t{{.HostConfig.IpcMode}}\t{{.HostConfig.CgroupnsMode}}', id])).split('\t');
    receipt.HostConfig = { NetworkMode, PidMode, IpcMode, CgroupnsMode };
    if (NetworkMode !== network || !['', 'private'].includes(PidMode ?? '') || IpcMode !== 'private' || CgroupnsMode !== 'private') {
      throw new Error('isolated Docker namespace modes differ');
    }
    const deadline = performance.now() + 120_000;
    let ready = false;
    while (performance.now() < deadline) {
      const observed = await command(outer, ['exec', name, 'docker', 'info', '--format', '{{.ID}}'], undefined, 5000);
      if (observed.code === 0 && observed.stdout.trim()) { ready = true; break; }
      if (await checked(outer, ['inspect', '--format', '{{.State.Running}}', name]) !== 'true') {
        const logs = await command(outer, ['logs', '--tail', '30', name], undefined, 5000);
        receipt.startupDiagnostic = (logs.stdout + logs.stderr).slice(-4000);
        throw new Error(`isolated Docker container stopped before readiness: ${String(receipt.startupDiagnostic)}`);
      }
      await pause(250);
    }
    if (!ready) throw new Error('isolated Docker did not become ready within 120 seconds');
    const group = (await lstat('/var/run/docker.sock')).gid;
    await checked(outer, ['exec', name, 'chown', `0:${String(group)}`, '/var/run/docker.sock']);
    await checked(outer, ['exec', name, 'chmod', '660', '/var/run/docker.sock']);
    if (!(await lstat(dockerSocket)).isSocket()) throw new Error('isolated Docker did not create its owned Unix socket');
    daemonId = await run(['info', '--format', '{{.ID}}']);
    const initial = await assertDedicated();
    if (initial.inventory.containers.length || initial.inventory.images.length || initial.inventory.volumes.length) throw new Error('isolated Docker was not initially empty');
    receipt.initial = initial;
    return { dockerSocket, workRoot, hostDirectories: [directory], receipt, command: (args, input) => command(endpoint, args, input),
      docker: run, assertDedicated, purgeOwned, cleanupRuntime: purgeOwned, close };
  } catch (error) {
    receipt.startupError = error instanceof Error ? error.message : String(error);
    try { await close(); } catch (cleanup) {
      throw Object.assign(new AggregateError([error, cleanup], 'Docker isolation startup and cleanup failed', { cause: error }), { isolationReceipt: receipt });
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { isolationReceipt: receipt });
  }
}
