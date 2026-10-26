import { randomBytes, sign } from 'node:crypto';
import { FleetOperationRequestSchema } from '@cauce/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companyRevision, createPool, FleetOperationsRepository, hostRequestMessage, withTransaction, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { createConsoleCredentialStamp } from '../console-credential-stamp.js';
import { registerAgentRecoveryRoutes } from '../console/agent-recovery.routes.js';
import type { AgentFactsProbe } from '../console/agent-documents.routes.js';
import { AgentProviderAuthBroker } from './agent-provider-auth-broker.js';
import { registerAgentProviderAuthHostRoute } from './agent-provider-auth-route.js';
import { channelCapabilities, channelCompany, channelHost, type ChannelHost } from './host-channel.fixtures.js';
import { RecoveryPreflightCommandSchema } from './agent-recovery-preflight.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { HostChannelFleetSource, type SignedHostChannel } from './signed-source.js';

let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool; let app: FastifyInstance;
let broker: AgentProviderAuthBroker;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); });
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 }); app = Fastify();
  broker = new AgentProviderAuthBroker(pool); registerAgentProviderAuthHostRoute(app, pool, broker);
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); await pool.end(); await current.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
const result = { status: 'update_required', reason_code: 'runtime_without_shared_tui',
  reason: 'Actualiza la ejecución para activar la sesión compartida.', next_action: 'update' };

