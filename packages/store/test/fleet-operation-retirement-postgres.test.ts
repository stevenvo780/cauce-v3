import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetReplacementCommitSchema, sha256Hex, type FleetEvidence, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import { FleetOperationsRepository, assertFleetReplacementCommit, fleetReplacementCommit, withTransaction,
  type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { lockFleetClaim } from '../src/repository/fleet-operation-state.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedFleetHuman } from './fleet-human-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let subject: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('retirement-room','Steven')");
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','retirement_operator')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','retirement-room','retirement_operator','operator')");
  subject = await seedFleetHuman(caseDatabase.adminPool, 'Steven', 'retirement_operator');
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('retirement-account','codex','isolated-retirement-account','Steven','env_path','CAUCE_ISOLATED_RETIREMENT_PATH',true)`);
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const EFFECTS: [FleetStepName, FleetEvidence][] = [
  ['stop', { stopped_verified: true }], ['artifacts', { artifact_sha256: 'a'.repeat(64) }],
  ['credentials', { certificate_fingerprint: 'b'.repeat(64) }], ['runtime', { runtime_digest: 'c'.repeat(64) }],
  ['authenticate', { provider_verified: true }], ['profile', { profile_verified: true }],
  ['verify', { bootstrap_verified: true, roundtrip_verified: true }],
  ['admission', { authority_verified: true, artifact_sha256: 'd'.repeat(64) }],
];
function creation(): Extract<FleetOperationRequest, { kind: 'create' | 'update' }> & { kind: 'create' } {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: 'retirement_agent' },
    expected_revision: 0, idempotency_key: 'retirement-original', parameters: {
      runtime_key: 'retirement-agent', harness_id: 'codex', primary_room_id: 'retirement-room', primary_account_id: 'retirement-account',
      memberships: [{ room_id: 'retirement-room', role: 'agent' }],
      placement: { host_id: 'retirement-host', mode: 'container', container_name: 'retirement-original', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/original' },
    } };
}
async function claimed(repo: FleetOperationsRepository, worker: string, leaseMs = 30_000): Promise<FleetOperationClaim> {
  const value = await repo.claim(worker, 'retirement-host', leaseMs); if (!value) throw new Error('claim absent');
  return value;
}
async function effects(repo: FleetOperationsRepository, claim: FleetOperationClaim, replacement?: FleetEvidence['replacement_verified']) {
  for (const [name, proof] of EFFECTS) {
    if (!claim.operation.steps.some(step => step.name === name)) continue;
    await repo.startStep(claim, name);
    await repo.completeStep(claim, name, { ...proof, ...(name === 'admission' && replacement ? { replacement_verified: replacement } : {}) });
  }
}
async function replacement(verified = true, leaseMs = 30_000) {
  const repo = new FleetOperationsRepository(pool);
  const input = creation(); await repo.enqueue('Steven', 'retirement_operator', input, subject);
  const create = await claimed(repo, 'create'); await repo.prepare(create); await effects(repo, create); await repo.settle(create);
  await repo.enqueue('Steven', 'retirement_operator', { ...input, kind: 'update', expected_revision: 2, idempotency_key: 'retirement-replacement',
    parameters: { ...input.parameters, placement: { ...input.parameters.placement, container_name: 'retirement-replacement',
      state_directory: '/home/dev/.cauce/replacement' } } }, subject);
  const claim = await claimed(repo, 'update', leaseMs); const prepared = await repo.prepare(claim);
  const snapshot = prepared.compensation_snapshot; if (!snapshot) throw new Error('snapshot absent');
  await effects(repo, claim, verified ? { snapshot_sha256: snapshot.snapshot_sha256, original_container_id: 'e'.repeat(64),
    replacement_container_id: 'f'.repeat(64), replacement_started_at: 'replacement-started', runtime_digest: '1'.repeat(64) } : undefined);
  return { repo, claim };
}
async function commit(claim: FleetOperationClaim) {
  const client = await pool.connect();
  try { return FleetReplacementCommitSchema.parse(await fleetReplacementCommit(client, claim.operation.id)); }
  finally { client.release(); }
}
function retired(value: Awaited<ReturnType<typeof commit>>): FleetEvidence {
  return { stopped_verified: true, removed: [{ type: 'container', name: 'retirement-original' }],
    replacement_retired: { commit_sha256: value.commit_sha256, original_container_id: value.original_container_id,
      replacement_container_id: value.replacement_container_id, runtime_digest: value.runtime_digest, volumes_retained: true } };
}
async function admitted() {
  return (await pool.query<{ enabled: boolean; lifecycle_state: string; container_name: string }>(
    `SELECT enabled,lifecycle_state,container_name FROM agents WHERE alias='retirement_agent'`)).rows[0];
}
describe('durable normal replacement retirement', () => {
  it('commits the new configuration while running and closes cancellation and rollback until physical retirement', async () => {
    const { repo, claim } = await replacement();
    const pending = await repo.settle(claim); const marker = await commit(claim);
    expect(pending.status).toBe('running'); expect(pending.applied_revision).toBe(4);
    expect(marker.decision).toBe('configuration_committed');
    expect(sha256Hex(marker.commit_canonical)).toBe(marker.commit_sha256);
    expect(JSON.parse(marker.commit_canonical)).toMatchObject({ operation_id: pending.id, applied_revision: 4 });
    expect(await admitted()).toEqual({ enabled: true, lifecycle_state: 'ready', container_name: 'retirement-replacement' });
    await expect(repo.cancel('Steven', 'retirement_operator', pending.id, pending.version, subject)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.resume('Steven', 'retirement_operator', pending.id, pending.version, subject)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.compensate(claim, { stopped_verified: true, revocation_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.settle(claim)).rejects.toMatchObject({ code: 'conflict' });
    const result = await repo.settle(claim, retired(marker));
    expect(result.status).toBe('succeeded'); expect(result.applied_revision).toBe(4);
    expect((await pool.query(`SELECT id FROM fleet_operation_events WHERE operation_id=$1 AND event='succeeded'`, [result.id])).rows).toHaveLength(1);
  });
  it('refuses to commit without the bound normal runtime identity', async () => {
    const { repo, claim } = await replacement(false);
    await expect(repo.settle(claim)).rejects.toMatchObject({ code: 'conflict' });
    expect((await admitted())?.enabled).toBe(false);
    const client = await pool.connect();
    try { expect(await fleetReplacementCommit(client, claim.operation.id)).toBeUndefined(); } finally { client.release(); }
  });
  it('reclaims a committed operation after the lease expires and fences the previous worker', async () => {
    const { repo, claim } = await replacement(true, 1000);
    await repo.settle(claim); const marker = await commit(claim);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const next = await claimed(repo, 'takeover'); expect(next.epoch).toBeGreaterThan(claim.epoch);
    expect(await commit(next)).toEqual(marker);
    await expect(repo.settle(claim, retired(marker))).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.fail(claim, { code: 'REVISION_CONFLICT', retryable: true })).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.settle(next, retired(marker))).status).toBe('succeeded');
  });
  it('keeps the new runtime ready and retries retirement with durable backoff instead of compensating', async () => {
    const { repo, claim } = await replacement(); await repo.settle(claim); const marker = await commit(claim);
    const failed = await repo.fail(claim, { code: 'STEP_FAILED', step: 'admission', retryable: true });
    expect(failed.status).toBe('running'); expect(failed.steps.every(step => step.status === 'succeeded')).toBe(true);
    expect((await admitted())?.enabled).toBe(true); expect(await repo.claim('too-soon', 'retirement-host')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5100));
    const next = await claimed(repo, 'retry'); expect(await commit(next)).toEqual(marker);
    expect((await repo.settle(next, retired(marker))).status).toBe('succeeded');
  });
  it('rejects foreign runtime identities, extra removals and missing volume retention before final success', async () => {
    const { repo, claim } = await replacement(); await repo.settle(claim); const marker = await commit(claim);
    const proof = retired(marker); const binding = proof.replacement_retired; if (!binding) throw new Error('binding absent');
    for (const invalid of [{ ...proof, replacement_retired: { ...binding, original_container_id: 'a'.repeat(64) } },
      { ...proof, replacement_retired: { ...binding, replacement_container_id: 'a'.repeat(64) } },
      { ...proof, removed: [{ type: 'volume', name: 'original-state' }] },
      { ...proof, replacement_retired: { ...binding, volumes_retained: false } }]) {
      await expect(repo.settle(claim, invalid as FleetEvidence)).rejects.toThrow();
      expect((await repo.execution(claim)).operation.status).toBe('running');
    }
    expect((await repo.settle(claim, proof)).status).toBe('succeeded');
  });
  it('records a retryable failure and releases the lease even when a foreign write invalidates the committed target seal', async () => {
    const { repo, claim } = await replacement(); await repo.settle(claim); const marker = await commit(claim);
    await pool.query("UPDATE agents SET display_name='foreign configuration' WHERE alias='retirement_agent'");
    await expect(withTransaction(pool, async client => assertFleetReplacementCommit(client, await lockFleetClaim(client, claim))))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.settle(claim, retired(marker))).rejects.toMatchObject({ code: 'conflict' });
    const failure = await repo.fail(claim, { code: 'REVISION_CONFLICT', retryable: true });
    expect(failure.status).toBe('running'); expect(failure.error).toEqual({ code: 'REVISION_CONFLICT', retryable: true });
    expect(failure.steps.every(step => step.status === 'succeeded')).toBe(true);
    expect((await admitted())?.enabled).toBe(true); expect(await repo.claim('backoff', 'retirement-host')).toBeNull();
    expect((await pool.query<{ worker_id: string | null; claim_token: string | null }>(
      'SELECT worker_id,claim_token FROM fleet_operations WHERE id=$1', [claim.operation.id])).rows[0])
      .toEqual({ worker_id: null, claim_token: null });
  });
});
