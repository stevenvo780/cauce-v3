import { readFile } from 'node:fs/promises';
import { validProcessingFee, type ProcessingFee } from '@cauce/store';
import { MercadoPagoClient, type MercadoPagoClientOptions } from './mercadopago-client.js';
import { verifyWebhookSignature, type WebhookSignatureInput } from './webhook-signature.js';

export const DEFAULT_BILLING_CURRENCY = 'COP';
export const DEFAULT_BILLING_PUBLIC_URL = 'https://consola.humanizar.tech';

export type BillingDisabledReason =
  | 'missing_access_token' | 'missing_webhook_secret' | 'unreadable_secret' | 'invalid_currency' | 'missing_usd_rate' | 'invalid_usd_rate'
  | 'invalid_public_url' | 'invalid_fee';

export interface BillingSettingsInput {
  readonly accessToken: string;
  readonly webhookSecret: string;
  readonly currency: string;
  readonly usdRate: number;
  readonly publicUrl: string;
  readonly fee?: ProcessingFee | undefined;
  readonly client?: MercadoPagoClientOptions;
}

/** Holds both secrets in private fields so serializing or logging the settings never exposes them. */
export class BillingSettings {
  readonly currency: string;
  readonly usdRate: number;
  readonly publicUrl: string;
  readonly fee: ProcessingFee | undefined;
  readonly provider: MercadoPagoClient;
  readonly #webhookSecret: string;

  constructor(input: BillingSettingsInput) {
    if (input.webhookSecret.length === 0) throw new Error('Mercado Pago webhook secret is empty');
    this.currency = input.currency;
    this.usdRate = input.usdRate;
    this.fee = input.fee;
    this.publicUrl = input.publicUrl.replace(/\/+$/u, '');
    this.provider = new MercadoPagoClient(input.accessToken, input.client);
    this.#webhookSecret = input.webhookSecret;
  }

  get backUrl(): string { return `${this.publicUrl}/config?seccion=plan&pago=vuelta`; }
  get webhookUrl(): string { return `${this.publicUrl}/v3/billing/mercadopago/webhook`; }

  verifyWebhook(input: Omit<WebhookSignatureInput, 'secret'>): boolean {
    return verifyWebhookSignature({ ...input, secret: this.#webhookSecret });
  }

  toJSON(): Record<string, unknown> {
    return { currency: this.currency, usd_rate: this.usdRate, fee: this.fee ?? null, public_url: this.publicUrl };
  }
}

export type BillingConfiguration = { readonly settings: BillingSettings } | { readonly reason: BillingDisabledReason };

type SecretReader = (path: string) => Promise<string>;

async function secretFile(path: string | undefined, read: SecretReader): Promise<string | undefined | null> {
  if (path === undefined || path.trim() === '') return undefined;
  try {
    const value = (await read(path)).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/** Billing stays disabled, never half-enabled, when any secret or conversion setting is missing or invalid. */
export async function configuredBilling(
  environment: NodeJS.ProcessEnv = process.env,
  read: SecretReader = path => readFile(path, 'utf8'),
): Promise<BillingConfiguration> {
  const accessToken = await secretFile(environment.MERCADOPAGO_ACCESS_TOKEN_FILE, read);
  if (accessToken === undefined) return { reason: 'missing_access_token' };
  const webhookSecret = await secretFile(environment.MERCADOPAGO_WEBHOOK_SECRET_FILE, read);
  if (webhookSecret === undefined) return { reason: 'missing_webhook_secret' };
  if (accessToken === null || webhookSecret === null) return { reason: 'unreadable_secret' };
  const currency = (environment.BILLING_CURRENCY ?? DEFAULT_BILLING_CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) return { reason: 'invalid_currency' };
  const rateText = environment.BILLING_USD_RATE?.trim();
  let usdRate = 1;
  if (rateText === undefined || rateText === '') {
    if (currency !== 'USD') return { reason: 'missing_usd_rate' };
  } else {
    usdRate = /^[0-9]{1,9}(?:\.[0-9]{1,6})?$/u.test(rateText) ? Number(rateText) : Number.NaN;
    if (!Number.isFinite(usdRate) || usdRate <= 0) return { reason: 'invalid_usd_rate' };
  }
  const configuredUrl = environment.BILLING_PUBLIC_URL?.trim();
  const publicUrl = configuredUrl?.length ? configuredUrl : DEFAULT_BILLING_PUBLIC_URL;
  let parsed: URL;
  try { parsed = new URL(publicUrl); } catch { return { reason: 'invalid_public_url' }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return { reason: 'invalid_public_url' };
  const fee = processingFee(environment);
  if (fee === null) return { reason: 'invalid_fee' };
  return { settings: new BillingSettings({ accessToken, webhookSecret, currency, usdRate, fee, publicUrl: parsed.origin + parsed.pathname }) };
}

/** BILLING_FEE_PERCENT, BILLING_FEE_FIXED and BILLING_FEE_VAT; all unset means prices are charged without a fee surcharge. */
function processingFee(environment: NodeJS.ProcessEnv): ProcessingFee | undefined | null {
  const raw = [environment.BILLING_FEE_PERCENT, environment.BILLING_FEE_FIXED, environment.BILLING_FEE_VAT].map(value => value?.trim() ?? '');
  if (raw.every(value => value === '')) return undefined;
  if (raw.some(value => !/^[0-9]{1,7}(?:\.[0-9]{1,4})?$/u.test(value === '' ? '0' : value))) return null;
  const [percent, fixed, vat] = raw.map(value => Number(value === '' ? '0' : value));
  const fee = { percent: percent ?? 0, fixed: fixed ?? 0, vat: vat ?? 0 };
  return validProcessingFee(fee) ? fee : null;
}
