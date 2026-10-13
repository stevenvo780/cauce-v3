import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runEnrolledFleetHost } from './enrolled-main.js';
import { HostCapabilitiesSchema } from './host-channel.capabilities.js';
import { readFleetHostConfig } from './main.js';
import { boundedProviderReceipt } from './provider-login.js';
import { SignedHostChannel } from './signed-source.js';

vi.mock('./worker.js', () => ({ FleetHostWorker: class {
  async start() { await Promise.resolve(); }
  async shutdown() { await Promise.resolve(); }
} }));
vi.mock('./provider-login.js', async importOriginal => ({
  ...await importOriginal<typeof import('./provider-login.js')>(), boundedProviderReceipt: vi.fn(),
}));

let directory: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
const report = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'test',
  policy_sha256: 'a'.repeat(64), fleet_executor: false, quota_executor: true, templates: [],
  quota_providers: ['codex'], quota_provider_actions: { codex: ['query'] } };
const unavailable = { codex: { authenticate: 'operations.authenticate: command is unavailable' },
  grok: { query: 'operations.quota: command is unavailable' } };

it('publishes unavailable quota actions from the executor receipt on the enrolled host channel', async () => {
  directory = await mkdtemp(join(tmpdir(), 'cauce-capabilities-'));
  const policy = join(directory, 'policy.json'); await writeFile(policy, '{}', { mode: 0o600 });
  const request = vi.fn().mockResolvedValue({});
  vi.spyOn(SignedHostChannel, 'load').mockResolvedValue({ identity: { host_id: 'test-host' }, request } as unknown as SignedHostChannel);
  vi.mocked(boundedProviderReceipt).mockResolvedValue({ available: false, actions: [], placements: [],
    quota_environments: { providers: ['codex'], actions: { codex: ['query'] }, unavailable } });
  await runEnrolledFleetHost(readFleetHostConfig({ CAUCE_FLEET_PROJECT_ROOT: directory, CAUCE_FLEET_HOST: 'test-host',
    CAUCE_FLEET_WORKER_ID: 'test-worker', CAUCE_FLEET_PYTHON: '/usr/bin/python3',
    CAUCE_FLEET_EXECUTABLE: join(directory, 'executor.py'), CAUCE_FLEET_POLICY_FILE: policy,
    CAUCE_FLEET_IDENTITY_DIRECTORY: join(directory, 'identity') }));
  expect(request).toHaveBeenCalledWith('POST', '/v3/fleet/hosts/test-host/channel',
    expect.objectContaining({ quota_provider_unavailable: unavailable, quota_provider_actions: { codex: ['query'] } }));
});

it('accepts optional action reasons including a provider with no available actions', () => {
  expect(HostCapabilitiesSchema.parse({ ...report, quota_provider_unavailable: unavailable }).quota_provider_unavailable).toEqual(unavailable);
  expect(HostCapabilitiesSchema.parse(report).quota_provider_unavailable).toBeUndefined();
});

it.each([{ opencode: { query: 'missing' } }, { codex: { shell: 'missing' } }, { codex: { authenticate: '' } },
  { codex: { authenticate: 'x'.repeat(513) } }, { codex: { authenticate: 'invalid\nreason' } },
  { codex: { query: 'contradicts an available action' } }])('rejects malformed or contradictory quota reasons: %j', reasons => {
  expect(HostCapabilitiesSchema.safeParse({ ...report, quota_provider_unavailable: reasons }).success).toBe(false);
});
