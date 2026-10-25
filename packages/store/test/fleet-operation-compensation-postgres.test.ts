import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type FleetError, type FleetEvidence, type FleetOperationRequest, type FleetStepName } from '@cauce/protocol';
import { FleetOperationsRepository, canRestoreFleetUpdate, fleetReplacementRuntimeDigest, parseFleetCompensationSnapshot,
  validateFleetCompensationSnapshot, type DatabasePool, type FleetCompensationSnapshot, type FleetOperationClaim } from '../src/index.js';
import { aggregateHostEvidence } from '../src/repository/fleet-operation-hosts.js';
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
  await pool.query(`INSERT INTO rooms(id,tenant_id) VALUES('restore-primary','Steven'),('restore-disabled','Steven'),
    ('restore-retired','Steven'),('restore-added','Steven')`);
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','restore_operator')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','restore-primary','restore_operator','operator')");
  subject = await seedFleetHuman(caseDatabase.adminPool, 'Steven', 'restore_operator');
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('restore-account','codex','isolated-restore-account','Steven','env_path','CAUCE_ISOLATED_RESTORE_PATH',true)`);
  await pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id,extensions_allowed)
    SELECT 'restore-host','Restore host',company_id,'{"types":["resources"],"mount_roots":[],"networks":[]}'::jsonb
    FROM tenants WHERE id='Steven'`);
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
function create(): Extract<FleetOperationRequest, { kind: 'create' | 'update' }> & { kind: 'create' } {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: 'restored_agent' },
    expected_revision: 0, idempotency_key: 'original-agent', parameters: {
      runtime_key: 'restored-agent', harness_id: 'codex', display_name: 'Original ñ 🦉',
      primary_room_id: 'restore-primary', primary_account_id: 'restore-account', extensions: [{ type: 'resources', cpus: 1e-7 }],
      memberships: [{ room_id: 'restore-primary', role: 'agent' }, { room_id: 'restore-disabled', role: 'operator', enabled: false }],
      placement: { host_id: 'restore-host', mode: 'container', container_name: 'original-container', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/original' },
    } };
}
async function claim(repo: FleetOperationsRepository, worker: string): Promise<FleetOperationClaim> {
  const value = await repo.claim(worker, 'restore-host'); if (!value) throw new Error('claim absent');
  return value;
}
async function effects(repo: FleetOperationsRepository, value: FleetOperationClaim, through: FleetStepName): Promise<void> {
  for (const [name, proof] of EFFECTS) {
    if (!value.operation.steps.some(step => step.name === name)) continue;
    await repo.startStep(value, name); await repo.completeStep(value, name, proof);
    if (name === through) return;
  }
}
async function rows(): Promise<{ agent: unknown; memberships: unknown[] }> {
  return {
    agent: (await pool.query<{ agent: unknown }>(`SELECT to_jsonb(agent)-'updated_at' AS agent FROM agents agent WHERE alias='restored_agent'`)).rows[0]?.agent,
    memberships: (await pool.query<{ member: unknown }>(`SELECT to_jsonb(member) AS member FROM memberships member
      WHERE alias='restored_agent' ORDER BY room_id`)).rows.map(({ member }) => member),
  };
}
async function replacement(options: { sameContainer?: boolean; through?: FleetStepName; cancel?: boolean } = {}): Promise<{
  repo: FleetOperationsRepository; value: FleetOperationClaim; snapshot: FleetCompensationSnapshot;
  before: Awaited<ReturnType<typeof rows>> }> {
  const repo = new FleetOperationsRepository(pool);
  const input = create(); await repo.enqueue('Steven', 'restore_operator', input, subject);
  const initial = await claim(repo, 'create-worker'); await repo.prepare(initial); await effects(repo, initial, 'admission');
  await repo.settle(initial);
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled,retired_at,retired_enabled)
    VALUES('Steven','restore-retired','restored_agent','adapter',false,'2026-01-02T03:04:05.123456Z',true)`);
  await pool.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
    VALUES('Steven','restored_agent','original-instance',7,clock_timestamp()+interval '1 hour')`);
  const before = await rows();
  await repo.enqueue('Steven', 'restore_operator', { ...input, kind: 'update', expected_revision: 2, idempotency_key: 'replacement-agent',
    parameters: { ...input.parameters, display_name: 'Replacement', primary_room_id: 'restore-added', extensions: [],
      placement: options.sameContainer ? input.parameters.placement
        : { ...input.parameters.placement, container_name: 'replacement-container', state_directory: '/home/dev/.cauce/replacement' },
      memberships: [{ room_id: 'restore-added', role: 'agent' }, { room_id: 'restore-primary', role: 'operator' },
        { room_id: 'restore-disabled', role: 'agent' }] } }, subject);
  const value = await claim(repo, 'replace-worker'); const prepared = await repo.prepare(value);
  const snapshot = validateFleetCompensationSnapshot(prepared.compensation_snapshot, prepared.operation, prepared.previous_agents);
  await effects(repo, value, options.through ?? 'runtime');
  if (options.cancel !== false) {
    const current = await repo.get('Steven', 'restore_operator', value.operation.id, subject);
    await repo.cancel('Steven', 'restore_operator', current.id, current.version, subject);
  }
  return { repo, value, snapshot, before };
}
function proof(snapshot: FleetCompensationSnapshot): FleetEvidence {
  const binding = { snapshot_sha256: snapshot.snapshot_sha256, original_container_id: 'e'.repeat(64),
    checkpoint_sha256: 'f'.repeat(64), authority_sha256: 'a'.repeat(64) };
  const runtime_digest = fleetReplacementRuntimeDigest(binding);
  return { stopped_verified: true, revocation_verified: true, runtime_digest,
    replacement_restored: { ...binding, runtime_digest, shared_authority_preserved: true, created_authority_revoked: true } };
}

