import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetCapability } from '@cauce/protocol';
import { createPool, fleetHostAvailability, type DatabasePool } from '@cauce/store';
import { FleetHostUnavailableError, configuredFleetGateway } from './gateway-config.js';

vi.mock('@cauce/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cauce/store')>(),
  fleetHostAvailability: vi.fn(async () => ({ usable: true })),
}));

const pool = createPool('postgresql://localhost/cauce_test_config_unused', { max: 1 });
const capability: FleetCapability = { available: true, actions: ['create', 'update', 'retire'],
  placements: [{ host_id: 'server', modes: ['native'], runtime_users: ['stev'], systemd_users: ['stev'],
    home_roots: ['/home/stev'], state_roots: ['/home/stev/state'] }] };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { await pool.end(); });
async function config(hosts = [{ host_id: 'server', socket_path: '/run/fleet/server.sock' }]) {
  const directory = await mkdtemp('/var/tmp/cauce-fleet-api-'); directories.push(directory);
  const filename = join(directory, 'config.json');
  await writeFile(filename, JSON.stringify({ version: 1, controller_host: 'server', hosts }), { mode: 0o600 });
  return { filename, environment: { CAUCE_FLEET_API_CONFIG_FILE: filename, CAUCE_FLEET_CONTROLLER_HOST: 'server' } };
}
describe('fleet gateway deployment configuration', () => {
  it('keeps unconfigured fleet actions unavailable', async () => {
    expect(await configuredFleetGateway(pool, { available: false, actions: [], placements: [] }, {})).toEqual({});
  });
  it('binds one durable coordinator and router only from a private matching host catalog', async () => {
    const { filename, environment } = await config();
    const result = await configuredFleetGateway(pool, capability, environment);
    expect(result.fleetCapability).toBe(capability); expect(result.fleetOperationsRepository).toBeDefined();
    expect(result.providerAuthService).toBeDefined();
    await expect(configuredFleetGateway(pool, capability, { ...environment, CAUCE_FLEET_CONTROLLER_HOST: 'other' })).rejects.toThrow('catalogs differ');
    await chmod(filename, 0o644); await expect(configuredFleetGateway(pool, capability, environment)).rejects.toThrow();
  });
  it('rejects missing and repeated host routes before binding operations', async () => {
    const missing = await config([{ host_id: 'other', socket_path: '/run/fleet/other.sock' }]);
    await expect(configuredFleetGateway(pool, capability, missing.environment)).rejects.toThrow();
    const repeated = await config([{ host_id: 'server', socket_path: '/run/fleet/one.sock' }, { host_id: 'server', socket_path: '/run/fleet/two.sock' }]);
    await expect(configuredFleetGateway(pool, capability, repeated.environment)).rejects.toThrow();
    const valid = await config();
    const template = capability.placements[0]; if (!template) throw new Error('Missing test placement');
    await expect(configuredFleetGateway(pool, { ...capability, placements: [...capability.placements,
      { ...template, host_id: 'unregistered' }] }, valid.environment)).rejects.toThrow('catalogs differ');
    const duplicate = await config([{ host_id: 'server', socket_path: '/run/fleet/one.sock' }, { host_id: 'other', socket_path: '/run/fleet/one.sock' }]);
    await expect(configuredFleetGateway(pool, capability, duplicate.environment)).rejects.toThrow();
  });
  it('blocks start and placement changes on a disabled or unreachable computer without blocking stop', async () => {
    const { environment } = await config();
    const query = vi.fn(async () => ({ rows: [{ host_id: 'server' }], rowCount: 1 }));
    const placed = { query } as unknown as DatabasePool;
    const operable: FleetCapability = { ...capability, actions: [...capability.actions, 'start', 'stop'] };
    const binding = (await configuredFleetGateway(placed, operable, environment)).fleetOperationsRepository;
    if (!binding) throw new Error('fleet operations binding was not configured');
    const target = { resource: 'agent' as const, tenant_id: 'Pablo', alias: 'midas' };
    const start = { kind: 'start' as const, target, expected_revision: 1, idempotency_key: 'start-midas-01', parameters: {} };
    const stop = { ...start, kind: 'stop' as const, idempotency_key: 'stop-midas-01' };

    vi.mocked(fleetHostAvailability).mockResolvedValueOnce({ usable: false, reason: 'unreachable' });
    await expect(binding.enqueue('Pablo', 'midas', start)).rejects.toMatchObject({
      code: 'host_unavailable', statusCode: 409,
      message: 'La computadora server está deshabilitada o sin conexión; sus agentes no se pueden operar hasta que vuelva.',
    });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM agents/u), ['Pablo', 'midas']);
    expect(fleetHostAvailability).toHaveBeenCalledWith(placed, 'server');

    vi.mocked(fleetHostAvailability).mockResolvedValueOnce({ usable: false, reason: 'disabled' });
    await expect(binding.preview('Pablo', 'midas', start)).rejects.toBeInstanceOf(FleetHostUnavailableError);

    vi.mocked(fleetHostAvailability).mockClear();
    const stopped = await binding.enqueue('Pablo', 'midas', stop).catch((error: unknown) => error);
    expect(stopped).not.toBeInstanceOf(FleetHostUnavailableError);
    expect(fleetHostAvailability).not.toHaveBeenCalled();
  });
});
