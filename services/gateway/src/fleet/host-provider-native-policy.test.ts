import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHostProviderAuthPolicy } from './host-provider-auth.js';
import { ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import { HostCapabilitiesSchema } from './host-channel.capabilities.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'provider-native-policy-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function policy(provider: string, loginArgs: string[], env?: Record<string, string>, muse?: Record<string, string>) {
  const helper = join(directory, 'helper'); await writeFile(helper, 'helper', { mode: 0o600 });
  const command = join(directory, 'cli'); const sha = 'a'.repeat(64);
  const profile = { provider, path: join(directory, 'profile'), identity: 'same-account', runtime_user: 'dev',
    command, command_sha256: sha, ...(muse === undefined ? {} : { muse }) };
  const template = { provider, runtime_user: 'dev', path_root: join(directory, 'profiles'), command, command_sha256: sha,
    ...(muse === undefined ? {} : { muse }), login: { method: 'device', command: [command, ...loginArgs], sha256: sha, ...(env === undefined ? {} : { env }) } };
  const executor = { schemaVersion: 1, host_id: 'test-host', profiles: { account: profile }, profile_templates: [template] };
  const executorPath = join(directory, 'executor.json'); const authPath = join(directory, 'auth.json');
  await writeFile(executorPath, JSON.stringify(executor), { mode: 0o600 });
  await writeFile(authPath, JSON.stringify({ ...executor, state_root: directory,
    helper: { executable: helper, sha256: createHash('sha256').update('helper').digest('hex') }, logins: {} }), { mode: 0o600 });
  return { hostConfig: { host: 'test-host', command: { python: '/usr/bin/python3', executable: helper, policyFile: executorPath } }, authPolicyFile: authPath, projectRoot: directory };
}
describe('native provider policies', () => {
  it('accepts the pinned Grok device login recipe', async () => {
    const parsed = await readHostProviderAuthPolicy(await policy('grok', ['login', '--device-auth'], { LANG: 'C.UTF-8' }));
    expect(parsed.profile_templates?.[0]?.login?.command.slice(1)).toEqual(['login', '--device-auth']);
  });
  it('accepts Muse with a separate pinned bridge and CLI login', async () => {
    const parsed = await readHostProviderAuthPolicy(await policy('muse', ['login'], { NO_COLOR: '1' },
      { bridge: join(directory, 'bridge'), bridge_sha256: 'b'.repeat(64) }));
    expect(parsed.profiles.account?.provider).toBe('muse');
  });
  it.each(['BASH_ENV', 'ENV', 'META_API_KEY', 'GROK_AUTH', 'HOME', 'XDG_CONFIG_HOME', 'OPENAI_BASE_URL'])('rejects login environment override %s', async key => {
    await expect(readHostProviderAuthPolicy(await policy('grok', ['login', '--device-auth'], { [key]: '/redirect' }))).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it.each([['grok', ['login', '--oauth']], ['muse', ['auth', 'set']], ['muse', ['login', '--api-key']]])('rejects an unapproved %s login recipe', async (provider, args) => {
    await expect(readHostProviderAuthPolicy(await policy(provider, args))).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it('rejects a Muse profile without its pinned bridge', async () => {
    await expect(readHostProviderAuthPolicy(await policy('muse', ['login']))).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it('rejects a Muse driver on another provider', async () => {
    await expect(readHostProviderAuthPolicy(await policy('grok', ['login', '--device-auth'], undefined,
      { bridge: join(directory, 'bridge'), bridge_sha256: 'b'.repeat(64) }))).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
  it('accepts the Muse public request without exposing private paths', () => {
    expect(ProviderAuthRequestSchema.safeParse({ operation_id: randomUUID(), expected_operation_version: 0, request_id: 'request-123',
      provider_id: 'muse', account_id: 'account', harness_id: 'muse', host_id: 'test-host', runtime_user: 'dev', profile_id: 'account' }).success).toBe(true);
  });
  it('accepts Muse runtime templates without claiming quota support', () => {
    const result = HostCapabilitiesSchema.safeParse({ resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'test',
      policy_sha256: 'a'.repeat(64), fleet_executor: false, quota_executor: false, templates: [{ template_id: 'muse', provider: 'muse',
        harness_id: 'muse', mode: 'native', runtime_user: 'dev', home_directory: '/home/dev', state_root: '/home/dev/.cauce', systemd_user: 'stev' }] });
    expect(result.success).toBe(true);
  });
});
