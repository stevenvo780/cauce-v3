import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
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
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('auth-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','auth-hub','auth-human','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('auth@example.test','auth@example.test',$1,'Fixture','operator','Steven','auth-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('test human absent');
  actor = { tenant_id: 'Steven', alias: 'auth-human', subject: `console:${human.id}` };
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('auth-main','codex','fixture-external','Steven','env_path','CAUCE_TEST_TOKEN_PATH',true)`);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,container_name,runtime_user,home_directory,state_directory,host_id,primary_account_id,lifecycle_state)
    VALUES('Steven','auth-new','codex','fixture-container','dev','/home/dev','/home/dev/state','isolated','auth-main','auth_pending')`);
  const operation = randomUUID();
  await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision,status)
    VALUES($1,'Steven','auth-human',$2::jsonb,'agent:Steven:auth-new','isolated:dev','isolated','start','{}',$3,'auth-operation-key',0,'awaiting_auth')`,
  [operation, JSON.stringify({ resource: 'agent', tenant_id: 'Steven', alias: 'auth-new' }), 'a'.repeat(64)]);
  await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)",
    [operation, JSON.stringify({ actor_subject: actor.subject })]);
  request = { operation_id: operation, expected_operation_version: 0, request_id: 'auth-request-one',
    provider_id: 'codex', account_id: 'auth-main', harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'auth-main' };
  cleaned = []; cleanupConfirmed = true;
});
afterEach(async () => { await current?.close(); current = undefined; });
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
  it('serializes reservations across instances and rejects stale operation versions', async () => {
    const first = await dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    await expect(dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await first.release();
    await expect(dependencies().reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM fleet_operation_events')).rows[0]?.n).toBe(3);
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
    const events = (await pool.query('SELECT metadata FROM fleet_operation_events')).rows;
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
