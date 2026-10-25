import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { OWNER, PREFIX, type OrphansFixture, type OrphansPlan, type TestDockerPlanItem } from './v4-huerfanos.fixtures.js';
import { checkedResource, type Capture } from './v4-huerfanos-volumes.fixtures.js';

export async function exerciseDockerRemains(fixture: OrphansFixture, capture: Capture) {
  const directory = join(fixture.directory, 'scratch-image');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'Dockerfile'), `FROM scratch\nLABEL cauce.e2e.owner="${OWNER}" cauce.e2e.run="${PREFIX}"\n`, { mode: 0o600 });
  const tag = `${PREFIX}:orphan`;
  await docker(['build', '-q', '-t', tag, directory]);
  const image = await docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
  fixture.trackImage(tag, image);
  const containerName = `${PREFIX}-orphan-container`;
  const container = await docker(['create', '--name', containerName, '--label', `cauce.e2e.owner=${OWNER}`,
    '--network', 'none', image, '/fixture-not-executed']);
  const networkName = `${PREFIX}-orphan-network`;
  const network = await docker(['network', 'create', '--internal', '--label', `cauce.e2e.owner=${OWNER}`, networkName]);
  fixture.trackNetwork(networkName, network);
  const daemon = JSON.parse(await docker(['info', '--format', '{{json .ID}}'])) as string;
  const item = (kind: TestDockerPlanItem['kind'], id: string, name: string): TestDockerPlanItem => ({
    id, kind, name, scope: { company_id: fixture.company }, location: { kind: 'lab_socket' },
    pin: { daemon_id: daemon, resource_sha256: null, preview_sha256: null },
  });
  const plan = (candidate: TestDockerPlanItem): OrphansPlan => ({ version: 1, company_id: fixture.company,
    expected_revision: 0, items: [candidate] });
  const remove = async (candidate: TestDockerPlanItem) => {
    const name = `docker-${candidate.id}`;
    const discovery = await checkedResource(fixture, plan(candidate), `${name}-discovery`);
    const observed = discovery.items[0];
    expect(observed).toMatchObject({ status: 'retained', reason_code: 'preview_review_required' });
    if (!observed?.resource_sha256 || !observed.preview_sha256) throw new Error('Docker discovery lacks identity or preview pin');
    candidate.pin.resource_sha256 = observed.resource_sha256; candidate.pin.preview_sha256 = observed.preview_sha256;
    await capture(`${name}-discovery`);
    const simulated = await checkedResource(fixture, plan(candidate), name);
    expect(simulated.items[0]).toMatchObject({ status: 'would_remove', reason_code: 'ready' });
    expect(simulated.external_mutations).toBe(false);
    const removed = await checkedResource(fixture, plan(candidate), name, true);
    expect(removed.items[0]).toMatchObject({ status: 'removed' });
    const replay = await checkedResource(fixture, plan(candidate), name, true);
    expect(replay.items[0]).toMatchObject({ status: 'removed', idempotent_replay: true });
    await capture(name);
    return { removed, replay };
  };
  const imagePlan = plan(item('test_image', 'image-in-use', image));
  const imageHeld = await checkedResource(fixture, imagePlan, 'docker-image-in-use', true);
  expect(imageHeld.items[0]).toMatchObject({ status: 'retained', reason_code: 'image_referenced' });
  expect(await docker(['image', 'inspect', '--format', '{{.Id}}', image])).toBe(image);
  await capture('docker-image-in-use');
  const removedContainer = await remove(item('test_container', 'container', containerName));
  expect(await docker(['ps', '-a', '--no-trunc', '--filter', `id=${container}`, '--format', '{{.ID}}'])).toBe('');
  const removedImage = await remove(item('test_image', 'image', image));
  expect(await docker(['images', '-q', '--no-trunc', '--filter', `reference=${tag}`])).toBe('');
  const runningImage = await docker(['inspect', '--format', '{{.Image}}', fixture.liveContainer]);
  const holder = await docker(['run', '-d', '--name', `${PREFIX}-network-holder`, '--label', `cauce.e2e.owner=${OWNER}`,
    '--network', networkName, '--entrypoint', '/bin/sleep', runningImage, '1200']);
  const networkPlan = plan(item('test_network', 'network-in-use', networkName));
  const networkHeld = await checkedResource(fixture, networkPlan, 'docker-network-in-use', true);
  expect(networkHeld.items[0]).toMatchObject({ status: 'retained', reason_code: 'network_has_endpoints' });
  expect(await docker(['network', 'inspect', '--format', '{{.Id}}', networkName])).toBe(network);
  expect(await docker(['network', 'inspect', '--format', '{{len .Containers}}', networkName])).toBe('1');
  await capture('docker-network-in-use');
  await docker(['stop', holder]); await docker(['rm', holder]);
  const removedNetwork = await remove(item('test_network', 'network', networkName));
  expect(await docker(['network', 'ls', '--filter', `id=${network}`, '--format', '{{.ID}}'])).toBe('');
  return { image, container, network, image_held: imageHeld, network_held: networkHeld,
    removed_container: removedContainer, removed_image: removedImage, removed_network: removedNetwork };
}
