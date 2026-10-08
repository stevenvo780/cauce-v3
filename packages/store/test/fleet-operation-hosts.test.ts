import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetEvidence, FleetOperationRequest, FleetStepName } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { aggregateHostEvidence } from '../src/repository/fleet-operation-hosts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('host-control','Steven'),('host-group','Isa'),('host-empty','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','host-control','host_operator','operator')");
  await agent('host_a', 'host-a'); await agent('host_b', 'host-b');
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
async function agent(alias: string, host: string): Promise<void> {
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Isa','host-group',$1,'agent')", [alias]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
    runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
    VALUES('Isa',$1,$2,'codex',$3,'container',$2,'dev','/home/dev','/home/dev/'||$2,'stev','host-group','ready',true)`,
  [alias, alias.replaceAll('_', '-'), host]);
}
function repository(coordinatorEnabled = true): FleetOperationsRepository {
  return new FleetOperationsRepository(pool, { controllerHost: 'host-a', coordinatorEnabled, coordinatorHosts: ['host-a', 'host-b', 'host-c'] });
}
function request(kind: 'retire' | 'purge' = 'retire', room = 'host-group'): FleetOperationRequest {
  return { kind, target: { resource: 'room', tenant_id: 'Isa', room_id: room }, parameters: {},
    expected_revision: 0, idempotency_key: `hosts-${kind}-${room}` };
}
async function claimed(repo: FleetOperationsRepository, input = request()): Promise<FleetOperationClaim> {
  await repo.enqueue('Steven', 'host_operator', input);
  const claim = await repo.claim('host-worker', 'host-a'); if (!claim) throw new Error('claim absent');
  return claim;
}
async function receipts(repo: FleetOperationsRepository, claim: FleetOperationClaim, step: FleetStepName, proof: FleetEvidence): Promise<void> {
  for (const slice of await repo.hostSlices(claim)) await repo.completeHostStep(claim, step, slice.host_id, slice.target_sha256, proof);
  await repo.completeStep(claim, step, aggregateHostEvidence(step, await repo.hostReceipts(claim, step)));
}
async function completed(repo: FleetOperationsRepository, claim: FleetOperationClaim, step: FleetStepName, proof: FleetEvidence): Promise<void> {
  await repo.startStep(claim, step); await receipts(repo, claim, step, proof);
}
async function assertUnfenced(): Promise<void> {
  expect((await pool.query("SELECT alias,enabled FROM agents WHERE tenant_id='Isa' ORDER BY alias")).rows)
    .toEqual([{ alias: 'host_a', enabled: true }, { alias: 'host_b', enabled: true }]);
  expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(0);
}
describe('durable exact fleet host barriers', () => {
  it.each(['artifacts', 'admission'] as const)('rejects different global desired images at the %s barrier', step => {
    const receipts = ['a', 'b'].map((host, index) => ({ host_id: host, target_sha256: host.repeat(64),
      evidence: { artifact_sha256: String(index + 1).repeat(64), ...(step === 'admission' ? { authority_verified: true } : {}) } }));
    expect(() => aggregateHostEvidence(step, receipts)).toThrow('same global desired image');
  });
  it('rejects a foreign host without an enabled coordinator before enqueue or fencing', async () => {
    const repo = repository(false);
    await expect(repo.preview('Steven', 'host_operator', request())).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.enqueue('Steven', 'host_operator', request())).rejects.toMatchObject({ code: 'conflict' });
    await assertUnfenced(); expect((await pool.query('SELECT 1 FROM fleet_operations')).rowCount).toBe(0);
  });
  it('rejects missing or incomplete registered host transports before fencing', async () => {
    for (const coordinatorHosts of [undefined, ['host-a'], ['host-a', 'host-b', 'host-b']]) {
      const repo = new FleetOperationsRepository(pool, { controllerHost: 'host-a', coordinatorEnabled: true,
        ...(coordinatorHosts === undefined ? {} : { coordinatorHosts }) });
      await expect(repo.preview('Steven', 'host_operator', request())).rejects.toMatchObject({ code: 'conflict' });
      await expect(repo.enqueue('Steven', 'host_operator', request())).rejects.toMatchObject({ code: 'conflict' });
    }
    await assertUnfenced();
  });
  it.each(['host_id', 'runtime_mode', 'systemd_user', 'state_directory'] as const)('rejects invalid or incomplete %s before any fence', async field => {
    await pool.query(`UPDATE agents SET ${field}=${field === 'state_directory' ? "'/home/dev/../unsafe'" : 'NULL'} WHERE tenant_id='Isa' AND alias='host_b'`);
    await expect(repository().enqueue('Steven', 'host_operator', request())).rejects.toMatchObject({ code: 'conflict' });
    await assertUnfenced();
  });
  it('rechecks placement under the preparation transaction after an accepted preview and enqueue', async () => {
    const repo = repository(); const claim = await claimed(repo);
    await pool.query("UPDATE agents SET host_id=NULL WHERE tenant_id='Isa' AND alias='host_b'");
    await expect(repo.prepare(claim)).rejects.toMatchObject({ code: 'conflict' });
    await assertUnfenced();
  });
  it('seals exact immutable per-host placements and refuses evidence for another host or digest', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim);
    const slices = await repo.hostSlices(claim);
    expect(slices.map(slice => [slice.host_id, slice.targets.map(target => target.alias)]))
      .toEqual([['host-a', ['host_a']], ['host-b', ['host_b']]]);
    expect(slices[0]?.agents[0]).toMatchObject({ host_id: 'host-a', enabled: true, systemd_user: 'stev' });
    await expect(repo.completeHostStep(claim, 'stop', 'host-a', slices[0]!.target_sha256, { stopped_verified: true }))
      .rejects.toMatchObject({ code: 'conflict' });
    await repo.startStep(claim, 'stop');
    for (const [host, digest] of [['host-c', slices[0]!.target_sha256], ['host-a', 'f'.repeat(64)]]) {
      await expect(repo.completeHostStep(claim, 'stop', host!, digest!, { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    }
    await pool.query("UPDATE agents SET state_directory='/unrelated-new-state' WHERE tenant_id='Isa' AND alias='host_a'");
    expect(await repo.hostSlices(claim)).toEqual(slices);
  });
  it('does not complete with a global boolean, a missing host or changed duplicate evidence', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim); await repo.startStep(claim, 'stop');
    const slice = (await repo.hostSlices(claim))[0]!;
    await expect(repo.completeStep(claim, 'stop', { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    const first = await repo.completeHostStep(claim, 'stop', slice.host_id, slice.target_sha256, { stopped_verified: true });
    expect((await repo.completeHostStep(claim, 'stop', slice.host_id, slice.target_sha256, { stopped_verified: true })).version).toBe(first.version);
    await expect(repo.completeHostStep(claim, 'stop', slice.host_id, slice.target_sha256,
      { stopped_verified: true, revocation_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.completeStep(claim, 'stop', { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await receipts(repo, claim, 'stop', { stopped_verified: true });
    expect((await repo.get('Steven', 'host_operator', claim.operation.id)).steps.find(step => step.name === 'stop')?.status).toBe('succeeded');
  });
  it('preserves the immutable prepared placement against a direct history rewrite', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim);
    const original = await repo.hostSlices(claim);
    await expect(pool.query(`UPDATE fleet_operation_events SET metadata=jsonb_set(metadata,
      '{host_slices,0,agents,0,state_directory}','"/modified-state"'::jsonb)
      WHERE operation_id=$1 AND metadata->>'step'='fence'`, [claim.operation.id])).rejects.toThrow('fleet operation history is permanent');
    expect(await repo.hostSlices(claim)).toEqual(original);
  });
  it('keeps durable resources until every host has stopped, revoked and physically purged', async () => {
    const repo = repository(); const claim = await claimed(repo, request('purge')); await repo.prepare(claim);
    await completed(repo, claim, 'stop', { stopped_verified: true });
    await completed(repo, claim, 'revoke', { revocation_verified: true }); await repo.startStep(claim, 'purge');
    const [first, second] = await repo.hostSlices(claim);
    await repo.completeHostStep(claim, 'purge', first!.host_id, first!.target_sha256, { stopped_verified: true, revocation_verified: true });
    await expect(repo.completeHostStep(claim, 'purge', second!.host_id, second!.target_sha256, {})).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.completeStep(claim, 'purge', { stopped_verified: true, revocation_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM rooms WHERE id='host-group' AND purged_at IS NULL")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM agents WHERE tenant_id='Isa' AND purged_at IS NULL")).rowCount).toBe(2);
    await receipts(repo, claim, 'purge', { stopped_verified: true, revocation_verified: true });
    await completed(repo, claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    expect((await repo.settle(claim)).status).toBe('succeeded');
    expect((await pool.query("SELECT 1 FROM rooms WHERE id='host-group' AND purged_at IS NULL")).rowCount).toBe(0);
  });
  it('discards unsealed receipts from an old epoch after a worker crash', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim); await repo.startStep(claim, 'stop');
    const slice = (await repo.hostSlices(claim))[0]!;
    await repo.completeHostStep(claim, 'stop', slice.host_id, slice.target_sha256, { stopped_verified: true });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.operation.id]);
    const retry = await repo.claim('host-retry', 'host-a'); if (!retry) throw new Error('retry absent');
    expect(retry.epoch).toBe(claim.epoch + 1); expect(await repo.hostReceipts(retry, 'stop')).toEqual([]);
    await expect(repo.completeHostStep(claim, 'stop', slice.host_id, slice.target_sha256, { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    const second = (await repo.hostSlices(retry))[1]!;
    await repo.completeHostStep(retry, 'stop', second.host_id, second.target_sha256, { stopped_verified: true });
    await expect(repo.completeStep(retry, 'stop', { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await receipts(repo, retry, 'stop', { stopped_verified: true });
  });
  it('preserves a completed global barrier across epochs without repeating destructive effects', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim);
    await completed(repo, claim, 'stop', { stopped_verified: true }); await completed(repo, claim, 'revoke', { revocation_verified: true });
    await completed(repo, claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.operation.id]);
    const retry = await repo.claim('host-retry', 'host-a'); if (!retry) throw new Error('retry absent');
    expect(retry.epoch).toBe(claim.epoch + 1); expect(await repo.hostReceipts(retry, 'stop')).toEqual([]);
    await expect(repo.completeHostStep(claim, 'stop', 'host-a', (await repo.hostSlices(retry))[0]!.target_sha256, { stopped_verified: true }))
      .rejects.toMatchObject({ code: 'conflict' });
    const before = (await repo.get('Steven', 'host_operator', retry.operation.id)).version;
    expect((await repo.completeStep(retry, 'stop', { stopped_verified: true })).version).toBe(before);
    expect((await repo.settle(retry)).status).toBe('succeeded');
  });
  it('preserves completed host barriers against a direct receipt deletion', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim);
    await completed(repo, claim, 'stop', { stopped_verified: true }); await completed(repo, claim, 'revoke', { revocation_verified: true });
    await completed(repo, claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    await expect(pool.query("UPDATE fleet_operation_events SET metadata=metadata-'host_barrier' WHERE operation_id=$1 AND metadata->>'step'='stop' AND metadata ? 'host_barrier'", [claim.operation.id]))
      .rejects.toThrow('fleet operation history is permanent');
    expect((await repo.settle(claim)).status).toBe('succeeded');
    expect((await pool.query("SELECT purged_at,enabled FROM agents WHERE alias='host_b'")).rows[0]).toEqual({ purged_at: null, enabled: false });
  });
  it.each(['room', 'agent'] as const)('resumes only artifacts after a sealed %s purge without repeating deletion', async resource => {
    const repo = repository(); const target = resource === 'room' ? { resource: 'room' as const, tenant_id: 'Isa', room_id: 'host-group' }
      : { resource: 'agent' as const, tenant_id: 'Isa', alias: 'host_a' };
    const claim = await claimed(repo, { kind: 'purge', target, parameters: {}, expected_revision: 0, idempotency_key: `sealed-${resource}-purge` }); await repo.prepare(claim);
    await completed(repo, claim, 'stop', { stopped_verified: true }); await completed(repo, claim, 'revoke', { revocation_verified: true });
    await completed(repo, claim, 'purge', { stopped_verified: true, revocation_verified: true });
    await repo.startStep(claim, 'artifacts'); const failed = await repo.fail(claim, { code: 'HOST_UNAVAILABLE', step: 'artifacts', retryable: true });
    const original = (await pool.query("SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'host_barrier' ORDER BY id", [claim.operation.id])).rows;
    if (resource === 'room') expect((await pool.query("SELECT 1 FROM rooms WHERE id='host-group' AND purged_at IS NULL")).rowCount).toBe(0);
    else expect((await pool.query("SELECT lifecycle_state,purged_at IS NOT NULL AS purged FROM agents WHERE alias='host_a'")).rows[0])
      .toEqual({ lifecycle_state: 'retired', purged: true });
    const resumed = await repo.resume('Steven', 'host_operator', failed.id, failed.version); expect(resumed.status).toBe('queued');
    const retry = await repo.claim('host-retry', 'host-a'); if (!retry) throw new Error('retry absent'); await repo.prepare(retry);
    expect((await pool.query("SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'host_barrier' ORDER BY id", [claim.operation.id])).rows)
      .toEqual(original);
    await completed(repo, retry, 'artifacts', { artifact_sha256: 'a'.repeat(64) }); expect((await repo.settle(retry)).status).toBe('succeeded');
    expect((await pool.query("SELECT count(*)::int AS n FROM fleet_operation_events WHERE operation_id=$1 AND metadata->>'step'='purge_scope'", [claim.operation.id])).rows[0])
      .toEqual({ n: 1 });
  });
  it('requires both compensation effects and every host before cancelling a prepared group', async () => {
    const repo = repository(); const claim = await claimed(repo); await repo.prepare(claim);
    const current = await repo.get('Steven', 'host_operator', claim.operation.id); await repo.cancel('Steven', 'host_operator', current.id, current.version);
    for (const slice of await repo.hostSlices(claim)) {
      await expect(repo.completeHostStep(claim, 'compensate', slice.host_id, slice.target_sha256, { stopped_verified: true }))
        .rejects.toMatchObject({ code: 'conflict' });
      await repo.completeHostStep(claim, 'compensate', slice.host_id, slice.target_sha256, { stopped_verified: true, revocation_verified: true });
      if (slice.host_id === 'host-a') await expect(repo.compensate(claim, { stopped_verified: true, revocation_verified: true }))
        .rejects.toMatchObject({ code: 'conflict' });
    }
    expect((await repo.compensate(claim, { stopped_verified: true, revocation_verified: true })).status).toBe('cancelled');
  });
  it('gives an empty group an explicit controller slice and measured receipts', async () => {
    const repo = repository(false); const claim = await claimed(repo, request('purge', 'host-empty')); await repo.prepare(claim);
    const slices = await repo.hostSlices(claim); expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ host_id: 'host-a', targets: [], agents: [] }); expect(slices[0]?.target_sha256).toMatch(/^[a-f0-9]{64}$/u);
    await repo.startStep(claim, 'stop'); await expect(repo.completeStep(claim, 'stop', { stopped_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await receipts(repo, claim, 'stop', { stopped_verified: true }); await completed(repo, claim, 'revoke', { revocation_verified: true });
    await completed(repo, claim, 'purge', { stopped_verified: true, revocation_verified: true });
    await completed(repo, claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) }); expect((await repo.settle(claim)).status).toBe('succeeded');
  });
  it('captures a new agent desired placement for the authority issuer despite having no previous fence', async () => {
    const repo = repository(); const input: FleetOperationRequest = { kind: 'create',
      target: { resource: 'agent', tenant_id: 'Isa', alias: 'new_host_agent' }, expected_revision: 0, idempotency_key: 'host-create',
      parameters: { runtime_key: 'new-host-agent', harness_id: 'codex', primary_room_id: 'host-group',
        memberships: [{ room_id: 'host-group', role: 'agent' }], placement: { host_id: 'host-c', mode: 'container',
          container_name: 'new-host-agent', runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/new-agent' } } };
    await repo.enqueue('Steven', 'host_operator', input);
    expect(await repo.claim('remote-host-worker', 'host-c')).toBeNull();
    const claim = await repo.claim('host-worker', 'host-a'); if (!claim) throw new Error('claim absent');
    expect((await repo.prepare(claim)).fenced_targets).toEqual([]);
    const slices = await repo.hostSlices(claim); expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ host_id: 'host-c', targets: [{ resource: 'agent', tenant_id: 'Isa', alias: 'new_host_agent', runtime_key: 'new-host-agent' }],
      agents: [expect.objectContaining({ enabled: false, lifecycle_state: 'provisioning', systemd_user: 'stev' })] });
    await repo.startStep(claim, 'artifacts');
    await expect(repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    await receipts(repo, claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
  });
});
