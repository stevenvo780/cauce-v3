import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const systemPath = [...new Set([dirname(process.execPath), '/usr/bin', '/bin'])].join(':');
const outputLimit = 1024 * 1024;
type OutputPattern = string | RegExp;
export interface InstalledCliResult { code: number | null; stdout: string; stderr: string }
export interface InstalledCliRunOptions { input?: string; detachWhen?: OutputPattern; timeout?: number }
export interface InstalledCliManifest {
  revision: string;
  source_sha256: string;
  release_sha256: string;
  ws_version: string;
  node_version: string;
  runtime_image_id: string;
  runtime_revision: string;
  runtime_source_sha256: string;
  runtime_sha256: string;
  files: Record<string, string>;
}

function matches(output: string, pattern: OutputPattern): boolean {
  return typeof pattern === 'string' ? output.includes(pattern)
    : new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, '')).test(output);
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

export class InstalledCliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly result: Promise<InstalledCliResult>;
  stdout = '';
  stderr = '';
  private finished = false;

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 60_000) {
    this.child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => undefined);
    this.child.stdout.on('data', (chunk: Buffer) => { this.stdout = (this.stdout + chunk.toString()).slice(-outputLimit); });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-outputLimit); });
    this.result = new Promise((resolveResult, reject) => {
      let expired = false;
      let forced: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        expired = true;
        signalGroup(this.child, 'SIGTERM');
        forced = setTimeout(() => { signalGroup(this.child, 'SIGKILL'); }, 3_000);
      }, timeout);
      const clear = () => { this.finished = true; clearTimeout(timer); clearTimeout(forced); };
      this.child.once('error', () => { clear(); reject(new Error('installed CLI process could not start')); });
      this.child.once('close', code => {
        clear();
        if (expired) reject(new Error('installed CLI process exceeded its deadline'));
        else resolveResult({ code, stdout: this.stdout, stderr: this.stderr });
      });
    });
    void this.result.catch(() => undefined);
  }

  async waitFor(pattern: OutputPattern, timeout = 30_000): Promise<string> {
    return await new Promise((resolveOutput, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.stdout.off('data', check);
        this.child.stderr.off('data', check);
        this.child.off('close', closed);
      };
      const check = () => {
        const output = this.stdout + this.stderr;
        if (matches(output, pattern)) { cleanup(); resolveOutput(output); }
      };
      const closed = () => { cleanup(); reject(new Error('installed CLI closed before its expected output')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('installed CLI did not produce its expected output')); }, timeout);
      this.child.stdout.on('data', check);
      this.child.stderr.on('data', check);
      this.child.once('close', closed);
      if (matches(this.stdout + this.stderr, pattern)) check();
      else if (this.finished) closed();
    });
  }

  write(input: string): void { this.child.stdin.write(input); }

  async stop(): Promise<InstalledCliResult> {
    signalGroup(this.child, 'SIGTERM');
    const timer = setTimeout(() => { signalGroup(this.child, 'SIGKILL'); }, 3_000);
    try { return await this.result; } finally { clearTimeout(timer); }
  }
}

async function fileHashes(directory: string, prefix = ''): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await fileHashes(directory, name));
    else if (entry.isSymbolicLink()) {
      const target = await readlink(join(directory, name));
      if (isAbsolute(target) || relative(directory, resolve(directory, prefix, target)).split('/')[0] === '..') {
        throw new Error('candidate runtime dependency link escapes its release');
      }
      hashes[name] = createHash('sha256').update('symlink\0' + target).digest('hex');
    }
    else {
      if (!entry.isFile()) throw new Error('candidate release contains a nonregular file');
      hashes[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    }
  }
  return hashes;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('candidate runtime metadata is invalid');
  return value as Record<string, unknown>;
}

