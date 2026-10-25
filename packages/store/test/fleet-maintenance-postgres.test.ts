import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationRequestSchema, sha256Hex, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import { CauceRepository, enqueueHostMaintenance, FleetOperationsRepository, HostEnrollmentRepository, hostEnrollmentMessage, lockCompanyAuthority,
  withTransaction, type DatabaseClient, type DatabasePool, type FleetOperationClaim, type HostMaintenanceIdentity } from '../src/index.js';
import { insertDelivery } from '../src/repository/messages/_insert.js';
import { agentContextReconcileLockKey } from '../src/repository/agent-context-lock.js';
import { fleetSteps } from '../src/repository/fleet-operation-authority.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedFleetHuman } from './fleet-human-postgres.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let identity: HostMaintenanceIdentity;
let subject: string;
let repository: FleetOperationsRepository;
const RELEASE = 'b'.repeat(64);
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('maintenance-room','Steven')");
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','maintenance_operator')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','maintenance-room','maintenance_operator','operator')");
  subject = await seedFleetHuman(admin, 'Steven', 'maintenance_operator');
  const company = (await pool.query<{ company_id: string }>("SELECT company_id FROM tenants WHERE id='Steven'")).rows[0];
  if (!company) throw new Error('test company absent');
  const enrollment = new HostEnrollmentRepository(pool);
  await pool.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('maintenance-host',$1,'Maintenance host')", [company.company_id]);
  const invitation = await enrollment.invite(client => lockCompanyAuthority(client,
    { tenant: 'Steven', alias: 'maintenance_operator', humanId: subject.slice('console:'.length) }),
  { host_id: 'maintenance-host', display_name: 'Maintenance host' });
  const keys = generateKeyPairSync('ed25519');
  const receipt = await enrollment.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token,
    public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64') });
  identity = { host_id: receipt.host_id, company_id: receipt.company_id,
    enrollment_id: receipt.enrollment_id, key_fingerprint: receipt.key_fingerprint };
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('maintenance-account','codex','isolated-maintenance-account','Steven','env_path','CAUCE_MAINTENANCE_TEST_PROFILE_PATH',true)`);
  await withTransaction(pool, async client => {
    await client.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,lifecycle_state,runtime_key,primary_room_id,host_id,runtime_mode,
    container_name,runtime_user,home_directory,state_directory,systemd_user,primary_account_id,model_id,reasoning_effort)
    VALUES('Steven','maintenance_agent','codex',true,'ready','maintenance-agent',NULL,'maintenance-host','container',
      'cauce-maintenance-agent','dev','/home/dev','/home/dev/.cauce/maintenance-agent','stev','maintenance-account','gpt-5','high')`);
    await client.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
    VALUES('Steven','maintenance-room','maintenance_agent','agent',true)`);
    await client.query("UPDATE agents SET primary_room_id='maintenance-room' WHERE tenant_id='Steven' AND alias='maintenance_agent'");
  });
  repository = new FleetOperationsRepository(pool, { controllerHost: identity.host_id });
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const enqueue = () => withTransaction(pool, client => enqueueHostMaintenance(client, identity, RELEASE));
function ownerRequest(kind: 'stop' | 'retire', revision: number, target: FleetTarget = {
  resource: 'agent', tenant_id: 'Steven', alias: 'maintenance_agent',
}): FleetOperationRequest {
  if (kind === 'stop' && target.resource !== 'agent') throw new Error('stop requires an agent');
  return { kind, target, expected_revision: revision, idempotency_key: randomUUID(), parameters: {} } as FleetOperationRequest;
}
const ownerEnqueue = (request: FleetOperationRequest) => repository.enqueue('Steven', 'maintenance_operator', request, subject);
async function legacyMaintenance(): Promise<string> {
  await pool.query("UPDATE agents SET model_id=NULL WHERE alias='maintenance_agent'");
  const target = { resource: 'agent' as const, tenant_id: 'Steven', alias: 'maintenance_agent' };
  const request = FleetOperationRequestSchema.parse({ kind: 'update', target, expected_revision: 0, idempotency_key: 'legacy-maintenance-null',
    parameters: { runtime_key: 'maintenance-agent', harness_id: 'codex', display_name: null, primary_room_id: 'maintenance-room',
      memberships: [{ room_id: 'maintenance-room', role: 'agent', enabled: true }], primary_account_id: 'maintenance-account',
      model_id: null, reasoning_effort: 'high', extensions: [], placement: { host_id: identity.host_id, mode: 'container',
        container_name: 'cauce-maintenance-agent', runtime_user: 'dev', home_directory: '/home/dev',
        state_directory: '/home/dev/.cauce/maintenance-agent', systemd_user: 'stev' } } });
  return withTransaction(pool, async client => {
    const row = (await client.query<{ id: string }>(`INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,
      executor_host,kind,request,request_hash,idempotency_key,expected_revision,steps,company_id)
      VALUES('Steven','maintenance_agent',$1::jsonb,$2,$3,$4,'update',$5::jsonb,$6,$7,0,$8::jsonb,$9) RETURNING id`,
    [JSON.stringify(target), sha256Hex(target), `fleet:${identity.company_id}:${identity.host_id}`, identity.host_id,
      JSON.stringify(request), sha256Hex(request), request.idempotency_key,
      JSON.stringify(fleetSteps(request).map(name => ({ name, status: 'pending' }))), identity.company_id])).rows[0];
    if (!row) throw new Error('legacy fixture absent');
    await client.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)",
      [row.id, JSON.stringify({ acting_company: identity.company_id, actor_subject: `host:${identity.host_id}:${identity.key_fingerprint}`,
        maintenance: { host_id: identity.host_id, enrollment_id: identity.enrollment_id, key_fingerprint: identity.key_fingerprint,
          release_sha256: RELEASE, parameters_sha256: sha256Hex(request.parameters) } })]);
    return row.id;
  });
}
async function claim(): Promise<FleetOperationClaim> {
  const result = await repository.claim('maintenance-worker', identity.host_id);
  if (!result) throw new Error('maintenance claim absent');
  return result;
}
const agent = async () => (await pool.query<{ enabled: boolean; lifecycle_state: string; primary_account_id: string; model_id: string }>(
  "SELECT enabled,lifecycle_state,primary_account_id,model_id FROM agents WHERE tenant_id='Steven' AND alias='maintenance_agent'")).rows[0];
const foreignRevision = () => pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
  VALUES('Steven','maintenance_operator','{}','{}','unrelated configuration change')`);
