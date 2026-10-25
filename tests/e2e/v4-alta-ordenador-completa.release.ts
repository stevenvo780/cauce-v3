import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HostReleaseManifestSchema, HostSetupFileSchema } from '../../services/gateway/src/fleet/host-setup.js';

const execute = promisify(execFile);
const workspace = resolve(import.meta.dirname, '../..');
const task = 'h11b-rechazo-setup-tres-vm-1025';
export const COMPLETE_RELEASE_PROVIDER_IDENTITY = 'host-setup@example.test';
export const COMPLETE_RELEASE_RUNTIME = { user: 'cauce', uid: 1500, home: '/home/cauce',
  stateRoot: '/home/cauce/.cauce', python: '/usr/local/bin/python3.12' } as const;
const releaseParts = ['ops/cli', 'ops/scripts', 'ops/container-runtime', 'ops/schemas', 'ops/pty-agent/reap_orphan_agent.py',
  'ops/guardias/cauce-estado', 'ops/guardias/cauce-sesiones', 'ops/guardias/cauce-attach'];
const sourceParts = [...releaseParts, 'services/gateway/src', 'packages/store/src', 'packages/store/package.json',
  'packages/protocol/src', 'packages/protocol/package.json', 'packages/adapter-sdk/src', 'packages/adapter-sdk/descriptors',
  'packages/adapter-sdk/package.json', 'tsconfig.json'];
const banner = 'import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const provider = `#!/usr/local/bin/python3
import json,re,sys,uuid
if '--version' in sys.argv:
 print('h11-synthetic-codex 1.0.0')
 sys.exit(0)
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'${COMPLETE_RELEASE_PROVIDER_IDENTITY}'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
 sys.exit(0)
