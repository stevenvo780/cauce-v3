import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { HostReleaseManifestSchema, HostSetupConfigSchema } from '../../services/gateway/src/fleet/host-setup.js';
import { cancelDeployReceipts, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { cancelDeployTuiRuntime } from './v4-fleet-cancel-deploy.tui.js';

const execute = promisify(execFile);
const root = process.cwd();
const releaseParts = ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/schemas', 'ops/pty-agent',
  'ops/guardias/cauce-estado', 'ops/guardias/cauce-sesiones', 'ops/guardias/cauce-attach'];
const sourceParts = [...releaseParts, 'services/gateway/src', 'packages/store/src', 'packages/store/package.json',
  'packages/protocol/src', 'packages/protocol/package.json', 'packages/adapter-sdk/src',
  'packages/adapter-sdk/descriptors', 'packages/adapter-sdk/package.json', 'tsconfig.json'];
const banner = 'import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface SourceFile { gitBlob: string | null; sha256: string; overlay: boolean }
interface SourceProof {
  revision: string;
  workingTree: boolean;
  files: Record<string, SourceFile>;
  builds: Record<string, { sha256: string; inputs: string[] }>;
  lifecycleClosure?: unknown;
  sourceArchiveSha256?: string;
}
export interface SessionRelease {
  phase: string;
  revision: string;
  directory: string;
  source: SourceProof;
  manifest: ReturnType<typeof HostReleaseManifestSchema.parse>;
}