const publication = () => ({ version: '3.0' as const, request_id: randomUUID(), trace_id: randomUUID(),
  tenant_id: 'Steven', room_id: 'maintenance-room', actor_alias: 'maintenance_operator',
  recipients: [{ tenant_id: 'Steven', alias: 'maintenance_agent' }], body: { text: 'Owned maintenance race' },
  idempotency_key: randomUUID(), lane: 'interactive' as const, priority: 1 });
async function blockedBy(pid: number): Promise<number> {
  let blocked: number | undefined;
  await expect.poll(async () => {
    blocked = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1`, [pid])).rows[0]?.pid;
    return blocked;
  }, { timeout: 5_000, interval: 10 }).toBeTypeOf('number');
  if (blocked === undefined) throw new Error('expected a blocked PostgreSQL backend');
  return blocked;
}
async function messageWithoutDelivery(): Promise<string> {
  const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES(gen_random_uuid(),gen_random_uuid(),'Steven','maintenance-room','maintenance_operator','{}','interactive') RETURNING id`)).rows[0];
  if (!message) throw new Error('owned fixture message absent');
  return message.id;
}
async function terminalSession(client: Pick<DatabaseClient, 'query'>, revoked = false, mode: 'shell' | 'harness' | 'harness_rw' = 'shell'): Promise<string> {
  const id = randomUUID(); const hash = Buffer.alloc(32, 1);
  await client.query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,
    container,runtime_user,mode,ticket_sha256,reason,issued_at,expires_at,consumed_at,revoked_at,
    request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
    relay_instance_id,relay_boot_id,relay_claim_sha256,relay_claim_epoch,relay_claimed_at,relay_claim_expires_at)
    VALUES($1,'maintenance-operator',true,'owned-maintenance-fixture','Steven','maintenance_agent',
    'cauce-maintenance-agent','dev',$7,$2,'owned fixture',clock_timestamp()-interval '11 minutes',
    clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '630 seconds',
    CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END,$4,$2,$2,1,$5,$6,$2,1,
    clock_timestamp()-interval '630 seconds',clock_timestamp()+interval '150 seconds')`,
  [id, hash, revoked, randomUUID(), 'a'.repeat(64), randomUUID(), mode]);
  return id;
}

describe('durable host maintenance', () => {
  it('never enqueues automatic maintenance without an explicit model selection', async () => {
    await pool.query("UPDATE agents SET model_id=NULL WHERE alias='maintenance_agent'");
    expect((await enqueue()).operations).toEqual([]);
    expect((await enqueue()).operations).toEqual([]);
    expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready', model_id: null });
  });
  it('revalidates the explicit model before granting a queued maintenance claim', async () => {
    await enqueue(); await pool.query("UPDATE agents SET model_id=NULL WHERE alias='maintenance_agent'");
    expect(await repository.claim('maintenance-worker', identity.host_id)).toBeNull();
    expect((await pool.query('SELECT status,error FROM fleet_operations')).rows)
      .toEqual([{ status: 'failed', error: { code: 'AUTHORITY_REVOKED', retryable: false } }]);
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
  });
  it.each(['claimed', 'deferred'] as const)('keeps exact legacy model-null maintenance %s available for owner Stop', async state => {
    const id = await legacyMaintenance(); const operation = await claim();
    expect(operation.operation.id).toBe(id);
    if (state === 'deferred') await repository.deferMaintenance(operation, 'preflight_unavailable');
    const manual = await ownerEnqueue(ownerRequest('stop', 0));
    expect((await pool.query('SELECT status FROM fleet_operations WHERE id=$1', [id])).rows).toEqual([{ status: 'cancelled' }]);
    expect((await repository.claim('owner-worker', identity.host_id))?.operation.id).toBe(manual.id);
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready', model_id: null });
  });
  it('rejects a legacy model-null operation when the current model selection changed', async () => {
    const id = await legacyMaintenance(); await pool.query("UPDATE agents SET model_id='gpt-5' WHERE alias='maintenance_agent'");
    expect(await repository.claim('maintenance-worker', identity.host_id)).toBeNull();
    expect((await pool.query('SELECT status,error FROM fleet_operations WHERE id=$1', [id])).rows)
      .toEqual([{ status: 'failed', error: { code: 'AUTHORITY_REVOKED', retryable: false } }]);
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
  });
  it.each(['stop', 'retire'] as const)('gives an authorized owner %s priority over deferred automatic maintenance', async kind => {
    const queued = (await enqueue()).operations[0]; const operation = await claim();
    await repository.deferMaintenance(operation, 'preflight_unavailable');
    await pool.query("UPDATE agents SET model_id=NULL WHERE alias='maintenance_agent'");
    const manual = await ownerEnqueue(ownerRequest(kind, operation.operation.expected_revision));
    expect(manual).toMatchObject({ kind, status: 'queued', actor: { actor_subject: subject } });
    expect((await pool.query('SELECT status,cancel_requested,worker_id,claim_token,lease_expires_at FROM fleet_operations WHERE id=$1', [queued?.id])).rows)
      .toEqual([{ status: 'cancelled', cancel_requested: true, worker_id: null, claim_token: null, lease_expires_at: null }]);
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event='cancelled'", [queued?.id])).rows[0]?.metadata)
      .toMatchObject({ maintenance_skipped: 'owner_priority', maintenance_preempted: { actor_subject: subject } });
    expect((await repository.claim('owner-worker', identity.host_id))?.operation.id).toBe(manual.id);
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready', model_id: null });
  });
  it('does not preempt for stale revisions, revoked humans or agent-origin requests', async () => {
    const queued = (await enqueue()).operations[0]; if (!queued) throw new Error('queued maintenance absent');
    const request = ownerRequest('stop', queued.expected_revision);
    await expect(ownerEnqueue({ ...request, expected_revision: queued.expected_revision + 1 })).rejects.toMatchObject({ code: 'conflict' });
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [subject.slice('console:'.length)]);
    await expect(ownerEnqueue(request)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.enqueue('Steven', 'maintenance_operator', request)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT status,version FROM fleet_operations WHERE id=$1', [queued.id])).rows)
      .toEqual([{ status: 'queued', version: '0' }]);
    expect((await pool.query("SELECT id FROM fleet_operation_events WHERE event='cancelled'")).rowCount).toBe(0);
  });
  it('keeps failed automatic maintenance protected', async () => {
    const queued = (await enqueue()).operations[0]; const operation = await claim();
    const failed = await repository.fail(operation, { code: 'HOST_UNAVAILABLE', retryable: true });
    await expect(ownerEnqueue(ownerRequest('stop', operation.operation.expected_revision))).rejects.toMatchObject({ code: 'conflict' });
    if (!queued) throw new Error('queued maintenance absent');
    expect(await repository.get('Steven', 'maintenance_operator', queued.id, subject)).toEqual(failed);
    expect((await pool.query("SELECT id FROM fleet_operation_events WHERE event='cancelled'")).rowCount).toBe(0);
  });
  it('keeps unresolved human operations protected', async () => {
    await ownerEnqueue(ownerRequest('stop', 0)); const human = await claim();
    await expect(ownerEnqueue(ownerRequest('retire', 0))).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.execution(human)).operation).toEqual(human.operation);
  });
  it('atomically revokes a claimed but unprepared maintenance worker when the owner wins', async () => {
    await enqueue(); const operation = await claim();
    const owner = await pool.connect(); const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await owner.query('BEGIN');
      const pid = (await owner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('owner backend absent');
      const manual = await repository.forTransaction(owner).enqueue('Steven', 'maintenance_operator', ownerRequest('stop', operation.operation.expected_revision), subject);
      const prepared = repository.prepare(operation); settlements.push(prepared); void prepared.catch(() => undefined);
      await blockedBy(pid);
      await owner.query('COMMIT'); committed = true;
      await expect(prepared).rejects.toMatchObject({ code: 'conflict' });
      expect(await repository.renew(operation)).toBe(false);
      await expect(repository.startStep(operation, 'stop')).rejects.toMatchObject({ code: 'conflict' });
      expect((await pool.query('SELECT epoch,worker_id,claim_token FROM fleet_operations WHERE id=$1', [operation.operation.id])).rows)
        .toEqual([{ epoch: String(operation.epoch + 1), worker_id: null, claim_token: null }]);
      expect((await repository.claim('owner-worker', identity.host_id))?.operation.id).toBe(manual.id);
      expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
    } finally {
      if (!committed) await owner.query('ROLLBACK');
      await Promise.allSettled(settlements); owner.release();
    }
  });
  it('cannot preempt maintenance after its preparation transaction wins', async () => {
    await enqueue(); const operation = await claim();
    const maintenance = await pool.connect(); const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await maintenance.query('BEGIN');
      const pid = (await maintenance.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('maintenance backend absent');
      const prepared = await repository.forTransaction(maintenance).prepare(operation);
      const manual = ownerEnqueue(ownerRequest('stop', prepared.operation.desired_revision ?? 0));
      settlements.push(manual); void manual.catch(() => undefined); await blockedBy(pid);
      await maintenance.query('COMMIT'); committed = true;
      await expect(manual).rejects.toMatchObject({ code: 'conflict' });
      expect((await repository.execution(operation)).operation).toEqual(prepared.operation);
      expect(await agent()).toMatchObject({ enabled: false, lifecycle_state: 'provisioning' });
    } finally {
      if (!committed) await maintenance.query('ROLLBACK');
      await Promise.allSettled(settlements); maintenance.release();
    }
  });
  it.each(['room', 'tenant'] as const)('preempts only automatic maintenance within the owner %s action scope', async resource => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('outside-maintenance-room','Steven')");
    for (const [alias, room] of [['included_agent', 'maintenance-room'], ['outside_agent', 'outside-maintenance-room']] as const) {
      await withTransaction(pool, async client => {
        await client.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,lifecycle_state,runtime_key,host_id,runtime_mode,
          container_name,runtime_user,home_directory,state_directory,systemd_user,primary_account_id,model_id,reasoning_effort)
          SELECT tenant_id,$1,harness_id,enabled,lifecycle_state,replace($1,'_','-'),host_id,runtime_mode,$1,runtime_user,home_directory,
            '/home/dev/.cauce/'||$1,systemd_user,primary_account_id,model_id,reasoning_effort FROM agents WHERE alias='maintenance_agent'`, [alias]);
        await client.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven',$1,$2,'agent')", [room, alias]);
        await client.query("UPDATE agents SET primary_room_id=$1 WHERE alias=$2", [room, alias]);
      });
    }
    const queued = (await enqueue()).operations; expect(queued).toHaveLength(3);
    const target: FleetTarget = resource === 'room' ? { resource, tenant_id: 'Steven', room_id: 'maintenance-room' } : { resource, tenant_id: 'Steven' };
    await ownerEnqueue(ownerRequest('retire', queued[0]?.expected_revision ?? 0, target));
    expect((await pool.query(`SELECT target->>'alias' AS alias,status FROM fleet_operations WHERE kind='update' ORDER BY target->>'alias'`)).rows)
      .toEqual([{ alias: 'included_agent', status: 'cancelled' }, { alias: 'maintenance_agent', status: 'cancelled' },
        { alias: 'outside_agent', status: resource === 'tenant' ? 'cancelled' : 'queued' }]);
  });
  it('builds one exact canonical update and attributes its real signed host', async () => {
    const first = await enqueue();
    expect(first.operations).toHaveLength(1);
    expect((await enqueue()).operations[0]?.id).toBe(first.operations[0]?.id);
    const operation = await claim();
    expect(operation.operation.actor).toEqual({ tenant_id: 'Steven', alias: 'maintenance_agent',
      actor_subject: `host:${identity.host_id}:${identity.key_fingerprint}` });
    expect(operation.request.kind).toBe('update');
    if (operation.request.kind !== 'update') throw new Error('update expected');
    expect(operation.request.parameters).toMatchObject({ primary_account_id: 'maintenance-account', model_id: 'gpt-5', reasoning_effort: 'high',
      memberships: [{ room_id: 'maintenance-room', role: 'agent', enabled: true }],
      placement: { host_id: identity.host_id, container_name: 'cauce-maintenance-agent' } });
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
    await repository.prepare(operation);
    expect(await agent()).toMatchObject({ enabled: false, lifecycle_state: 'provisioning' });
    expect((await pool.query('SELECT actor_human_id FROM config_revisions ORDER BY id DESC LIMIT 1')).rows[0]).toEqual({ actor_human_id: null });
    expect(typeof (await repository.execution(operation)).operation.desired_revision).toBe('number');
  });
  it('rejects a different enrollment, fingerprint and company without enqueueing effects', async () => {
    for (const changed of [{ enrollment_id: randomUUID() }, { key_fingerprint: 'f'.repeat(64) }, { company_id: 'foreign' }]) {
      await expect(withTransaction(pool, client => enqueueHostMaintenance(client, { ...identity, ...changed }, RELEASE)))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
    expect(await agent()).toMatchObject({ enabled: true });
  });
  it('defers pending delivery before any fence and retains the canonical admission', async () => {
    await enqueue(); const operation = await claim();
    await pool.query(`WITH message AS (INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES(gen_random_uuid(),gen_random_uuid(),'Steven','maintenance-room','maintenance_operator','{}','interactive') RETURNING id)
      INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) SELECT id,'Steven','maintenance_agent' FROM message`);
    await expect(repository.prepare(operation)).rejects.toMatchObject({ reason: 'pending_deliveries' });
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
    expect((await pool.query('SELECT status FROM deliveries')).rows).toEqual([{ status: 'pending' }]);
    expect((await pool.query("SELECT id FROM fleet_operation_events WHERE event='step_completed'")).rowCount).toBe(0);
    await repository.deferMaintenance(operation, 'pending_deliveries');
    expect(await repository.claim('another-worker', identity.host_id)).toBeNull();
    const deferred = (await pool.query<{ metadata: { maintenance_deferred: { reason: string; attempt: number; retry_at: string } } }>(
      "SELECT metadata FROM fleet_operation_events WHERE event='renewed'")).rows[0]?.metadata.maintenance_deferred;
    expect(deferred).toMatchObject({ reason: 'pending_deliveries', attempt: 1 });
    expect(typeof deferred?.retry_at).toBe('string');
    await expect(repository.prepare(operation)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('uses durable retry history across repository instances and increases the backoff', async () => {
    const queued = (await enqueue()).operations[0];
    await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'renewed',$2::jsonb)`,
      [queued?.id, JSON.stringify({ maintenance_deferred: { reason: 'composer_busy', attempt: 1, retry_at: '2000-01-01T00:00:00.000Z' } })]);
    const operation = await claim();
    await new FleetOperationsRepository(pool).deferMaintenance(operation, 'composer_busy');
    const event = (await pool.query<{ attempt: string; delay: number }>(`SELECT metadata->'maintenance_deferred'->>'attempt' AS attempt,
      extract(epoch FROM (metadata->'maintenance_deferred'->>'retry_at')::timestamptz-clock_timestamp())::float AS delay
      FROM fleet_operation_events WHERE event='renewed' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(event?.attempt).toBe('2'); expect(event?.delay).toBeGreaterThan(55); expect(event?.delay).toBeLessThanOrEqual(60);
    expect(await new FleetOperationsRepository(pool).claim('another-worker', identity.host_id)).toBeNull();
  });
  it('cancels stale queued requests and creates a new immutable revision', async () => {
    const first = (await enqueue()).operations[0]; await foreignRevision();
    const fresh = (await enqueue()).operations[0];
    expect(fresh?.id).not.toBe(first?.id); expect(fresh?.expected_revision).toBeGreaterThan(first?.expected_revision ?? 0);
    expect((await pool.query('SELECT status FROM fleet_operations WHERE id=$1', [first?.id])).rows).toEqual([{ status: 'cancelled' }]);
    expect(await agent()).toMatchObject({ enabled: true });
  });
  it('skips a claimed stale revision without treating it as an already current runtime', async () => {
    await enqueue(); const operation = await claim(); await foreignRevision();
    await expect(repository.execution(operation)).resolves.toMatchObject({ operation: { id: operation.operation.id } });
    await expect(repository.prepare(operation)).rejects.toMatchObject({ code: 'conflict' });
    await repository.skipMaintenance(operation, 'revision_changed');
    expect((await enqueue()).operations[0]?.id).not.toBe(operation.operation.id);
    expect(await agent()).toMatchObject({ enabled: true });
  });
  it('does not repeatedly enqueue an already current release when an unrelated revision changes', async () => {
    await enqueue(); const operation = await claim(); await repository.skipMaintenance(operation);
    await foreignRevision(); expect((await enqueue()).operations).toEqual([]);
  });
  it('permits returning to an earlier release after a newer maintenance attempt', async () => {
    await enqueue(); const initial = await claim(); await repository.skipMaintenance(initial);
    await withTransaction(pool, client => enqueueHostMaintenance(client, identity, 'c'.repeat(64)));
    const newer = await claim(); await repository.skipMaintenance(newer, 'release_changed');
    expect((await enqueue()).operations[0]?.id).not.toBe(initial.operation.id);
  });
  it('keeps an expired provider login reserved until its durable cleanup is released', async () => {
    await enqueue(); const operation = await claim();
    const reservation = { session_id: randomUUID(), actor_subject: subject,
      cohort: JSON.stringify([identity.host_id, 'dev', 'maintenance-profile']), expires_at: '2000-01-01T00:00:00.000Z', state: 'reserved' };
    await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,1,'step_started',$2::jsonb)`,
      [operation.operation.id, JSON.stringify({ step: 'authenticate', provider_auth: reservation })]);
    await expect(repository.prepare(operation)).rejects.toMatchObject({ reason: 'provider_login' });
    expect(await agent()).toMatchObject({ enabled: true });
    await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,1,'step_completed',$2::jsonb)`,
      [operation.operation.id, JSON.stringify({ step: 'authenticate', provider_auth: { ...reservation, state: 'released' } })]);
    expect(typeof (await repository.prepare(operation)).operation.desired_revision).toBe('number');
  });
  it('rejects deferral after preparation even before a physical step starts', async () => {
    await enqueue(); const operation = await claim(); await repository.prepare(operation);
    await expect(repository.deferMaintenance(operation, 'tui_unreadable')).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.execution(operation)).operation.status).toBe('running');
    expect(await agent()).toMatchObject({ enabled: false, lifecycle_state: 'provisioning' });
  });
  it('rejects deferral once stop starts and rejects skipping a prepared operation', async () => {
    await enqueue(); const operation = await claim(); await repository.prepare(operation); await repository.startStep(operation, 'stop');
    await expect(repository.deferMaintenance(operation, 'tui_unreadable')).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.skipMaintenance(operation)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not disable a live agent when an unprepared maintenance operation fails', async () => {
    await enqueue(); const operation = await claim(); await repository.fail(operation, { code: 'HOST_UNAVAILABLE', retryable: true });
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
  });
  it('waits for an already validated agent publication and defers before fencing its new delivery', async () => {
    await enqueue(); const operation = await claim();
    const barrier = await pool.connect(); const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await barrier.query('BEGIN');
      const pid = (await barrier.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('barrier backend absent');
      await barrier.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cauce:agent-root:Steven/maintenance_operator']);
      const published = new CauceRepository(pool).publish(publication(), { agentRoot: true });
      settlements.push(published); void published.catch(() => undefined);
      const publisherPid = await blockedBy(pid);
      const prepared = repository.prepare(operation);
      settlements.push(prepared); void prepared.catch(() => undefined);
      await blockedBy(publisherPid);
      expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
      expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(0);
      await barrier.query('COMMIT');
      committed = true;
      expect((await published).delivery_ids).toHaveLength(1);
      await expect(prepared).rejects.toMatchObject({ reason: 'pending_deliveries' });
      expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
      expect((await pool.query('SELECT status FROM deliveries')).rows).toEqual([{ status: 'pending' }]);
    } finally {
      if (!committed) await barrier.query('ROLLBACK');
      await Promise.allSettled(settlements); barrier.release();
    }
  });
  it('revalidates a waiting publication after maintenance commits its fence', async () => {
    await enqueue(); const operation = await claim();
    const preparation = await pool.connect(); const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await preparation.query('BEGIN');
      const pid = (await preparation.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('preparation backend absent');
      await repository.forTransaction(preparation).prepare(operation);
      const published = new CauceRepository(pool).publish(publication());
      settlements.push(published); void published.catch(() => undefined);
      await blockedBy(pid);
      expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(0);
      await preparation.query('COMMIT');
      committed = true;
      await expect(published).rejects.toMatchObject({ code: 'no_route' });
      expect(await agent()).toMatchObject({ enabled: false, lifecycle_state: 'provisioning' });
      expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(0);
    } finally {
      if (!committed) await preparation.query('ROLLBACK');
      await Promise.allSettled(settlements); preparation.release();
    }
  });
  it('rejects internal delivery insertion without waiting on an exclusive recipient context fence', async () => {
    const messageId = await messageWithoutDelivery(); const fence = await pool.connect();
    try {
      await fence.query('BEGIN');
      await fence.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [agentContextReconcileLockKey('Steven', 'maintenance_agent')]);
      await expect(withTransaction(pool, async client => {
        await client.query("SET LOCAL statement_timeout='1000ms'");
        return insertDelivery(client, { messageId, recipientTenant: 'Steven', recipientAlias: 'maintenance_agent' });
      })).rejects.toMatchObject({ code: 'conflict', message: 'recipient context is being reconciled; retry the delivery' });
      expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(0);
    } finally { await fence.query('ROLLBACK'); fence.release(); }
  });
  it('rejects every internal delivery producer after preparation has committed', async () => {
    const messageId = await messageWithoutDelivery(); await enqueue(); const operation = await claim(); await repository.prepare(operation);
    await expect(withTransaction(pool, client => insertDelivery(client,
      { messageId, recipientTenant: 'Steven', recipientAlias: 'maintenance_agent' })))
      .rejects.toMatchObject({ code: 'conflict', message: 'recipient runtime maintenance is prepared; retry after admission' });
    expect((await pool.query('SELECT id FROM deliveries')).rowCount).toBe(0);
  });
  it.each([false, true])('defers a consumed live relay claim even with an expired ticket and revoked=%s', async revoked => {
    await enqueue(); const operation = await claim(); const session = await terminalSession(pool, revoked);
    await expect(repository.prepare(operation)).rejects.toMatchObject({ reason: 'preflight_unavailable' });
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
    await pool.query('UPDATE terminal_sessions SET closed_at=clock_timestamp() WHERE id=$1', [session]);
    expect(typeof (await repository.prepare(operation)).operation.desired_revision).toBe('number');
  });
  it('permits maintenance after the revoked relay claim expires without requiring a remote close receipt', async () => {
    await enqueue(); const operation = await claim(); const session = await terminalSession(pool, true);
    await pool.query("UPDATE terminal_sessions SET relay_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session]);
    expect(typeof (await repository.prepare(operation)).operation.desired_revision).toBe('number');
  });
  it('does not defer for a read-only harness viewer with a live relay claim', async () => {
    await enqueue(); const operation = await claim(); await terminalSession(pool, false, 'harness');
    expect(typeof (await repository.prepare(operation)).operation.desired_revision).toBe('number');
  });
  it('defers a revoked writable harness relay while its input claim remains live', async () => {
    await enqueue(); const operation = await claim(); await terminalSession(pool, true, 'harness_rw');
    await expect(repository.prepare(operation)).rejects.toMatchObject({ reason: 'preflight_unavailable' });
    expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
  });
  it('waits for terminal SHARE authority to commit and then observes its live relay claim before fencing', async () => {
    await enqueue(); const operation = await claim(); const terminal = await pool.connect();
    const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await terminal.query('BEGIN'); await terminal.query('LOCK TABLE agents IN SHARE MODE');
      const pid = (await terminal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('terminal backend absent');
      await terminalSession(terminal);
      const prepared = repository.prepare(operation); settlements.push(prepared); void prepared.catch(() => undefined);
      await blockedBy(pid);
      expect(await agent()).toMatchObject({ enabled: true });
      await terminal.query('COMMIT'); committed = true;
      await expect(prepared).rejects.toMatchObject({ reason: 'preflight_unavailable' });
      expect(await agent()).toMatchObject({ enabled: true, lifecycle_state: 'ready' });
    } finally {
      if (!committed) await terminal.query('ROLLBACK');
      await Promise.allSettled(settlements); terminal.release();
    }
  });
  it('holds terminal SHARE authority behind maintenance until the target is durably disabled', async () => {
    await enqueue(); const operation = await claim();
    const preparation = await pool.connect(); const terminal = await pool.connect();
    const settlements: Promise<unknown>[] = []; let committed = false;
    try {
      await preparation.query('BEGIN'); await repository.forTransaction(preparation).prepare(operation);
      const pid = (await preparation.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('preparation backend absent');
      await terminal.query('BEGIN');
      const grant = (async () => {
        await terminal.query('LOCK TABLE agents IN SHARE MODE');
        const enabled = (await terminal.query<{ enabled: boolean }>(
          "SELECT enabled FROM agents WHERE tenant_id='Steven' AND alias='maintenance_agent'")).rows[0]?.enabled;
        if (enabled !== true) return false;
        await terminalSession(terminal); return true;
      })();
      settlements.push(grant); void grant.catch(() => undefined); await blockedBy(pid);
      await preparation.query('COMMIT'); committed = true;
      expect(await grant).toBe(false); await terminal.query('COMMIT');
      expect((await pool.query('SELECT id FROM terminal_sessions')).rowCount).toBe(0);
    } finally {
      if (!committed) await preparation.query('ROLLBACK');
      await Promise.allSettled(settlements); await terminal.query('ROLLBACK'); preparation.release(); terminal.release();
    }
  });
});