if 'exec' not in sys.argv: sys.exit('unsupported synthetic provider command')
prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
nonce=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
if nonce is None: sys.exit('the real bootstrap nonce is absent')
native=sys.argv[sys.argv.index('resume')+2] if 'resume' in sys.argv else str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':native}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':nonce.group(0)}}),flush=True)
`;

const runtimeDockerfile = `FROM node:22-bookworm AS node
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client openssl \\
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd -m -u 1500 -s /bin/bash cauce && ln -s /usr/local/bin/python3 /usr/bin/python3
COPY --chmod=0555 provider-cli.py /usr/local/bin/codex
USER cauce
WORKDIR /home/cauce
ENV HOME=/home/cauce
CMD ["sleep","infinity"]
`;

interface ArchivedFile { mode: string; gitBlob: string; sha256: string }
interface BuildProof { sha256: string; inputs: string[] }
export interface CompleteReleaseSourceManifest {
  revision: string;
  archive: { file: string; sha256: string };
  files: Record<string, ArchivedFile>;
  bundles: Record<string, BuildProof>;
  provider: { synthetic: true; sha256: string; identity: string; vendorAuthentication: false };
}
export interface CompleteRelease {
  releaseDirectory: string;
  setupConfig: ReturnType<typeof HostSetupFileSchema.parse>;
  signingKey: KeyObject;
  image: { tag: string; id: string };
  manifest: ReturnType<typeof HostReleaseManifestSchema.parse>;
  sourceManifest: CompleteReleaseSourceManifest;
  publicArtifacts: { sourceArchive: string; sourceManifest: string; releaseArchive: string; releaseManifest: string };
  close(): Promise<void>;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
}

async function archiveSources(revision: string, directory: string): Promise<CompleteReleaseSourceManifest> {
  const sourceArchive = join(directory, 'source.tar');
  await execute('git', ['archive', '--format=tar', `--output=${sourceArchive}`, revision, '--', ...sourceParts], { cwd: workspace });
  const tree = join(directory, 'source');
  await mkdir(tree);
  await execute('tar', ['-xf', sourceArchive, '-C', tree]);
  const entries = (await execute('git', ['ls-tree', '-r', '-z', revision, '--', ...sourceParts],
    { cwd: workspace, maxBuffer: 8 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  const files: Record<string, ArchivedFile> = {};
  for (const entry of entries) {
    const parsed = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if (!parsed) throw new Error('the committed release tree contains an unsupported entry');
    const [, mode, expected, name] = parsed;
    if (mode === undefined || expected === undefined || name === undefined) throw new Error('the committed source entry is incomplete');
    const value = await readFile(join(tree, name));
    const actual = createHash('sha1').update(`blob ${String(value.length)}\0`).update(value).digest('hex');
    if (actual !== expected) throw new Error(`the archived source differs from its Git blob: ${name}`);
    files[name] = { mode, gitBlob: expected, sha256: digest(value) };
  }
  return { revision, archive: { file: sourceArchive, sha256: digest(await readFile(sourceArchive)) }, files, bundles: {},
    provider: { synthetic: true, sha256: digest(provider), identity: COMPLETE_RELEASE_PROVIDER_IDENTITY, vendorAuthentication: false } };
}

async function compile(tree: string, stage: string, entry: string, output: string, proof: CompleteReleaseSourceManifest): Promise<void> {
  const target = join(stage, output);
  await mkdir(resolve(target, '..'), { recursive: true });
  const metadata = join(dirname(stage), 'build', `${output}.meta.json`);
  await mkdir(dirname(metadata), { recursive: true });
  const result = await execute(join(workspace, 'node_modules/.bin/esbuild'), [join(tree, entry), '--bundle', '--platform=node',
    '--format=esm', '--target=node22', '--external:pg-native', '--log-level=error', `--outfile=${target}`, `--metafile=${metadata}`,
    `--alias:@cauce/protocol=${join(tree, 'packages/protocol/src')}`, `--alias:@cauce/store=${join(tree, 'packages/store/src/index.ts')}`,
    `--alias:@cauce/adapter-sdk=${join(tree, 'packages/adapter-sdk/src/index.ts')}`, `--banner:js=${banner}`],
  { cwd: tree, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_PATH: ['services/gateway', 'packages/store', 'packages/protocol',
    'packages/adapter-sdk', ''].map(part => join(workspace, part, 'node_modules')).join(':') } });
  await writeFile(`${metadata}.log`, result.stdout + result.stderr);
  const meta = JSON.parse(await readFile(metadata, 'utf8')) as { inputs: Record<string, unknown> };
  const inputs: string[] = [];
  for (const input of Object.keys(meta.inputs)) {
    const filename = await realpath(resolve(tree, input));
    const name = relative(tree, filename);
    if (!name.startsWith('../') && !isAbsolute(name)) {
      const archived = proof.files[name];
      if (archived?.sha256 !== digest(await readFile(filename))) throw new Error(`unverified bundle input: ${name}`);
      inputs.push(name);
    } else if (!filename.includes('/node_modules/') || filename.includes('/node_modules/@cauce/')) {
      throw new Error(`bundle source escaped the committed archive: ${input}`);
    }
  }
  proof.bundles[output] = { sha256: digest(await readFile(target)), inputs: inputs.sort() };
}

interface InspectedImage { id: string; labels: Record<string, unknown> }

async function existingImage(tag: string): Promise<InspectedImage | undefined> {
  try {
    const inspected = await execute('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', tag]);
    const value = JSON.parse(inspected.stdout) as { id?: unknown; labels?: unknown };
    if (typeof value.id !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.id)
      || value.labels !== null && (typeof value.labels !== 'object' || Array.isArray(value.labels))) {
      throw new Error('the private runtime image inspection has an invalid identity');
    }
    return { id: value.id, labels: (value.labels ?? {}) as Record<string, unknown> };
  }
  catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string'
      && ['Error response from daemon', 'Error'].some(prefix => ['image', 'object']
        .some(kind => stderr.trim() === `${prefix}: No such ${kind}: ${tag}`))) return undefined;
    throw error;
  }
}

export async function buildCompleteRelease(options: { revision: string; directory: string; runId: string }): Promise<CompleteRelease> {
  const { revision, directory, runId } = options;
  const committed = (await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
  if (revision !== committed || !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('the complete host release must use the frozen checkout commit');
  if (!isAbsolute(directory) || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) throw new Error('invalid private release directory or run id');
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0) throw new Error('the private release directory must be empty');
  const sourceManifest = await archiveSources(revision, directory);
  const tree = join(directory, 'source'); const stage = join(directory, 'stage');
  await mkdir(stage);
  for (const part of releaseParts) {
    await mkdir(resolve(stage, part, '..'), { recursive: true });
    await cp(join(tree, part), join(stage, part), { recursive: true });
  }
  await cp(join(tree, 'packages/adapter-sdk/descriptors'), join(stage, 'adapter/descriptors'), { recursive: true });
  await cp(join(tree, 'packages/adapter-sdk/descriptors'), join(stage, 'adapter/packages/adapter-sdk/dist/descriptors'), { recursive: true });
  await compile(tree, stage, 'services/gateway/src/fleet/main.ts', 'services/gateway/dist/fleet/main.js', sourceManifest);
  await compile(tree, stage, 'packages/adapter-sdk/src/bin/codex.ts', 'adapter/src/bin/codex.js', sourceManifest);
  await writeFile(join(stage, 'adapter/package.json'), '{"type":"module"}\n');
  await writeJson(join(directory, 'source-manifest.json'), sourceManifest);
  const imageContext = join(directory, 'image');
  await mkdir(imageContext);
  await writeFile(join(imageContext, 'Dockerfile'), runtimeDockerfile);
  await writeFile(join(imageContext, 'provider-cli.py'), provider, { mode: 0o755 });
  const tag = `zz-canary-${task}-${runId}:agent`;
  let imageId: string | undefined;
  let buildAttempted = false;
  const assertOwnedImage = (image: InspectedImage) => {
    if (image.labels['cauce.e2e.owner'] !== task || image.labels['cauce.e2e.run'] !== runId
      || image.labels['cauce.e2e.source-revision'] !== revision || imageId !== undefined && image.id !== imageId) {
      throw new Error('the private runtime image tag changed identity or ownership; refusing to remove it');
    }
  };
  const close = async () => {
    if (!buildAttempted) return;
    const current = await existingImage(tag);
    if (current !== undefined) {
      assertOwnedImage(current);
      imageId = current.id;
      await execute('docker', ['image', 'rm', tag]);
      if (await existingImage(tag) !== undefined) throw new Error('the private runtime image tag remains after removal');
    }
    await writeJson(join(directory, 'image-cleanup.json'), { tag, id: imageId ?? null, absent: true });
  };
  if (await existingImage(tag) !== undefined) throw new Error('the private runtime image tag already exists');
  try {
    buildAttempted = true;
    const built = await execute('docker', ['build', '--label', `cauce.e2e.owner=${task}`, '--label', `cauce.e2e.run=${runId}`,
      '--label', `cauce.e2e.source-revision=${revision}`, '-t', tag, imageContext], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(join(directory, 'image-build.log'), built.stdout + built.stderr);
    const builtImage = await existingImage(tag);
    if (builtImage === undefined) throw new Error('the private runtime image has no immutable id');
    assertOwnedImage(builtImage);
    imageId = builtImage.id;
    const releaseDirectory = join(directory, 'host-release');
    const packer = join(tree, 'ops/scripts/host-release.py');
    const epoch = (await execute('git', ['show', '-s', '--format=%ct', revision], { cwd: workspace })).stdout.trim();
    const packed = await execute('python3', [packer, 'pack', '--stage', stage, '--out', releaseDirectory, '--revision', revision,
      '--epoch', epoch, '--image', tag, '--provider', 'codex=/usr/local/bin/codex'], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(join(directory, 'pack.log'), packed.stdout + packed.stderr);
    const manifest = HostReleaseManifestSchema.parse(JSON.parse(packed.stdout));
    const verified = await execute('python3', [packer, 'verify', releaseDirectory, '--revision', revision], { timeout: 600_000 });
    await writeFile(join(directory, 'verify.log'), verified.stdout + verified.stderr);
    const { privateKey: signingKey } = generateKeyPairSync('ed25519');
    const signingKeyFile = join(directory, 'setup-signing.pem');
    await writeFile(signingKeyFile, signingKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await chmod(signingKeyFile, 0o600);
    const hook = { executable: '@release@/ops/cli/fleet-provider-hook.py', sha256: '@pin:hook_sha256@', argv: [], user: '@user@' };
    const setupConfig = HostSetupFileSchema.parse({ version: 1, signing_key_file: signingKeyFile, release_directory: releaseDirectory,
      files: [], policy: {
        bundles: { codex: { directory: '@release@/adapter', digest: '@pin:adapter_digest@', executable: '/usr/local/bin/node',
          executable_sha256: null, argv: ['@release@/adapter/src/bin/codex.js'], shared_tui: false,
          descriptor_sha256: digest(await readFile(join(tree, 'packages/adapter-sdk/descriptors/codex.json'))) } },
        container_templates: [{ harness_id: 'codex', prefix: `zz-canary-${task}-`, image: '@pin:image@',
          runtime_user: COMPLETE_RELEASE_RUNTIME.user, systemd_user: '@user@', home_directory: COMPLETE_RELEASE_RUNTIME.home,
          state_root: COMPLETE_RELEASE_RUNTIME.stateRoot, profile_root: `${COMPLETE_RELEASE_RUNTIME.home}/.cauce-profiles`,
          python: COMPLETE_RELEASE_RUNTIME.python }],
        profile_templates: [{ provider: 'codex', runtime_user: COMPLETE_RELEASE_RUNTIME.user,
          path_root: `${COMPLETE_RELEASE_RUNTIME.home}/.cauce-profiles`, command: '@pin:codex_command@',
          command_sha256: '@pin:codex_command_sha256@', runtime_mode: 'container', container_prefix: `zz-canary-${task}-` }],
        hooks: { authenticate: hook, profile: hook, verify: hook, revoke: hook },
      } });
    return { releaseDirectory, setupConfig, signingKey, image: { tag, id: imageId }, manifest, sourceManifest,
      publicArtifacts: { sourceArchive: join(directory, 'source.tar'), sourceManifest: join(directory, 'source-manifest.json'),
        releaseArchive: join(releaseDirectory, 'release.tar'), releaseManifest: join(releaseDirectory, 'host-release.json') }, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'complete release build and image cleanup failed'); }
    throw error;
  }
}
