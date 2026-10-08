import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, planFleetHostSlices, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { createProviderAuthDependencies, type ProviderAuthPhysicalHooks } from './provider-auth-binding.js';
import type { ProviderAuthRequest } from './provider-auth.types.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let actor: { tenant_id: string; alias: string; subject: string };
let request: ProviderAuthRequest;
let cleaned: string[];
let cleanupConfirmed: boolean;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async ({ task }) => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('auth-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','auth-hub','auth-human','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('auth@example.test','auth@example.test',$1,'Fixture','operator','Steven','auth-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('test human absent');
  actor = { tenant_id: 'Steven', alias: 'auth-human', subject: `console:${human.id}` };
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','auth-human')");
  if (!task.name.includes('absent human membership')) await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','auth-human','operator',ARRAY['read','control'])", [human.id]);
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('auth-main','codex','fixture-external','Steven','env_path','CAUCE_TEST_TOKEN_PATH',true)`);
  await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,container_name,runtime_user,home_directory,state_directory,host_id,runtime_mode,systemd_user,primary_account_id,lifecycle_state)
    VALUES('Steven','auth-new','auth-new','codex','fixture-container','dev','/home/dev','/home/dev/state','isolated','container','stev','auth-main','auth_pending')`);
  const operation = randomUUID();
  await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision,status)
    VALUES($1,'Steven','auth-human',$2::jsonb,'agent:Steven:auth-new','isolated:dev',$5,'start',$3::jsonb,$4,'auth-operation-key',0,'awaiting_auth')`,
  [operation, JSON.stringify({ resource: 'agent', tenant_id: 'Steven', alias: 'auth-new' }),
    JSON.stringify({ kind: 'start', target: { resource: 'agent', tenant_id: 'Steven', alias: 'auth-new' }, parameters: {}, expected_revision: 0, idempotency_key: 'auth-operation-key' }),
    'a'.repeat(64), task.name.includes('controller runs elsewhere') ? 'controller' : 'isolated']);
  await pool.query('UPDATE fleet_operations SET desired_revision=0 WHERE id=$1', [operation]);
  const row = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [operation])).rows[0];
  const agent = (await pool.query<{ agent: Record<string, unknown> }>("SELECT to_jsonb(agent) AS agent FROM agents agent WHERE alias='auth-new'")).rows[0]?.agent;
  if (!row || !agent) throw new Error('fixture sealed scope absent');
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_completed',$2::jsonb)",
    [operation, JSON.stringify({ step: 'prepare', prepared_revision: 0, fenced_targets: [row.target], previous_agents: [agent],
      ...(task.name.includes('absent prepared host seal') ? {} : { host_slices: planFleetHostSlices(row, [agent], [agent]) }), desired_memberships: [] })]);
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)",
    [operation, JSON.stringify({ actor_subject: actor.subject })]);
  request = { operation_id: operation, expected_operation_version: 0, request_id: 'auth-request-one',
    provider_id: 'codex', account_id: 'auth-main', harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'auth-main' };
  cleaned = []; cleanupConfirmed = true;
});
afterEach(async () => { await pool.end(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function dependencies() {
  const hooks: ProviderAuthPhysicalHooks = {
    stopAdapter: async () => ({ stopped: true }), openLogin: async () => ({ method: 'device', subscribeOutput: () => () => undefined,
      start: async () => undefined, write: async () => undefined, resize: async () => undefined, close: async () => ({ stopped: true }) }),
    verify: async () => ({ identity_matches: true, functional_call_verified: true }),
    cleanup: async (_scope, id) => { cleaned.push(id); return { stopped: cleanupConfirmed }; },
  };
  return createProviderAuthDependencies(pool, async () => ({ provider_id: 'codex', account_id: 'auth-main',
    harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'auth-main' }), hooks);
}
describe('durable provider authentication reservations', () => {
  it('authorizes an exact sealed physical host when the controller runs elsewhere', async () => {
    await expect(dependencies().authorize(actor, request)).resolves.toBeUndefined();
  });
  it('rejects an absent prepared host seal before reserving a login', async () => {
    await expect(dependencies().authorize(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('binds the exact operation scope and rejects account/profile/host/user/harness substitution', async () => {
    const deps = dependencies(); await deps.authorize(actor, request);
    for (const patch of [{ account_id: 'other' }, { profile_id: 'other' }, { host_id: 'other' }, { runtime_user: 'root' }, { harness_id: 'claude' }]) {
      await expect(deps.authorize(actor, { ...request, ...patch })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    }
  });
  it('requires the current human and hub control even if its former alias remains authorized', async () => {
    const deps = dependencies();
    await pool.query("UPDATE console_users SET alias='changed' WHERE id=$1", [actor.subject.slice(8)]);
    await expect(deps.authorize(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('rejects a revoked human membership even while its alias and console user remain active', async () => {
    const deps = dependencies(); await deps.authorize(actor, request);
    await pool.query("UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1", [actor.subject.slice(8)]);
    await expect(deps.authorize(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('requires an absent human membership to be granted before physical authentication', async () => {
    await expect(dependencies().authorize(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('requires current room authority', async () => {
    const deps = dependencies();
    await pool.query("UPDATE rooms SET enabled=false,retired_at=clock_timestamp(),retired_enabled=true WHERE id='auth-hub'");
    await expect(deps.authorize(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('serializes reservations across instances and rejects stale operation versions', async () => {
    const first = await dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    await expect(dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await first.release();
    await expect(dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM fleet_operation_events')).rows[0]?.n).toBe(4);
  });
  it('requires demonstrated cleanup of an expired reservation before another process may reopen', async () => {
    const prior = randomUUID();
    await dependencies().reserve(actor, request, prior, new Date(Date.now() + 20).toISOString());
    await pool.query(`UPDATE fleet_operations SET version=version+1 WHERE id=$1`, [request.operation_id]);
    await new Promise(resolve => setTimeout(resolve, 25));
    request.expected_operation_version = 2;
    cleanupConfirmed = false;
    await expect(dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' });
    cleanupConfirmed = true;
    const next = await dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    expect(cleaned).toEqual([prior, prior]); await next.release();
  });
  it('fences physical effects after revocation and stores metadata without private terminal data', async () => {
    const deps = dependencies(); const id = randomUUID();
    const reservation = await deps.reserve(actor, request, id, new Date(Date.now() + 10_000).toISOString());
    await pool.query("UPDATE provider_accounts SET enabled=false WHERE id='auth-main'");
    await expect(reservation.openLogin(new AbortController().signal)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await reservation.release();
    const events = (await pool.query("SELECT metadata FROM fleet_operation_events WHERE metadata ? 'provider_auth' OR metadata ? 'provider_auth_status'")).rows;
    expect(JSON.stringify(events)).not.toContain('CAUCE_TEST_TOKEN_PATH');
    expect(JSON.stringify(events)).not.toContain('/home/dev');
  });
  it('refuses another current human who shares the initiating alias', async () => {
    const other = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('other@example.test','other@example.test',$1,'Other','operator','Steven','auth-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
    if (!other) throw new Error('fixture absent');
    await expect(dependencies().authorize({ ...actor, subject: `console:${other.id}` }, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
});
