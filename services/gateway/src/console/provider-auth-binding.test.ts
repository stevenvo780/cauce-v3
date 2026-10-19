import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, planFleetHostSlices, withTransaction, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { createProviderAuthDependencies, type ProviderAuthPhysicalHooks } from './provider-auth-binding.js';
import type { ProviderAuthRequest } from './provider-auth.types.js';
import { latestProviderAuthReservation, recordProviderAuthReservation, releaseProviderAuthReservation } from './provider-auth-reservation.js';

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
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1, connectionTimeoutMillis: 1000 });
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('auth-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','auth-hub','auth-human','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('auth@example.test','auth@example.test',$1,'Fixture','operator','Steven','auth-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('test human absent');
  await current.adminPool.query("INSERT INTO company_admins(company_id,human_id,role,source) SELECT company_id,id,'admin','v4.0-hub-operator' FROM console_users WHERE id=$1", [human.id]);
  actor = { tenant_id: 'Steven', alias: 'auth-human', subject: `console:${human.id}` };
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','auth-human')");
  if (!task.name.includes('absent human membership')) await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions) VALUES($1,'Steven','auth-human',ARRAY['read','control'])", [human.id]);
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
function dependencies(overrides: Partial<ProviderAuthPhysicalHooks> = {}) {
  const hooks: ProviderAuthPhysicalHooks = {
    stopAdapter: async () => ({ stopped: true }), openLogin: async () => ({ method: 'device', subscribeOutput: () => () => undefined,
      start: async () => undefined, write: async () => undefined, resize: async () => undefined, close: async () => ({ stopped: true }) }),
    verify: async () => ({ identity_matches: true, functional_call_verified: true }),
    cleanup: async (_scope, id) => { cleaned.push(id); return { stopped: cleanupConfirmed }; },
    ...overrides,
  };
  return createProviderAuthDependencies(pool, async () => ({ provider_id: 'codex', account_id: 'auth-main',
    harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'auth-main' }), hooks);
}
async function expireReservation() {
  await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
    SELECT operation_id,version,'step_started',jsonb_set(metadata,'{provider_auth,expires_at}',to_jsonb($2::text))
    FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`,
  [request.operation_id, new Date(Date.now() - 1000).toISOString()]);
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
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM fleet_operation_events')).rows[0]?.n).toBe(5);
  });
  it('requires demonstrated cleanup of an expired reservation before another process may reopen', async () => {
    const prior = randomUUID();
    await dependencies().reserve(actor, request, prior, new Date(Date.now() + 10_000).toISOString());
    await pool.query(`UPDATE fleet_operations SET version=version+1 WHERE id=$1`, [request.operation_id]);
    await expireReservation();
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
  it('leaves the single pool connection and operation locks free while cleanup waits for the host', async () => {
    let started!: () => void; let finish!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const id = randomUUID();
    const reservation = await dependencies({ cleanup: async (_scope, session) => {
      expect(session).toBe(id); cleaned.push(session); started();
      await response; return { stopped: true };
    } }).reserve(actor, request, id, new Date(Date.now() + 10_000).toISOString());
    const releasing = reservation.release();
    try {
      await waiting;
      await withTransaction(pool, async client => {
        expect((await client.query<{ free: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,783003005)) AS free',
          [JSON.stringify([request.host_id, request.runtime_user, request.profile_id])])).rows[0]?.free).toBe(true);
        await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE NOWAIT', [request.operation_id]);
        expect((await latestProviderAuthReservation(client, request.operation_id))?.state).toBe('releasing');
      });
      await expect(reservation.release()).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
      await expect(reservation.verify(new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
      const version = (await pool.query<{ version: string }>('SELECT version FROM fleet_operations WHERE id=$1', [request.operation_id])).rows[0];
      await expect(dependencies().reserve(actor, { ...request, expected_operation_version: Number(version?.version) }, randomUUID(),
        new Date(Date.now() + 10_000).toISOString())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    } finally { finish(); await releasing; }
    await reservation.release(); expect(cleaned).toEqual([id]);
  });
  it('cleans an expired reservation outside transactions before reserving its replacement', async () => {
    const prior = randomUUID();
    await dependencies().reserve(actor, request, prior, new Date(Date.now() + 10_000).toISOString());
    await expireReservation();
    const version = (await pool.query<{ version: string }>('SELECT version FROM fleet_operations WHERE id=$1', [request.operation_id])).rows[0];
    let started!: () => void; let finish!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const reserving = dependencies({ cleanup: async (_scope, session) => {
      if (session === prior) { started(); await response; }
      return { stopped: true };
    } }).reserve(actor, { ...request, expected_operation_version: Number(version?.version) }, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    try {
      await waiting;
      await withTransaction(pool, async client => {
        await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE NOWAIT', [request.operation_id]);
        expect((await latestProviderAuthReservation(client, request.operation_id))?.state).toBe('releasing');
      });
    } finally { finish(); }
    await (await reserving).release();
  });
  it('fences a late cleanup result from a different current session', async () => {
    let started!: () => void; let finish!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const reservation = await dependencies({ cleanup: async () => { started(); await response; return { stopped: true }; } })
      .reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    const releasing = reservation.release();
    const outcome = expect(releasing).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    const successor = randomUUID();
    try {
      await waiting;
      await withTransaction(pool, async client => {
        const previous = await latestProviderAuthReservation(client, request.operation_id);
        if (!previous) throw new Error('reservation absent');
        await recordProviderAuthReservation(client, request.operation_id, 'step_started', { ...previous, session_id: successor, state: 'reserved' });
      });
    } finally { finish(); }
    await outcome;
    expect((await withTransaction(pool, client => latestProviderAuthReservation(client, request.operation_id)))?.session_id).toBe(successor);
  });
  it('fences the result of an expired cleanup claim for the same session', async () => {
    let firstStarted!: () => void; let secondStarted!: () => void;
    let firstFinish!: () => void; let secondFinish!: () => void; let calls = 0;
    const firstWaiting = new Promise<void>(resolve => { firstStarted = resolve; });
    const secondWaiting = new Promise<void>(resolve => { secondStarted = resolve; });
    const firstResponse = new Promise<void>(resolve => { firstFinish = resolve; });
    const secondResponse = new Promise<void>(resolve => { secondFinish = resolve; });
    const reservation = await dependencies({ cleanup: async () => {
      calls += 1;
      if (calls === 1) { firstStarted(); await firstResponse; } else { secondStarted(); await secondResponse; }
      return { stopped: true };
    } }).reserve(actor, request, randomUUID(), new Date(Date.now() + 10_000).toISOString());
    const firstRelease = expect(reservation.release()).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await firstWaiting;
    await withTransaction(pool, async client => {
      const previous = await latestProviderAuthReservation(client, request.operation_id);
      if (!previous) throw new Error('reservation absent');
      await recordProviderAuthReservation(client, request.operation_id, 'step_started',
        { ...previous, release_until: new Date(Date.now() - 1000).toISOString() }, false);
    });
    const secondRelease = reservation.release();
    try {
      await secondWaiting; firstFinish(); await firstRelease;
      expect((await withTransaction(pool, client => latestProviderAuthReservation(client, request.operation_id)))?.state).toBe('releasing');
    } finally { firstFinish(); secondFinish(); await secondRelease; }
    await reservation.release(); expect(calls).toBe(2);
    expect((await pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM fleet_operation_events
      WHERE operation_id=$1 AND metadata->'provider_auth'->>'state'='released'`, [request.operation_id])).rows[0]?.n).toBe(1);
  });
  it('keeps release and its durable result atomic when recording the result fails', async () => {
    const id = randomUUID();
    const reservation = await dependencies().reserve(actor, request, id, new Date(Date.now() + 10_000).toISOString());
    const cohort = JSON.stringify([request.host_id, request.runtime_user, request.profile_id]);
    await expect(releaseProviderAuthReservation(pool, request.operation_id, cohort, id, async () => ({ stopped: true }),
      async () => { throw new Error('result recording unavailable'); })).rejects.toThrow('result recording unavailable');
    expect((await withTransaction(pool, client => latestProviderAuthReservation(client, request.operation_id)))?.state).toBe('releasing');
    await expect(reservation.release()).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  });
});
