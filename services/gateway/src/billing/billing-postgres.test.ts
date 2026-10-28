import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, companyAgentAllowance, FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation } from '../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { hashPassword } from '../password.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { buildTestGateway } from '../test-support/gateway-doubles.js';
import { BillingSettings } from './config.js';
import { webhookManifest } from './webhook-signature.js';
import { assertAgentAllowance, PlanLimitError } from './agent-allowance.js';

const PASSWORD = 'billing-company-fixture-password';
const ORIGIN = 'http://localhost';
const SECRET = 'billing-webhook-fixture-secret';
const TOKEN = 'APP_USR-billing-fixture-token';
const WEBHOOK = '/v3/billing/mercadopago/webhook';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let hash: string | undefined;
let app: FastifyInstance;

interface Preapproval { id: string; status: string; external_reference: string; init_point: string }
const provider = new Map<string, Preapproval>();
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const fetchMock = vi.fn<typeof fetch>();

function mercadoPago(): void {
  let sequence = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.Authorization !== `Bearer ${TOKEN}`) return new Response('{}', { status: 401 });
    const id = url.pathname.split('/')[2];
    if (init?.method === 'POST') {
      const body = JSON.parse(text(init.body)) as { external_reference: string };
      sequence += 1;
      const created = { id: `mp${String(sequence)}`, status: 'pending', external_reference: body.external_reference,
        init_point: `https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=mp${String(sequence)}` };
      provider.set(created.id, created);
      return Response.json(created, { status: 201 });
    }
    const found = id === undefined ? undefined : provider.get(id);
    if (!found) return new Response('{}', { status: 404 });
    if (init?.method === 'PUT') found.status = 'cancelled';
    return Response.json(found);
  });
}

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await seedCompanyIsolation(admin);
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  const leon = (await admin.query<{ id: string }>("SELECT id::text FROM console_users WHERE email='leon@example.test'")).rows[0]?.id;
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  provider.clear(); fetchMock.mockReset(); mercadoPago();
  const billing = new BillingSettings({ accessToken: TOKEN, webhookSecret: SECRET, currency: 'COP', usdRate: 4000,
    publicUrl: 'https://consola.example', client: { fetch: fetchMock, baseUrl: 'https://mp.test' } });
  const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 44) });
  app = await buildTestGateway({ pool, authProvider, repository: new CauceRepository(pool), billing,
    fleetOperationsRepository: new FleetOperationsRepository(pool) });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

interface Session { cookie: string; csrf: string }

async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  return { cookie: header?.split(';', 1)[0] ?? '', csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function post(session: Session, url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload }),
    headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
}
function overview(session: Session): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/v3/console/billing', headers: { cookie: session.cookie } });
}
function webhook(dataId: string, body: Record<string, unknown>, options: { ts?: number; requestId?: string; secret?: string } = {}) {
  const ts = String(Math.floor((options.ts ?? Date.now()) / 1000));
  const requestId = options.requestId ?? `request-${dataId}`;
  const v1 = createHmac('sha256', options.secret ?? SECRET).update(webhookManifest(dataId, requestId, ts)).digest('hex');
  return app.inject({ method: 'POST', url: `${WEBHOOK}?data.id=${dataId}&type=subscription_preapproval`, payload: body,
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId } });
}
const createAgent = (alias: string) => ({ resource: 'agent', action: 'create', tenant_id: 'PraxisHub', alias, value: { display_name: alias } });
async function subscriptionStatus(): Promise<string | undefined> {
  return (await pool.query<{ status: string }>("SELECT status FROM billing_subscriptions WHERE company_id='praxis' ORDER BY created_at DESC LIMIT 1"))
    .rows[0]?.status;
}
async function checkout(session: Session, quantity = 3): Promise<Preapproval> {
  const response = await post(session, '/v3/console/billing/checkout', { plan: 'gestionado', quantity });
  expect(response.statusCode).toBe(200);
  const created = [...provider.values()].at(-1);
  if (!created) throw new Error('no preapproval created');
  expect(response.json()).toEqual({ checkout_url: created.init_point });
  return created;
}

