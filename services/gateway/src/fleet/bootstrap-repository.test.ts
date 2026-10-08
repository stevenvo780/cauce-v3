import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestDatabase, startTestCaseDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { BootstrapRepository } from './bootstrap-repository.js';
import type { BootstrapAck, BootstrapCreate, BootstrapDescriptor } from './bootstrap-contracts.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let repository: BootstrapRepository; let operationId: string;
const identity = { tenant_id: 'Steven', alias: 'boot-agent' };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent'); current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('boot-account','codex','bootstrap-test-account','Steven','env_path','CAUCE_BOOT_TEST_PATH',true)`);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory,
    runtime_key,host_id,primary_account_id,model_id,lifecycle_state) VALUES
    ('Steven','boot-owner','codex',true,'boot-owner','dev','/home/dev','/home/dev/.cauce','boot-owner','test-host','boot-account','test-model','ready'),
    ('Steven','boot-agent','codex',false,'boot-agent','dev','/home/dev','/home/dev/.cauce','boot-agent','test-host','boot-account','test-model','verifying')`);
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('boot-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','boot-hub','boot-owner','operator')");
  const person = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('boot@example.test','boot@example.test',$1,'Boot','operator','Steven','boot-owner') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!person) throw new Error('person absent');
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','boot-owner','operator',ARRAY['read','control'])", [person.id]);
  await pool.query("INSERT INTO agent_profiles(tenant_id,alias,purpose) VALUES('Steven','boot-agent','Boot purpose')");
  operationId = randomUUID();
  await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,
    idempotency_key,expected_revision,status,steps,worker_id,claim_token,epoch,lease_expires_at)
    VALUES($1,'Steven','boot-owner',$2::jsonb,'agent:Steven/boot-agent','boot-cohort','test-host','start',$3::jsonb,$4,
      'boot-idempotence',0,'running',$5::jsonb,'test-worker',$6,1,clock_timestamp()+interval '5 minutes')`,
  [operationId, JSON.stringify({ resource: 'agent', ...identity }), JSON.stringify({ kind: 'start', target: { resource: 'agent', ...identity }, parameters: {} }),
    'a'.repeat(64), JSON.stringify([{ name: 'profile', status: 'running' }, { name: 'verify', status: 'pending' }]), randomUUID()]);
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)",
    [operationId, JSON.stringify({ actor_subject: `console:${person.id}` })]);
  repository = new BootstrapRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function input(action: 'profile' | 'verify' = 'profile', phase: 'bootstrap' | 'normal' = 'bootstrap'): BootstrapCreate {
  return { operation_id: operationId, phase, action, nonce: (action === 'profile' ? '1' : phase === 'bootstrap' ? '2' : '3').repeat(64), account_id: 'boot-account', profile_revision: 1 };
}
function proof(descriptor: BootstrapDescriptor & { claim_token: string }): BootstrapAck {
  return { operation_id: descriptor.operation_id, phase: descriptor.phase, runtime_key: descriptor.runtime_key, nonce: descriptor.nonce,
    claim_token: descriptor.claim_token, account_id: descriptor.account_id, profile_revision: descriptor.profile_revision,
    harness_id: descriptor.harness_id, model_id: descriptor.model_id, documents: descriptor.documents,
    reply: descriptor.action === 'verify' ? `CAUCE_BOOTSTRAP_${descriptor.nonce}` : null, harness_started: descriptor.action === 'verify' };
}
async function complete(action: 'profile' | 'verify' = 'profile', phase: 'bootstrap' | 'normal' = 'bootstrap') {
  const receipt = await repository.create(identity, input(action, phase));
  const claim = await repository.claim(identity, operationId, phase, identity.alias);
  if (!claim) throw new Error('claim absent');
  return { receipt, claim, acknowledged: await repository.ack(identity, claim.probe_id, proof(claim)) };
}
async function verifyStep(): Promise<void> {
  await pool.query(`UPDATE fleet_operations SET steps=$2::jsonb WHERE id=$1`, [operationId,
    JSON.stringify([{ name: 'profile', status: 'succeeded' }, { name: 'verify', status: 'running' }])]);
}
describe('bootstrap durable control on disposable PostgreSQL', () => {
  it('uses its single reserved connection for canonical context under the advisory lock', async () => {
    if (!current) throw new Error('test database absent');
    const single = createPool(current.url, { max: 1, connectionTimeoutMillis: 500 });
    try {
      const constrained = new BootstrapRepository(single);
      const values = await Promise.all([constrained.state(identity, operationId, 'bootstrap'), constrained.state(identity, operationId, 'normal')]);
      expect(values.map(value => value.profile_revision)).toEqual([1, 1]);
      expect((await constrained.create(identity, input())).state).toBe('pending');
    } finally { await single.end(); }
  });

  it('waits without claiming while authentication is pending and refuses a missing durable profile', async () => {
    await pool.query("UPDATE fleet_operations SET status='awaiting_auth',worker_id=NULL,claim_token=NULL,lease_expires_at=NULL");
    expect(await repository.claim(identity, operationId, 'bootstrap', identity.alias)).toBeNull();
    expect(await repository.state(identity, operationId, 'bootstrap')).toMatchObject({ status: 'awaiting_auth', enabled: false, normal_admitted: false });
    await pool.query("DELETE FROM agent_profiles WHERE alias='boot-agent'");
    await expect(repository.state(identity, operationId, 'bootstrap')).rejects.toMatchObject({ code: 'unverified' });
  });

  it('issues idempotent descriptors and stores only a hashed one-time claim, preserving disabled and unapplied profile', async () => {
    const first = await repository.create(identity, input());
    expect(await repository.create(identity, input())).toEqual(first);
    const claim = await repository.claim(identity, operationId, 'bootstrap', identity.alias);
    if (!claim) throw new Error('claim absent');
    const events = await pool.query('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1', [operationId]);
    expect(JSON.stringify(events.rows)).not.toContain(claim.claim_token);
    await expect(repository.claim(identity, operationId, 'bootstrap', identity.alias)).rejects.toMatchObject({ code: 'conflict' });
    const acknowledged = await repository.ack(identity, claim.probe_id, proof(claim));
    expect(acknowledged.state).toBe('succeeded'); expect(JSON.stringify(acknowledged)).not.toContain(claim.claim_token);
    expect(await repository.ack(identity, claim.probe_id, proof(claim))).toEqual(acknowledged);
    expect((await pool.query<{ enabled: boolean }>("SELECT enabled FROM agents WHERE alias='boot-agent'")).rows[0]?.enabled).toBe(false);
    expect((await pool.query<{ applied_revision: string | null }>("SELECT applied_revision FROM agent_profiles WHERE alias='boot-agent'")).rows[0]?.applied_revision).toBeNull();
  });
  it('rejects wrong tenant, alias, runtime, account, phase, revision and unsupported step', async () => {
    await expect(repository.create({ ...identity, alias: 'boot-owner' }, input())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.create(identity, { ...input(), account_id: 'unknown-account' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.create(identity, { ...input(), profile_revision: 2 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.create(identity, input('verify'))).rejects.toMatchObject({ code: 'conflict' });
    const receipt = await repository.create(identity, input());
    await expect(repository.read(identity, 'normal', receipt.probe.probe_id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.claim(identity, operationId, 'bootstrap', 'wrong-runtime')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.read({ ...identity, tenant_id: 'Isa' }, 'bootstrap', receipt.probe.probe_id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('revalidates the actual queued human, membership, provider consent and worker fencing on every effect', async () => {
    const { claim } = await complete();
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE actor_alias='boot-owner'");
    await expect(repository.profile(identity, operationId, 'bootstrap')).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read','control'] WHERE actor_alias='boot-owner'");
    await pool.query("UPDATE provider_accounts SET enabled=false WHERE id='boot-account'");
    await expect(repository.state(identity, operationId, 'bootstrap')).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE provider_accounts SET enabled=true WHERE id='boot-account'; UPDATE fleet_operations SET epoch=epoch+1");
    await expect(repository.ack(identity, claim.probe_id, proof(claim))).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second'");
    await expect(repository.create(identity, input())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not reassign a claimed effect after its lease expires', async () => {
    await repository.create(identity, input()); const claim = await repository.claim(identity, operationId, 'bootstrap', identity.alias);
    if (!claim) throw new Error('claim absent');
    const previous = (await pool.query<{ record: Record<string, unknown> }>(`SELECT metadata->'bootstrap_probe' AS record FROM fleet_operation_events
      WHERE operation_id=$1 AND metadata ? 'bootstrap_probe' ORDER BY id DESC LIMIT 1`, [operationId])).rows[0];
    if (!previous) throw new Error('record absent');
    await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_started',$2::jsonb)",
      [operationId, JSON.stringify({ bootstrap_probe: { ...previous.record, claim_expires_at: new Date(Date.now() - 1).toISOString() } })]);
    await expect(repository.claim(identity, operationId, 'bootstrap', identity.alias)).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.create(identity, { ...input(), nonce: '9'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.ack(identity, claim.probe_id, proof(claim))).rejects.toMatchObject({ code: 'conflict' });
  });
  it('requires exact physical profile proof and a native provider answer before allowing normal admission', async () => {
    await complete(); await verifyStep(); await repository.create(identity, input('verify'));
    const claim = await repository.claim(identity, operationId, 'bootstrap', identity.alias); if (!claim) throw new Error('claim absent');
    await expect(repository.ack(identity, claim.probe_id, { ...proof(claim), reply: 'HTTP echo' })).rejects.toMatchObject({ code: 'unverified' });
    await expect(repository.ack(identity, claim.probe_id, { ...proof(claim), documents: claim.documents.map(file => ({ ...file, sha256: 'a'.repeat(64) })) })).rejects.toMatchObject({ code: 'unverified' });
    await expect(repository.ack(identity, claim.probe_id, { ...proof(claim), harness_started: false })).rejects.toMatchObject({ code: 'unverified' });
    await expect(repository.create(identity, input('verify', 'normal'))).rejects.toMatchObject({ code: 'conflict' });
    await repository.ack(identity, claim.probe_id, proof(claim));
    await pool.query(`UPDATE fleet_operations SET steps=$2::jsonb WHERE id=$1`, [operationId,
      JSON.stringify([{ name: 'profile', status: 'succeeded' }, { name: 'verify', status: 'succeeded' }, { name: 'admission', status: 'running' }])]);
    await complete('verify', 'normal');
    expect((await repository.state(identity, operationId, 'normal')).normal_admitted).toBe(false);
    await pool.query("UPDATE agents SET enabled=true,lifecycle_state='ready' WHERE alias='boot-agent'; UPDATE fleet_operations SET status='succeeded',steps='[{\"name\":\"admission\",\"status\":\"succeeded\"}]'::jsonb");
    expect((await repository.state(identity, operationId, 'normal')).normal_admitted).toBe(true);
    expect((await repository.state(identity, operationId, 'bootstrap')).normal_admitted).toBe(false);
    expect(await repository.profile(identity, operationId, 'normal')).toMatchObject({ profile_revision: 1, documents: claim.documents });
    await expect(repository.profile(identity, operationId, 'bootstrap')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects changed desired profiles, enabled or retired agents and revoked current human membership', async () => {
    await repository.create(identity, input()); await pool.query("UPDATE agent_profiles SET purpose='Changed purpose' WHERE alias='boot-agent'");
    await expect(repository.claim(identity, operationId, 'bootstrap', identity.alias)).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET enabled=true WHERE alias='boot-agent'");
    await expect(repository.profile(identity, operationId, 'bootstrap')).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE agents SET enabled=false,retired_at=clock_timestamp() WHERE alias='boot-agent'");
    await expect(repository.state(identity, operationId, 'normal')).rejects.toMatchObject({ code: 'forbidden' });
    await pool.query("UPDATE agents SET retired_at=NULL WHERE alias='boot-agent'; UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE actor_alias='boot-owner'");
    await expect(repository.state(identity, operationId, 'normal')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
