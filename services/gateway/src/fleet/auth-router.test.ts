import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, planFleetHostSlices, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { createProviderAuthDependencies, resolveProviderAuthRequest, type ProviderAuthPolicyResolver } from '../console/provider-auth-binding.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthSnapshot } from '../console/provider-auth.types.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { createFleetProviderAuthRouter, type FleetProviderAuthRouterOptions } from './auth-router.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let actor: ProviderAuthActor; let directory: string; let options: FleetProviderAuthRouterOptions;
let operations: Record<string, string>; let router: ReturnType<typeof createFleetProviderAuthRouter>;
let apps: Awaited<ReturnType<typeof startAuthBridge>>[]; let received: Record<string, string>;
let substituted: ProviderAuthSnapshot | undefined;
let emitters: Record<string, ((bytes: Uint8Array) => void) | undefined>;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async ({ task }) => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  substituted = undefined; directory = await mkdtemp(join(tmpdir(), 'auth-router-')); apps = []; received = {}; emitters = {}; operations = {};
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('router-hub','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','router-hub','router-human','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('router@example.test','router@example.test',$1,'Router','operator','Steven','router-human') RETURNING id`, ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('test human absent');
  actor = { tenant_id: 'Steven', alias: 'router-human', subject: `console:${human.id}` };
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','router-human')");
  await pool.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,'Steven','router-human','operator',ARRAY['read','control'])", [human.id]);
  options = { hosts: [] };
  for (const host of ['host-a', 'host-b']) {
    const alias = `router-${host}`; const account = `account-${host}`; const operationId = randomUUID(); operations[host] = operationId;
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$1,'Steven','env_path','CAUCE_TEST_ROUTER_ACCOUNT_PATH',true)`, [account]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,runtime_user,
      home_directory,state_directory,systemd_user,primary_account_id,lifecycle_state)
      VALUES('Steven',$1,$1,'codex',$2,'container',$1,'dev','/home/dev',$3,'stev',$4,'auth_pending')`,
    [alias, host, `/home/dev/.cauce/${alias}`, account]);
    const request = { kind: 'start', target: { resource: 'agent', tenant_id: 'Steven', alias }, parameters: {}, expected_revision: 0, idempotency_key: alias };
    await pool.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,
      idempotency_key,expected_revision,desired_revision,status)
      VALUES($1,'Steven','router-human',$2::jsonb,$3,$4,'controller','start',$5::jsonb,$6,$7,0,0,'awaiting_auth')`,
    [operationId, JSON.stringify(request.target), `agent:Steven:${alias}`, `${host}:dev:${account}`, JSON.stringify(request), 'a'.repeat(64), alias]);
    const row = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [operationId])).rows[0];
    const agent = (await pool.query<{ agent: Record<string, unknown> }>('SELECT to_jsonb(agent) AS agent FROM agents agent WHERE alias=$1', [alias])).rows[0]?.agent;
    if (!row || !agent) throw new Error('test host scope absent');
    await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)",
      [operationId, JSON.stringify({ actor_subject: actor.subject })]);
    await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_completed',$2::jsonb)",
      [operationId, JSON.stringify({ step: 'prepare', prepared_revision: 0, fenced_targets: [request.target], previous_agents: [agent], desired_memberships: [],
        ...(task.name.includes('absent sealed scope') && host === 'host-a' ? {} : { host_slices: planFleetHostSlices(row, [agent], [agent]) }) })]);
    const resolve: ProviderAuthPolicyResolver = async (_client, value) => {
      if (value.agent.host_id !== host) throw new ProviderAuthError('AUTHORITY_REVOKED');
      return { host_id: host, provider_id: 'codex', account_id: account, profile_id: account, harness_id: 'codex', runtime_user: 'dev' };
    };
    received[host] = '';
    const manager = new ProviderAuthManager(createProviderAuthDependencies(pool, resolve, {
      stopAdapter: async () => ({ stopped: true }), cleanup: async () => ({ stopped: true }),
      verify: async () => ({ identity_matches: true, functional_call_verified: true }),
      openLogin: async () => ({ method: 'device', subscribeOutput: output => { emitters[host] = output; return () => { emitters[host] = undefined; }; },
        start: async () => undefined, write: async bytes => { received[host] = (received[host] ?? '') + Buffer.from(bytes).toString(); },
        resize: async () => undefined, close: async () => ({ stopped: true }) }),
    }));
    const service = Object.assign(manager, { resolve: (who: ProviderAuthActor, id: string) => resolveProviderAuthRequest(pool, who, id, resolve) });
    if (task.name.includes('valid foreign operation snapshot') && host === 'host-a') {
      service.start = async () => { if (!substituted) throw new Error('foreign snapshot absent'); return substituted; };
    }
    if (task.name.includes('substituted bridge host') && host === 'host-a') {
      const start = service.start.bind(service);
      service.start = async (who, input) => ({ ...await start(who, input), host_id: 'host-b' });
    }
    const socketPath = join(directory, `${host}.sock`); const policy = { ownerUid: process.geteuid?.() ?? 0 };
    apps.push(await startAuthBridge(socketPath, service, policy));
    options.hosts.push({ host_id: host, socket_path: socketPath, socket_policy: policy });
  }
  router = createFleetProviderAuthRouter(pool, options);
});
afterEach(async () => {
  await router.shutdown(); for (const app of apps) await app.close(); await pool.end(); await current?.close(); current = undefined;
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function operation(host = 'host-a'): string { const id = operations[host]; if (!id) throw new Error('test operation absent'); return id; }
async function open(host = 'host-a') { return router.start(actor, await router.resolve(actor, operation(host))); }
describe('durable provider auth host routing over private Unix sockets with PostgreSQL max1', () => {
  it('resolves and starts on the exact sealed physical host while the controller lives elsewhere', async () => {
    const request = await router.resolve(actor, operation()); expect(request.host_id).toBe('host-a');
    const session = await router.start(actor, request); expect(session).toMatchObject({ host_id: 'host-a', status: 'awaiting_login' });
    expect(pool.totalCount).toBe(1); expect(JSON.stringify(session)).not.toContain(directory);
    await expect(router.start(actor, { ...request, host_id: 'host-b' })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('recovers session host from durable reservation after router recreation and routes terminal tickets on that host', async () => {
    const session = await open(); const fresh = createFleetProviderAuthRouter(pool, options);
    try {
      expect((await fresh.get(actor, session.session_id)).host_id).toBe('host-a');
      const ticket = await fresh.issueSocketTicket(actor, session.session_id);
      await fresh.consumeSocketTicket(actor, session.session_id, ticket.ticket);
      await expect(fresh.consumeSocketTicket(actor, session.session_id, ticket.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
      let output = ''; const channel = await fresh.attach(actor, session.session_id, bytes => { output += Buffer.from(bytes).toString(); });
      await channel.input(Buffer.from('ROUTER_INPUT')); await channel.resize(100, 30); emitters['host-a']?.(Buffer.from('ROUTER_OUTPUT'));
      await expect.poll(() => received['host-a']).toBe('ROUTER_INPUT'); await expect.poll(() => output).toBe('ROUTER_OUTPUT');
      expect(received['host-b']).toBe('');
      expect((await fresh.verify(actor, session.session_id)).status).toBe('authenticated');
      await channel.close();
    } finally { await fresh.shutdown(); }
  });
  it('routes get, cancel and operation revocation to the durable host without a session map', async () => {
    const first = await open(); const second = await open('host-b');
    expect((await router.cancel(actor, first.session_id)).status).toBe('cancelled');
    await router.revokeOperation(operation('host-b'));
    expect(await router.get(actor, second.session_id)).toMatchObject({ status: 'failed', error: 'AUTHORITY_REVOKED', cleanup_pending: false });
  });
  it('rejects an unknown session and a different initiating human before any host receives terminal bytes', async () => {
    await expect(router.get(actor, randomUUID())).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const session = await open();
    await expect(router.get({ ...actor, subject: `console:${randomUUID()}` }, session.session_id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(received).toEqual({ 'host-a': '', 'host-b': '' });
  });
  it('fails closed on an absent sealed scope before contacting a configured physical host', async () => {
    await expect(router.resolve(actor, operation())).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE metadata ? 'provider_auth'")).rowCount).toBe(0);
  });
  it('has no fallback when the exact host socket is unavailable or unconfigured', async () => {
    const first = options.hosts[0]; const second = options.hosts[1]; if (!first || !second) throw new Error('fixture host absent');
    const unavailable = createFleetProviderAuthRouter(pool, { hosts: [{ ...first, socket_path: join(directory, 'missing.sock') }, second] });
    const absent = createFleetProviderAuthRouter(pool, { hosts: [second] });
    try {
      await expect(unavailable.resolve(actor, operation())).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
      await expect(absent.resolve(actor, operation())).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
      expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE metadata ? 'provider_auth'")).rowCount).toBe(0);
    } finally { await unavailable.shutdown(); await absent.shutdown(); }
  });
  it.each([['host_id', 'host-b'], ['runtime_user', 'root'], ['primary_account_id', 'account-host-b'], ['home_directory', '/home/other']])(
    'rejects changed durable %s across every session action instead of following another placement', async (field, value) => {
    const session = await open(); await pool.query(`UPDATE agents SET ${field}=$1 WHERE alias='router-host-a'`, [value]);
    for (const action of [() => router.get(actor, session.session_id), () => router.verify(actor, session.session_id),
      () => router.cancel(actor, session.session_id), () => router.issueSocketTicket(actor, session.session_id),
      () => router.consumeSocketTicket(actor, session.session_id, randomUUID()), () => router.attach(actor, session.session_id, () => undefined)])
      await expect(action()).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(received['host-b']).toBe('');
  });
  it('closes a channel after durable scope drift before forwarding more terminal input', async () => {
    const session = await open(); const channel = await router.attach(actor, session.session_id, () => undefined);
    await channel.input(Buffer.from('BEFORE_DRIFT')); await expect.poll(() => received['host-a']).toBe('BEFORE_DRIFT');
    await pool.query("UPDATE agents SET runtime_user='root' WHERE alias='router-host-a'");
    await expect(channel.input(Buffer.from('AFTER_DRIFT'))).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(received['host-a']).toBe('BEFORE_DRIFT'); expect(received['host-b']).toBe(''); await channel.close();
  });
  it('rejects ambiguous host/socket mappings and invalid private socket policy before sending identity', async () => {
    const first = options.hosts[0]; if (!first) throw new Error('fixture host absent');
    for (const hosts of [[], [first, first], [{ ...first, socket_path: 'relative.sock' }],
      [{ ...first, socket_policy: { ownerUid: -1 } }], [first, { ...first, host_id: 'other-host' }]])
      expect(() => createFleetProviderAuthRouter(pool, { hosts })).toThrowError(new ProviderAuthError('INVALID_REQUEST'));
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE metadata ? 'provider_auth'")).rowCount).toBe(0);
  });
  it('rejects contradictory durable session cohorts instead of accepting the latest host as authority', async () => {
    const session = await open();
    await pool.query("INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'step_completed',$2::jsonb)",
      [operation(), JSON.stringify({ provider_auth: { session_id: session.session_id, actor_subject: actor.subject,
        cohort: JSON.stringify(['host-b', 'dev', 'account-host-a']), expires_at: session.expires_at, state: 'released' } })]);
    await expect(router.get(actor, session.session_id)).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  });
  it('rejects a valid foreign operation snapshot from the same initiating human', async () => {
    substituted = await open('host-b'); const request = await router.resolve(actor, operation());
    await expect(router.start(actor, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect((await router.get(actor, substituted.session_id)).operation_id).toBe(operation('host-b'));
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth'", [operation()])).rowCount).toBe(0);
  });
  it('rejects a substituted bridge host in an otherwise valid session response', async () => {
    await expect(open()).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
});
