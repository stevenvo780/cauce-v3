import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetControllerConfigSchema, createFleetControllerTransport, readFleetControllerConfig } from './controller-config.js';
const command = { python: '/usr/bin/python3', executable: '/srv/fleet/executor.py', policyFile: '/run/private/host-policy.json' };
const config = { version: 1, controller_host: 'host-a', hosts: [{ host_id: 'host-a', command }] };
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
describe('fleet registered controller transports', () => {
  it('reads a canonical private controller file and requires its exact host', async () => {
    directory = await mkdtemp('/var/tmp/cauce-controller-config-'); const filename = join(directory, 'config.json');
    await writeFile(filename, JSON.stringify(config), { mode: 0o600 }); expect(await readFleetControllerConfig(filename, 'host-a')).toEqual(config);
    await expect(readFleetControllerConfig(filename, 'host-b')).rejects.toThrow('identity differs');
    await chmod(filename, 0o644); await expect(readFleetControllerConfig(filename, 'host-a')).rejects.toThrow();
  });
  it('rejects repeated and unregistered remote transports', () => {
    expect(FleetControllerConfigSchema.safeParse({ ...config, hosts: [...config.hosts, ...config.hosts] }).success).toBe(false);
    expect(FleetControllerConfigSchema.safeParse({ ...config, hosts: [...config.hosts, { host_id: 'host-b', command }] }).success).toBe(false);
    expect(FleetControllerConfigSchema.safeParse({ ...config, controller_host: 'unknown' }).success).toBe(false);
  });
  it('does not fall back to the first host when an unknown host is requested', async () => {
    const transport = createFleetControllerTransport(FleetControllerConfigSchema.parse(config));
    await expect(transport.perform('unknown', 'stop', {} as never, new AbortController().signal)).rejects.toThrow('transport is unavailable');
  });
  it('allows repeated remote socket paths across hosts while requiring unique controller paths', () => {
    const transport = { executable: '/usr/bin/ssh', executable_sha256: 'a'.repeat(64), destination: 'root@fixture',
      known_hosts_file: '/run/private/known-hosts', known_hosts_sha256: 'b'.repeat(64) };
    const authority_command = { python: '/usr/bin/python3', executable: '/srv/issuer.py', sha256: 'c'.repeat(64),
      policy_file: '/run/private/issuer.json', policy_sha256: 'd'.repeat(64) };
    const hosts = ['host-a', 'host-b', 'host-c'].map(host => ({ host_id: host,
      command: { ...command, ...(host === 'host-a' ? {} : { transport }) },
      authority_socket: `/run/private/${host}-authority.sock`, auth_socket: `/run/private/${host}-auth.sock`,
      ...(host === 'host-a' ? {} : { authority_remote_socket: '/run/private/authority.sock', auth_remote_socket: '/run/private/auth.sock' }) }));
    const candidate = { ...config, authority_command, hosts };
    expect(FleetControllerConfigSchema.safeParse(candidate).success).toBe(true);
    expect(FleetControllerConfigSchema.safeParse({ ...candidate, hosts: hosts.map(host =>
      host.host_id === 'host-c' ? { ...host, auth_socket: '/run/private/host-b-auth.sock' } : host) }).success).toBe(false);
    expect(FleetControllerConfigSchema.safeParse({ ...candidate, hosts: hosts.map(host =>
      host.host_id === 'host-c' ? { ...host, auth_remote_socket: '/run/private/authority.sock' } : host) }).success).toBe(false);
  });
});
