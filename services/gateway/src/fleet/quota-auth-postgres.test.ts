import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQuotaAccount, QuotaEnvironmentRepository, QuotaOperationsRepository, type DatabasePool, type QuotaOperationClaim } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import type { ProviderAuthLogin, ProviderAuthRequest } from '../console/provider-auth.types.js';
import { channelCompany, channelHost, companySource } from './host-channel.fixtures.js';
import { SignedHostChannel } from './signed-source.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { HostChannelQuotaRepository } from './quota-executor.js';
import { QuotaAuthBroker, registerQuotaAuthHostRoute } from './quota-auth-broker.js';
import { QuotaHostAuthentication } from './quota-auth-host.js';
import type { QuotaEffect } from './quota-host-command.js';

let database: TestDatabase; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let app: FastifyInstance | undefined; let directory: string | undefined; let hostRuntime: QuotaHostAuthentication | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => { current = await startTestCaseDatabase(database); pool = current.pool; });
afterEach(async () => { await hostRuntime?.shutdown(); await app?.close(); if (directory) await rm(directory, { recursive: true, force: true });
  await current?.close(); app = undefined; directory = undefined; hostRuntime = undefined; });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
async function fixture(options: { verificationFails?: boolean } = {}) {
  const company = await channelCompany(pool, 'quota-auth-fixture');
  const host = await channelHost(pool, company);
  const broker = new QuotaAuthBroker(pool);
  app = Fastify(); registerHostChannelRoutes(app, pool); registerQuotaAuthHostRoute(app, pool, broker);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing');
  directory = await mkdtemp(join(tmpdir(), 'cauce-quota-auth-'));
  await writeFile(join(directory, 'private.pem'), host.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ enrollment_id: '22000000-0000-4000-8000-000000000001',
    company_id: host.company_id, host_id: host.host_id, gateway: `http://127.0.0.1:${String(address.port)}`,
    state: 'enrolled', executor_ready: false,
    key_fingerprint: createHash('sha256').update(host.keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') }), { mode: 0o600 });
  const channel = await SignedHostChannel.load(directory);
  const repository = new HostChannelQuotaRepository(channel, host.host_id);
  const environments = new QuotaEnvironmentRepository(pool, { approvedHostIds: [host.host_id], providers: ['codex'] });
  const account = await createQuotaAccount(pool, companySource(company), { provider: 'codex', label: 'Synthetic unverified account', idempotency_key: 'synthetic-account' });
  expect((await pool.query<{ enabled: boolean }>('SELECT enabled FROM provider_accounts WHERE id=$1', [account.account_id])).rows[0]?.enabled).toBe(false);
  const created = await environments.create(companySource(company), { account_id: account.account_id,
    host_id: host.host_id, label: 'Synthetic auth witness', idempotency_key: 'synthetic-environment' });
  const worker = new QuotaOperationsRepository(pool);
  const createClaim = await worker.claim(`host-${host.host_id}`, host.host_id); if (!createClaim) throw new Error('create claim missing');
  await worker.finish(createClaim, { runtime_verified: true, container_name: `cauce-quota-${created.environment.id.replaceAll('-', '')}` });
  const environment = (await environments.list(companySource(company))).environments[0]; if (!environment) throw new Error('environment missing');
  await environments.action(companySource(company), environment.id, { action: 'authenticate', consent: true,
    expected_version: environment.version, idempotency_key: 'synthetic-auth' });
  const claim = await repository.claim('ignored', host.host_id); if (!claim) throw new Error('auth claim missing');
  const execution = await repository.execution(claim);
  const plan: NonNullable<QuotaEffect['login_plan']> = { operation_id: claim.id, account_scope: execution.environment.account_id,
    command: ['/usr/local/bin/codex', 'login', '--device-auth'], home: '/home/node', cwd: '/home/node', runtime_user: 'node',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, backend: 'container', state_root: '/fixture/quota-login', ttl_seconds: 600,
    container_binding: { container_id: 'a'.repeat(64), generation: 'b'.repeat(64), image_digest: 'sha256:' + 'c'.repeat(64),
      python: '/usr/bin/python3', helper: '/cauce/executor/provider-login.py' } };
  let listener: ((bytes: Uint8Array) => void) | undefined; let started = 0; let stopped = 0; const inputs: string[] = [];
  const login: ProviderAuthLogin = { method: 'device', subscribeOutput: callback => { listener = callback; return () => { listener = undefined; }; },
    start: async () => { started++; listener?.(Buffer.from('Synthetic provider prompt\n')); },
    write: async bytes => { inputs.push(Buffer.from(bytes).toString()); }, resize: async () => undefined,
    close: async () => { stopped++; return { stopped: true }; } };
  hostRuntime = new QuotaHostAuthentication(channel, repository, { host: host.host_id, projectRoot: '/fixture',
    command: { python: '/usr/bin/python3', executable: '/fixture/fleet-executor.py', policyFile: '/fixture/policy.json' },
    loginConfiguration: async packet => ({ python: '/usr/bin/python3', helper: { executable: '/fixture/helper.py', sha256: 'a'.repeat(64) },
      stateRoot: packet.state_root, packet, method: 'device' }), createLogin: async () => login,
    verify: async () => {
      if (options.verificationFails) throw new Error('Synthetic verification failure');
      return { authenticated_verified: true, account_identity: 'SYNTHETIC_IDENTITY_NOT_PROVIDER_ACCEPTANCE' };
    } });
  const handle = await hostRuntime.begin(execution, plan, claim, new AbortController().signal);
  await repository.finish(claim, handle.public_result, true);
  const actor = { tenant_id: company.hub.id, alias: 'owner', subject: `console:${company.user.id}` };
  if (!broker.service.resolve) throw new Error('resolver missing');
  const request = await broker.service.resolve(actor, claim.id);
  return { broker, repository, request, actor, host, claim, handle, login, inputs, state: () => ({ started, stopped }) };
}
describe('quota authentication over real signed HTTP and runtime PostgreSQL', () => {
  it('rejects another selected company even when the requester is a platform administrator', async () => {
    const f = await fixture(); const other = await channelCompany(pool, 'quota-auth-company-selection');
    if (!current) throw new Error('test database missing');
    await current.adminPool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [f.actor.subject.slice(8)]);
    await expect(f.broker.service.resolve?.({ ...f.actor, requestedCompany: other.company.id }, f.claim.id))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect(f.broker.service.start({ ...f.actor, requestedCompany: other.company.id }, f.request))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(f.state().started).toBe(0); expect(f.inputs).toEqual([]);
  }, 30_000);
  it('fails durably after provider verification rejects, confirms stop and never requeues authentication', async () => {
    const f = await fixture({ verificationFails: true });
    const session = await f.broker.service.start(f.actor, f.request);
    await f.broker.service.attach(f.actor, session.session_id, () => undefined);
    expect(await f.broker.service.verify(f.actor, session.session_id)).toMatchObject({ status: 'failed', cleanup_pending: false });
    await f.handle.close();
    expect(f.state().stopped).toBeGreaterThan(0);
    expect((await pool.query<{ status: string; error_code: string }>(
      'SELECT status,error_code FROM quota_environment_operations WHERE id=$1', [f.claim.id])).rows)
      .toEqual([{ status: 'failed', error_code: 'STEP_FAILED' }]);
    expect(await f.repository.claim('ignored', f.host.host_id)).toBeNull();
    expect((await pool.query<{ status: string }>('SELECT status FROM quota_environments WHERE id=$1', [f.claim.environment_id])).rows)
      .toEqual([{ status: 'failed' }]);
  }, 30_000);
  it('reuses private terminal commands, requires provider proof and persists the fenced result', async () => {
    const f = await fixture();
    const session = await f.broker.service.start(f.actor, f.request);
    expect(session).toMatchObject({ status: 'awaiting_login', operation_id: f.claim.id, host_id: f.host.host_id });
    expect(f.state().started).toBe(0);
    const output: string[] = [];
    const terminal = await f.broker.service.attach(f.actor, session.session_id, bytes => { output.push(Buffer.from(bytes).toString()); });
    await terminal.input(Buffer.from('SYNTHETIC_PRIVATE_INPUT'));
    expect(f.inputs).toEqual(['SYNTHETIC_PRIVATE_INPUT']);
    expect(output.join('')).toContain('Synthetic provider prompt');
    expect(await f.broker.service.verify(f.actor, session.session_id)).toMatchObject({ status: 'authenticated', cleanup_pending: false });
    const row = (await pool.query<{ status: string; result: unknown }>('SELECT status,result FROM quota_environment_operations WHERE id=$1', [f.claim.id])).rows[0];
    expect(row?.status).toBe('done');
    expect(JSON.stringify(row?.result)).not.toContain('SYNTHETIC_PRIVATE_INPUT');
    expect(JSON.stringify(row?.result)).not.toContain('SYNTHETIC_IDENTITY_NOT_PROVIDER_ACCEPTANCE');
    expect(f.state()).toMatchObject({ started: 1 });
  }, 30_000);
  it('denies another human and changed scope before opening or forwarding input', async () => {
    const f = await fixture(); const foreign = await channelCompany(pool, 'quota-auth-foreign');
    await expect(f.broker.service.start({ tenant_id: foreign.hub.id, alias: 'owner', subject: `console:${foreign.user.id}` }, f.request))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const changed: ProviderAuthRequest = { ...f.request, host_id: 'other-host', request_id: 'other-scope' };
    await expect(f.broker.service.start(f.actor, changed)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(f.state().started).toBe(0); expect(f.inputs).toEqual([]);
  }, 30_000);
  it('fences replayed authentication registration and closes sessions on host revocation', async () => {
    const f = await fixture();
    const wrong: QuotaOperationClaim = { ...f.claim, claim_epoch: f.claim.claim_epoch + 1 };
    await expect(f.repository.resumeAuthentication(wrong)).rejects.toThrow();
    const session = await f.broker.service.start(f.actor, f.request);
    await pool.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [f.host.host_id]);
    await expect(f.broker.service.get(f.actor, session.session_id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await f.handle.close(); expect(f.state().stopped).toBeGreaterThan(0);
    expect((await pool.query<{ status: string }>('SELECT status FROM quota_environment_operations WHERE id=$1', [f.claim.id])).rows[0]?.status).not.toBe('done');
  }, 30_000);
});
