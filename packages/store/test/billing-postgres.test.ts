import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProviderStatus, attachProviderSubscription, companyAgentAllowance, createPendingSubscription,
  currentSubscription, findCoupon, readSubscription, recordBillingEvent, redeemCoupon, StoreError, withTransaction, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyActors } from './companies-postgres.fixtures.js';
import { downsThrough } from './migration-downs.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  await seedCompanyActors(admin);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const pending = (company = 'praxis', quantity = 3) =>
  createPendingSubscription(pool, { company_id: company, plan: 'gestionado', quantity, currency: 'COP', amount_local: 1_200_000, created_by: 'owner@example.test' });

describe('billing on PostgreSQL', () => {
  it('creates a pending subscription priced from the plan', async () => {
    const created = await pending();
    expect(created).toMatchObject({
      company_id: 'praxis', plan: 'gestionado', quantity: 3, agent_limit: 3, amount_usd: 300, currency: 'COP',
      amount_local: 1_200_000, status: 'pending', provider: 'mercadopago', provider_subscription_id: null, checkout_url: null,
    });
    expect(await currentSubscription(pool, 'praxis')).toEqual(created);
    expect(await readSubscription(pool, created.id)).toEqual(created);
  });

  it('allows one pending or authorized subscription per company', async () => {
    const first = await pending();
    await expect(pending()).rejects.toMatchObject({ code: 'conflict' });
    await expect(pending('humanizar')).resolves.toMatchObject({ company_id: 'humanizar' });
    await attachProviderSubscription(pool, first.id, { provider_subscription_id: 'mp-1', checkout_url: 'https://mp.example/1' });
    await applyProviderStatus(pool, { id: first.id, provider_subscription_id: 'mp-1', status: 'authorized' });
    await expect(pending()).rejects.toMatchObject({ code: 'conflict' });
    await applyProviderStatus(pool, { id: first.id, provider_subscription_id: 'mp-1', status: 'cancelled' });
    await expect(pending()).resolves.toMatchObject({ status: 'pending' });
  });

  it('attaches the provider id and checkout url once', async () => {
    const created = await pending();
    const attached = await attachProviderSubscription(pool, created.id, { provider_subscription_id: 'mp-1', checkout_url: 'https://mp.example/1' });
    expect(attached).toMatchObject({ provider_subscription_id: 'mp-1', checkout_url: 'https://mp.example/1', status: 'pending' });
    await expect(attachProviderSubscription(pool, created.id, { provider_subscription_id: 'mp-2', checkout_url: 'x' }))
      .rejects.toMatchObject({ code: 'not_found' });
    const other = await pending('humanizar');
    await expect(attachProviderSubscription(pool, other.id, { provider_subscription_id: 'mp-1', checkout_url: 'x' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('applies the re-read status, keeps cancellation final and refuses a foreign provider id', async () => {
    const created = await pending();
    await attachProviderSubscription(pool, created.id, { provider_subscription_id: 'mp-1', checkout_url: 'u' });
    expect(await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-other', status: 'authorized' })).toBeNull();
    expect(await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'mystery' })).toBeNull();
    expect(await applyProviderStatus(pool, { id: '00000000-0000-4000-8000-000000000000', provider_subscription_id: 'mp-1', status: 'authorized' })).toBeNull();
    const authorized = await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'authorized' });
    expect(authorized).toMatchObject({ status: 'authorized' });
    expect(authorized?.last_event_at).not.toBeNull();
    const paused = await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'paused' });
    expect(paused).toMatchObject({ status: 'paused' });
    await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'cancelled' });
    expect(await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'authorized' })).toBeNull();
    expect((await readSubscription(pool, created.id))?.status).toBe('cancelled');
  });

  it('records each provider event once', async () => {
    const created = await pending();
    const event = { provider_event_id: '123', request_id: 'req-1', topic: 'subscription_preapproval', subscription_id: created.id, payload: { data: { id: '123' } } };
    expect(await recordBillingEvent(pool, event)).toBe(true);
    expect(await recordBillingEvent(pool, event)).toBe(false);
    expect(await recordBillingEvent(pool, { ...event, topic: 'payment' })).toBe(true);
    const stored = await admin.query<{ count: number }>('SELECT count(*)::integer AS count FROM billing_events');
    expect(stored.rows).toEqual([{ count: 2 }]);
    await expect(recordBillingEvent(pool, { ...event, provider_event_id: '' })).rejects.toBeInstanceOf(StoreError);
  });

  it('returns the live subscription ahead of an older cancelled one', async () => {
    expect(await currentSubscription(pool, 'praxis')).toBeNull();
    const first = await pending();
    await applyProviderStatus(pool, { id: first.id, provider_subscription_id: 'mp-1', status: 'cancelled' });
    expect((await currentSubscription(pool, 'praxis'))?.status).toBe('cancelled');
    const second = await pending();
    expect((await currentSubscription(pool, 'praxis'))?.id).toBe(second.id);
  });

  it('computes the agent allowance from exemption, subscription and live agents', async () => {
    const baseline = await companyAgentAllowance(pool, 'praxis');
    expect(baseline).toEqual({ exempt: false, limit: 0, used: 2 });
    await admin.query("UPDATE companies SET billing_exempt=true WHERE id='praxis'");
    expect(await companyAgentAllowance(pool, 'praxis')).toEqual({ exempt: true, limit: null, used: 2 });
    await admin.query("UPDATE companies SET billing_exempt=false WHERE id='praxis'");
    const created = await pending('praxis', 5);
    expect((await companyAgentAllowance(pool, 'praxis')).limit).toBe(0);
    await applyProviderStatus(pool, { id: created.id, provider_subscription_id: 'mp-1', status: 'authorized' });
    expect(await companyAgentAllowance(pool, 'praxis')).toEqual({ exempt: false, limit: 5, used: 2 });
    await admin.query("UPDATE agents SET enabled=false,lifecycle_state='retired',retired_at=now() WHERE tenant_id='PraxisTeam'");
    expect((await companyAgentAllowance(pool, 'praxis')).used).toBe(1);
    await expect(companyAgentAllowance(pool, 'nowhere')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not count a person seat without a runtime or the company context director', async () => {
    await admin.query("INSERT INTO agents(tenant_id,alias,display_name,enabled) VALUES('PraxisHub','owner_seat','Owner',false)");
    await admin.query(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('seat@example.test','seat@example.test',$1,'Seat','operator','PraxisHub','owner_seat')`, ['$scrypt$' + 'x'.repeat(48)]);
    await admin.query("INSERT INTO agents(tenant_id,alias,display_name,enabled) VALUES('PraxisHub','director_seat','Director',false)");
    await admin.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias,delivery_source_only)
      VALUES('praxis','director','PraxisHub','director_seat',true)`);
    expect((await companyAgentAllowance(pool, 'praxis')).used).toBe(2);
    await admin.query("INSERT INTO agents(tenant_id,alias,display_name,enabled) VALUES('PraxisHub','draft_agent','Draft',false)");
    expect((await companyAgentAllowance(pool, 'praxis')).used).toBe(3);
  });

  it('redeems a live coupon until it runs out or expires and records it on the subscription', async () => {
    await admin.query(`INSERT INTO billing_coupons(code,percent_off,max_redemptions,expires_at) VALUES
      ('UNO-SOLO',75,1,NULL),('VENCIDO',50,NULL,now()-interval '1 day'),('LIBRE',20,NULL,NULL)`);
    expect(await findCoupon(pool, 'uno-solo')).toEqual({ code: 'UNO-SOLO', percent_off: 75 });
    expect(await findCoupon(pool, 'vencido')).toBeNull();
    expect(await findCoupon(pool, 'x')).toBeNull();
    const coupon = await redeemCoupon(pool, ' Uno-Solo ');
    expect(coupon).toEqual({ code: 'UNO-SOLO', percent_off: 75 });
    expect(await redeemCoupon(pool, 'UNO-SOLO')).toBeNull();
    expect(await redeemCoupon(pool, 'VENCIDO')).toBeNull();
    expect(await redeemCoupon(pool, 'LIBRE')).toEqual({ code: 'LIBRE', percent_off: 20 });
    expect(await redeemCoupon(pool, 'LIBRE')).toEqual({ code: 'LIBRE', percent_off: 20 });
    const created = await createPendingSubscription(pool, { company_id: 'praxis', plan: 'espacio', quantity: 1, currency: 'COP',
      amount_local: 40_000, ...(coupon ? { coupon } : {}) });
    expect(created).toMatchObject({ amount_usd: 10, coupon_code: 'UNO-SOLO', percent_off: 75 });
    await expect(pool.query("UPDATE billing_coupons SET redemptions=redemptions+1 WHERE code='UNO-SOLO'")).rejects.toThrow();
  });

  it('reverts the coupons with down/097 while no discounted subscription is live', async () => {
    await admin.query("INSERT INTO billing_coupons(code,percent_off) VALUES('LIBRE',20)");
    const down = (await downsThrough('097_billing_coupons.sql')).join('\n');
    await withTransaction(admin, client => client.query(down));
    expect((await admin.query("SELECT 1 FROM information_schema.tables WHERE table_name='billing_coupons'")).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM information_schema.columns WHERE table_name='billing_subscriptions' AND column_name IN ('coupon_code','percent_off')")).rowCount).toBe(0);
  });

  it('marks existing companies exempt and later ones not, and reverts with down/096', async () => {
    const exempt = await admin.query<{ id: string; billing_exempt: boolean }>('SELECT id,billing_exempt FROM companies ORDER BY id');
    expect(exempt.rows.find(row => row.id === 'humanizar')?.billing_exempt).toBe(true);
    expect(exempt.rows.find(row => row.id === 'praxis')?.billing_exempt).toBe(false);
    const down = (await downsThrough('096_billing.sql')).join('\n');
    await withTransaction(admin, client => client.query(down));
    expect((await admin.query("SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'billing_%'")).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM information_schema.columns WHERE column_name='billing_exempt'")).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM pg_proc WHERE proname='cauce_runtime_grants_096'")).rowCount).toBe(0);
  });
});