async function saveRuntimeArchive(args: string[], archive: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn('docker', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  let stderr = '';
  const deadline = { expired: false };
  let forced: NodeJS.Timeout | undefined;
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', () => { reject(new Error('canonical runtime archive export could not start')); });
    child.once('close', resolveExit);
  });
  void exited.catch(() => undefined);
  const timer = setTimeout(() => {
    deadline.expired = true;
    signalGroup(child, 'SIGTERM');
    forced = setTimeout(() => { signalGroup(child, 'SIGKILL'); }, 3_000);
  }, 5 * 60_000);
  try {
    const [code] = await Promise.all([exited, pipeline(child.stdout, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))]);
    if (deadline.expired) throw new Error('canonical runtime archive export exceeded its deadline');
    if (code !== 0) throw new Error(`canonical runtime archive export failed with code ${String(code)} (${String(stderr.length)} diagnostic bytes withheld)`);
  } catch (error) {
    signalGroup(child, 'SIGTERM');
    const kill = setTimeout(() => { signalGroup(child, 'SIGKILL'); }, 3_000);
    try { await exited.catch(() => undefined); } finally { clearTimeout(kill); }
    throw error;
  } finally { clearTimeout(timer); clearTimeout(forced); }
}

async function exportCanonicalRuntime(source: string, release: string, revision: string, sourceDigest: string) {
  const inRunner = process.env.CI === '1' && process.env.DOCKER_HOST === 'unix:///var/run/docker.sock'
    && process.env.HOME?.startsWith('/tmp/cauce-e2e-home-l2b-ciclo-sdk-1025-') === true;
  const context = process.env.DOCKER_CONTEXT ?? 'lab';
  if (!inRunner && !/^lab[23]?$/u.test(context)) throw new Error('candidate runtime build requires Docker lab');
  const dockerEnv = { ...process.env };
  if (inRunner) delete dockerEnv.DOCKER_CONTEXT;
  const prefix = inRunner ? [] : ['--context', context];
  const docker = async (args: string[]) => await execute('docker', [...prefix, ...args], {
    cwd: source, env: dockerEnv, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000,
  });
  const owner = `zz-canary-l2-cli-${randomUUID()}`;
  const imageName = `${owner}:${revision.slice(0, 12)}`;
  let imageBuilt = false;
  let containerCreated = false;
  try {
    await docker(['build', '--quiet', '--target', 'runtime', '--label', `io.cauce.test.owner=${owner}`,
      '--label', 'cauce.e2e.owner=l2b-ciclo-sdk-1025',
      '--build-arg', `CAUCE_RELEASE_COMMIT=${revision}`, '--build-arg', `CAUCE_SOURCE_DIGEST=${sourceDigest}`,
      '--file', join(source, 'deploy/Dockerfile'), '--tag', imageName, source]);
    imageBuilt = true;
    const inspected: unknown = JSON.parse((await docker(['image', 'inspect', '--format', '{{json .}}', imageName])).stdout);
    const image = record(inspected);
    const config = record(image.Config);
    const labels = record(config.Labels);
    if (labels['org.opencontainers.image.revision'] !== revision || labels['io.cauce.source.digest'] !== sourceDigest
      || labels['io.cauce.test.owner'] !== owner || typeof image.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(image.Id)) {
      throw new Error('canonical runtime image does not attest its candidate revision');
    }
    const variables: unknown = config.Env;
    const nodeVersion = Array.isArray(variables)
      ? variables.find((value: unknown): value is string => typeof value === 'string' && value.startsWith('NODE_VERSION=')) : undefined;
    if (typeof nodeVersion !== 'string') throw new Error('canonical runtime has no Node version');
    await docker(['create', '--name', owner, '--network', 'none', '--read-only', '--label', `io.cauce.test.owner=${owner}`,
      '--label', 'cauce.e2e.owner=l2b-ciclo-sdk-1025', imageName]);
    containerCreated = true;
    const runtimeArchive = join(dirname(release), 'cli-candidate-runtime.tar');
    await saveRuntimeArchive([...prefix, 'cp', `${owner}:/app/.`, '-'], runtimeArchive, source, dockerEnv);
    await execute('tar', ['--no-same-owner', '--delay-directory-restore', '--unlink-first', '-xf', runtimeArchive, '-C', release], {
      timeout: 5 * 60_000, maxBuffer: 64 * 1024,
    });
    const wsPackage = record(JSON.parse(await readFile(join(release, 'services/terminal-relay/node_modules/ws/package.json'), 'utf8')) as unknown);
    if (typeof wsPackage.version !== 'string') throw new Error('canonical runtime has no WebSocket version');
    const runtimeHashes = await fileHashes(release);
    return { runtime_image_id: image.Id, runtime_revision: revision, runtime_source_sha256: sourceDigest,
      runtime_sha256: createHash('sha256').update(JSON.stringify(runtimeHashes)).digest('hex'),
      ws_version: wsPackage.version, node_version: 'v' + nodeVersion.slice('NODE_VERSION='.length) };
  } finally {
    if (containerCreated) await docker(['rm', '--force', owner]);
    if (imageBuilt) await docker(['image', 'rm', imageName]);
  }
}