describe('billing through the gateway on PostgreSQL', () => {
  it('shows plans and the allowance of the session company to its administrator only', async () => {
    const leon = await login('leon@example.test');
    const response = await overview(leon);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, exempt: false, currency: 'COP', usd_rate: 4000, subscription: null,
      allowance: { limit: 0, used: 2 } });
    expect(response.json<{ plans: unknown[] }>().plans).toEqual([
      { plan: 'gestionado', price_usd: 100, unit: 'agent', agent_limit_per_unit: 1, recommended_quantity: 3 },
      { plan: 'hotel_20', price_usd: 150, unit: 'network', agent_limit_per_unit: 20 },
      { plan: 'hotel_50', price_usd: 300, unit: 'network', agent_limit_per_unit: 50 },
      { plan: 'espacio', price_usd: 40, unit: 'space', agent_limit_per_unit: 5 },
    ]);
    const miguel = await overview(await login('miguel@example.test'));
    expect(miguel.json()).toMatchObject({ exempt: true, allowance: { limit: null } });
    const anonymous = await app.inject({ method: 'GET', url: '/v3/console/billing' });
    expect([401, 403]).toContain(anonymous.statusCode);
  });

  it('checks out in local currency, refuses a second live subscription and needs CSRF', async () => {
    const leon = await login('leon@example.test');
    const withoutCsrf = await app.inject({ method: 'POST', url: '/v3/console/billing/checkout', payload: { plan: 'gestionado', quantity: 3 },
      headers: { cookie: leon.cookie, origin: ORIGIN } });
    expect(withoutCsrf.statusCode).toBe(403);
    expect((await post(leon, '/v3/console/billing/checkout', { plan: 'gestionado', quantity: 51 })).statusCode).toBe(400);
    const created = await checkout(leon);
    const request = JSON.parse(text(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ payer_email: 'leon@example.test', back_url: 'https://consola.example/config?seccion=plan&pago=vuelta',
      auto_recurring: { transaction_amount: 1_200_000, currency_id: 'COP', frequency: 1, frequency_type: 'months' } });
    expect((await pool.query('SELECT status,provider_subscription_id,amount_local::float8 AS amount FROM billing_subscriptions')).rows)
      .toEqual([{ status: 'pending', provider_subscription_id: created.id, amount: 1_200_000 }]);
    expect((await post(leon, '/v3/console/billing/checkout', { plan: 'espacio', quantity: 1 })).statusCode).toBe(409);
    expect((await post(await login('miguel@example.test'), '/v3/console/billing/checkout', { plan: 'espacio', quantity: 1 })).statusCode)
      .toBe(409);
  });

  it('charges the Mercado Pago account the administrator names, never an invalid address', async () => {
    const leon = await login('leon@example.test');
    expect((await post(leon, '/v3/console/billing/checkout', { plan: 'hotel_50', quantity: 1, payer_email: 'no-es-correo' })).statusCode).toBe(400);
    expect((await post(leon, '/v3/console/billing/checkout', { plan: 'hotel_50', quantity: 1, payer_email: 'leon.pagos@correo.test' })).statusCode)
      .toBe(200);
    const request = JSON.parse(text(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ payer_email: 'leon.pagos@correo.test' });
  });

  it('rolls the pending subscription back when Mercado Pago fails', async () => {
    const leon = await login('leon@example.test');
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    const failed = await post(leon, '/v3/console/billing/checkout', { plan: 'hotel_20', quantity: 1 });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain(TOKEN);
    expect((await pool.query('SELECT id FROM billing_subscriptions')).rowCount).toBe(0);
    await checkout(leon, 1);
  });

  it('applies only the status re-read from Mercado Pago, once per event', async () => {
    const created = await checkout(await login('leon@example.test'));
    const claimed = await webhook(created.id, { id: 9001, type: 'subscription_preapproval', action: 'updated', data: { id: created.id },
      status: 'authorized' });
    expect(claimed.statusCode).toBe(200);
    expect(await subscriptionStatus()).toBe('pending');
    provider.set(created.id, { ...created, status: 'authorized' });
    expect((await webhook(created.id, { id: 9002, type: 'subscription_preapproval', data: { id: created.id }, status: 'cancelled' })).statusCode)
      .toBe(200);
    expect(await subscriptionStatus()).toBe('authorized');
    provider.set(created.id, { ...created, status: 'paused' });
    expect((await webhook(created.id, { id: 9002, type: 'subscription_preapproval', data: { id: created.id } })).statusCode).toBe(200);
    expect(await subscriptionStatus()).toBe('authorized');
    expect((await pool.query("SELECT provider_event_id FROM billing_events WHERE topic='subscription_preapproval' ORDER BY id")).rows)
      .toEqual([{ provider_event_id: '9001' }, { provider_event_id: '9002' }]);
    const other = await webhook('unrelated', { id: 9003, type: 'payment', data: { id: 'unrelated' } });
    expect(other.statusCode).toBe(200);
  });

  it('rejects a tampered or expired webhook without recording or applying it', async () => {
    const created = await checkout(await login('leon@example.test'));
    provider.set(created.id, { ...created, status: 'authorized' });
    const calls = fetchMock.mock.calls.length;
    for (const options of [{ secret: 'other-secret' }, { ts: Date.now() - 11 * 60_000 }]) {
      const response = await webhook(created.id, { id: 9100, type: 'subscription_preapproval', data: { id: created.id } }, options);
      expect(response.statusCode).toBe(401);
    }
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect((await pool.query('SELECT id FROM billing_events')).rowCount).toBe(0);
    expect(await subscriptionStatus()).toBe('pending');
  });

  it('refreshes and cancels from the console by re-reading Mercado Pago', async () => {
    const leon = await login('leon@example.test');
    const created = await checkout(leon);
    provider.set(created.id, { ...created, status: 'authorized' });
    const refreshed = await post(leon, '/v3/console/billing/refresh');
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ subscription: { status: 'authorized', agent_limit: 3 } });
    const cancelled = await post(leon, '/v3/console/billing/cancel');
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ subscription: { status: 'cancelled' } });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
    expect((await post(leon, '/v3/console/billing/cancel')).statusCode).toBe(409);
  });

  it('answers 402 plan_limit_reached when a non-exempt company creates past its plan', async () => {
    const leon = await login('leon@example.test');
    const blocked = await post(leon, '/v3/console/config/changes', { dry_run: true, mutation: createAgent('extra_one') });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ error: 'plan_limit_reached', limit: 0, used: 2 });
    const created = await checkout(leon);
    provider.set(created.id, { ...created, status: 'authorized' });
    expect((await post(leon, '/v3/console/billing/refresh')).statusCode).toBe(200);
    const admitted = await post(leon, '/v3/console/config/changes', { dry_run: true, mutation: createAgent('extra_one') });
    expect(admitted.statusCode).toBe(200);
    const batch = await post(leon, '/v3/console/config/changes', { dry_run: true,
      mutation: { resource: 'batch', action: 'apply', mutations: [createAgent('extra_one'), createAgent('extra_two')] } });
    expect(batch.statusCode).toBe(402);
    expect(batch.json()).toMatchObject({ error: 'plan_limit_reached', limit: 3, used: 2 });
  });

  it('answers 402 to a fleet create past the plan and lets an exempt company through', async () => {
    const create = (tenant: string, alias: string) => ({ kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias },
      expected_revision: 0, idempotency_key: `billing-${alias}`, parameters: { runtime_key: `${alias.replace(/_/gu, '-')}-rt`, harness_id: 'codex',
        primary_room_id: 'sala', memberships: [{ room_id: 'sala', role: 'agent' }],
        placement: { host_id: 'praxis-host', mode: 'native', runtime_user: 'runner', home_directory: '/home/runner', state_directory: '/state/x' } } });
    const blocked = await post(await login('leon@example.test'), '/v3/console/fleet/operations', create('PraxisHub', 'fleet_extra'));
    expect(blocked.json()).toMatchObject({ error: 'plan_limit_reached' });
    expect(blocked.statusCode).toBe(402);
    expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
    const exempt = await post(await login('miguel@example.test'), '/v3/console/fleet/operations', create('Miguel', 'fleet_extra'));
    expect(exempt.statusCode).not.toBe(402);
  });

  it('counts a fleet restore of a retired agent against the plan', async () => {
    await admin.query("UPDATE agents SET enabled=false,lifecycle_state='retired',retired_at=now() WHERE tenant_id='PraxisTeam'");
    const restored = await post(await login('leon@example.test'), '/v3/console/fleet/operations', { kind: 'restore',
      target: { resource: 'agent', tenant_id: 'PraxisTeam', alias: 'team_agent' }, expected_revision: 0,
      idempotency_key: 'billing-restore-team', parameters: {} });
    expect(restored.json()).toMatchObject({ error: 'plan_limit_reached' });
    expect(restored.statusCode).toBe(402);
  });

  it('holds a plan slot for a queued fleet create until it runs', async () => {
    const before = await companyAgentAllowance(pool, 'praxis');
    const target = { resource: 'agent', tenant_id: 'PraxisHub', alias: 'queued_one' };
    await admin.query(`INSERT INTO fleet_operations(id,actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,
      idempotency_key,expected_revision,status,steps) VALUES($1,'PraxisHub','leon',$2::jsonb,'agent:PraxisHub/queued_one','billing-cohort','praxis-host',
      'create',$3::jsonb,$4,'billing-queued',0,'queued','[]'::jsonb)`,
    [randomUUID(), JSON.stringify(target), JSON.stringify({ kind: 'create', target, parameters: {} }), 'b'.repeat(64)]);
    const after = await companyAgentAllowance(pool, 'praxis');
    expect(after.used).toBe(before.used + 1);
    await admin.query("UPDATE billing_subscriptions SET agent_limit=$1 WHERE company_id='praxis' AND status='authorized'", [after.used]);
    await expect(assertAgentAllowance(pool, 'praxis', [{ tenant_id: 'PraxisHub', alias: 'queued_one' }])).resolves.toBeUndefined();
    await expect(assertAgentAllowance(pool, 'praxis', [{ tenant_id: 'PraxisHub', alias: 'another_one' }])).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('applies no plan limit while billing is unconfigured', async () => {
    await app.close();
    const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 44) });
    app = await buildTestGateway({ pool, authProvider, repository: new CauceRepository(pool), billing: null,
      fleetOperationsRepository: new FleetOperationsRepository(pool) });
    const leon = await login('leon@example.test');
    expect((await overview(leon)).statusCode).toBe(503);
    const created = await post(leon, '/v3/console/config/changes', { dry_run: true, mutation: createAgent('unbilled_one') });
    expect(created.statusCode).toBe(200);
  });

  it('leaves exempt companies and other companies targets unaffected', async () => {
    const miguel = await login('miguel@example.test');
    const exempt = await post(miguel, '/v3/console/config/changes', { dry_run: true,
      mutation: { resource: 'agent', action: 'create', tenant_id: 'Miguel', alias: 'exempt_extra', value: { display_name: 'exempt' } } });
    expect(exempt.statusCode).toBe(200);
    await expect(assertAgentAllowance(pool, 'humanizar', [{ tenant_id: 'Miguel', alias: 'a' }, { tenant_id: 'Miguel', alias: 'b' }]))
      .resolves.toBeUndefined();
    await expect(assertAgentAllowance(pool, 'praxis', [{ tenant_id: 'Miguel', alias: 'foreign' }])).resolves.toBeUndefined();
    await expect(assertAgentAllowance(pool, 'praxis', [{ tenant_id: 'PraxisTeam', alias: 'team_agent' }])).resolves.toBeUndefined();
    await expect(assertAgentAllowance(pool, 'praxis', [{ tenant_id: 'PraxisTeam', alias: 'new_agent' }])).rejects.toBeInstanceOf(PlanLimitError);
  });
});