function signedRequest(host: ChannelHost, path: string, payload: Record<string, unknown>) {
  const packet = { host_id: host.host_id, company_id: host.company_id, issued_at: Date.now(), nonce: randomBytes(32).toString('hex'), payload, proof: '' };
  const proof = sign(null, Buffer.from(hostRequestMessage('POST', path, packet)), host.keys.privateKey).toString('base64');
  return app.inject({ method: 'POST', url: path, payload: { ...packet, proof } });
}
function exchange(host: ChannelHost, payload: Record<string, unknown>) {
  return signedRequest(host, `/v3/fleet/hosts/${host.host_id}/agent-auth`, payload);
}
async function fixture(preflight = true) {
  const company = await channelCompany(pool, 'recovery-preflight'); const host = await channelHost(pool, company);
  const capabilities = { ...channelCapabilities(), agent_recovery_preflight: preflight };
  await pool.query('UPDATE fleet_host_identities SET capabilities=$2::jsonb,capabilities_seen_at=clock_timestamp() WHERE host_id=$1',
    [host.host_id, JSON.stringify(capabilities)]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,primary_room_id,primary_account_id,enabled,lifecycle_state,
    host_id,runtime_key,runtime_mode,container_name,runtime_user,home_directory,state_directory)
    VALUES($1,'recovery-agent','codex',NULL,$2,false,'draft',$3,'recovery-agent','container','cauce-recovery-agent','dev','/home/dev','/home/dev/.cauce/recovery-agent')`,
  [company.hub.id, `${company.company.id}-account`, host.host_id]);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','recovery-agent','agent')", [company.hub.id]);
  await pool.query("UPDATE agents SET primary_room_id='office',enabled=true,lifecycle_state='ready',systemd_user='dev' WHERE tenant_id=$1 AND alias='recovery-agent'", [company.hub.id]);
  const key = Buffer.alloc(32, 2); const users = new PostgresConsoleUserStore(pool); const user = await users.findById(company.user.id);
  if (!user) throw new Error('Recovery human absent');
  const provider = new PasswordAuthProvider({ users, signingKey: key }); const now = Math.floor(Date.now() / 1000);
  const cookie = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: user.id,
    sid: 'recovery-preflight-session', iat: now, exp: now + 60, csrf: randomBytes(32).toString('base64url'),
    credential_stamp: createConsoleCredentialStamp(key, { userId: user.id, passwordHash: user.password_hash,
      passwordChangedAtUs: user.password_changed_at_us ?? '0' }) });
  registerAgentRecoveryRoutes(app, { pool, authProvider: provider, preflight: broker.recoveryPreflight, probe: {} as AgentFactsProbe });
  const target = { tenant_id: company.hub.id, alias: 'recovery-agent', runtime_key: 'recovery-agent' };
  const path = `/v3/console/tenants/${company.hub.id}/agents/recovery-agent/recovery`;
  return { company, host, target, path, headers: { cookie: `__Host-cauce_session=${cookie}` } };
}
async function requestStarted(f: Awaited<ReturnType<typeof fixture>>) {
  let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
  const request = broker.recoveryPreflight.request.bind(broker.recoveryPreflight);
  vi.spyOn(broker.recoveryPreflight, 'request').mockImplementation((...args) => { const waiting = request(...args); started(); return waiting; });
  const response = app.inject({ method: 'GET', url: f.path, headers: f.headers }).then(value => value);
  await dispatched;
  return { response };
}

describe('authorized fleet recovery query over signed host transport', () => {
  it('releases the pool while waiting, uses no operation and credits the exact signed host response', async () => {
    const f = await fixture(); const waiting = await requestStarted(f);
    expect((await pool.query('SELECT 1 AS available')).rows).toEqual([{ available: 1 }]);
    const outgoing = await exchange(f.host, { action: 'exchange', events: [] }); expect(outgoing.statusCode).toBe(200);
    const command = RecoveryPreflightCommandSchema.parse(outgoing.json<{ recovery_previews: unknown[] }>().recovery_previews[0]);
    expect(command.payload.agent).toMatchObject({ ...f.target, company_id: f.company.company.id, host_id: f.host.host_id, fleet_baseline: false });
    expect(command).not.toHaveProperty('operation_id'); expect(command).not.toHaveProperty('fence');
    const received = await exchange(f.host, { action: 'exchange', events: [], recovery_results: [{ id: command.id, target: f.target, ok: true, result }] });
    expect(received.statusCode).toBe(200);
    const response = await waiting.response; expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ ...result,
      tenant_id: f.target.tenant_id, alias: f.target.alias, transport: 'fleet', in_flight: 0 });
    expect((await pool.query('SELECT count(*)::int AS count FROM fleet_operations')).rows).toEqual([{ count: 0 }]);
  });
  it('rechecks runtime placement and current authority before accepting a stale physical response', async () => {
    const f = await fixture(); const waiting = await requestStarted(f);
    const outgoing = await exchange(f.host, { action: 'exchange', events: [] });
    const command = RecoveryPreflightCommandSchema.parse(outgoing.json<{ recovery_previews: unknown[] }>().recovery_previews[0]);
    await pool.query("UPDATE agents SET model_id='changed-after-request' WHERE tenant_id=$1 AND alias=$2", [f.target.tenant_id, f.target.alias]);
    expect((await exchange(f.host, { action: 'exchange', events: [], recovery_results: [{ id: command.id, target: f.target, ok: true, result }] })).statusCode).toBe(200);
    const response = await waiting.response; expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: 'conflict' });
    expect((await pool.query('SELECT count(*)::int AS count FROM fleet_operations')).rows).toEqual([{ count: 0 }]);
  });
  it('explains a legacy host without a read-only transport and rejects foreign humans before queueing', async () => {
    const f = await fixture(false); const request = vi.spyOn(broker.recoveryPreflight, 'request');
    const response = await app.inject({ method: 'GET', url: f.path, headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ status: 'unsupported', reason_code: 'executor_unavailable', next_action: 'stop_start' });
    expect((await app.inject({ method: 'GET', url: f.path })).statusCode).toBe(403); expect(request).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS count FROM fleet_operations')).rows).toEqual([{ count: 0 }]);
  });
  it('rejects Reiniciar for an agent stopped with Detener in the console query and in the durable store', async () => {
    const f = await fixture(); const request = vi.spyOn(broker.recoveryPreflight, 'request');
    await pool.query("UPDATE agents SET enabled=false,lifecycle_state='draft' WHERE tenant_id=$1 AND alias=$2", [f.target.tenant_id, f.target.alias]);
    const response = await app.inject({ method: 'GET', url: f.path, headers: f.headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict',
      message: 'El agente está detenido. Arráncalo con «Arrancar»: «Reiniciar agente» solo recupera un agente en marcha.' });
    expect(request).not.toHaveBeenCalled();
    const revision = await withTransaction(pool, client => companyRevision(client, f.company.company.id));
    const identity = { generation: 'a'.repeat(64), container_id: 'b'.repeat(64), writer_instance_id: '00000000-0000-4000-8000-0000000000a1' };
    for (const force of [false, true]) {
      await expect(new FleetOperationsRepository(pool).enqueue(f.company.hub.id, 'owner', FleetOperationRequestSchema.parse({ kind: 'recover',
        target: { resource: 'agent', tenant_id: f.target.tenant_id, alias: f.target.alias }, expected_revision: revision,
        idempotency_key: `recovery-stopped-${String(force)}`,
        parameters: { action: 'apply', identity, expected_fingerprint: 'c'.repeat(64), force, strategy: 'relaunch' } }), `console:${f.company.user.id}`))
        .rejects.toMatchObject({ code: 'conflict', message: 'recovery requires an admitted running agent; a stopped agent is started with start' });
    }
    expect((await pool.query('SELECT enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [f.target.tenant_id, f.target.alias])).rows)
      .toEqual([{ enabled: false, lifecycle_state: 'draft' }]);
    expect((await pool.query('SELECT count(*)::int AS count FROM fleet_operations')).rows).toEqual([{ count: 0 }]);
  });
  it.each(['recover', 'update', 'stop'] as const)('retains the typed cause for %s through the signed host source, gateway and durable store', async kind => {
    const f = await fixture(); registerHostChannelRoutes(app, pool);
    const revision = await withTransaction(pool, client => companyRevision(client, f.company.company.id));
    const repository = new FleetOperationsRepository(pool);
    const parameters = kind === 'recover' ? { action: 'probe' } : kind === 'stop' ? {} : {
      runtime_key: f.target.runtime_key, harness_id: 'codex', primary_room_id: 'office', primary_account_id: `${f.company.company.id}-account`,
      memberships: [{ room_id: 'office', role: 'agent' }], placement: { host_id: f.host.host_id, mode: 'container',
        container_name: 'cauce-recovery-agent', runtime_user: 'dev', systemd_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/recovery-agent' } };
    const operation = await repository.enqueue(f.company.hub.id, 'owner', FleetOperationRequestSchema.parse({ kind,
      target: { resource: 'agent', tenant_id: f.target.tenant_id, alias: f.target.alias }, expected_revision: revision,
      idempotency_key: 'recovery-public-failure', parameters }), `console:${f.company.user.id}`);
    const channel = { identity: { host_id: f.host.host_id }, request: async (_method: 'POST', path: string, payload: Record<string, unknown>) => {
      const response = await signedRequest(f.host, path, payload);
      if (response.statusCode !== 200) throw new Error(`Host response ${String(response.statusCode)}`);
      return response.json<unknown>();
    } } as SignedHostChannel;
    const source = new HostChannelFleetSource(channel); const claim = await source.claim('recovery-host', f.host.host_id);
    if (!claim) throw new Error('Recovery claim absent');
    const error = { code: 'STEP_FAILED', step: kind === 'recover' ? 'runtime' : 'stop', retryable: true, reason: 'runtime_identity_mismatch' } as const;
    expect((await source.fail(claim, error)).error).toEqual(error);
    expect((await repository.get(f.company.hub.id, 'owner', operation.id, `console:${f.company.user.id}`)).error)
      .toEqual(error);
  });
});
