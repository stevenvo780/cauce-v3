import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FleetHost } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { requireDockerLab } from './b2-lab.js';
import { enrollComputer, hostRequest, inviteComputer, registerHostOwner, signedHostPacket, startEnrolledController,
  startHostGateway, type HostOwner } from './b2-host-signed-channel.helpers.js';

let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool;
let gateway: Awaited<ReturnType<typeof startHostGateway>>; let owner: HostOwner; let other: HostOwner;
let controller: Awaited<ReturnType<typeof startEnrolledController>> | undefined;
const enrollmentPath = '/v3/console/fleet/hosts/enrollments';
const report = { cli_version: 'b2-isolated-client', platform: 'linux/test', docker_version: null, status: 'reachable' };
const capabilities = { resource: 'host', action: 'capabilities', schemaVersion: 1, executor_version: 'b2-closed-catalog',
  policy_sha256: 'a'.repeat(64), fleet_executor: true, quota_executor: false, quota_providers: [], quota_provider_actions: {},
  templates: [{ template_id: 'codex-container', provider: 'codex', harness_id: 'codex', runtime_user: 'dev', mode: 'container',
    home_directory: '/home/dev', state_root: '/home/dev/.cauce', container_prefix: 'zz-canary-' }] };

beforeAll(async () => { await requireDockerLab(); database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; gateway = await startHostGateway(pool);
  owner = await registerHostOwner(gateway.url, 'zz-canary-b2-a'); other = await registerHostOwner(gateway.url, 'zz-canary-b2-b');
}, 120_000);
afterEach(async () => { await controller?.close(); controller = undefined; await gateway.app.close(); await current.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
async function hosts(person = owner): Promise<FleetHost[]> {
  const response = await hostRequest(gateway.url, '/v3/console/fleet/hosts', 'GET', undefined, person.headers);
  expect(response.status).toBe(200); return (await response.json() as { hosts: FleetHost[] }).hosts;
}
async function capability() {
  const response = await hostRequest(gateway.url, '/v3/console/fleet/capability', 'GET', undefined, owner.headers);
  expect(response.status).toBe(200); return response.json() as Promise<{ available: boolean; placements: { host_id: string }[] }>;
}

describe('B2 enrolled computers through the real HTTP gateway and durable PostgreSQL', () => {
  it('enrolls, reports online and publishes a closed capability catalog scoped to its company', async () => {
    const computer = await enrollComputer(gateway.url, owner, 'desk'); const id = computer.receipt.host_id;
    expect(await hosts()).toMatchObject([{ host_id: id, status: 'unknown', status_source: 'none' }]);
    const heartbeat = `/v3/fleet/hosts/${id}/heartbeat`;
    const response = await hostRequest(gateway.url, heartbeat, 'POST', signedHostPacket(computer, heartbeat, report));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ host_id: id, company_id: owner.slug, accepted: true });
    expect(await hosts()).toMatchObject([{ host_id: id, status: 'reachable', status_source: 'controller' }]);
    expect((await hosts())[0]?.last_seen_at).toBeTypeOf('string');
    const channel = `/v3/fleet/hosts/${id}/channel`;
    const catalog = await hostRequest(gateway.url, channel, 'POST', signedHostPacket(computer, channel, capabilities));
    expect(catalog.status).toBe(200); expect(await catalog.json()).toMatchObject({ executor_ready: true });
    expect(await capability()).toMatchObject({ available: true, placements: [{ host_id: id }] });
    expect(await hosts(other)).toEqual([]);
    const listed = await hostRequest(gateway.url, enrollmentPath, 'GET', undefined, owner.headers);
    expect(await listed.json()).toMatchObject({ enrollments: [{ host_id: id, state: 'enrolled', executor_ready: true }] });
    await pool.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1", [id]);
    expect(await capability()).toMatchObject({ available: false, placements: [] });
    await pool.query("UPDATE fleet_hosts SET controller_seen_at=now()-interval '91 seconds' WHERE host_id=$1", [id]);
    expect(await hosts()).toMatchObject([{ host_id: id, status: 'unknown', status_source: 'none' }]);
  });
  it('rejects replay, altered payloads, foreign companies, stale timestamps and browser cookies without consuming valid proof', async () => {
    const computer = await enrollComputer(gateway.url, owner, 'proof'); const id = computer.receipt.host_id;
    const heartbeat = `/v3/fleet/hosts/${id}/heartbeat`; const channel = `/v3/fleet/hosts/${id}/channel`;
    const packet = signedHostPacket(computer, heartbeat, report);
    for (const [path, body, headers] of [
      [heartbeat, { ...packet, payload: { ...report, cli_version: 'tampered' } }, {}],
      [channel, packet, {}],
      [heartbeat, signedHostPacket(computer, heartbeat, report, { company_id: other.slug }), {}],
      [heartbeat, signedHostPacket(computer, heartbeat, report, { issued_at: Date.now() - 121_000 }), {}],
      [heartbeat, packet, owner.headers],
    ] as const) {
      const rejected = await hostRequest(gateway.url, path, 'POST', body, headers);
      expect(rejected.status).toBe(403); await rejected.body?.cancel();
    }
    expect((await pool.query('SELECT 1 FROM fleet_host_request_nonces WHERE host_id=$1', [id])).rowCount).toBe(0);
    expect(await hosts()).toMatchObject([{ host_id: id, status: 'unknown' }]);
    const accepted = await hostRequest(gateway.url, heartbeat, 'POST', packet); expect(accepted.status).toBe(200); await accepted.body?.cancel();
    const replay = await hostRequest(gateway.url, heartbeat, 'POST', packet); expect(replay.status).toBe(409); await replay.body?.cancel();
    const forgedCommand = signedHostPacket(computer, channel, { resource: 'fleet_operation', action: 'shell', command: 'echo forbidden' });
    const closed = await hostRequest(gateway.url, channel, 'POST', forgedCommand); expect(closed.status).toBe(400); await closed.body?.cancel();
    expect((await pool.query('SELECT 1 FROM fleet_host_request_nonces WHERE host_id=$1 AND nonce=$2', [id, forgedCommand.nonce])).rowCount).toBe(0);
    const row = (await hosts())[0]; if (!row) throw new Error('registered host absent');
    const disabled = await hostRequest(gateway.url, `/v3/console/fleet/hosts/${id}`, 'PATCH', { expected_version: row.version, enabled: false }, owner.headers);
    expect(disabled.status).toBe(200); await disabled.body?.cancel();
    const revoked = await hostRequest(gateway.url, heartbeat, 'POST', signedHostPacket(computer, heartbeat, report));
    expect(revoked.status).toBe(403); await revoked.body?.cancel();
    expect(await hosts()).toMatchObject([{ host_id: id, enabled: false }]);
  });
  it('cancels an unused invitation and runs the enrolled controller with the real closed executor until SIGTERM', async () => {
    const unused = await inviteComputer(gateway.url, owner, 'unused');
    const revoked = await hostRequest(gateway.url, `${enrollmentPath}/${unused.enrollment_id}`, 'DELETE', undefined, owner.headers);
    expect(revoked.status).toBe(200); expect(await revoked.json()).toMatchObject({ state: 'revoked' });
    const computer = await enrollComputer(gateway.url, owner, 'controller');
    controller = await startEnrolledController(gateway.url, computer);
    const active = controller;
    await expect.poll(async () => {
      if (active.child.exitCode !== null) throw new Error(active.diagnostic() || 'isolated controller exited');
      return (await hosts()).find(host => host.host_id === computer.receipt.host_id)?.status;
    }, { timeout: 30_000 }).toBe('reachable');
    const id = computer.receipt.host_id;
    await expect.poll(async () => (await pool.query<{ capabilities: { fleet_executor?: boolean } }>(
      'SELECT capabilities FROM fleet_host_identities WHERE host_id=$1', [id])).rows[0]?.capabilities.fleet_executor,
    { timeout: 30_000 }).toBe(false);
    await expect.poll(async () => (await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM fleet_host_request_nonces WHERE host_id=$1', [id])).rows[0]?.count ?? 0,
    { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => gateway.successfulHostPaths.has(`/v3/fleet/hosts/${id}/space-backups`),
      { timeout: 30_000 }).toBe(true);
    expect(await capability()).toMatchObject({ available: false, placements: [] });
    await active.close(); controller = undefined;
    expect(active.child.exitCode).toBe(0); expect(active.diagnostic()).toBe('');
    expect((await pool.query('SELECT 1 FROM fleet_operations WHERE executor_host=$1', [id])).rowCount).toBe(0);
    console.info('B2_HOST_REAL_CONTROLLER', JSON.stringify({ enrolled: true, signed_heartbeat: true,
      executor: 'ops/cli/fleet-executor.py', closed_policy: true, executor_ready: false, typed_idle_work_seen: true,
      shutdown: 'SIGTERM', exit_code: 0 }));
  }, 60_000);
});