describe('replacement cancellation snapshot and atomic restoration', () => {
  it('restores the entire previous configuration and every raw membership without reviving the old lease', async () => {
    const { repo, value, snapshot, before } = await replacement();
    expect(snapshot.previous_agents[0]).toMatchObject({ display_name: 'Original ñ 🦉', enabled: true, lifecycle_state: 'ready' });
    expect(snapshot.previous_memberships).toEqual(before.memberships);
    const receipt = proof(snapshot);
    const slices = await repo.hostSlices(value); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await repo.completeHostStep(value, 'compensate', slice.host_id, slice.target_sha256, receipt);
    const aggregate = aggregateHostEvidence('compensate', await repo.hostReceipts(value, 'compensate'));
    expect(aggregate).toEqual(receipt);
    expect((await repo.compensate(value, aggregate)).status).toBe('cancelled');
    expect(await rows()).toEqual(before);
    expect((await pool.query("SELECT epoch,(lease_until<=clock_timestamp()) AS expired FROM connection_leases WHERE alias='restored_agent'")).rows)
      .toEqual([{ epoch: '8', expired: true }]);
    await expect(repo.compensate(value, aggregate)).rejects.toMatchObject({ code: 'conflict' });
    expect(await rows()).toEqual(before);
  });
  it('keeps cancelling and the prepared rows intact without exact runtime and authority proof', async () => {
    const { repo, value, snapshot } = await replacement(); const prepared = await rows();
    const valid = proof(snapshot); const nested = valid.replacement_restored; if (!nested) throw new Error('proof absent');
    for (const evidence of [{ stopped_verified: true, revocation_verified: true },
      { ...valid, replacement_restored: { ...nested, snapshot_sha256: '0'.repeat(64) } },
      { ...valid, runtime_digest: '0'.repeat(64) },
      { ...valid, replacement_restored: { ...nested, authority_sha256: '0'.repeat(64) } }]) {
      await expect(repo.compensate(value, evidence)).rejects.toMatchObject({ code: 'conflict' });
      expect(await rows()).toEqual(prepared);
    }
    const slices = await repo.hostSlices(value); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await expect(repo.completeHostStep(value, 'compensate', slice.host_id, slice.target_sha256,
      { ...valid, runtime_digest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.get('Steven', 'restore_operator', value.operation.id, subject)).status).toBe('cancelling');
    await repo.fail(value, { code: 'HOST_UNAVAILABLE', retryable: true });
    const retry = await claim(repo, 'compensation-worker');
    await repo.fail(retry, { code: 'HOST_UNAVAILABLE', retryable: true });
    expect(await repo.claim('retry-worker', 'restore-host')).toBeNull();
    expect((await pool.query(`SELECT count(*)::integer AS count FROM fleet_operation_events
      WHERE operation_id=$1 AND event='failed' AND metadata->>'compensation'='true'`, [value.operation.id])).rows[0]).toEqual({ count: 1 });
  });
  it('rejects a changed target seal even when no new configuration revision was recorded', async () => {
    const { repo, value, snapshot } = await replacement();
    const slices = await repo.hostSlices(value); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await repo.completeHostStep(value, 'compensate', slice.host_id, slice.target_sha256, proof(snapshot));
    await pool.query("UPDATE memberships SET role='adapter' WHERE alias='restored_agent' AND room_id='restore-disabled'");
    const changed = await rows();
    await expect(repo.compensate(value, proof(snapshot))).rejects.toMatchObject({ code: 'conflict' });
    expect(await rows()).toEqual(changed);
    expect((await repo.get('Steven', 'restore_operator', value.operation.id, subject)).status).toBe('cancelling');
  });
  it('requires a new host receipt after a claim takeover and rejects the old worker', async () => {
    const { repo, value, snapshot, before } = await replacement(); const receipt = proof(snapshot);
    const slices = await repo.hostSlices(value); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await repo.completeHostStep(value, 'compensate', slice.host_id, slice.target_sha256, receipt);
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [value.operation.id]);
    const next = await claim(repo, 'takeover-worker');
    await expect(repo.compensate(value, receipt)).rejects.toMatchObject({ code: 'conflict' });
    expect(await repo.hostReceipts(next, 'compensate')).toEqual([]);
    await expect(repo.compensate(next, receipt)).rejects.toMatchObject({ code: 'conflict' });
    await repo.completeHostStep(next, 'compensate', slice.host_id, slice.target_sha256, receipt);
    expect((await repo.compensate(next, receipt)).status).toBe('cancelled');
    expect(await rows()).toEqual(before);
  });
  it('pins literal Unicode, numeric object keys and floating values without recanonicalizing another language', async () => {
    const { snapshot } = await replacement();
    const { snapshot_canonical: _canonical, snapshot_sha256: _digest, ...body } = snapshot;
    const agent = body.previous_agents[0]; if (!agent) throw new Error('agent absent');
    body.previous_agents = [{ ...agent, metadata: { '10': 'ñ', '2': '🦉', tiny: 1e-7, integer: 1e20, flag: true } }];
    const snapshot_canonical = JSON.stringify(body);
    const value = { ...body, snapshot_canonical, snapshot_sha256: sha256Hex(snapshot_canonical) };
    expect(parseFleetCompensationSnapshot(value)).toEqual(value);
    const altered = { ...body, previous_agents: [{ ...body.previous_agents[0], metadata: { flag: 1 } }] };
    expect(parseFleetCompensationSnapshot({ ...altered, snapshot_canonical, snapshot_sha256: sha256Hex(snapshot_canonical) })).toBeUndefined();
    expect(canRestoreFleetUpdate({ desired_revision: 1, steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'runtime', status: 'running' }] },
      { ...create(), kind: 'update' }, snapshot.previous_agents, snapshot)).toBe(true);
    expect(canRestoreFleetUpdate({ desired_revision: 1, steps: [{ name: 'prepare', status: 'succeeded' }, { name: 'runtime', status: 'running' }] },
      { ...create(), kind: 'update' }, snapshot.previous_agents)).toBe(false);
  });
  it.each([true, false])('restores after a failed stop following credentials, preserving the original failure: same container %s', async sameContainer => {
    const { repo, value, snapshot, before } = await replacement({ sameContainer, through: 'credentials', cancel: false });
    const original: FleetError = { code: 'STEP_FAILED', step: 'stop', reason: 'runtime_stop_unverified', retryable: true };
    expect((await repo.fail(value, original)).status).toBe('cancelling');
    expect((await pool.query('SELECT cancel_requested FROM fleet_operations WHERE id=$1', [value.operation.id])).rows[0])
      .toEqual({ cancel_requested: false });
    const cleanup = await claim(repo, 'automatic-worker');
    await expect(repo.startStep(cleanup, 'runtime')).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.prepare(cleanup)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.compensate(cleanup, { stopped_verified: true, revocation_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await repo.fail(cleanup, { code: 'HOST_UNAVAILABLE', reason: 'replacement_authority_unverified', retryable: true });
    expect(await repo.claim('too-soon-worker', 'restore-host')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5100));
    const retry = await claim(repo, 'automatic-retry-worker'); const receipt = proof(snapshot);
    const slices = await repo.hostSlices(retry); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await repo.completeHostStep(retry, 'compensate', slice.host_id, slice.target_sha256, receipt);
    const failed = await repo.compensate(retry, receipt);
    expect(failed).toMatchObject({ status: 'failed', error: { ...original, retryable: false } });
    expect(await rows()).toEqual(before);
    const markers = (await pool.query<{ metadata: { rollback_requested: { original_error: FleetError; snapshot_sha256: string } } }>(`SELECT metadata FROM fleet_operation_events
      WHERE operation_id=$1 AND metadata ? 'rollback_requested'`, [value.operation.id])).rows;
    expect(markers).toHaveLength(1);
    expect(markers[0]?.metadata.rollback_requested).toEqual({ original_error: original, snapshot_sha256: snapshot.snapshot_sha256 });
    await expect(repo.resume('Steven', 'restore_operator', failed.id, failed.version, subject)).rejects.toMatchObject({ code: 'conflict' });
    const count = await pool.query("SELECT count(*)::integer AS count FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'host_receipt'", [failed.id]);
    const archived = await repo.cancel('Steven', 'restore_operator', failed.id, failed.version, subject);
    expect(archived.status).toBe('cancelled');
    expect(await pool.query("SELECT count(*)::integer AS count FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'host_receipt'", [failed.id])).toMatchObject({ rows: count.rows });
    expect(await rows()).toEqual(before);
    await expect(repo.enqueue('Steven', 'restore_operator', { ...create(), kind: 'update', expected_revision: archived.desired_revision ?? 0,
      idempotency_key: 'new-update-after-archiving' }, subject)).resolves.toMatchObject({ status: 'queued' });
  });
  it('lets an explicit cancellation override automatic restoration after credentials on the same container', async () => {
    const { repo, value, snapshot, before } = await replacement({ sameContainer: true, through: 'credentials', cancel: false });
    const failed = await repo.fail(value, { code: 'STEP_FAILED', step: 'credentials', retryable: true });
    expect(failed.status).toBe('cancelling');
    await repo.cancel('Steven', 'restore_operator', failed.id, failed.version, subject);
    const cleanup = await claim(repo, 'explicit-cleanup-worker'); const receipt = proof(snapshot);
    const slices = await repo.hostSlices(cleanup); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    await repo.completeHostStep(cleanup, 'compensate', slice.host_id, slice.target_sha256, receipt);
    expect((await repo.compensate(cleanup, receipt)).status).toBe('cancelled');
    expect(await rows()).toEqual(before);
  });
  it('keeps the rollback pending while human control is revoked and never resumes normal steps', async () => {
    const { repo, value, snapshot, before } = await replacement({ sameContainer: true, through: 'credentials', cancel: false });
    const original: FleetError = { code: 'STEP_FAILED', step: 'credentials', retryable: true };
    await repo.fail(value, original);
    const humanId = subject.slice('console:'.length);
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1::uuid", [humanId]);
    expect(await repo.claim('revoked-worker', 'restore-host')).toBeNull();
    const blocked = await repo.get('Steven', 'restore_operator', value.operation.id, subject);
    expect(blocked).toMatchObject({ status: 'cancelling', error: { code: 'AUTHORITY_REVOKED' } });
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read','control'] WHERE human_id=$1::uuid", [humanId]);
    await expect(repo.resume('Steven', 'restore_operator', blocked.id, blocked.version, subject)).rejects.toMatchObject({ code: 'conflict' });
    expect(await repo.claim('no-spin-worker', 'restore-host')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5100));
    const cleanup = await claim(repo, 'authorized-cleanup-worker');
    expect(cleanup.operation.status).toBe('cancelling');
    await expect(repo.startStep(cleanup, 'runtime')).rejects.toMatchObject({ code: 'conflict' });
    const slices = await repo.hostSlices(cleanup); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    const receipt = proof(snapshot); await repo.completeHostStep(cleanup, 'compensate', slice.host_id, slice.target_sha256, receipt);
    expect(await repo.compensate(cleanup, receipt)).toMatchObject({ status: 'failed', error: { ...original, retryable: false } });
    expect(await rows()).toEqual(before);
  });
  it('restores after completed admission when settlement rolls back its own admission writes', async () => {
    const { repo, value, snapshot, before } = await replacement({ sameContainer: true, through: 'admission', cancel: false });
    const prepared = await rows();
    if (!caseDatabase) throw new Error('case database absent');
    await caseDatabase.adminPool.query(`CREATE FUNCTION reject_fixture_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation->>'resource'='fleet_operation' AND NEW.operation->>'action'='settle' THEN
          RAISE EXCEPTION 'fixture_settlement_aborted';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await caseDatabase.adminPool.query(`CREATE TRIGGER reject_fixture_settlement BEFORE INSERT ON config_revisions
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_settlement()`);
    await expect(repo.settle(value)).rejects.toThrow('fixture_settlement_aborted');
    expect(await rows()).toEqual(prepared);
    const original: FleetError = { code: 'STEP_FAILED', step: 'admission', retryable: true };
    expect((await repo.fail(value, original)).status).toBe('cancelling');
    const cleanup = await claim(repo, 'settlement-cleanup-worker');
    const slices = await repo.hostSlices(cleanup); const slice = slices[0]; if (!slice) throw new Error('scope absent');
    const receipt = proof(snapshot); await repo.completeHostStep(cleanup, 'compensate', slice.host_id, slice.target_sha256, receipt);
    expect(await repo.compensate(cleanup, receipt)).toMatchObject({ status: 'failed', error: { ...original, retryable: false } });
    expect(await rows()).toEqual(before);
  });
});
