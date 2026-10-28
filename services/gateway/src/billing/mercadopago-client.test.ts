import { describe, expect, it, vi } from 'vitest';
import { configuredBilling } from './config.js';
import { MercadoPagoClient, MercadoPagoError } from './mercadopago-client.js';

const TOKEN = 'APP_USR-fixture-access-token';
const PREAPPROVAL = { id: 'mp123', status: 'pending', external_reference: 'internal-id', init_point: 'https://www.mercadopago.com.co/x', extra: 1 };

function fetchReturning(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function call(mock: ReturnType<typeof fetchReturning>, index = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = mock.mock.calls[index] ?? [];
  return { url: typeof url === 'string' ? url : url instanceof Request ? url.url : (url?.toString() ?? ''), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
}

describe('Mercado Pago REST client', () => {
  it('creates a monthly pending preapproval with bearer token and idempotency key', async () => {
    const mock = fetchReturning(201, PREAPPROVAL);
    const client = new MercadoPagoClient(TOKEN, { fetch: mock, baseUrl: 'https://mp.test/' });
    await expect(client.createPreapproval({ id: 'internal-id', reason: 'Cauce Gestionado x3', payerEmail: 'owner@example.test',
      backUrl: 'https://consola.example/config?seccion=plan&pago=vuelta', amount: 1_200_000, currency: 'COP' }))
      .resolves.toEqual({ id: 'mp123', status: 'pending', external_reference: 'internal-id', init_point: PREAPPROVAL.init_point });
    const { url, init, headers } = call(mock);
    expect(url).toBe('https://mp.test/preapproval');
    expect(init.method).toBe('POST');
    expect(headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'X-Idempotency-Key': 'internal-id', 'Content-Type': 'application/json' });
    expect(JSON.parse(text(init.body))).toEqual({
      reason: 'Cauce Gestionado x3', external_reference: 'internal-id', payer_email: 'owner@example.test',
      back_url: 'https://consola.example/config?seccion=plan&pago=vuelta', status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 1_200_000, currency_id: 'COP' },
    });
  });

  it('reads and cancels a preapproval by its provider id', async () => {
    const mock = fetchReturning(200, { ...PREAPPROVAL, status: 'cancelled', init_point: null });
    const client = new MercadoPagoClient(TOKEN, { fetch: mock });
    await client.getPreapproval('mp123');
    await client.cancelPreapproval('mp123', 'internal-id');
    expect(call(mock, 0)).toMatchObject({ url: 'https://api.mercadopago.com/preapproval/mp123', init: { method: 'GET' } });
    expect(call(mock, 0).headers['X-Idempotency-Key']).toBeUndefined();
    expect(call(mock, 1)).toMatchObject({ url: 'https://api.mercadopago.com/preapproval/mp123', init: { method: 'PUT' } });
    expect(call(mock, 1).headers['X-Idempotency-Key']).toBe('internal-id:cancel');
    expect(JSON.parse(text(call(mock, 1).init.body))).toEqual({ status: 'cancelled' });
    await expect(client.getPreapproval('../users/me')).rejects.toBeInstanceOf(MercadoPagoError);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('fails with the HTTP status only and never echoes the token or the provider body', async () => {
    for (const mock of [fetchReturning(401, { message: `bad token ${TOKEN}` }), fetchReturning(200, { unexpected: TOKEN }),
      vi.fn<typeof fetch>(async () => { throw new Error(`network ${TOKEN}`); })]) {
      const error = await new MercadoPagoClient(TOKEN, { fetch: mock }).getPreapproval('mp123').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MercadoPagoError);
      expect((error as Error).message).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });
});

describe('billing configuration', () => {
  const files: Record<string, string> = { '/run/token': `${TOKEN}\n`, '/run/secret': 'webhook-secret\n', '/run/empty': ' \n' };
  const read = async (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error('ENOENT');
    return value;
  };
  const secrets = { MERCADOPAGO_ACCESS_TOKEN_FILE: '/run/token', MERCADOPAGO_WEBHOOK_SECRET_FILE: '/run/secret' };

  it('stays disabled without either secret, with an unreadable one, or without a rate for a non-USD currency', async () => {
    expect(await configuredBilling({}, read)).toEqual({ reason: 'missing_access_token' });
    expect(await configuredBilling({ MERCADOPAGO_ACCESS_TOKEN_FILE: '/run/token' }, read)).toEqual({ reason: 'missing_webhook_secret' });
    expect(await configuredBilling({ ...secrets, MERCADOPAGO_WEBHOOK_SECRET_FILE: '/run/empty' }, read)).toEqual({ reason: 'unreadable_secret' });
    expect(await configuredBilling({ ...secrets, MERCADOPAGO_ACCESS_TOKEN_FILE: '/run/absent' }, read)).toEqual({ reason: 'unreadable_secret' });
    expect(await configuredBilling(secrets, read)).toEqual({ reason: 'missing_usd_rate' });
    expect(await configuredBilling({ ...secrets, BILLING_USD_RATE: '-3' }, read)).toEqual({ reason: 'invalid_usd_rate' });
    expect(await configuredBilling({ ...secrets, BILLING_CURRENCY: 'pesos' }, read)).toEqual({ reason: 'invalid_currency' });
    expect(await configuredBilling({ ...secrets, BILLING_USD_RATE: '4000', BILLING_PUBLIC_URL: 'http://plain.example' }, read))
      .toEqual({ reason: 'invalid_public_url' });
  });

  it('defaults to COP and the public console, and never serializes a secret', async () => {
    const configured = await configuredBilling({ ...secrets, BILLING_USD_RATE: '4000' }, read);
    if (!('settings' in configured)) throw new Error('billing should be configured');
    const { settings } = configured;
    expect(settings).toMatchObject({ currency: 'COP', usdRate: 4000, publicUrl: 'https://consola.humanizar.tech' });
    expect(settings.backUrl).toBe('https://consola.humanizar.tech/config?seccion=plan&pago=vuelta');
    expect(settings.webhookUrl).toBe('https://consola.humanizar.tech/v3/billing/mercadopago/webhook');
    for (const text of [JSON.stringify(settings), JSON.stringify(settings.provider), String(Object.values(settings))]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('webhook-secret');
    }
    const usd = await configuredBilling({ ...secrets, BILLING_CURRENCY: 'usd' }, read);
    expect('settings' in usd && usd.settings.usdRate).toBe(1);
  });

  it('reads the Mercado Pago fee only when it is a sane surcharge', async () => {
    const base = { ...secrets, BILLING_USD_RATE: '3200' };
    const plain = await configuredBilling(base, read);
    expect('settings' in plain && plain.settings.fee).toBeUndefined();
    const charged = await configuredBilling({ ...base, BILLING_FEE_PERCENT: '3.29', BILLING_FEE_FIXED: '800', BILLING_FEE_VAT: '19' }, read);
    expect('settings' in charged && charged.settings.fee).toEqual({ percent: 3.29, fixed: 800, vat: 19 });
    expect(await configuredBilling({ ...base, BILLING_FEE_PERCENT: 'tres' }, read)).toEqual({ reason: 'invalid_fee' });
    expect(await configuredBilling({ ...base, BILLING_FEE_PERCENT: '60' }, read)).toEqual({ reason: 'invalid_fee' });
  });
});
