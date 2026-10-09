import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository } from '../src/index.js';
import { aggregateHostEvidence, type FleetHostSlice, type FleetHostReceipt } from '../src/repository/fleet-operation-hosts.js';
import type { DatabasePool, FleetOperationClaim } from '../src/index.js';
import type { FleetOperation, FleetOperationRequest, FleetOperationPreview, FleetStepName, FleetEvidence, FleetError, FleetTarget } from '@cauce/protocol';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

interface Repository {
  enqueue(tenant: string, alias: string, request: FleetOperationRequest): Promise<FleetOperation>;
  preview(tenant: string, alias: string, request: FleetOperationRequest): Promise<FleetOperationPreview>;
  get(tenant: string, alias: string, id: string): Promise<FleetOperation>;
  cancel(tenant: string, alias: string, id: string, version: number): Promise<FleetOperation>;
  resume(tenant: string, alias: string, id: string, version: number): Promise<FleetOperation>;
  claim(worker: string, host: string, leaseMs?: number): Promise<FleetOperationClaim | null>;
  renew(claim: FleetOperationClaim, leaseMs?: number): Promise<boolean>;
  prepare(claim: FleetOperationClaim): Promise<{ operation: FleetOperation; fenced_targets: unknown[] }>;
  startStep(claim: FleetOperationClaim, name: FleetStepName): Promise<FleetOperation>;
  completeStep(claim: FleetOperationClaim, name: FleetStepName, evidence: FleetEvidence): Promise<FleetOperation>;
  hostSlices(claim: FleetOperationClaim): Promise<FleetHostSlice[]>;
  hostReceipts(claim: FleetOperationClaim, name: FleetStepName): Promise<FleetHostReceipt[]>;
  completeHostStep(claim: FleetOperationClaim, name: FleetStepName, host: string, digest: string, evidence: FleetEvidence): Promise<FleetOperation>;
  fail(claim: FleetOperationClaim, error: FleetError): Promise<FleetOperation>;
  awaitAuth(claim: FleetOperationClaim): Promise<FleetOperation>;
  settle(claim: FleetOperationClaim): Promise<FleetOperation>;
  compensate(claim: FleetOperationClaim, evidence?: FleetEvidence): Promise<FleetOperation>;
  execution(claim: FleetOperationClaim): Promise<{ previous_agents: Record<string, unknown>[] }>;
}
let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
}, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('fleet-test','Steven'),('fleet-other','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','fleet-test','fleet_operator','operator'),('Isa','fleet-other','fleet_reader','agent')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('fleet-test-account','codex','isolated-test-account','Steven','env_path','CAUCE_ISOLATED_TEST_ACCOUNT_PATH',true)`);
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function repository(): Repository {
  return new FleetOperationsRepository(pool);
}
function create(name: string, host = 'test-host'): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: name }, expected_revision: 0,
    idempotency_key: `create-${name}`, parameters: { runtime_key: name.replaceAll('_', '-'), harness_id: 'codex',
      primary_room_id: 'fleet-test', primary_account_id: 'fleet-test-account', memberships: [{ room_id: 'fleet-test', role: 'agent' }],
      placement: { host_id: host, mode: 'container', container_name: `container-${name}`, runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${name}` } } };
}
async function claimFor(repo: Repository, name: string): Promise<FleetOperationClaim> {
  await repo.enqueue('Steven', 'fleet_operator', create(name, `${name.replaceAll('_', '-')}-host`));
  const claim = await repo.claim('execution-worker', `${name.replaceAll('_', '-')}-host`);
  if (!claim) throw new Error('execution claim absent');
  return claim;
}
async function verifyCreation(repo: Repository, claim: FleetOperationClaim): Promise<void> {
  const evidence: [FleetStepName, FleetEvidence][] = [
    ['stop', { stopped_verified: true }],
    ['artifacts', { artifact_sha256: 'a'.repeat(64) }],
    ['credentials', { certificate_fingerprint: 'b'.repeat(64) }],
    ['runtime', { runtime_digest: 'c'.repeat(64) }],
    ['authenticate', { provider_verified: true }],
    ['profile', { profile_verified: true }],
    ['verify', { bootstrap_verified: true, roundtrip_verified: true }],
    ['admission', { authority_verified: true, artifact_sha256: 'd'.repeat(64) }],
  ];
  for (const [name, proof] of evidence) {
    if (!claim.operation.steps.some((step) => step.name === name)) continue;
    await repo.startStep(claim, name); await completeProof(repo, claim, name, proof);
  }
}
async function transition(repo: Repository, kind: 'start' | 'stop' | 'retire' | 'restore' | 'purge', target: FleetTarget, revision: number, host: string): Promise<FleetOperationClaim> {
  const base = { expected_revision: revision, idempotency_key: `${kind}-${String(revision)}-operation`, parameters: {} };
  let request: FleetOperationRequest;
  if (kind === 'start' || kind === 'stop') {
    if (target.resource !== 'agent') throw new Error('runtime fixture requires an agent');
    request = { ...base, kind, target };
  } else request = { ...base, kind, target };
  await repo.enqueue('Steven', 'fleet_operator', request);
  const claim = await repo.claim('transition-worker', host); if (!claim) throw new Error('transition claim absent');
  return claim;
}
async function finishRemoval(repo: Repository, claim: FleetOperationClaim): Promise<void> {
  for (const [name, evidence] of [['stop', { stopped_verified: true }], ['revoke', { revocation_verified: true }],
    ['purge', { stopped_verified: true, revocation_verified: true }], ['artifacts', { artifact_sha256: 'e'.repeat(64) }]] as [FleetStepName, FleetEvidence][]) {
    if (!claim.operation.steps.some((step) => step.name === name)) continue;
    await repo.startStep(claim, name); await completeProof(repo, claim, name, evidence);
  }
  await repo.settle(claim);
}
async function completeProof(repo: Repository, claim: FleetOperationClaim, name: FleetStepName, proof: FleetEvidence): Promise<void> {
  if (claim.request.target.resource === 'agent') { await repo.completeStep(claim, name, proof); return; }
  for (const slice of await repo.hostSlices(claim)) {
    await repo.completeHostStep(claim, name, slice.host_id, slice.target_sha256, proof);
  }
  await repo.completeStep(claim, name, aggregateHostEvidence(name, await repo.hostReceipts(claim, name)));
}
describe('durable fleet operations', () => {
  it('deduplicates identical retries and rejects changed payload under the same key', async () => {
    const repo = repository(); const input = create('fleet_one');
    const first = await repo.enqueue('Steven', 'fleet_operator', input);
    const second = await repo.enqueue('Steven', 'fleet_operator', input);
    expect(second.id).toBe(first.id);
    expect(first.status).toBe('queued');
    await expect(repo.enqueue('Steven', 'fleet_operator', { ...input, expected_revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM fleet_operation_events WHERE operation_id=$1', [first.id])).rows[0]?.n).toBe(1);
  });
  it('allows only one concurrent operation for an identity', async () => {
    const repo = repository(); const input = create('fleet_two');
    const results = await Promise.allSettled([repo.enqueue('Steven', 'fleet_operator', input),
      repo.enqueue('Steven', 'fleet_operator', { ...input, idempotency_key: 'other-fleet-two' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('adopts a console registry draft on create but refuses an agent that already has a runtime', async () => {
    const repo = repository();
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state) VALUES('Steven','drafted','codex','Borrador',false,'draft')`);
    const draftClaim = await claimFor(repo, 'drafted');
    const prepared = await repo.prepare(draftClaim);
    expect(prepared.operation.desired_revision).toBe(1);
    const slices = await repo.hostSlices(draftClaim);
    expect(slices.flatMap(slice => slice.targets.map(target => target.alias))).toEqual(['drafted']);
    expect((await pool.query('SELECT enabled,lifecycle_state,runtime_key FROM agents WHERE alias=$1', ['drafted'])).rows)
      .toEqual([{ enabled: false, lifecycle_state: 'provisioning', runtime_key: 'drafted' }]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,lifecycle_state,runtime_key) VALUES('Steven','installed','codex',false,'draft','installed')`);
    await expect(repo.enqueue('Steven', 'fleet_operator', { ...create('installed', 'installed-host'), expected_revision: 1 }))
      .rejects.toThrow(/already exists/u);
  });
  it('still rejects a sealed create scope whose previous agent already has a runtime', async () => {
    const repo = repository();
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state) VALUES('Steven','forged','codex','Borrador',false,'draft')`);
    const claim = await claimFor(repo, 'forged'); await repo.prepare(claim);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(`UPDATE fleet_operation_events SET metadata=jsonb_set(metadata,'{previous_agents,0,runtime_key}','"forged"')
        WHERE operation_id=$1 AND event='step_completed' AND metadata->>'step' IN ('prepare','fence')`, [claim.operation.id]);
      await client.query('COMMIT');
    } finally { client.release(); }
    await expect(repo.hostSlices(claim)).rejects.toThrow(/exact complete durable placement|exact durable fence|digest/u);
  });

  it('rejects stale desired revision and unauthorized control before any enqueue', async () => {
    const repo = repository();
    await expect(repo.enqueue('Steven', 'fleet_operator', { ...create('stale'), expected_revision: 999 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.enqueue('Isa', 'fleet_reader', create('denied'))).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('previews without writes and never reveals claim material in public receipts', async () => {
    const repo = repository(); const input = create('preview');
    const preview = await repo.preview('Steven', 'fleet_operator', input);
    expect(preview.can_apply).toBe(true); expect(preview.steps).toContain('authenticate');
    expect((await pool.query('SELECT 1 FROM fleet_operations WHERE request->>\'idempotency_key\'=$1', [input.idempotency_key])).rowCount).toBe(0);
    const operation = await repo.enqueue('Steven', 'fleet_operator', create('receipt'));
    const publicReceipt = await repo.get('Steven', 'fleet_operator', operation.id);
    expect(publicReceipt).not.toHaveProperty('request'); expect(publicReceipt).not.toHaveProperty('claim_token');
  });
  it('cancels queued work with CAS and fences an expired worker', async () => {
    const repo = repository(); const queued = await repo.enqueue('Steven', 'fleet_operator', create('cancelled', 'cancel-host'));
    await expect(repo.cancel('Steven', 'fleet_operator', queued.id, 99)).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.cancel('Steven', 'fleet_operator', queued.id, queued.version)).status).toBe('cancelled');
    await repo.enqueue('Steven', 'fleet_operator', create('fenced', 'fence-host'));
    const old = await repo.claim('worker-one', 'fence-host'); expect(old).not.toBeNull();
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old?.operation.id]);
    const next = await repo.claim('worker-two', 'fence-host'); expect(next?.epoch).toBe((old?.epoch ?? 0) + 1);
    if (!old || !next) throw new Error('claim absent');
    expect(await repo.renew(old)).toBe(false); expect(await repo.renew(next)).toBe(true);
  });
  it('serializes a shared runtime cohort and reauthorizes at claim', async () => {
    const repo = repository(); const first = create('cohort_one', 'cohort-host'); const second = create('cohort_two', 'cohort-host');
    if (first.kind !== 'create' || second.kind !== 'create') throw new Error('invalid fixture');
    second.parameters.placement.container_name = first.parameters.placement.container_name;
    await repo.enqueue('Steven', 'fleet_operator', first); await repo.enqueue('Steven', 'fleet_operator', second);
    expect(await repo.claim('cohort-worker', 'cohort-host')).not.toBeNull();
    expect(await repo.claim('other-worker', 'cohort-host')).toBeNull();
    await repo.enqueue('Steven', 'fleet_operator', create('revoked', 'revoked-host'));
    await pool.query("UPDATE memberships SET enabled=false WHERE alias='fleet_operator'");
    expect(await repo.claim('revoked-worker', 'revoked-host')).toBeNull();
    await pool.query("UPDATE memberships SET enabled=true WHERE alias='fleet_operator'");
  });
  it('prepares disabled desired state and memberships atomically and preserves the revision on retry', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'prepared');
    const first = await repo.prepare(claim); const repeated = await repo.prepare(claim);
    expect(first.operation.desired_revision).toBe(1); expect(repeated.operation.desired_revision).toBe(1);
    expect((await pool.query('SELECT enabled,lifecycle_state,runtime_key,primary_room_id FROM agents WHERE alias=$1', ['prepared'])).rows)
      .toEqual([{ enabled: false, lifecycle_state: 'provisioning', runtime_key: 'prepared', primary_room_id: 'fleet-test' }]);
    expect((await pool.query('SELECT enabled,role FROM memberships WHERE alias=$1', ['prepared'])).rows)
      .toEqual([{ enabled: false, role: 'agent' }]);
    expect((await pool.query('SELECT purpose,revision,applied_revision FROM agent_profiles WHERE alias=$1', ['prepared'])).rows)
      .toEqual([{ purpose: 'Agente prepared', revision: '1', applied_revision: null }]);
    expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(1);
  });
  it('rejects prepare under a changed revision without creating partial desired state', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'changed');
    await pool.query("INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary) VALUES('Steven','fleet_operator','{}','{}','other change')");
    await expect(repo.prepare(claim)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM agents WHERE alias='changed'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM memberships WHERE alias='changed'")).rowCount).toBe(0);
  });
  it('never admits an installed agent without complete authentication profile hello and reply evidence', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'verified'); await repo.prepare(claim);
    await expect(repo.settle(claim)).rejects.toMatchObject({ code: 'conflict' });
    await repo.startStep(claim, 'artifacts');
    await expect(repo.completeStep(claim, 'artifacts', {})).rejects.toMatchObject({ code: 'invalid_input' });
    await verifyCreation(repo, claim);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='verified'")).rows[0]?.enabled).toBe(false);
    const done = await repo.settle(claim);
    expect(done.status).toBe('succeeded'); expect(done.applied_revision).toBe(2);
    expect((await pool.query("SELECT enabled,lifecycle_state FROM agents WHERE alias='verified'")).rows[0])
      .toEqual({ enabled: true, lifecycle_state: 'ready' });
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM memberships WHERE alias='verified'")).rows[0]?.enabled).toBe(true);
  });
  it('fences stale and cancelled workers before recording a physical step', async () => {
    const repo = repository(); const old = await claimFor(repo, 'step_fence'); await repo.prepare(old);
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old.operation.id]);
    const next = await repo.claim('replacement', 'step-fence-host'); if (!next) throw new Error('claim absent');
    await expect(repo.startStep(old, 'artifacts')).rejects.toMatchObject({ code: 'conflict' });
    const current = await repo.get('Steven', 'fleet_operator', old.operation.id);
    await repo.cancel('Steven', 'fleet_operator', current.id, current.version);
    await expect(repo.startStep(next, 'artifacts')).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.compensate(next)).status).toBe('cancelled');
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='step_fence'")).rows[0]?.enabled).toBe(false);
  });
  it('reauthorizes every executor write after operator control is revoked', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'no_authority'); await repo.prepare(claim);
    await pool.query("UPDATE memberships SET enabled=false WHERE alias='fleet_operator'");
    await expect(repo.startStep(claim, 'artifacts')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repo.fail(claim, { code: 'HOST_UNAVAILABLE', retryable: true })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('resumes its own prepared create after authentication wait without duplicating identity or steps', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'auth_wait'); await repo.prepare(claim);
    for (const [name, proof] of [['artifacts', { artifact_sha256: 'a'.repeat(64) }],
      ['credentials', { certificate_fingerprint: 'b'.repeat(64) }], ['runtime', { runtime_digest: 'c'.repeat(64) }]] as [FleetStepName, FleetEvidence][]) {
      await repo.startStep(claim, name); await repo.completeStep(claim, name, proof);
    }
    await repo.startStep(claim, 'authenticate'); const waiting = await repo.awaitAuth(claim);
    expect(waiting.status).toBe('awaiting_auth');
    await repo.resume('Steven', 'fleet_operator', waiting.id, waiting.version);
    const next = await repo.claim('auth-worker', 'auth-wait-host'); if (!next) throw new Error('claim absent');
    expect((await repo.prepare(next)).operation.desired_revision).toBe(1);
    expect((await pool.query("SELECT 1 FROM agents WHERE alias='auth_wait'")).rowCount).toBe(1);
    await repo.startStep(next, 'authenticate'); await repo.completeStep(next, 'authenticate', { provider_verified: true });
  });
  it('releases an expired cohort so another host can claim independent queued work', async () => {
    const repo = repository(); const old = await claimFor(repo, 'expired_cohort');
    await repo.enqueue('Steven', 'fleet_operator', create('second_cohort', 'second-host'));
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old.operation.id]);
    expect(await repo.claim('second-worker', 'second-host')).not.toBeNull();
    expect(await repo.renew(old)).toBe(false);
  });
  it('requires a separately verified admission generation before committing ready', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'admission'); await repo.prepare(claim);
    await verifyCreation(repo, claim);
    await expect(repo.completeStep(claim, 'admission', { authority_verified: true })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='admission'")).rows[0]?.enabled).toBe(false);
    expect((await repo.settle(claim)).status).toBe('succeeded');
  });
  it('updates desired placement while preserving source runtime facts and disabled membership intent', async () => {
    const repo = repository(); const initial = await claimFor(repo, 'updated'); await repo.prepare(initial); await verifyCreation(repo, initial);
    await repo.settle(initial);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('optional-room','Steven')");
    const input = create('updated', 'updated-host'); if (input.kind !== 'create') throw new Error('fixture absent');
    const update: FleetOperationRequest = { ...input, kind: 'update', expected_revision: 2, idempotency_key: 'update-placement',
      parameters: { ...input.parameters, placement: { ...input.parameters.placement, container_name: 'new-updated-container', state_directory: '/home/dev/new-updated-state' },
        memberships: [{ room_id: 'fleet-test', role: 'agent' }, { room_id: 'optional-room', role: 'agent', enabled: false }] } };
    await expect(repo.enqueue('Steven', 'fleet_operator', { ...update, parameters: { ...update.parameters,
      placement: { ...update.parameters.placement, host_id: 'new-host' } } })).rejects.toMatchObject({ code: 'conflict' });
    await repo.enqueue('Steven', 'fleet_operator', update);
    const claim = await repo.claim('update-worker', 'updated-host'); if (!claim) throw new Error('claim absent');
    await repo.prepare(claim);
    await expect(repo.startStep(claim, 'artifacts')).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.execution(claim)).previous_agents[0]).toMatchObject({ host_id: 'updated-host', container_name: 'container-updated' });
    expect((await pool.query("SELECT enabled,host_id,container_name FROM agents WHERE alias='updated'")).rows[0])
      .toEqual({ enabled: false, host_id: 'updated-host', container_name: 'new-updated-container' });
    await verifyCreation(repo, claim); await repo.settle(claim);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM memberships WHERE alias='updated' AND room_id='optional-room'")).rows[0]?.enabled).toBe(false);
  });
  it('retires an agent with durable lease and ticket fencing while preserving history', async () => {
    const repo = repository(); const initial = await claimFor(repo, 'retired'); await repo.prepare(initial); await verifyCreation(repo, initial);
    await repo.settle(initial);
    await pool.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
      VALUES('Steven','retired','retired-instance',5,clock_timestamp()+interval '1 hour')`);
    await pool.query(`INSERT INTO terminal_sessions(id,operator_id,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,expires_at,relay_instance_id,
      request_id,request_sha256,browser_owner_sha256,browser_owner_generation)
      VALUES(gen_random_uuid(),'operator','Steven:fleet_operator','Steven','retired','container-retired','harness',decode(repeat('aa',32),'hex'),'test',
        clock_timestamp()+interval '1 hour',repeat('a',64),gen_random_uuid(),decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),1)`);
    const input: FleetOperationRequest = { kind: 'retire', target: { resource: 'agent', tenant_id: 'Steven', alias: 'retired' },
      expected_revision: 2, idempotency_key: 'retire-with-lease', parameters: {} };
    await repo.enqueue('Steven', 'fleet_operator', input); const claim = await repo.claim('retirement', 'retired-host');
    if (!claim) throw new Error('claim absent'); const prepared = await repo.prepare(claim);
    expect(prepared.fenced_targets).toEqual([{ resource: 'agent', tenant_id: 'Steven', alias: 'retired' }]);
    expect((await pool.query("SELECT epoch,(lease_until<=clock_timestamp()) AS expired FROM connection_leases WHERE alias='retired'")).rows[0])
      .toEqual({ epoch: '6', expired: true });
    expect((await pool.query("SELECT (revoked_at IS NOT NULL) AS revoked,(closed_at IS NULL) AS not_closed FROM terminal_sessions WHERE alias='retired'")).rows[0])
      .toEqual({ revoked: true, not_closed: true });
    for (const [name, proof] of [['stop', { stopped_verified: true }], ['revoke', { revocation_verified: true }],
      ['artifacts', { artifact_sha256: 'e'.repeat(64) }]] as [FleetStepName, FleetEvidence][]) {
      await repo.startStep(claim, name); await repo.completeStep(claim, name, proof);
    }
    expect((await repo.settle(claim)).status).toBe('succeeded');
    expect((await pool.query("SELECT enabled,lifecycle_state,(retired_at IS NOT NULL) AS retired FROM agents WHERE alias='retired'")).rows[0])
      .toEqual({ enabled: false, lifecycle_state: 'retired', retired: true });
    expect((await pool.query("SELECT 1 FROM connection_leases WHERE alias='retired'")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM terminal_sessions WHERE alias='retired'")).rowCount).toBe(1);
  });
  it('cannot cancel an attempted runtime by merely disabling desired state', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'dirty'); await repo.prepare(claim);
    for (const [name, proof] of [['artifacts', { artifact_sha256: 'a'.repeat(64) }], ['credentials', { certificate_fingerprint: 'b'.repeat(64) }]] as [FleetStepName, FleetEvidence][]) {
      await repo.startStep(claim, name); await repo.completeStep(claim, name, proof);
    }
    await repo.startStep(claim, 'runtime'); const current = await repo.get('Steven', 'fleet_operator', claim.operation.id);
    await repo.cancel('Steven', 'fleet_operator', current.id, current.version);
    await expect(repo.compensate(claim)).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.get('Steven', 'fleet_operator', current.id)).status).toBe('cancelling');
    expect((await repo.compensate(claim, { stopped_verified: true, revocation_verified: true })).status).toBe('cancelled');
  });
  it('stops and restarts an agent without losing membership intent or accepting install-only readiness', async () => {
    const repo = repository(); const initial = await claimFor(repo, 'restart'); await repo.prepare(initial); await verifyCreation(repo, initial); await repo.settle(initial);
    const target = { resource: 'agent', tenant_id: 'Steven', alias: 'restart' } as const;
    const stop = await transition(repo, 'stop', target, 2, 'restart-host'); await repo.prepare(stop); await finishRemoval(repo, stop);
    expect((await pool.query("SELECT enabled,lifecycle_state FROM agents WHERE alias='restart'")).rows[0]).toEqual({ enabled: false, lifecycle_state: 'draft' });
    const start = await transition(repo, 'start', target, 4, 'restart-host'); await repo.prepare(start);
    await expect(repo.settle(start)).rejects.toMatchObject({ code: 'conflict' });
    await verifyCreation(repo, start); await repo.settle(start);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='restart'")).rows[0]?.enabled).toBe(true);
  });
  it('restores retired agent memberships only after a fresh verification sequence', async () => {
    const repo = repository(); const initial = await claimFor(repo, 'restore'); await repo.prepare(initial); await verifyCreation(repo, initial); await repo.settle(initial);
    const target = { resource: 'agent', tenant_id: 'Steven', alias: 'restore' } as const;
    const retire = await transition(repo, 'retire', target, 2, 'restore-host'); await repo.prepare(retire); await finishRemoval(repo, retire);
    const restore = await transition(repo, 'restore', target, 4, 'restore-host'); await repo.prepare(restore);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='restore'")).rows[0]?.enabled).toBe(false);
    await verifyCreation(repo, restore); await repo.settle(restore);
    expect((await pool.query("SELECT enabled,(retired_at IS NULL) AS active FROM memberships WHERE alias='restore'")).rows[0])
      .toEqual({ enabled: true, active: true });
  });
  it('restores a room declaratively while leaving its affected agents disabled', async () => {
    const repo = new FleetOperationsRepository(pool, { controllerHost: 'group-host' }) as Repository;
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('lifecycle-room','Steven')");
    const input = create('room_member', 'group-host'); if (input.kind !== 'create') throw new Error('fixture absent');
    input.parameters.primary_room_id = 'lifecycle-room'; input.parameters.memberships = [{ room_id: 'lifecycle-room', role: 'agent' }];
    await repo.enqueue('Steven', 'fleet_operator', input); const initial = await repo.claim('group-worker', 'group-host'); if (!initial) throw new Error('claim absent');
    await repo.prepare(initial); await verifyCreation(repo, initial); await repo.settle(initial);
    const target = { resource: 'room', tenant_id: 'Steven', room_id: 'lifecycle-room' } as const;
    const retire = await transition(repo, 'retire', target, 2, 'group-host'); await repo.prepare(retire);
    expect((await pool.query<{ lifecycle_state: string }>("SELECT lifecycle_state FROM agents WHERE alias='room_member'")).rows[0]?.lifecycle_state).toBe('retiring');
    await finishRemoval(repo, retire);
    expect((await pool.query<{ lifecycle_state: string }>("SELECT lifecycle_state FROM agents WHERE alias='room_member'")).rows[0]?.lifecycle_state).toBe('draft');
    const restore = await transition(repo, 'restore', target, 4, 'group-host'); await repo.prepare(restore); await verifyCreation(repo, restore); await repo.settle(restore);
    expect((await pool.query("SELECT enabled,(retired_at IS NULL) AS active FROM rooms WHERE id='lifecycle-room'")).rows[0]).toEqual({ enabled: true, active: true });
    expect((await pool.query("SELECT enabled,lifecycle_state FROM agents WHERE alias='room_member'")).rows[0]).toEqual({ enabled: false, lifecycle_state: 'draft' });
  });
  it('purges an unused room and preserves message anchors when purging a used room', async () => {
    const repo = new FleetOperationsRepository(pool, { controllerHost: 'purge-host' }) as Repository;
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('unused-room','Steven')");
    const purge = await transition(repo, 'purge', { resource: 'room', tenant_id: 'Steven', room_id: 'unused-room' }, 0, 'purge-host');
    await repo.prepare(purge); await finishRemoval(repo, purge);
    expect((await pool.query("SELECT 1 FROM rooms WHERE id='unused-room'")).rowCount).toBe(0);
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('purge-control','Steven')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','purge-control','fleet_operator','operator')");
    await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user,harness_id)
      VALUES('Steven','fleet_operator','fleet-operator','purge-host','container','fleet-operator','dev','/home/dev','/home/dev/fleet-operator','stev','codex')`);
    const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES(gen_random_uuid(),'purge-used-room','Steven','fleet-test','fleet_operator','{}','interactive') RETURNING id`)).rows[0];
    const used = await transition(repo, 'purge', { resource: 'room', tenant_id: 'Steven', room_id: 'fleet-test' }, 2, 'purge-host');
    await repo.prepare(used); await finishRemoval(repo, used);
    expect((await pool.query("SELECT enabled,purged_at IS NOT NULL AS purged FROM rooms WHERE id='fleet-test'")).rows[0])
      .toEqual({ enabled: false, purged: true });
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [message?.id])).rowCount).toBe(1);
    expect((await pool.query("SELECT enabled FROM memberships WHERE room_id='fleet-test' AND alias='fleet_operator'")).rows[0])
      .toEqual({ enabled: false });
  });
  it('fails a prepared operation safely and resumes without repeating completed evidence', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'resume_failed'); await repo.prepare(claim);
    await repo.startStep(claim, 'artifacts'); await repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    const failed = await repo.fail(claim, { code: 'HOST_UNAVAILABLE', step: 'runtime', retryable: true });
    expect(failed.status).toBe('failed'); await repo.resume('Steven', 'fleet_operator', failed.id, failed.version);
    const next = await repo.claim('resuming-worker', 'resume-failed-host'); if (!next) throw new Error('claim absent');
    await repo.prepare(next); const before = (await repo.get('Steven', 'fleet_operator', next.operation.id)).version;
    await repo.completeStep(next, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    expect((await repo.get('Steven', 'fleet_operator', next.operation.id)).version).toBe(before);
    await expect(repo.completeStep(next, 'artifacts', { artifact_sha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects an intervening configuration change before admission and keeps desired routing disabled', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'revision_race'); await repo.prepare(claim); await verifyCreation(repo, claim);
    await pool.query("INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary) VALUES('Steven','fleet_operator','{}','{}','new operator change')");
    await expect(repo.settle(claim)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='revision_race'")).rows[0]?.enabled).toBe(false);
  });
  it('preserves a permanent physical identity tombstone when purging an otherwise empty agent', async () => {
    const repo = new FleetOperationsRepository(pool, { controllerHost: 'empty-host' }) as Repository;
    await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user,harness_id)
      VALUES('Steven','empty_agent','permanent-key','empty-host','container','empty-agent','dev','/home/dev','/home/dev/empty-agent','stev','codex')`);
    const purge = await transition(repo, 'purge', { resource: 'agent', tenant_id: 'Steven', alias: 'empty_agent' }, 0, 'empty-host');
    await repo.prepare(purge); await finishRemoval(repo, purge);
    expect((await pool.query("SELECT enabled,purged_at IS NOT NULL AS purged FROM agents WHERE alias='empty_agent'")).rows[0])
      .toEqual({ enabled: false, purged: true });
    expect((await pool.query("SELECT 1 FROM fleet_runtime_identities WHERE alias='empty_agent' AND runtime_key='permanent-key'")).rowCount).toBe(1);
    await expect(repo.enqueue('Steven', 'fleet_operator', { ...create('empty_agent', 'empty-host'), expected_revision: 2 })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('restores a tenant without restoring a room that had already been retired independently', async () => {
    const repo = new FleetOperationsRepository(pool, { controllerHost: 'tenant-host' }) as Repository;
    await pool.query("INSERT INTO tenants(id) VALUES('FleetTenant')");
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('tenant-active-room','FleetTenant'),('tenant-old-room','FleetTenant')");
    await pool.query("UPDATE rooms SET retired_at=clock_timestamp()-interval '1 day',retired_enabled=true,enabled=false WHERE id='tenant-old-room'");
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,container_name,runtime_user,home_directory,state_directory,lifecycle_state,enabled,retired_at) VALUES
      ('FleetTenant','tenant_active_agent','codex','tenant-active','dev','/home/dev','/home/dev/tenant-active','ready',true,NULL),
      ('FleetTenant','tenant_old_agent','codex','tenant-old','dev','/home/dev','/home/dev/tenant-old','retired',false,clock_timestamp()-interval '1 day')`);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
      ('FleetTenant','tenant-active-room','tenant_active_agent','agent'),('FleetTenant','tenant-old-room','tenant_old_agent','agent')`);
    await pool.query("UPDATE agents SET runtime_key=replace(alias,'_','-'),host_id='tenant-host',runtime_mode='container',systemd_user='stev' WHERE tenant_id='FleetTenant'");
    const target = { resource: 'tenant', tenant_id: 'FleetTenant' } as const;
    const retire = await transition(repo, 'retire', target, 0, 'tenant-host'); await repo.prepare(retire);
    expect((await pool.query<{ lifecycle_state: string }>("SELECT lifecycle_state FROM agents WHERE alias='tenant_active_agent'")).rows[0]?.lifecycle_state).toBe('retiring');
    await finishRemoval(repo, retire);
    const restore = await transition(repo, 'restore', target, 2, 'tenant-host'); await repo.prepare(restore); await verifyCreation(repo, restore); await repo.settle(restore);
    expect((await pool.query("SELECT id,enabled,(retired_at IS NULL) AS active FROM rooms WHERE tenant_id='FleetTenant' ORDER BY id")).rows)
      .toEqual([{ id: 'tenant-active-room', enabled: true, active: true }, { id: 'tenant-old-room', enabled: false, active: false }]);
    expect((await pool.query("SELECT alias,enabled,lifecycle_state,(retired_at IS NULL) AS active FROM agents WHERE tenant_id='FleetTenant' ORDER BY alias")).rows)
      .toEqual([{ alias: 'tenant_active_agent', enabled: false, lifecycle_state: 'draft', active: true },
        { alias: 'tenant_old_agent', enabled: false, lifecycle_state: 'retired', active: false }]);
  });
  it('recovers a crash after every successful physical step without duplicating a completion', async () => {
    const repo = repository(); let claim = await claimFor(repo, 'crash_steps'); await repo.prepare(claim);
    const proofs: [FleetStepName, FleetEvidence][] = [['artifacts', { artifact_sha256: 'a'.repeat(64) }],
      ['credentials', { certificate_fingerprint: 'b'.repeat(64) }], ['runtime', { runtime_digest: 'c'.repeat(64) }],
      ['authenticate', { provider_verified: true }], ['profile', { profile_verified: true }],
      ['verify', { bootstrap_verified: true, roundtrip_verified: true }], ['admission', { authority_verified: true, artifact_sha256: 'd'.repeat(64) }]];
    for (const [name, evidence] of proofs) {
      await repo.startStep(claim, name); await repo.completeStep(claim, name, evidence);
      await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.operation.id]);
      const next = await repo.claim('crash-recovery', 'crash-steps-host'); if (!next) throw new Error('recovery absent');
      claim = next; expect((await repo.prepare(claim)).operation.desired_revision).toBe(1);
      await repo.completeStep(claim, name, evidence);
    }
    expect((await repo.settle(claim)).status).toBe('succeeded');
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM fleet_operation_events WHERE operation_id=$1 AND event='step_completed'", [claim.operation.id])).rows[0]?.n).toBe(8);
  });
  it('allows safe cancellation after an unrelated revision change without restoring stale desired state', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'cancel_revision'); await repo.prepare(claim);
    await pool.query("INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary) VALUES('Steven','fleet_operator','{}','{}','other change')");
    const current = await repo.get('Steven', 'fleet_operator', claim.operation.id); await repo.cancel('Steven', 'fleet_operator', current.id, current.version);
    expect((await repo.compensate(claim)).status).toBe('cancelled');
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='cancel_revision'")).rows[0]?.enabled).toBe(false);
  });
  it('rejects an activation intent whose primary membership is explicitly disabled', async () => {
    const repo = repository(); const input = create('bad_primary'); if (input.kind !== 'create') throw new Error('fixture absent');
    input.parameters.memberships[0] = { room_id: 'fleet-test', role: 'agent', enabled: false };
    await expect(repo.enqueue('Steven', 'fleet_operator', input)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rechecks payer consent at admission instead of trusting previously completed provider evidence', async () => {
    const repo = repository(); const claim = await claimFor(repo, 'revoked_account'); await repo.prepare(claim); await verifyCreation(repo, claim);
    await pool.query("UPDATE provider_accounts SET enabled=false WHERE id='fleet-test-account'");
    await expect(repo.settle(claim)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='revoked_account'")).rows[0]?.enabled).toBe(false);
  });
});