export async function buildInstalledCli(directory: string) {
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const source = join(directory, 'cli-candidate-source');
  const sourceArchive = join(directory, 'cli-candidate-source.tar');
  const opsArchive = join(directory, 'cli-candidate-ops.tar');
  const archive = join(directory, 'cli-candidate-release.tar');
  const release = join(directory, 'cli-release');
  const home = join(directory, 'cli-home');
  const runtime = join(home, '.local/share/cauce-v3');
  const binDirectory = join(home, '.local/bin');
  const cwd = join(directory, 'cli-working-directory');
  const env = { HOME: home, PATH: `${binDirectory}:${systemPath}`, XDG_STATE_HOME: join(home, '.local/state'),
    PYTHONDONTWRITEBYTECODE: '1', CAUCE_DESTINO_AVISO_INICIAL: 'zz-canary-cli', LANG: 'C.UTF-8', TERM: 'xterm-256color' };
  for (const path of [source, release, home, runtime, cwd]) await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await execute('git', ['archive', '--format=tar', `--output=${sourceArchive}`, revision], { cwd: root });
  await execute('git', ['archive', '--format=tar', `--output=${opsArchive}`, revision, 'ops/cli', 'ops/guardias',
    'ops/scripts/install-cauce-cli.sh'], { cwd: root });
  await execute('tar', ['--no-same-owner', '-xf', sourceArchive, '-C', source]);
  const sourceDigest = createHash('sha256').update(await readFile(sourceArchive)).digest('hex');
  const runtimeMetadata = await exportCanonicalRuntime(source, release, revision, sourceDigest);
  await execute('tar', ['--no-same-owner', '--delay-directory-restore', '--overwrite', '-xf', opsArchive, '-C', release]);
  await execute('tar', ['-cf', archive, '-C', release, '.']);
  const manifest: InstalledCliManifest = { revision,
    source_sha256: sourceDigest,
    release_sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    ...runtimeMetadata, files: await fileHashes(release) };
  const manifestFile = join(directory, 'cli-candidate-manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await execute('tar', ['--no-same-owner', '--delay-directory-restore', '--unlink-first', '-xf', archive, '-C', runtime]);
  await execute('/usr/bin/bash', [join(release, 'ops/scripts/install-cauce-cli.sh'), binDirectory], { cwd, env });
  const bin = join(binDirectory, 'cauce');
  if ((await realpath(bin)) !== bin || relative(root, cwd).split('/')[0] !== '..') {
    throw new Error('installed CLI isolation boundary is invalid');
  }
  for (const file of ['cauce', 'cauce-login', 'cauce-spaces', 'context_client.py']) {
    const installed = createHash('sha256').update(await readFile(join(binDirectory, file))).digest('hex');
    if (installed !== manifest.files[join('ops/cli', file)]) throw new Error('installed CLI differs from its candidate release');
  }
  const start = (args: string[], options: Pick<InstalledCliRunOptions, 'timeout'> = {}) => new InstalledCliProcess(bin, args, cwd, env, options.timeout);
  const run = async (args: string[], options: InstalledCliRunOptions = {}): Promise<InstalledCliResult> => {
    const child = start(args, options);
    try {
      if (options.input !== undefined) {
        const terminal = !['login', 'spaces', 'hosts', 'context', 'context-native', 'platform', 'diagnose'].includes(args[0] ?? '');
        if (terminal) { await child.waitFor('Terminal conectado'); child.write(options.input); }
        else child.child.stdin.end(options.input);
      }
      if (options.detachWhen !== undefined) { await child.waitFor(options.detachWhen); child.write('\x1d'); }
      return await child.result;
    } catch (error) {
      const stopped = await child.stop().catch(() => undefined);
      if (stopped && stopped.code !== 0) return stopped;
      throw error;
    }
  };
  return { bin, home, runtime, revision, source, manifest, manifestFile, archive, release,
    sessionFile: join(env.XDG_STATE_HOME, 'cauce-v3/console-session.json'), start, run };
}
