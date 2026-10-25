import { execFile } from 'node:child_process';
import { appendFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { command, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { HostReleaseManifestSchema, HostSetupConfigSchema } from '../../services/gateway/src/fleet/host-setup.js';
import { CANCEL_DEPLOY_OWNER, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import type { CancelDeploySetup } from './v4-fleet-cancel-deploy.setup.js';

const execute = promisify(execFile);

export interface CancelDeployment {
  phase: string;
  stage: string;
  bundleDigest: string;
  image: string;
  imageReference: string;
  release: string;
  signer: string;
  plan: unknown;
}

async function requireUnusedImage(reference: string): Promise<void> {
  const observed = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', reference]);
  if (observed.code === 0) throw new Error(`the deployment image reference already exists: ${reference}`);
  if (observed.code !== 1 || !/no such image/iu.test(observed.stderr) || !observed.stderr.includes(reference)) {
    throw new Error(`deployment image inspection failed: ${observed.stderr}`);
  }
}

export async function deployCancelRelease(fixture: CancelDeployFixture, setup: CancelDeploySetup, phase: string,
  options: { image: string; newImage: boolean; sourceStage?: string }): Promise<CancelDeployment> {
  const work = dirname(fixture.computer.installRoot);
  const stage = join(work, `${phase}-stage`);
  await cp(options.sourceStage ?? join(work, 'stage'), stage, { recursive: true });
  await appendFile(join(stage, 'adapter/src/bin/codex.js'), `\n;void ${JSON.stringify(phase)};\n`);
  let image = options.image;
  let imageSource = options.image;
  if (options.newImage) {
    const reference = `${fixture.computer.prefix}:${phase}`, base = `${reference}-base`;
    await requireUnusedImage(base); await requireUnusedImage(reference);
    expect(await docker(['image', 'inspect', '--format', '{{.Id}}', options.image])).toBe(options.image);
    fixture.deploymentImages.set(base, options.image);
    await docker(['image', 'tag', options.image, base]);
    expect(await docker(['image', 'inspect', '--format', '{{.Id}}', base])).toBe(options.image);
    const built = await command('docker', ['build', '-q', '--pull=false', '--label', `cauce.e2e.owner=${CANCEL_DEPLOY_OWNER}`, '-t', reference, '-'],
      `FROM ${base}\nRUN printf '%s\\n' '${phase}' > /etc/cauce-deployment-image\n`);
    if (built.code !== 0) throw new Error(`approved deployment image build failed: ${built.stderr}`);
    image = built.stdout.trim();
    fixture.deploymentImages.set(reference, image);
    imageSource = reference;
    expect(image).not.toBe(options.image);
    expect(await docker(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', reference]))
      .toBe(`${image} ${CANCEL_DEPLOY_OWNER}`);
    expect(await docker(['image', 'inspect', '--format', '{{.Id}}', base])).toBe(options.image);
  }
  const directory = join(work, `${phase}-release`);
  const current = setup.approvedConfiguration();
  expect(await docker(['image', 'inspect', '--format', '{{.Id}}', imageSource])).toBe(image);
  const packed = await execute('python3', [join(process.cwd(), 'ops/scripts/host-release.py'), 'pack', '--stage', stage, '--out', directory,
    '--revision', current.release.revision, '--image', imageSource], { maxBuffer: 1024 * 1024, timeout: 300_000 });
  expect(await docker(['image', 'inspect', '--format', '{{.Id}}', imageSource])).toBe(image);
  const manifest = HostReleaseManifestSchema.parse(JSON.parse(packed.stdout));
  const adapter = manifest.pins.adapter_digest;
  const bundle = current.policy.bundles.codex;
  if (!manifest.image || !adapter || !bundle) throw new Error('approved deployment release lacks its bundle or image');
  expect(adapter).not.toBe(bundle.digest);
  const configuration = HostSetupConfigSchema.parse({ ...current,
    release: { name: 'release', revision: manifest.revision, path: join(directory, manifest.release.file),
      sha256: manifest.release.sha256, size: manifest.release.size },
    image: { name: 'agent-image', path: join(directory, manifest.image.file), sha256: manifest.image.sha256,
      size: manifest.image.size, id: manifest.image.id },
    policy: { ...current.policy, bundles: { ...current.policy.bundles, codex: { ...bundle, digest: adapter } },
      container_templates: current.policy.container_templates.map(template => ({ ...template, image: manifest.image?.id })) },
  });
  setup.publish(configuration);
  const imageReference = `cauce-host-image:${manifest.image.id.replace(/^sha256:/u, '')}`;
  if (options.newImage) fixture.deploymentImages.set(imageReference, image);
  const installed = await fixture.computer.cli(['setup', '--install-root', fixture.computer.installRoot]);
  if (installed.code !== 0) throw new Error(`signed deployment setup failed: ${installed.stderr}`);
  const release = join(fixture.computer.installRoot, fixture.company, fixture.hostId, 'release', manifest.release.sha256);
  expect(await docker(['image', 'inspect', '--format', '{{.Id}}', imageReference])).toBe(image);
  return { phase, stage, bundleDigest: adapter, image, imageReference, release, signer: setup.signerFingerprint,
    plan: JSON.parse(installed.stdout) as unknown };
}

export async function replaceBoundBundle(fixture: CancelDeployFixture, deployment: CancelDeployment, previousRelease: string,
  container: string): Promise<unknown> {
  const policy = join(fixture.computer.installRoot, fixture.company, fixture.hostId, 'executor-policy.json');
  const script = `import json,pathlib,shutil,sys
release,old,policy_file=map(pathlib.Path,sys.argv[1:4]);expected=sys.argv[4]
sys.path[:0]=[str(release/'ops/cli'),str(release/'ops/container-runtime')]
from host_setup import verify_bundles
from cauce_container_base import bundle_digest
policy=json.loads(policy_file.read_text());verify_bundles(policy,release)
source=pathlib.Path(policy['bundles']['codex']['directory']);target=old/'adapter'
assert source==release/'adapter' and source!=target and policy['bundles']['codex']['digest']==expected
assert bundle_digest(str(source))==expected
before=bundle_digest(str(target));assert before!=expected
staging=old/'adapter-deployment';shutil.copytree(source,staging,symlinks=True)
assert bundle_digest(str(staging))==expected
for child in target.iterdir():
 if child.is_dir() and not child.is_symlink():shutil.rmtree(child)
 else:child.unlink()
shutil.copytree(staging,target,dirs_exist_ok=True,symlinks=True);shutil.rmtree(staging)
after=bundle_digest(str(target));assert after==expected
print(json.dumps({'path':str(target),'before':before,'after':after,'approved_digest':expected,'source':str(source)}))
`;
  const copied = await fixture.computer.onComputer(['python3', '-B', '-c', script, deployment.release, previousRelease, policy, deployment.bundleDigest]);
  if (copied.code !== 0) throw new Error(`the signed approved bundle could not replace its bound path: ${copied.stderr}`);
  const observed = await docker(['exec', '--user', 'cauce', container, 'python3', '-I', '-B', '-c',
    'import sys;sys.path.insert(0,"/cauce/lifecycle");from cauce_container_base import bundle_digest;print(bundle_digest(sys.argv[1]))',
    join(previousRelease, 'adapter')]);
  expect(observed).toBe(deployment.bundleDigest);
  return JSON.parse(copied.stdout) as unknown;
}
