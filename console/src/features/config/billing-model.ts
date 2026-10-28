import type { BillingFee, BillingOverview, BillingPlan, BillingPlanId, BillingStatus, BillingSubscription } from '../../api/client/billing-client';

export const QUANTITY_RANGE: Partial<Record<BillingPlanId, { min: number; max: number; initial: number }>> = {
  gestionado: { min: 1, max: 50, initial: 3 },
  espacio: { min: 1, max: 10, initial: 1 },
};

export const PLAN_TITLE: Record<BillingPlanId, string> = {
  gestionado: 'Gestionado',
  hotel_20: 'Hotel 20',
  hotel_50: 'Hotel 50',
  espacio: 'Por espacio',
};

export const PLAN_SUMMARY: Record<BillingPlanId, string> = {
  gestionado: 'Nosotros ponemos y probamos las cuotas de IA y hospedamos tus agentes. Pagas por agente.',
  hotel_20: 'Tú pones tus cuotas y tus ordenadores; pagas la red de interconexión. Hasta 20 agentes.',
  hotel_50: 'Igual que Hotel 20, para hasta 50 agentes.',
  espacio: 'Tú pones cuotas y ordenadores; pagas por espacio de trabajo, con 5 agentes por espacio.',
};

export const PLAN_ORDER: readonly BillingPlanId[] = ['gestionado', 'hotel_20', 'hotel_50', 'espacio'];

export const STATUS_LABEL: Record<BillingStatus, string> = {
  pending: 'Pago pendiente',
  authorized: 'Activo',
  paused: 'Pausado',
  cancelled: 'Cancelado',
};

export function clampQuantity(plan: BillingPlanId, value: number): number {
  const range = QUANTITY_RANGE[plan];
  if (!range) return 1;
  if (!Number.isFinite(value)) return range.initial;
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)));
}

export function quantityOf(plan: BillingPlan, quantity: number): number {
  return plan.plan === 'gestionado' || plan.plan === 'espacio' ? clampQuantity(plan.plan, quantity) : 1;
}

export function totalUsd(plan: BillingPlan, quantity: number): number {
  return Math.round(plan.price_usd * quantityOf(plan, quantity) * 100) / 100;
}

export function agentLimit(plan: BillingPlan, quantity: number): number {
  return plan.agent_limit_per_unit * quantityOf(plan, quantity);
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
}

/** Same rule as the gateway's checkout: the fee is added on top so the plan price arrives whole. */
export function chargedLocal(usd: number, rate: number, fee?: BillingFee | null): number {
  const net = usd * rate;
  if (!fee) return Math.round(net);
  const taxed = 1 + fee.vat / 100;
  return Math.ceil((net + fee.fixed * taxed) / (1 - (fee.percent / 100) * taxed));
}

export function formatLocal(usd: number, currency: string, rate: number, fee?: BillingFee | null): string | undefined {
  if (currency === 'USD' || !(rate > 0)) return undefined;
  const amount = chargedLocal(usd, rate, fee);
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${String(amount)} ${currency}`;
  }
}

/** A subscription that blocks buying another: it is live or waiting for the payment. */
export function holdsPlan(subscription: BillingSubscription | null): boolean {
  return subscription?.status === 'authorized' || subscription?.status === 'pending';
}

/** The company still has to choose a plan: not exempt and without an authorized subscription. */
export function needsPlan(overview: BillingOverview | undefined): boolean {
  return overview !== undefined && overview.configured && !overview.exempt && overview.subscription?.status !== 'authorized';
}
