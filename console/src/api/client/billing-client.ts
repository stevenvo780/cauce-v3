import type { RequestFn } from './system-client';

export type BillingPlanId = 'gestionado' | 'hotel_20' | 'hotel_50' | 'espacio';
export type BillingStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface BillingPlan {
  plan: BillingPlanId;
  price_usd: number;
  unit: string;
  agent_limit_per_unit: number;
  recommended_quantity?: number;
}

export interface BillingSubscription {
  id?: string;
  plan: BillingPlanId;
  quantity: number;
  agent_limit: number;
  amount_usd: number;
  currency: string;
  amount_local: number;
  status: BillingStatus;
  checkout_url?: string | null;
}

export interface BillingFee {
  percent: number;
  fixed: number;
  vat: number;
}

export interface BillingOverview {
  configured: boolean;
  exempt: boolean;
  plans: BillingPlan[];
  currency: string;
  usd_rate: number;
  /** Mercado Pago's charge that the local price includes, so the plan price arrives whole; null without a surcharge. */
  fee?: BillingFee | null;
  subscription: BillingSubscription | null;
  /** `limit` is null for an exempt company and 0 without an authorized subscription. */
  allowance: { limit: number | null; used: number };
}

export interface BillingClient {
  getBilling(): Promise<BillingOverview>;
  startBillingCheckout(input: { plan: BillingPlanId; quantity: number; payer_email?: string }): Promise<{ checkout_url: string }>;
  cancelBilling(): Promise<unknown>;
  refreshBilling(): Promise<unknown>;
}

const base = '/v3/console/billing';

export function billingClient(request: RequestFn): BillingClient {
  const post = <T>(path: string, body?: unknown) => request<T>(path, {
    method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    getBilling: () => request<BillingOverview>(base, { cache: 'no-store' }),
    startBillingCheckout: (input) => post(`${base}/checkout`, input),
    cancelBilling: () => post(`${base}/cancel`),
    refreshBilling: () => post(`${base}/refresh`),
  };
}
