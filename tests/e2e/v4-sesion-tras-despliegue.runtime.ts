import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { approvedAgentQuotaHarnesses } from '../../packages/store/src/agent-quota-operations-model.js';
import { command, docker, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { cancelDeployReceipts, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import type { SessionRelease } from './v4-sesion-tras-despliegue.release.js';

export const AUTO_SESSION_OWNER = 'h13b-v4-1025';
export const AUTO_SESSION_MODEL = 'gpt-5.4';
const readerName = 'v4-sesion-tras-despliegue-quota.py';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function registerSessionQuotaApprovals(release: SessionRelease) {
  const directory = join(dirname(release.directory), 'stage/adapter/descriptors');
  const descriptorSha256 = hash(await readFile(join(directory, 'codex.json')));
  expect(descriptorSha256).toBe(release.source.fixture?.descriptors['descriptors/codex.json']);
  expect(descriptorSha256).toBe(release.source.fixture?.descriptors['packages/adapter-sdk/dist/descriptors/codex.json']);
  const approvalsFile = join(dirname(release.directory), 'quota-descriptor-approvals.json');
  await writeFile(approvalsFile, JSON.stringify({ codex: descriptorSha256 }) + '\n', { mode: 0o600 });
  const previous = { approvals: process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE,
    directory: process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY };
  const close = () => {
    if (previous.approvals === undefined) delete process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE;
    else process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE = previous.approvals;
    if (previous.directory === undefined) delete process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
    else process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY = previous.directory;
  };
  const before = await approvedAgentQuotaHarnesses();
  process.env.CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE = approvalsFile;
  process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY = directory;
  try {
    const approved = await approvedAgentQuotaHarnesses();
    expect(approved).toEqual(['codex']);
    return { close, evidence: { releaseSha256: release.manifest.release.sha256, descriptorSha256, before, approved } };
  } catch (error) { close(); throw error; }
}

export async function stageSessionDescriptors(adapter: string): Promise<Record<string, string>> {
  const source = JSON.parse(await readFile(join(adapter, 'descriptors/codex.json'), 'utf8')) as {
    provider: { quota_argv: string[] };
  };
  source.provider.quota_argv = ['/usr/local/bin/' + readerName, '/home/node/.codex'];
  const value = JSON.stringify(source, null, 2) + '\n';
  const proof: Record<string, string> = {};
  for (const directory of ['descriptors', 'packages/adapter-sdk/dist/descriptors']) {
    await mkdir(join(adapter, directory), { recursive: true });
    await writeFile(join(adapter, directory, 'codex.json'), value, { mode: 0o644 });
    proof[directory + '/codex.json'] = hash(value);
  }
  return proof;
}

export async function controlledSessionRuntime(): Promise<ComputerRuntimeBundle> {
  const providerCli = await readFile(join(process.cwd(), 'tests/e2e/v4-sesion-tras-despliegue-provider.py'), 'utf8');
  return { providerCli, sharedTui: true, async stage(directory) {
    const argv = await cancelDeployRuntime.stage(directory);
    await stageSessionDescriptors(directory);
    return argv;
  } };
}

export async function prepareSessionQuotaImage(fixture: CancelDeployFixture, scope?: 'security' | 'model-null'): Promise<{ id: string; reference: string }> {
  const suffix = scope === undefined ? '' : '-' + scope;
  const directory = join(cancelDeployReceipts, 'quota-image' + suffix);
  await mkdir(directory, { recursive: true });
  const reader = await readFile(join(process.cwd(), 'tests/e2e', readerName));
  const base = fixture.computer.prefix + ':h13b-base' + suffix, reference = fixture.computer.prefix + ':h13b-quota' + suffix;
  for (const name of [base, reference]) {
    const existing = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', name]);
    if (existing.code === 0 || !/no such image|not found/iu.test(existing.stderr)) throw new Error('the owned image name is unavailable: ' + name);
  }
  await docker(['image', 'tag', fixture.computer.agentImage, base]);
  fixture.deploymentImages.set(base, fixture.computer.agentImage);
  await writeFile(join(directory, readerName), reader, { mode: 0o755 });
  await writeFile(join(directory, 'Dockerfile'), 'FROM ' + base + '\nCOPY --chmod=755 ' + readerName + ' /usr/local/bin/' + readerName + '\n');
  const built = await command('docker', ['build', '-q', '--pull=false', '--label', 'cauce.e2e.owner=' + AUTO_SESSION_OWNER,
    '-t', reference, directory]);
  if (built.code !== 0) throw new Error('the owned quota image build failed: ' + built.stderr);
  const image = built.stdout.trim();
  expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(await docker(['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', reference]))
    .toBe(image + ' ' + AUTO_SESSION_OWNER);
  fixture.deploymentImages.set(reference, image);
  await writeFile(join(directory, 'proof.json'), JSON.stringify({ image, reference, parent: fixture.computer.agentImage,
    readerSha256: hash(reader), syntheticProvider: true }, null, 2) + '\n', { mode: 0o600 });
  return { id: image, reference };
}
