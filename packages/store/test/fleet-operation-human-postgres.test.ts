import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const humanId = 'd872c0d3-2f32-4ef0-8b59-e8f81a265e71';
const otherId = 'd872c0d3-2f32-4ef0-8b59-e8f81a265e72';
const subject = `console:${humanId}`;
let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','human_fleet_operator')");
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('human-fleet-room','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','human-fleet-room','human_fleet_operator','operator')");
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,'fleet@isolated.test','fleet@isolated.test',$2,'Fleet human','operator','Steven','human_fleet_operator')`,
  [humanId, '$scrypt$' + 'x'.repeat(40)]);
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function repository(): FleetOperationsRepository { return new FleetOperationsRepository(pool); }
function create(): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: 'human_created' }, expected_revision: 0,
    idempotency_key: 'human-fleet-create', parameters: { runtime_key: 'human-created', harness_id: 'codex',
      primary_room_id: 'human-fleet-room', memberships: [{ room_id: 'human-fleet-room', role: 'agent' }],
      placement: { host_id: 'human-host', mode: 'container', container_name: 'human-test', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/human-test' } } };
}
async function membership(): Promise<void> {
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'Steven','human_fleet_operator','operator',ARRAY['read','control'])`, [humanId]);
}
describe('durable human fleet provenance', () => {
  it('preserves the trusted human in queued metadata and every public receipt without a new column', async () => {
    const repo = repository(); await membership();
    expect((await repo.preview('Steven', 'human_fleet_operator', create(), subject)).can_apply).toBe(true);
    const queued = await repo.enqueue('Steven', 'human_fleet_operator', create(), subject);
    expect(queued.actor.actor_subject).toBe(subject);
    expect((await pool.query<{ metadata: Record<string, unknown> }>('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event=\'queued\'', [queued.id])).rows[0]?.metadata)
      .toEqual({ actor_subject: subject });
    const claim = await repo.claim('human-worker', 'human-host'); if (!claim) throw new Error('claim absent');
    expect(claim.operation.actor.actor_subject).toBe(subject);
    expect((await repo.prepare(claim)).operation.actor.actor_subject).toBe(subject);
    expect((await repo.get('Steven', 'human_fleet_operator', queued.id)).actor.actor_subject).toBe(subject);
    expect((await repo.list('Steven', 'human_fleet_operator', create().target))[0]?.actor.actor_subject).toBe(subject);
  });
  it('rejects missing or malformed people and exact tenant alias mismatches before preview or enqueue', async () => {
    const repo = repository();
    for (const value of ['console:not-a-uuid', `console:${otherId}`, 'oauth:untrusted']) {
      await expect(repo.preview('Steven', 'human_fleet_operator', create(), value)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), value)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await pool.query("UPDATE console_users SET alias='other_alias' WHERE id=$1", [humanId]);
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), subject)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT 1 FROM fleet_operations')).rowCount).toBe(0);
  });
  it('does not authorize a disabled human at enqueue and records revocation before claiming queued work', async () => {
    const repo = repository(); await pool.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), subject)).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query('UPDATE console_users SET active=true WHERE id=$1', [humanId]);
    const queued = await repo.enqueue('Steven', 'human_fleet_operator', create(), subject);
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    expect(await repo.claim('human-worker', 'human-host')).toBeNull();
    expect(await repo.get('Steven', 'human_fleet_operator', queued.id)).toMatchObject({ status: 'failed', error: { code: 'AUTHORITY_REVOKED' } });
    expect((await pool.query("SELECT 1 FROM agents WHERE alias='human_created'")).rowCount).toBe(0);
  });
  it.each(['account', 'membership', 'role'] as const)('reauthorizes the original %s at renewal and every executor phase after preparation', async (revocation) => {
    const repo = repository(); await membership();
    await repo.enqueue('Steven', 'human_fleet_operator', create(), subject);
    const claim = await repo.claim('human-worker', 'human-host'); if (!claim) throw new Error('claim absent');
    await repo.prepare(claim); await repo.startStep(claim, 'artifacts');
    const version = (await repo.get('Steven', 'human_fleet_operator', claim.operation.id)).version;
    if (revocation === 'account') await pool.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    else if (revocation === 'role') await pool.query("UPDATE console_users SET role='reader' WHERE id=$1", [humanId]);
    else await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'],revision=revision+1 WHERE human_id=$1", [humanId]);
    expect(await repo.renew(claim)).toBe(false);
    for (const write of [() => repo.prepare(claim), () => repo.execution(claim), () => repo.startStep(claim, 'artifacts'),
      () => repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) }),
      () => repo.fail(claim, { code: 'STEP_FAILED', retryable: false }), () => repo.awaitAuth(claim),
      () => repo.settle(claim), () => repo.compensate(claim)]) {
      await expect(write()).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(repo.cancel('Steven', 'human_fleet_operator', claim.operation.id, version)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repo.resume('Steven', 'human_fleet_operator', claim.operation.id, version)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repo.get('Steven', 'human_fleet_operator', claim.operation.id)).version).toBe(version);
    expect((await pool.query("SELECT enabled,lifecycle_state FROM agents WHERE alias='human_created'")).rows[0])
      .toEqual({ enabled: false, lifecycle_state: 'provisioning' });
  });
  it('rejects a changed human or a legacy bus retry under the same idempotency key', async () => {
    const repo = repository();
    await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'other@isolated.test','other@isolated.test',$2,'Other human','operator','Steven','human_fleet_operator')`,
    [otherId, '$scrypt$' + 'x'.repeat(40)]);
    const queued = await repo.enqueue('Steven', 'human_fleet_operator', create(), subject);
    expect((await repo.enqueue('Steven', 'human_fleet_operator', create(), subject)).id).toBe(queued.id);
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), `console:${otherId}`)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('fails closed when a current human membership is disabled, revoked or no longer uses the exact alias', async () => {
    const repo = repository(); await membership();
    await pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [humanId]);
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), subject)).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','other_human_operator')");
    await pool.query("UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,actor_alias='other_human_operator' WHERE human_id=$1", [humanId]);
    await expect(repo.enqueue('Steven', 'human_fleet_operator', create(), subject)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
