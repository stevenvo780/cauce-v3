import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, type DatabasePool, type RegisteredCompany } from '@cauce/store';
import { AgentQuotaClaimSchema, AgentQuotaExecutionSchema, type AgentQuotaClaim } from '@cauce/protocol';
import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { channelCapabilities, channelCompany, channelHost, channelPacket, channelPost, type ChannelHost } from '../../services/gateway/src/fleet/host-channel.fixtures.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { buildTestGateway } from '../../services/gateway/src/test-support/gateway-doubles.js';

const PASSWORD = 'agent-quota-fixture-password';
const ORIGIN = 'http://localhost';
let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool; let admin: DatabasePool;
let app: FastifyInstance; let north: RegisteredCompany; let south: RegisteredCompany;
let host: ChannelHost; let other: ChannelHost; let session: { cookie: string; csrf: string };
let passwordHash: string | undefined; let approvals: string | undefined;
const descriptors = new URL('../../packages/adapter-sdk/descriptors/', import.meta.url);
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); });
beforeEach(async () => {
  // Quota readers exist only for owner-approved descriptors: pin the packaged codex descriptor, never openclaw.
  approvals = await mkdtemp(join(tmpdir(), 'zz-canary-agent-quota-approvals-'));
  const approvalsFile = join(approvals, 'approvals.json');
  const codex = await readFile(new URL('codex.json', descriptors));
  await writeFile(approvalsFile, JSON.stringify({ codex: createHash('sha256').update(codex).digest('hex') }), { mode: 0o600 });
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', approvalsFile);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', fileURLToPath(descriptors).replace(/\/$/u, ''));
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  north = await channelCompany(pool, 'north'); south = await channelCompany(pool, 'south');
  host = await channelHost(pool, north); other = await channelHost(pool, south);
  for (const company of [north, south]) {
    await admin.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,host_id,runtime_mode,container_name,
      runtime_user,home_directory,state_directory,runtime_key,systemd_user,lifecycle_state)
      VALUES($1,'worker','codex',true,$2,'container',$3,'dev','/home/dev','/home/dev/.cauce/worker',$4,'stev','ready')`,
    [company.hub.id, `${company.company.id}-host`, `cauce-${company.company.id}-worker`, `${company.company.id}-worker`]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','worker','agent')", [company.hub.id]);
  }
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await admin.query('UPDATE console_users SET password_hash=$1 WHERE id=ANY($2::uuid[])', [passwordHash, [north.user.id, south.user.id]]);
  app = await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 47),
  }) });
  for (const enrolled of [host, other]) {
    expect((await channelPost(app, enrolled, channelCapabilities())).statusCode).toBe(200);
  }
  const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: north.user.email, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  session = { cookie: cookie?.split(';', 1)[0] ?? '', csrf: login.json<{ csrf_token: string }>().csrf_token };
});
afterEach(async () => {
  await app.close(); await current.close();
  vi.unstubAllEnvs(); if (approvals) await rm(approvals, { recursive: true, force: true }); approvals = undefined;
});
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
const path = (company = north, alias = 'worker') => `/v3/console/agents/${company.hub.id}/${alias}/quota`;
const read = (company = north, alias = 'worker') => app.inject({ method: 'GET', url: path(company, alias), headers: { cookie: session.cookie } });
const query = (payload: Record<string, unknown>, company = north) => app.inject({ method: 'POST', url: path(company), payload,
  headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
async function enqueue(key = 'agent-quota-request'): Promise<LightMyRequestResponse> {
  const card = await read(); expect(card.statusCode).toBe(200);
  return query({ expected_revision: card.json<{ revision: number }>().revision, idempotency_key: key });
}
async function claim(): Promise<AgentQuotaClaim> {
  expect((await enqueue()).statusCode).toBe(202);
  const response = await channelPost(app, host, { resource: 'agent_quota', action: 'claim' });
  expect(response.statusCode).toBe(200);
  return AgentQuotaClaimSchema.parse(response.json<{ claim: unknown }>().claim);
}
async function receipt(fence: AgentQuotaClaim) {
  const response = await channelPost(app, host, { resource: 'agent_quota', action: 'execution', claim: fence });
  expect(response.statusCode).toBe(200);
  const execution = AgentQuotaExecutionSchema.parse(response.json());
  return { status: 'measured', operation_id: execution.operation_id, tenant: execution.agent.tenant_id, alias: execution.agent.alias,
    host_id: execution.agent.host_id, container_name: execution.agent.container_name, harness: execution.agent.harness_id,
    captured_at: new Date().toISOString(), provider: 'codex', observation_status: 'ok',
    identity_hash: createHash('sha256').update(JSON.stringify(['codex', 'north-observed-account'])).digest('hex'),
    provider_report: { provider: 'codex', ok: true, available: true,
      windows: [{ group_key: 'default', window_key: 'week', used_percent: 12, remaining_percent: 88 }] } };
}
async function counts() {
  return (await admin.query<{ operations: number; collections: number; bindings: number }>(`SELECT (SELECT count(*)::int FROM agent_quota_operations) AS operations,
    (SELECT count(*)::int FROM quota_collections) AS collections,(SELECT count(*)::int FROM agent_account_bindings) AS bindings`)).rows[0];
}

describe('durable agent quota through real browser sessions and signed company hosts', () => {
  it.each(['missing', 'stale', 'unavailable', 'inactive'])('rejects new quota work for a %s computer without queue effects', async state => {
    if (state === 'missing') await admin.query('DELETE FROM fleet_host_identities WHERE host_id=$1', [host.host_id]);
    if (state === 'stale') await admin.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1", [host.host_id]);
    if (state === 'unavailable') await admin.query("UPDATE fleet_host_identities SET capabilities=jsonb_set(capabilities,'{fleet_executor}','false') WHERE host_id=$1", [host.host_id]);
    if (state === 'inactive') await admin.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [host.host_id]);
    const before = await counts();
    const card = await read();
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ reader_available: true, can_query: false, reason: 'quota_host_unavailable', status: 'unknown' });
    const rejected = await enqueue(`unavailable-computer-${state}`);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: 'quota_host_unavailable' });
    expect(await counts()).toEqual(before);
  });
  it('returns unknown for its own agent and identical 404s for foreign and absent targets without queue effects', async () => {
    expect((await read()).json()).toMatchObject({ tenant_id: north.hub.id, alias: 'worker', status: 'unknown', reader_available: true });
    const before = await counts();
    const foreign = await read(south); const absent = await read(north, 'missing');
    expect(foreign.statusCode).toBe(404); expect(foreign.body).toBe(absent.body);
    expect((await query({ expected_revision: 0, idempotency_key: 'foreign-agent-quota' }, south)).statusCode).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it('requires CSRF/control, rejects commands and stale revisions, and enqueues one operation per idempotency key', async () => {
    const body = { expected_revision: 0, idempotency_key: 'agent-quota-idempotency' };
    expect((await app.inject({ method: 'POST', url: path(), payload: body, headers: { cookie: session.cookie, origin: ORIGIN } })).statusCode).toBe(403);
    expect((await query({ ...body, command: 'bash', refresh_own_session: true })).statusCode).toBe(400);
    expect((await query({ ...body, expected_revision: 999 })).statusCode).toBe(409);
    const [first, second] = await Promise.all([query(body), query(body)]);
    expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202);
    expect(first.json<{ operation_id: string }>().operation_id).toBe(second.json<{ operation_id: string }>().operation_id);
    expect(await counts()).toMatchObject({ operations: 1, collections: 0, bindings: 0 });
    expect((await query({ ...body, expected_revision: 1 })).statusCode).toBe(409);
    await admin.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [north.user.id]);
    expect((await query({ ...body, idempotency_key: 'forbidden-agent-quota' })).statusCode).toBe(403);
  });

  it('renews, executes, binds and reads a durable receipt, accepts identical replay and rejects altered results', async () => {
    const fence = await claim();
    expect((await channelPost(app, other, { resource: 'agent_quota', action: 'claim' })).json()).toEqual({ claim: null });
    expect((await channelPost(app, other, { resource: 'agent_quota', action: 'execution', claim: fence })).statusCode).toBe(403);
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'renew', claim: fence })).json()).toEqual({ renewed: true });
    const measured = await receipt(fence);
    const packet = { resource: 'agent_quota', action: 'finish', claim: fence, receipt: measured };
    expect((await channelPost(app, host, packet)).statusCode).toBe(200);
    const before = await counts(); expect(before).toEqual({ operations: 1, collections: 1, bindings: 1 });
    expect((await channelPost(app, host, packet)).statusCode).toBe(200); expect(await counts()).toEqual(before);
    expect((await channelPost(app, host, { ...packet, receipt: { ...measured, captured_at: new Date(Date.now() + 1_000).toISOString() } })).statusCode).toBe(409);
    expect((await channelPost(app, other, packet)).statusCode).toBe(403);
    const card = await read(); expect(card.headers['cache-control']).toBe('no-store');
    expect(card.json()).toMatchObject({ status: 'ok', captured_at: measured.captured_at, operation: { status: 'done' } });
    expect(card.json<{ binding: { account_id: string } }>().binding.account_id).toMatch(/^qa_[a-f0-9]{32}$/u);
    expect(card.body).not.toContain(measured.identity_hash);
  });

  it('persists an explicit unsupported card and never dispatches a reader for an unsupported harness', async () => {
    await admin.query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias='worker'", [north.hub.id]);
    const card = await read(); expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ status: 'unsupported', reader_available: false, can_query: false, reason: 'quota_reader_unavailable' });
    expect((await read()).json()).toMatchObject({ status: 'unsupported' });
    expect((await enqueue('unsupported-agent-quota')).json()).toMatchObject({ error: 'quota_reader_unavailable', status: 'unsupported', operation_id: null });
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'claim' })).json()).toEqual({ claim: null });
  });

  it('fences expired and replaced claims without committing any stale measurement', async () => {
    const first = await claim(); const measured = await receipt(first);
    await admin.query("UPDATE agent_quota_operations SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'finish', claim: first, receipt: measured })).statusCode).toBe(403);
    const replacement = AgentQuotaClaimSchema.parse((await channelPost(app, host, { resource: 'agent_quota', action: 'claim' })).json<{ claim: unknown }>().claim);
    expect(replacement.claim_epoch).toBe(first.claim_epoch + 1);
    for (const changed of [first, { ...replacement, worker_id: 'fabricated-worker' }, { ...replacement, claim_token: randomUUID() }]) {
      expect((await channelPost(app, host, { resource: 'agent_quota', action: 'renew', claim: changed })).statusCode).toBe(403);
    }
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'renew', claim: replacement })).json()).toEqual({ renewed: true });
    expect(await counts()).toMatchObject({ collections: 0, bindings: 0 });
  });

  it('rolls back signed nonce consumption when receipt validation fails and rejects arbitrary host actions', async () => {
    const fence = await claim(); const measured = await receipt(fence);
    const wrong = channelPacket(host, { resource: 'agent_quota', action: 'finish', claim: fence,
      receipt: { ...measured, alias: 'other' } });
    expect((await app.inject({ method: 'POST', url: `/v3/fleet/hosts/${host.host_id}/channel`, payload: wrong })).statusCode).toBe(422);
    expect((await admin.query('SELECT nonce FROM fleet_host_request_nonces WHERE host_id=$1 AND nonce=$2', [host.host_id, wrong.nonce])).rows).toEqual([]);
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'refresh_own_session', claim: fence })).statusCode).toBe(400);
    expect(await counts()).toMatchObject({ collections: 0, bindings: 0 });
  });

  it.each(['human', 'placement'])('persists invalidated %s authority through signed finish and fences the rejected claim', async invalidated => {
    const fence = await claim(); const measured = await receipt(fence);
    if (invalidated === 'human') {
      await admin.query("UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1", [north.user.id]);
    } else {
      await admin.query("UPDATE agents SET container_name='cauce-replaced' WHERE tenant_id=$1 AND alias='worker'", [north.hub.id]);
    }
    const signed = channelPacket(host, { resource: 'agent_quota', action: 'finish', claim: fence, receipt: measured });
    expect((await app.inject({ method: 'POST', url: `/v3/fleet/hosts/${host.host_id}/channel`, payload: signed })).statusCode).toBe(409);
    expect((await admin.query<{ status: string; error_code: string }>('SELECT status,error_code FROM agent_quota_operations WHERE id=$1', [fence.id])).rows)
      .toEqual([{ status: 'failed', error_code: invalidated === 'human' ? 'AUTHORITY_REVOKED' : 'SCOPE_CHANGED' }]);
    expect((await admin.query('SELECT nonce FROM fleet_host_request_nonces WHERE host_id=$1 AND nonce=$2', [host.host_id, signed.nonce])).rowCount).toBe(1);
    await admin.query('UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL WHERE human_id=$1', [north.user.id]);
    await admin.query("UPDATE agents SET container_name='cauce-north-worker' WHERE tenant_id=$1 AND alias='worker'", [north.hub.id]);
    expect((await channelPost(app, host, { resource: 'agent_quota', action: 'finish', claim: fence, receipt: measured })).statusCode).toBe(409);
    expect(await counts()).toMatchObject({ collections: 0, bindings: 0 });
  });

  it('persists bounded failure receipts and rejects changed terminal errors', async () => {
    const fence = await claim();
    const failed = { resource: 'agent_quota', action: 'fail', claim: fence, code: 'RUNTIME_UNAVAILABLE' };
    expect((await channelPost(app, host, failed)).statusCode).toBe(200);
    expect((await channelPost(app, host, failed)).statusCode).toBe(200);
    expect((await channelPost(app, host, { ...failed, code: 'STEP_FAILED' })).statusCode).toBe(409);
    expect((await read()).json()).toMatchObject({ status: 'failed', operation: { status: 'failed' } });
    expect(await counts()).toMatchObject({ collections: 0, bindings: 0 });
  });
});
