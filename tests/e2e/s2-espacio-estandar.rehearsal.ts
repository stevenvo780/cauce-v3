import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import type { MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { docker, type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { Legacy, Probe, Runtime } from './s2-espacio-estandar.test.js';
import { connectXOuterDocker } from './v4-agentes-x-docker-isolation.js';

const execute = promisify(execFile);
const PREVIOUS_OPS = 'c25cc0e636a4836b417c0a9081c804498a74b672';
const PYTHON = "import runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,sys.argv.pop(0));runpy.run_path(sys.argv[0],run_name='__main__')";
export const HARNESS_SOURCE_FILES = ['packages/protocol/src/context-retirement.ts', 'packages/store/src/context-retirement.ts',
  'packages/store/src/context-git-retirement.ts', 'services/gateway/src/console/context-repository/retirement-routes.ts'];
const SOURCE_FILES = ['tests/e2e/s2-espacio-estandar.test.ts', 'tests/e2e/s2-espacio-estandar.rehearsal.ts',
  'tests/e2e/s2b-espacio-estandar-prod.test.ts', '.delegados/v4/espacio-estandar.sh',
  '.delegados/v4/espacio-estandar.py', '.delegados/v4/espacio-estandar.remoto.py',
  '.delegados/v4/live_adapter.py', '.delegados/v4/live_adapter_probe.py', ...HARNESS_SOURCE_FILES];
const PREPARATION_FILES = ['tests/e2e/s2b-espacio-estandar-preparado.test.ts',
  '.delegados/v4/espacio-estandar-preparar.sh', '.delegados/v4/espacio-estandar-preparar.py'];

export function registerRehearsalDockerContext(): void {
  const previousDocker = { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
  let dockerConfiguration = '';
  beforeAll(async () => {
    const outer = await connectXOuterDocker();
    const endpoint = process.env.DOCKER_HOST;
    assert.equal(endpoint, 'unix:///var/run/docker.sock');
    const format = '{{.Name}}\t{{.ID}}';
    const daemon = await outer.docker(['info', '--format', format]);
    const [name, identity] = daemon.split('\t');
    const contexts: Record<string, string> = { 'docker-lab': 'lab', 'docker-lab-2': 'lab2', 'docker-lab-3': 'lab3' };
    const context = contexts[name ?? ''];
    assert.ok(context && identity, 'standard-space rehearsal requires a laboratory Docker daemon');
    dockerConfiguration = await mkdtemp('/tmp/zz-canary-standard-space-docker-');
    const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: dockerConfiguration };
    delete environment.DOCKER_CONTEXT;
    const options = { env: environment, encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 64 * 1024 };
    await execute('docker', ['context', 'create', context, '--docker', 'host=' + endpoint], options);
    const configured = await execute('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], options);
    assert.equal(configured.stdout.trim(), endpoint);
    const selected = await execute('docker', ['info', '--format', format],
      { ...options, env: { ...environment, DOCKER_CONTEXT: context } });
    assert.equal(selected.stdout.trim(), daemon, 'named Docker context must address the runner daemon');
    process.env.DOCKER_CONFIG = dockerConfiguration;
    process.env.DOCKER_CONTEXT = context;
    console.info('S2B_LABORATORY_DOCKER_ENDPOINT', JSON.stringify({ context, endpoint, name, identity, runner: outer.runner }));
  });
  // Parent cleanup must still run when the imported child suite's cleanup fails.
  afterAll(async () => {
    if (previousDocker.DOCKER_CONTEXT === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previousDocker.DOCKER_CONTEXT;
    if (previousDocker.DOCKER_CONFIG === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousDocker.DOCKER_CONFIG;
    if (dockerConfiguration) await rm(dockerConfiguration, { recursive: true, force: true });
  });
}

type Save = (name: string, value: unknown) => Promise<void>;
async function command(file: string, args: string[], input?: string) {
  const running = execute(file, args, { timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  if (input !== undefined) running.child.stdin?.end(input);
  return running;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function addRehearsalRuntimes(options: {
  directory: string; run: string; computer: ComputerHarness; runtimes: Runtime[];
}) {
  const ws = options.runtimes.find(runtime => !runtime.native && runtime.harness === 'codex');
  const native = options.runtimes.find(runtime => runtime.native); assert.ok(ws && native);
  for (const original of [ws, native]) {
    const alias = 'zz-canary-s2b-' + (original.native ? 'native' : 'ws') + '-' + options.run;
    const stateRoot = original.home + '/zz-canary-s2b-' + options.run;
    const state = stateRoot + (original.native ? '/n' : '/w');
    assert.ok(Buffer.byteLength(state + '/e-' + '0'.repeat(36) + '.sock') <= 100);
    const runtime: Runtime = { ...original, alias, state, rehearsal: true,
      unit: 'cauce-v3-' + (original.native ? 'host-' : 'container-') + alias + '.service' };
    options.runtimes.push(runtime);
    if (runtime.native) {
      const prepared = await options.computer.onComputer(['mkdir', '-m', '0700', stateRoot, state]);
      expect(prepared.code, prepared.stderr).toBe(0);
    } else {
      const localState = join(options.directory, 'ws-home', 'zz-canary-s2b-' + options.run);
      await mkdir(localState, { mode: 0o700 }); await mkdir(join(localState, 'w'), { mode: 0o700 });
      const config = join(options.directory, 'ws-home/.local/share/cauce-v3/config', alias, '.codex');
      await mkdir(config, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries({ 'AGENTS.md': 'Owned rehearsal provider\n', 'config.toml': '', 'auth.json': '{}\n' })) {
        await writeFile(join(config, name), content, { mode: 0o600 });
      }
    }
  }
}

export async function prepareRehearsalAuth(pool: DatabasePool, fallback: MtlsAuthProvider, actor: string, run: string) {
  const email = 'zz-canary-s2b-' + run + '@example.invalid';
  const password = randomBytes(32).toString('base64url');
  await maintainConsoleUser(pool, { email, name: 'Owned rehearsal operator', role: 'operator', tenant: 'Steven', alias: actor,
    updateOnly: false, activate: false }, await hashPassword(password));
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32), fallback });
  await provider.ready();
  return { provider, email, password, origin: 'https://s2b.example.invalid' };
}

interface Configuration {
  root: string; directory: string; owner: string; run: string; release: string; bundleDigest: string;
  computer: ComputerHarness; pool: DatabasePool; runtimes: Runtime[]; consoleAuth: Awaited<ReturnType<typeof prepareRehearsalAuth>>;
  gateway: string; certificate: string; save: Save;
  preparedCommit?: string;
}
export interface Rehearsal {
  configuration: Configuration; ops: string; opsDigest: string; sdk: string; sdkDigest: string; releaseRoot: string; session: string;
  sources: Record<string, string>;
}
interface PreparedSources {
  version: number; commit: string; inventory_path: string; ops_release: string; ops_sha256: string;
  sdk_release: string; sdk_sha256: string;
}
interface ToolReceipt {
  version: number; status: string; phase: string;
  probe: { process_alive: boolean; hello_ack: boolean; lease_valid: boolean; delivery_done: boolean; delivery_id: string };
  after: { process: { layout: Record<string, unknown> } };
  reverted?: { process: { layout: Record<string, unknown> } };
  revert_probe?: ToolReceipt['probe'];
}
async function files(root: string, relative = '', sealed = false): Promise<string[]> {
  if (sealed) expect((await stat(join(root, relative))).mode & 0o222).toBe(0);
  const result: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    assert.notEqual(entry.name, 'private'); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) result.push(...await files(root, name, sealed));
    else {
      assert.ok(entry.isFile());
      if (sealed) expect((await stat(join(root, name))).mode & 0o222).toBe(0);
      result.push(name);
    }
  }
  return result.sort();
}
async function sourceHashes(root: string, prepared = false): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all([...SOURCE_FILES, ...(prepared ? PREPARATION_FILES : [])].map(async (file): Promise<[string, string]> =>
    [file, hash(await readFile(join(root, file)))])));
}
function deploymentTarget(configuration: Configuration, runtime: Runtime, releaseRoot: string) {
  return { alias: runtime.alias, kind: runtime.native ? 'native' : 'container', transport: 'docker',
    host: configuration.computer.container, manager: 'cauce', uid: 1500,
    unit: runtime.unit, state_directory: runtime.state, runtime_user: runtime.user, runtime_uid: runtime.uid, harness: runtime.harness,
    tenant_id: 'Steven', room_id: 'grp.steven', expected_instance_id: (runtime.native ? 'systemd-' : 'systemd-container-') + runtime.alias,
    release_root: releaseRoot, preserve_paths: [...new Set([runtime.state, runtime.cwd, runtime.providerCwd])]
      .flatMap(path => [path, path + '/legacy.marker', path + '/legacy.link']),
    node_executable: '/usr/local/bin/node', ...(runtime.native ? {} : { container: runtime.container }),
    bundle_root: '/home/cauce/s2b/bundles', config_root: '/home/cauce/s2b/config', ops_root: '/home/cauce/s2b/previous-ops',
    owner: configuration.owner, namespace: configuration.run };
}
export async function configureRehearsal(configuration: Configuration): Promise<Rehearsal> {
  const { root, directory, computer, runtimes, consoleAuth, gateway, certificate } = configuration;
  const sourceOps = join(directory, 'ops'), previous = join(directory, 'previous-ops');
  for (const relative of await files(sourceOps)) {
    const target = join(previous, relative); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (relative === 'container-aliases.json') await copyFile(join(sourceOps, relative), target);
    else if (relative !== 'scripts/adapter-space-launcher.sh') {
      const entry = (await command('git', ['-C', root, 'ls-tree', PREVIOUS_OPS, '--', 'ops/' + relative])).stdout.trim();
      if (!entry) {
        assert.ok(['container-runtime/cauce_container_lease.py', 'container-runtime/cauce_container_restart.py'].includes(relative),
          'previous operations release is missing a required source');
        continue;
      }
      const old = await command('git', ['-C', root, 'show', PREVIOUS_OPS + ':ops/' + relative]);
      const mode = entry.split(' ')[0]; assert.ok(mode === '100755' || mode === '100644');
      await writeFile(target, old.stdout, { mode: mode === '100755' ? 0o755 : 0o644 });
    }
  }
  await command('chmod', ['-R', 'a=rX', sourceOps, previous]);
  const runtimeTools = join(root, 'ops/container-runtime');
  const digest = async (target: string) => (await command('python3', ['-I', '-B', '-c', PYTHON, runtimeTools,
    join(runtimeTools, 'cauce-container-runtime.py'), 'bundle-digest', target])).stdout.trim();
  const [opsDigest, previousOpsDigest] = await Promise.all([digest(sourceOps), digest(previous)]);
  const managerRoot = '/home/cauce/s2b', releaseRoot = managerRoot + '/releases';
  const prepared = await computer.onComputer(['mkdir', '-m', '0700', managerRoot, releaseRoot, managerRoot + '/config', managerRoot + '/pki', managerRoot + '/locks', managerRoot + '/bundles']);
  expect(prepared.code, prepared.stderr).toBe(0);
  for (const [source, destination] of [[previous, 'previous-ops'], [join(directory, 'bundles/releases'), 'bundles/releases']] as const) {
    await docker(['cp', source, computer.container + ':' + managerRoot + '/' + destination]);
    await docker(['exec', computer.container, 'chown', '-R', '1500:1500', managerRoot + '/' + destination]);
  }
  const ws = runtimes.find(runtime => runtime.rehearsal && !runtime.native); assert.ok(ws?.unit);
  const stagedConfig = join(directory, 'config', ws.alias + '.env');
  const original = await readFile(stagedConfig, 'utf8');
  const managerPki = managerRoot + '/pki/' + ws.alias;
  const adjusted = original.replace(/^PKI_DIR=.*$/mu, 'PKI_DIR=' + managerPki);
  const privateConfig = join(directory, 'manager-' + ws.alias + '.env'); await writeFile(privateConfig, adjusted, { mode: 0o600 });
  await docker(['cp', join(directory, 'pki', ws.alias), computer.container + ':' + managerPki]);
  await docker(['cp', privateConfig, computer.container + ':' + managerRoot + '/config/' + ws.alias + '.env']);
  await docker(['exec', computer.container, 'chown', '-R', '1500:1500', managerRoot + '/pki', managerRoot + '/config']);
  const unit = ['[Unit]', 'Description=Owned legacy container adapter', '[Service]', 'Type=simple',
    'Environment=HOME=/home/cauce', 'Environment=PATH=/usr/local/bin:/usr/bin:/bin',
    'Environment=CAUCE_CONTAINER_TEST_MODE=1', 'Environment=CAUCE_CONTAINER_WAIT_SECONDS=0',
    'Environment=CAUCE_CONTAINER_OPS_ROOT=' + managerRoot + '/previous-ops',
    'Environment=CAUCE_CONTAINER_CONFIG_ROOT=' + managerRoot + '/config',
    'Environment=CAUCE_CONTAINER_PKI_ROOT=' + managerRoot + '/pki',
    'Environment=CAUCE_CONTAINER_BUNDLE_ROOT=' + managerRoot + '/bundles',
    'Environment=CAUCE_CONTAINER_LOCK_ROOT=' + managerRoot + '/locks',
    'Environment=CAUCE_CONTAINER_CONTROL_ROOT=/run/zz-canary-s2-supervisor',
    'ExecStart=' + managerRoot + '/previous-ops/scripts/container-adapter-supervisor.sh start ' + ws.alias,
    'ExecStop=' + managerRoot + '/previous-ops/scripts/container-adapter-supervisor.sh stop ' + ws.alias,
    'KillMode=control-group', 'TimeoutStopSec=45', ''].join('\n');
  const stagedUnit = join(directory, ws.unit); await writeFile(stagedUnit, unit, { mode: 0o600 });
  const unitPath = '/home/cauce/.config/systemd/user/' + ws.unit;
  await docker(['cp', stagedUnit, computer.container + ':' + unitPath]);
  await docker(['exec', computer.container, 'chown', '1500:1500', unitPath]);
  const native = runtimes.find(runtime => runtime.rehearsal && runtime.native); assert.ok(native?.unit);
  const legacyDropin = '/home/cauce/.config/systemd/user/' + native.unit + '.d/zzzzzzzz-adaptador-vivo.conf';
  const legacyContent = ['[Service]', 'Environment=CAUCE_LEGACY_WITNESS=owned', 'ExecStart=',
    'ExecStart="/usr/local/bin/node" "--conditions=owned extra argument" ' + native.home +
      '/s2-release/packages/adapter-sdk/dist/src/bin/codex.js --alias ' + native.alias, ''].join('\n');
  const legacy = await computer.onComputer(['python3', '-I', '-B', '-c',
    'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(mode=0o775);p.parent.chmod(0o775);p.write_text(sys.argv[2]);p.chmod(0o664)',
    legacyDropin, legacyContent]);
  expect(legacy.code, legacy.stderr).toBe(0);
  const reload = await computer.onComputer(['systemctl', '--user', 'daemon-reload']); expect(reload.code, reload.stderr).toBe(0);
  const session = join(directory, 'rehearsal-session.json');
  await command('python3', ['-B', join(root, 'ops/cli/cauce-login'), '--gateway', gateway, '--origin', consoleAuth.origin,
    '--ca-file', certificate, '--email', consoleAuth.email, '--password-stdin', '--session-file', session], consoleAuth.password + '\n');
  expect((await stat(session)).mode & 0o777).toBe(0o600);
  const sources = await sourceHashes(root, configuration.preparedCommit !== undefined);
  let ops = sourceOps, approvedOpsDigest = opsDigest, sdk = configuration.release, sdkDigest = configuration.bundleDigest;
  let preparation: PreparedSources | null = null;
  if (configuration.preparedCommit !== undefined) {
    const inventory = join(directory, 'preparation.inventory.json'), output = join(directory, 'prepared');
    await writeFile(inventory, JSON.stringify({ version: 1, agents: runtimes.filter(runtime => runtime.rehearsal)
      .map(runtime => deploymentTarget(configuration, runtime, releaseRoot)) }) + '\n', { mode: 0o600 });
    await command('bash', [join(root, '.delegados/v4/espacio-estandar-preparar.sh'), configuration.preparedCommit,
      '--salida', output, '--inventario', inventory, '--laboratorio']);
    const receipt = join(output, 'recibo.json'); expect((await stat(receipt)).mode & 0o777).toBe(0o600);
    preparation = JSON.parse(await readFile(receipt, 'utf8')) as PreparedSources;
    expect(preparation).toMatchObject({ version: 1, commit: configuration.preparedCommit, inventory_path: inventory });
    for (const path of [preparation.ops_release, preparation.sdk_release]) {
      expect(await realpath(path)).toBe(path); expect(path.startsWith(output + '/')).toBe(true);
      await files(path, '', true); await expect(stat(join(path, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await stat(join(preparation.sdk_release, 'packages/adapter-sdk/dist/src/context/space-layout.js'))).isFile()).toBe(true);
    expect(await digest(preparation.ops_release)).toBe(preparation.ops_sha256);
    expect(await digest(preparation.sdk_release)).toBe(preparation.sdk_sha256);
    expect(await sourceHashes(root, true), 'preparation source changed while building the approved artifacts').toEqual(sources);
    ops = preparation.ops_release; approvedOpsDigest = preparation.ops_sha256;
    sdk = preparation.sdk_release; sdkDigest = preparation.sdk_sha256;
    await configuration.save('deployment-preparation', preparation);
  }
  await configuration.save('deployment-source', { previous_ops_revision: PREVIOUS_OPS, previous_ops_digest: previousOpsDigest,
    ops_digest: approvedOpsDigest, sdk_digest: sdkDigest, approved_artifacts_origin: preparation ? 'git archive' : 'fixture',
    legacy_cli_sdk_digest: configuration.bundleDigest, preparation_receipt: preparation, source_sha256: sources });
  return { configuration, ops, opsDigest: approvedOpsDigest, sdk, sdkDigest, releaseRoot, session, sources };
}

interface Driver {
  start: (runtime: Runtime) => Promise<unknown>;
  stop: (runtime: Runtime) => Promise<unknown>;
  inspect: (runtime: Runtime) => Promise<Probe>;
  inspectLegacy: (runtime: Runtime) => Promise<Legacy>;
  verifyStopped: (runtime: Runtime, probe: Probe) => Promise<void>;
  save: Save;
}
async function argv(runtime: Runtime, observed: Probe): Promise<string[]> {
  return JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
    'import json,pathlib,sys;print(json.dumps([part.decode() for part in (pathlib.Path("/proc")/sys.argv[1]/"cmdline").read_bytes().split(bytes([0])) if part]))', String(observed.pid)])) as string[];
}
async function unit(rehearsal: Rehearsal, runtime: Runtime) {
  const result = await rehearsal.configuration.computer.onComputer(['systemctl', '--user', 'cat', runtime.unit ?? 'missing']);
  expect(result.code, result.stderr).toBe(0); return result.stdout;
}
async function legacyDropin(rehearsal: Rehearsal, runtime: Runtime) {
  if (!runtime.native) return null;
  assert.ok(runtime.unit);
  const result = await rehearsal.configuration.computer.onComputer(['python3', '-I', '-B', '-c',
    'import hashlib,json,pathlib,stat,sys;p=pathlib.Path(sys.argv[1]);metadata=lambda f:{"uid":f.lstat().st_uid,"gid":f.lstat().st_gid,"mode":oct(stat.S_IMODE(f.lstat().st_mode)),"inode":f.lstat().st_ino,"directory":f.is_dir(),"symlink":f.is_symlink(),"sha256":hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else None};print(json.dumps({"directory":metadata(p.parent),"file":metadata(p),"managed":[{"name":f.name,**metadata(f)} for f in p.parent.glob("zzzzzzzz-space-standard-*.conf")]}))',
    '/home/cauce/.config/systemd/user/' + runtime.unit + '.d/zzzzzzzz-adaptador-vivo.conf']);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { directory: Record<string, unknown>; file: Record<string, unknown>;
    managed: { name: string; uid: number; gid: number; mode: string; symlink: boolean }[] };
}
async function installedFiles(rehearsal: Rehearsal) {
  const result = await rehearsal.configuration.computer.onComputer(['python3', '-I', '-B', '-c',
    'import hashlib,json,pathlib,sys;p=pathlib.Path(sys.argv[1]);print(json.dumps([(str(f.relative_to(p)),f.lstat().st_ino,f.lstat().st_mode,hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() and not f.is_symlink() else None) for f in sorted(p.rglob("*"))]))', rehearsal.releaseRoot]);
  expect(result.code, result.stderr).toBe(0); return result.stdout;
}
function evidence(observed: Probe) {
  const { environment, ...safe } = observed;
  return { ...safe, environment_names: Object.entries(environment).filter(([, value]) => value !== null).map(([name]) => name) };
}
async function renewedLease(rehearsal: Rehearsal, runtime: Runtime) {
  const row = (await rehearsal.configuration.pool.query<{ epoch: string; connected_at: string; fingerprint: string }>(
    `SELECT epoch,connected_at::text,encode(digest(connection_token::text,'sha256'),'hex') AS fingerprint
       FROM connection_leases WHERE tenant_id='Steven' AND alias=$1 AND lease_until>clock_timestamp()`, [runtime.alias])).rows[0];
  assert.ok(row); expect(Number(row.epoch)).toBeGreaterThan(0);
  expect(row.fingerprint !== runtime.leaseFingerprint).toBe(true);
  runtime.leaseFingerprint = row.fingerprint;
  return { epoch: Number(row.epoch), connected_at: row.connected_at, token_rotated: true };
}
async function runRehearsalSteps(rehearsal: Rehearsal, runtime: Runtime, driver: Driver) {
  const { configuration } = rehearsal, { directory, root, consoleAuth, gateway, certificate } = configuration;
  const kind = runtime.native ? 'native' : 'container';
  const baselineLegacy = await driver.inspectLegacy(runtime);
  const firstLease = await driver.start(runtime), before = await driver.inspect(runtime);
  expect(before.environment).toEqual({ CAUCE_SPACE_ROOT: null, TMPDIR: null }); expect(before.layout).toEqual({});
  const originalArgv = await argv(runtime, before), originalUnit = await unit(rehearsal, runtime);
  if (runtime.native) {
    expect(originalArgv).toContain('--conditions=owned extra argument');
    expect(originalUnit).toContain('ExecStart="/usr/local/bin/node" "--conditions=owned extra argument" ');
  }
  const legacyBefore = await legacyDropin(rehearsal, runtime);
  if (legacyBefore) expect(legacyBefore).toMatchObject({
    directory: { uid: 1500, gid: 1500, mode: '0o775', directory: true, symlink: false },
    file: { uid: 1500, gid: 1500, mode: '0o664', directory: false, symlink: false }, managed: [] });
  const inventory = join(directory, 'deployment-' + kind + '.inventory.json');
  const target = deploymentTarget(configuration, runtime, rehearsal.releaseRoot);
  await writeFile(inventory, JSON.stringify({ version: 1, agents: [target] }) + '\n', { mode: 0o600 });
  const receipt = join(directory, 'deployment-' + kind + '.receipt.json');
  const common = ['--inventario', inventory, '--ops-release', rehearsal.ops, '--ops-sha256', rehearsal.opsDigest,
    '--sdk-release', rehearsal.sdk, '--sdk-sha256', rehearsal.sdkDigest, '--recibo', receipt, '--laboratorio',
    '--sesion', rehearsal.session, '--gateway', gateway, '--origin', consoleAuth.origin, '--ca-file', certificate, '--timeout', '180'];
  const tool = async (args: string[]) => {
    expect(await sourceHashes(root, configuration.preparedCommit !== undefined), 'rehearsal or deployment tool source changed during the run').toEqual(rehearsal.sources);
    return command('bash', [join(root, '.delegados/v4/espacio-estandar.sh'), ...args, ...common]);
  };
  const localFiles = async () => (await command('find', ['-P', directory, '-printf', '%P\\0%y\\0%l\\0'])).stdout;
  const installedBeforeSimulation = await installedFiles(rehearsal), localFilesBeforeSimulation = await localFiles();
  const simulation = await tool(['--simular']);
  expect(JSON.parse(simulation.stdout)).toMatchObject({ version: 1, simulated: true, writes: false, http_requests: false,
    agents: [{ alias: runtime.alias, ready: true, blockers: [] }] });
  expect(await installedFiles(rehearsal)).toBe(installedBeforeSimulation);
  expect(await localFiles()).toBe(localFilesBeforeSimulation);
  expect(await unit(rehearsal, runtime)).toBe(originalUnit);
  expect(await legacyDropin(rehearsal, runtime)).toEqual(legacyBefore);
  expect(await driver.inspect(runtime)).toEqual(before);
  await expect(stat(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  const applyingAt = Date.now();
  await tool(['--aplicar', runtime.alias]);
  const applied = await driver.inspect(runtime), appliedArgv = await argv(runtime, applied);
  const appliedLease = await renewedLease(rehearsal, runtime); await driver.verifyStopped(runtime, before);
  expect(applied.pid).not.toBe(before.pid); expect(applied.ticks).not.toBe(before.ticks);
  expect(JSON.stringify(appliedArgv) === JSON.stringify(originalArgv)).toBe(true);
  expect(applied.cwd).toBe(before.cwd); expect(applied.legacy).toEqual(baselineLegacy);
  expect(applied.environment).toEqual({ CAUCE_SPACE_ROOT: runtime.state + '/space', TMPDIR: runtime.state + '/space/tmp' });
  expect(Object.keys(applied.layout)).toHaveLength(8);
  for (const entry of Object.values(applied.layout)) expect(entry).toMatchObject({ mode: '0o700', uid: runtime.uid, directory: true, symlink: false });
  const applyDuration = Date.now() - applyingAt;
  expect((await stat(receipt)).mode & 0o777).toBe(0o600);
  const appliedReceipt = JSON.parse(await readFile(receipt, 'utf8')) as ToolReceipt;
  expect(appliedReceipt).toMatchObject({ version: 1, status: 'complete', phase: 'verified',
    probe: { process_alive: true, hello_ack: true, lease_valid: true, delivery_done: true } });
  const legacyApplied = await legacyDropin(rehearsal, runtime);
  if (legacyApplied && legacyBefore) {
    expect(legacyApplied.directory).toEqual(legacyBefore.directory); expect(legacyApplied.file).toEqual(legacyBefore.file);
    expect(legacyApplied.managed).toHaveLength(1);
    const ownDropin = legacyApplied.managed[0]; assert.ok(ownDropin);
    expect(ownDropin).toMatchObject({ uid: 1500, gid: 1500, mode: '0o600', symlink: false });
    expect(ownDropin.name > 'zzzzzzzz-adaptador-vivo.conf').toBe(true);
  }
  const temporary = JSON.parse(await docker(['exec', '--user', runtime.user, runtime.container, 'python3', '-I', '-B', '-c',
    'import json,pathlib,sys;paths=list(pathlib.Path(sys.argv[1]).glob("CAUCE_LIVE_*/proof.json"));assert len(paths)==1;print(paths[0].read_text())',
    runtime.state + '/space/tmp'])) as { cwd: string; tmpdir: string };
  expect(temporary.cwd).toBe(runtime.providerCwd); expect(temporary.tmpdir).toBe(runtime.state + '/space/tmp');
  const revertingAt = Date.now(); await tool(['--revertir', runtime.alias]);
  const reverted = await driver.inspect(runtime);
  const revertedLease = await renewedLease(rehearsal, runtime); await driver.verifyStopped(runtime, applied);
  expect(reverted.pid).not.toBe(applied.pid); expect(reverted.ticks).not.toBe(applied.ticks);
  expect(reverted.environment).toEqual(before.environment);
  expect(JSON.stringify(await argv(runtime, reverted)) === JSON.stringify(originalArgv)).toBe(true);
  expect(await unit(rehearsal, runtime)).toBe(originalUnit);
  expect(reverted.legacy).toEqual(baselineLegacy); expect(reverted.layout).toEqual({});
  const revertedReceipt = JSON.parse(await readFile(receipt, 'utf8')) as ToolReceipt;
  expect(revertedReceipt).toMatchObject({ status: 'reverted', phase: 'reverted',
    revert_probe: { process_alive: true, hello_ack: true, lease_valid: true, delivery_done: true } });
  expect(revertedReceipt.reverted?.process.layout).toEqual(appliedReceipt.after.process.layout);
  const legacyReverted = await legacyDropin(rehearsal, runtime); expect(legacyReverted).toEqual(legacyBefore);
  const revertDuration = Date.now() - revertingAt;
  const stoppedLease = await driver.stop(runtime); await driver.verifyStopped(runtime, reverted);
  await driver.save('deployment-' + kind, { alias: runtime.alias, first_lease: firstLease, original_argv_sha256: hash(JSON.stringify(originalArgv)),
    original_unit_sha256: hash(originalUnit), before: evidence(before), applied: evidence(applied), reverted: evidence(reverted),
    tool_receipt: revertedReceipt, applied_lease: appliedLease, reverted_lease: revertedLease,
    legacy_dropin: { before: legacyBefore, applied: legacyApplied, reverted: legacyReverted },
    temporary_created_by_real_turn_in_space: true, stopped_lease: stoppedLease, stopped_verified: true,
    timing_ms: { apply_until_verified: applyDuration, revert_until_verified: revertDuration } });
}

function safeLog(value: string) {
  return value.slice(-16_384).split('\n').map(line =>
    /(?:CAUCE_[A-Z_]+=|authorization|bearer|cookie|csrf|password|credential|secret|private.key|"body"|"prompt"|"reply")/iu.test(line)
      ? '[REDACTED_SENSITIVE_LOG_LINE]' : line).join('\n');
}
export async function runRehearsal(rehearsal: Rehearsal, runtime: Runtime, driver: Driver) {
  try { await runRehearsalSteps(rehearsal, runtime, driver); }
  catch (error) {
    const { computer, directory } = rehearsal.configuration;
    const kind = runtime.native ? 'native' : 'container';
    const diagnostics = await Promise.allSettled([
      computer.onComputer(['systemctl', '--user', 'show', runtime.unit ?? 'missing',
        '--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MainPID,NeedDaemonReload']),
      computer.onComputer(['journalctl', '--user', '--unit=' + (runtime.unit ?? 'missing'), '--no-pager', '-n', '50', '--output=cat']),
      computer.onComputer(['stat', '--printf=%u:%g:%a\n', '/home/cauce/.config/systemd/user/' + (runtime.unit ?? 'missing')]),
      docker(['exec', '--user', '0', runtime.container, 'tail', '-c', '16384', runtime.state + '/.cauce-adapter.log'])
        .then(stdout => ({ code: 0, stdout, stderr: '' })),
    ]);
    let progress: unknown = null;
    try { progress = JSON.parse(await readFile(join(directory, 'deployment-' + kind + '.receipt.json'), 'utf8')) as unknown; }
    catch { /* The preflight has no receipt. */ }
    await driver.save('deployment-' + kind + '-failure', { alias: runtime.alias, tool_progress: progress,
      diagnostics: diagnostics.map((result, index) => ({ source: ['systemd', 'journal', 'unit_metadata', 'adapter_log'][index],
        ...(result.status === 'fulfilled' ? { code: result.value.code, stdout: safeLog(result.value.stdout), stderr: safeLog(result.value.stderr) }
          : { unavailable: true }) })) });
    console.info('S2_REHEARSAL_FAILURE_EVIDENCE', JSON.stringify({ alias: runtime.alias, artifact: 'deployment-' + kind + '-failure.json' }));
    throw error;
  }
}
