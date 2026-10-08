import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFleetHostConfig, readFleetHostDatabaseUrl } from './main.js';

const configured = { CAUCE_FLEET_PROJECT_ROOT: '/srv/cauce', CAUCE_FLEET_DATABASE_URL_FILE: '/run/private/database-url',
  CAUCE_FLEET_HOST: 'isolated', CAUCE_FLEET_WORKER_ID: 'isolated-worker', CAUCE_FLEET_PYTHON: '/usr/bin/python3',
  CAUCE_FLEET_EXECUTABLE: '/srv/cauce/ops/cli/fleet-executor.py', CAUCE_FLEET_POLICY_FILE: '/run/private/host-policy.json' };
let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { force: true, recursive: true }); temporary = undefined; });
async function secret(body = 'postgresql://worker:synthetic-private-secret@127.0.0.1:5432/isolated\n'): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), 'cauce-host-config-'));
  const file = join(temporary, 'database-url'); await writeFile(file, body, { mode: 0o600 }); return file;
}
describe('fleet host process configuration', () => {
  it('requires both auth paths and validates the optional socket group', () => {
    const auth = { CAUCE_FLEET_API_SOCKET: '/run/cauce-fleet/auth.sock', CAUCE_FLEET_AUTH_POLICY_FILE: '/run/private/auth-policy.json' };
    expect(readFleetHostConfig({ ...configured, ...auth, CAUCE_FLEET_API_GROUP_GID: '1000' }).auth).toEqual({
      socket: auth.CAUCE_FLEET_API_SOCKET, policyFile: auth.CAUCE_FLEET_AUTH_POLICY_FILE, groupGid: 1000,
    });
    for (const partial of [{ CAUCE_FLEET_API_SOCKET: auth.CAUCE_FLEET_API_SOCKET },
      { CAUCE_FLEET_AUTH_POLICY_FILE: auth.CAUCE_FLEET_AUTH_POLICY_FILE }, { CAUCE_FLEET_API_GROUP_GID: '1000' },
      { ...auth, CAUCE_FLEET_API_GROUP_GID: '0' }, { ...auth, CAUCE_FLEET_API_GROUP_GID: 'NaN' }]) {
      expect(() => readFleetHostConfig({ ...configured, ...partial })).toThrow('Fleet host configuration is invalid');
    }
  });
  it('requires explicit reproducible project and physical command paths', () => {
    const config = readFleetHostConfig({ ...configured, DATABASE_URL: 'postgresql://ignored-private-account@other/other' });
    expect(config.projectRoot).toBe('/srv/cauce'); expect(config.databaseFile).toBe('/run/private/database-url');
    expect(config.host).toBe('isolated'); expect(config.worker).toBe('isolated-worker');
    expect(config.command).toEqual({ python: '/usr/bin/python3', executable: '/srv/cauce/ops/cli/fleet-executor.py',
      policyFile: '/run/private/host-policy.json', timeoutMs: 60_000 });
    expect(config.pollMs).toBe(1000); expect(config.leaseMs).toBe(30_000);
    expect(JSON.stringify(config)).not.toContain('ignored-private-account');
  });
  it.each([
    ['CAUCE_FLEET_PROJECT_ROOT', 'relative-root'], ['CAUCE_FLEET_DATABASE_URL_FILE', '/run/../private/file'],
    ['CAUCE_FLEET_PYTHON', '/usr//bin/python3'], ['CAUCE_FLEET_EXECUTABLE', '/cli\n'],
    ['CAUCE_FLEET_POLICY_FILE', ''], ['CAUCE_FLEET_HOST', 'UPPERCASE-HOST'], ['CAUCE_FLEET_WORKER_ID', 'worker with spaces'],
    ['CAUCE_FLEET_POLL_MS', '0'], ['CAUCE_FLEET_LEASE_MS', '999'], ['CAUCE_FLEET_COMMAND_TIMEOUT_MS', '300001'],
  ])('rejects invalid %s without disclosing its value', (field, value) => {
    expect(() => readFleetHostConfig({ ...configured, [field]: value })).toThrow('Fleet host configuration is invalid');
  });
  it('reads the PostgreSQL URL exclusively from a private regular owned file', async () => {
    const file = await secret();
    expect(await readFleetHostDatabaseUrl(file)).toBe('postgresql://worker:synthetic-private-secret@127.0.0.1:5432/isolated');
  });
  it('rejects a readable public credential file', async () => {
    const file = await secret(); await chmod(file, 0o644);
    await expect(readFleetHostDatabaseUrl(file)).rejects.toThrow('Fleet host database configuration is unavailable');
  });
  it('rejects a symlink or multiply linked credential file', async () => {
    const file = await secret(); const symbolic = file + '-symbolic'; const hard = file + '-hard';
    await symlink(file, symbolic);
    await expect(readFleetHostDatabaseUrl(symbolic)).rejects.toThrow('Fleet host database configuration is unavailable');
    await link(file, hard);
    await expect(readFleetHostDatabaseUrl(hard)).rejects.toThrow('Fleet host database configuration is unavailable');
  });
  it.each(['private-token-invalid-url', 'https://worker:private-password@example/isolated', 'postgresql://localhost', 'x'.repeat(16_385)])(
    'reports malformed or oversized credential data without logging it', async (body) => {
      const file = await secret(body);
      await expect(readFleetHostDatabaseUrl(file)).rejects.toThrow('Fleet host database configuration is unavailable');
    });
  it('reports a missing private path without exposing its path in the error', async () => {
    await expect(readFleetHostDatabaseUrl('/tmp/synthetic-private-secret-missing')).rejects.toThrow('Fleet host database configuration is unavailable');
  });
});