async function jsonFile(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function snapshotSource(directory: string, reference: string, workingTree: boolean): Promise<SourceProof> {
  const revision = (await execute('git', ['rev-parse', reference], { cwd: root })).stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('the release source must resolve to an exact commit');
  const source = join(directory, 'source');
  await mkdir(source);
  const entries = (await execute('git', ['ls-tree', '-r', '-z', revision, '--', ...sourceParts],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  const blobs = new Map<string, string>();
  for (const entry of entries) {
    const parsed = /^(?:100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if (!parsed?.[1] || !parsed[2]) throw new Error('the archived release contains an unsupported Git entry');
    blobs.set(parsed[2], parsed[1]);
  }
  let names = [...blobs.keys()];
  if (workingTree) {
    names = [...new Set((await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...sourceParts],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(Boolean))];
    for (const name of names) {
      const details = await stat(join(root, name)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!details) continue;
      if (!details.isFile()) throw new Error('the candidate source must contain only regular files');
      await mkdir(dirname(join(source, name)), { recursive: true });
      await cp(join(root, name), join(source, name));
    }
  } else {
    const archive = join(directory, 'source-git.tar');
    await execute('git', ['archive', '--format=tar', '--output=' + archive, revision, '--', ...sourceParts], { cwd: root });
    await execute('tar', ['-xf', archive, '-C', source]);
  }
  const proof: SourceProof = { revision, workingTree, files: {}, builds: {} };
  for (const name of names) {
    const value = await readFile(join(source, name)).catch((error: unknown) => {
      if (workingTree && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!value) continue;
    const gitBlob = blobs.get(name) ?? null;
    const actual = createHash('sha1').update('blob ' + String(value.length) + '\0').update(value).digest('hex');
    if (!workingTree && actual !== gitBlob) throw new Error('the archived source differs from its Git blob: ' + name);
    proof.files[name] = { gitBlob, sha256: sha256(value), overlay: actual !== gitBlob };
  }
  const archive = join(directory, 'source-sealed.tar');
  await execute('tar', ['-cf', archive, '-C', source, '.']);
  proof.sourceArchiveSha256 = sha256(await readFile(archive));
  return proof;
}

async function compile(directory: string, entry: string, output: string, proof: SourceProof): Promise<void> {
  const source = join(directory, 'source'), target = join(directory, 'stage', output);
  await mkdir(dirname(target), { recursive: true });
  const metadata = join(directory, 'build', output + '.meta.json');
  await mkdir(dirname(metadata), { recursive: true });
  await execute(join(root, 'node_modules/.bin/esbuild'), [join(source, entry), '--bundle', '--platform=node', '--format=esm',
    '--target=node22', '--external:pg-native', '--log-level=error', '--outfile=' + target, '--metafile=' + metadata,
    '--alias:@cauce/protocol=' + join(source, 'packages/protocol/src'),
    '--alias:@cauce/store=' + join(source, 'packages/store/src/index.ts'), '--banner:js=' + banner],
  { cwd: source, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_PATH: ['services/gateway', 'packages/store',
    'packages/protocol', 'packages/adapter-sdk', ''].map(part => join(root, part, 'node_modules')).join(':') } });
  const inputs = Object.keys((JSON.parse(await readFile(metadata, 'utf8')) as { inputs: Record<string, unknown> }).inputs);
  const measured: string[] = [];
  for (const input of inputs) {
    const filename = resolve(source, input), name = relative(source, filename);
    if (!name.startsWith('../') && !isAbsolute(name)) {
      if (proof.files[name]?.sha256 !== sha256(await readFile(filename))) throw new Error('an unsealed source entered the bundle: ' + name);
      measured.push(name);
    } else if (!filename.includes('/node_modules/') || filename.includes('/node_modules/@cauce/')) {
      throw new Error('a bundle source escaped its sealed release: ' + input);
    }
  }
  proof.builds[output] = { sha256: sha256(await readFile(target)), inputs: measured.sort() };
}

const lifecycleClosure = String.raw`import ast,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);tree=ast.parse((root/'ops/cli/fleet_executor_lifecycle.py').read_text())
values={}
for statement in tree.body:
 if isinstance(statement,ast.Assign):
  for target in statement.targets:
   if isinstance(target,ast.Name) and target.id in ('MODULES','BOOTSTRAP'):values[target.id]=ast.literal_eval(statement.value)
modules=values['MODULES'];packet=ast.parse(values['BOOTSTRAP']);names=None
for statement in packet.body:
 if isinstance(statement,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='names' for target in statement.targets):
  names=ast.literal_eval(statement.value)
assert modules==names,'the lifecycle packet module lists differ'
proof={}
assert all((root/'ops/container-runtime'/(name+'.py')).is_file() for name in (*modules,'cauce-container-runtime')),'the lifecycle packet is not closed'
for name in (*modules,'cauce-container-runtime'):
 proof[name]=hashlib.sha256((root/'ops/container-runtime'/(name+'.py')).read_bytes()).hexdigest()
print(json.dumps({'packetClosed':True,'modules':modules,'sha256':proof}))
`;

export async function buildSessionRelease(fixture: CancelDeployFixture, phase: string, reference: string,
  workingTree = false): Promise<SessionRelease> {
  const directory = join(cancelDeployReceipts, 'release-' + phase);
  await mkdir(directory, { recursive: true });
  const source = await snapshotSource(directory, reference, workingTree), stage = join(directory, 'stage');
  const closure = await execute('python3', ['-I', '-B', '-c', lifecycleClosure, join(directory, 'source')]);
  const closureProof: unknown = JSON.parse(closure.stdout);
  source.lifecycleClosure = closureProof;
  await jsonFile(join(directory, 'lifecycle-closure.json'), closureProof);
  await mkdir(stage);
  for (const part of releaseParts) {
    await mkdir(dirname(join(stage, part)), { recursive: true });
    await cp(join(directory, 'source', part), join(stage, part), { recursive: true });
  }
  for (const destination of ['adapter/descriptors', 'adapter/packages/adapter-sdk/dist/descriptors']) {
    await cp(join(directory, 'source/packages/adapter-sdk/descriptors'), join(stage, destination), { recursive: true });
  }
  await writeFile(join(stage, 'adapter/provider-cli.py'), cancelDeployTuiRuntime.providerCli, { mode: 0o755 });
  await writeFile(join(stage, 'adapter/package.json'), '{"type":"module"}\n');
  await compile(directory, 'packages/adapter-sdk/src/bin/codex.ts', 'adapter/src/bin/codex.js', source);
  await compile(directory, 'services/gateway/src/fleet/main.ts', 'services/gateway/dist/fleet/main.js', source);
  const epoch = (await execute('git', ['show', '-s', '--format=%ct', source.revision], { cwd: root })).stdout.trim();
  const releaseDirectory = join(directory, 'packed'), packer = join(directory, 'source/ops/scripts/host-release.py');
  const packed = await execute('python3', [packer, 'pack', '--stage', stage, '--out', releaseDirectory, '--revision', source.revision,
    '--epoch', epoch, '--image', fixture.computer.agentImage], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  const manifest = HostReleaseManifestSchema.parse(JSON.parse(packed.stdout));
  const verified = await execute('python3', [packer, 'verify', releaseDirectory, '--revision', source.revision], { timeout: 600_000 });
  await writeFile(join(directory, 'pack.log'), packed.stdout + packed.stderr + verified.stdout + verified.stderr, { mode: 0o600 });
  await jsonFile(join(directory, 'source-manifest.json'), { ...source, syntheticProvider: true,
    providerSha256: sha256(cancelDeployTuiRuntime.providerCli), builderImage: fixture.computer.agentImage,
    archiveConfigImage: manifest.image?.id });
  return { phase, revision: source.revision, directory: releaseDirectory, source, manifest };
}

export async function installSessionRelease(fixture: CancelDeployFixture, release: SessionRelease): Promise<unknown> {
  const current = fixture.setup.approvedConfiguration(), bundle = current.policy.bundles.codex;
  const { manifest } = release;
  if (!bundle || !manifest.image || !manifest.pins.adapter_digest) throw new Error('the release lacks its measured bundle or image');
  expect(manifest.image.id).toBe(fixture.computer.configImage);
  fixture.setup.publish(HostSetupConfigSchema.parse({ ...current,
    release: { name: 'release', revision: release.revision, path: join(release.directory, manifest.release.file),
      sha256: manifest.release.sha256, size: manifest.release.size },
    image: { name: 'agent-image', path: join(release.directory, manifest.image.file),
      sha256: manifest.image.sha256, size: manifest.image.size, id: manifest.image.id },
    policy: { ...current.policy, bundles: { ...current.policy.bundles, codex: { ...bundle, digest: manifest.pins.adapter_digest, shared_tui: true } } },
  }));
  const result = await fixture.computer.cli(['setup', '--install-root', fixture.computer.installRoot]);
  await jsonFile(join(cancelDeployReceipts, 'setup-' + release.phase + '.json'), result);
  if (result.code !== 0) throw new Error('signed setup ' + release.phase + ' failed: ' + result.stderr);
  const plan: unknown = JSON.parse(result.stdout);
  await jsonFile(join(cancelDeployReceipts, 'plan-' + release.phase + '.json'), plan);
  return plan;
}
