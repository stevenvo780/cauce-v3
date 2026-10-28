import type { DatabaseClient } from './db.js';
import { StoreError } from './repository/errors.js';

type Queryable = Pick<DatabaseClient, 'query'>;

export const BILLING_PLANS = ['gestionado', 'hotel_20', 'hotel_50', 'espacio'] as const;
export type BillingPlan = typeof BILLING_PLANS[number];
export const BILLING_STATUSES = ['pending', 'authorized', 'paused', 'cancelled'] as const;
export type BillingStatus = typeof BILLING_STATUSES[number];

export const GESTIONADO_MAX_AGENTS = 50;
export const GESTIONADO_RECOMMENDED_AGENTS = 3;
export const ESPACIO_MAX_SPACES = 10;

interface PlanDefinition {
  unitUsd: number;
  agentsPerUnit: number;
  minQuantity: number;
  maxQuantity: number;
  recommendedQuantity?: number;
}

export const BILLING_PLAN_DEFINITIONS: Readonly<Record<BillingPlan, PlanDefinition>> = {
  gestionado: { unitUsd: 100, agentsPerUnit: 1, minQuantity: 1, maxQuantity: GESTIONADO_MAX_AGENTS, recommendedQuantity: GESTIONADO_RECOMMENDED_AGENTS },
  hotel_20: { unitUsd: 150, agentsPerUnit: 20, minQuantity: 1, maxQuantity: 1 },
  hotel_50: { unitUsd: 300, agentsPerUnit: 50, minQuantity: 1, maxQuantity: 1 },
  espacio: { unitUsd: 40, agentsPerUnit: 5, minQuantity: 1, maxQuantity: ESPACIO_MAX_SPACES },
};

export interface PlanQuote { amount_usd: number; agent_limit: number }

export function isBillingPlan(value: unknown): value is BillingPlan {
  return typeof value === 'string' && (BILLING_PLANS as readonly string[]).includes(value);
}

export function planQuote(plan: BillingPlan, quantity: number): PlanQuote {
  if (!isBillingPlan(plan)) throw new StoreError('invalid_input', 'unknown billing plan');
  const definition = BILLING_PLAN_DEFINITIONS[plan];
  if (!Number.isInteger(quantity) || quantity < definition.minQuantity || quantity > definition.maxQuantity) {
    throw new StoreError('invalid_input', `quantity for ${plan} must be an integer between ${String(definition.minQuantity)} and ${String(definition.maxQuantity)}`);
  }
  return { amount_usd: definition.unitUsd * quantity, agent_limit: definition.agentsPerUnit * quantity };
}

export function localAmount(amountUsd: number, usdRate: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(usdRate) || usdRate <= 0) {
    throw new StoreError('invalid_input', 'amount and rate must be positive numbers');
  }
  return Math.round(amountUsd * usdRate);
}

export function mapProviderStatus(status: string): BillingStatus | null {
  switch (status) {
    case 'pending': return 'pending';
    case 'authorized': return 'authorized';
    case 'paused': return 'paused';
    case 'cancelled': case 'finished': return 'cancelled';
    default: return null;
  }
}

export interface BillingSubscription {
  id: string;
  company_id: string;
  plan: BillingPlan;
  quantity: number;
  agent_limit: number;
  amount_usd: number;
  currency: string;
  amount_local: number;
  status: BillingStatus;
  provider: string;
  provider_subscription_id: string | null;
  checkout_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

interface SubscriptionRow extends Omit<BillingSubscription, 'amount_usd' | 'amount_local' | 'created_at' | 'updated_at' | 'last_event_at'> {
  amount_usd: string;
  amount_local: string;
  created_at: Date;
  updated_at: Date;
  last_event_at: Date | null;
}

const SUBSCRIPTION_COLUMNS = `id::text,company_id,plan,quantity,agent_limit,amount_usd::text,currency,amount_local::text,status,
  provider,provider_subscription_id,checkout_url,created_by,created_at,updated_at,last_event_at`;

function toSubscription(row: SubscriptionRow): BillingSubscription {
  return {
    ...row,
    amount_usd: Number(row.amount_usd),
    amount_local: Number(row.amount_local),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_event_at: row.last_event_at?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingSubscriptionInput {
  company_id: string;
  plan: BillingPlan;
  quantity: number;
  currency: string;
  amount_local: number;
  created_by?: string | null;
}

export async function createPendingSubscription(db: Queryable, input: PendingSubscriptionInput): Promise<BillingSubscription> {
  const quote = planQuote(input.plan, input.quantity);
  if (!/^[A-Z]{3}$/u.test(input.currency)) throw new StoreError('invalid_input', 'currency must be a three-letter code');
  if (!Number.isFinite(input.amount_local) || input.amount_local <= 0) throw new StoreError('invalid_input', 'local amount must be positive');
  try {
    const result = await db.query<SubscriptionRow>(
      `INSERT INTO billing_subscriptions(company_id,plan,quantity,agent_limit,amount_usd,currency,amount_local,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [input.company_id, input.plan, input.quantity, quote.agent_limit, quote.amount_usd, input.currency,
        input.amount_local, input.created_by ?? null]);
    const [row] = result.rows;
    if (!row) throw new StoreError('conflict', 'subscription insert returned no row');
    return toSubscription(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('conflict', 'the company already has a pending or authorized subscription');
    throw error;
  }
}

export async function attachProviderSubscription(
  db: Queryable, id: string, provider: { provider_subscription_id: string; checkout_url: string },
): Promise<BillingSubscription> {
  if (!UUID_PATTERN.test(id)) throw new StoreError('invalid_input', 'invalid subscription id');
  try {
    const result = await db.query<SubscriptionRow>(
      `UPDATE billing_subscriptions SET provider_subscription_id=$2,checkout_url=$3,updated_at=now()
        WHERE id=$1 AND status='pending' AND provider_subscription_id IS NULL RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [id, provider.provider_subscription_id, provider.checkout_url]);
    if (!result.rows[0]) throw new StoreError('not_found', 'no pending subscription without a provider id');
    return toSubscription(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('conflict', 'provider subscription id is already attached');
    throw error;
  }
}

export interface ProviderStatusUpdate {
  id: string;
  provider_subscription_id: string;
  status: string;
}

/** Applies a status the caller just re-read from the provider. Returns null when the row is absent, belongs to another provider id, or the status is unknown. */
export async function applyProviderStatus(db: Queryable, update: ProviderStatusUpdate): Promise<BillingSubscription | null> {
  const status = mapProviderStatus(update.status);
  if (status === null || !UUID_PATTERN.test(update.id)) return null;
  try {
    const result = await db.query<SubscriptionRow>(
      `UPDATE billing_subscriptions SET status=$3,provider_subscription_id=COALESCE(provider_subscription_id,$2),
          updated_at=now(),last_event_at=now()
        WHERE id=$1 AND (provider_subscription_id IS NULL OR provider_subscription_id=$2)
          AND (status<>'cancelled' OR $3='cancelled')
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [update.id, update.provider_subscription_id, status]);
    return result.rows[0] ? toSubscription(result.rows[0]) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('conflict', 'the company already has another pending or authorized subscription');
    throw error;
  }
}

export interface BillingEventInput {
  provider_event_id: string;
  request_id?: string | null;
  topic: string;
  subscription_id?: string | null;
  payload: unknown;
}

/** Returns true when the event is new and false when the same (provider_event_id, topic) was recorded before. */
export async function recordBillingEvent(db: Queryable, event: BillingEventInput): Promise<boolean> {
  if (event.provider_event_id.length === 0 || event.topic.length === 0) throw new StoreError('invalid_input', 'event id and topic are required');
  const result = await db.query(
    `INSERT INTO billing_events(provider_event_id,request_id,topic,subscription_id,payload)
     VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT (provider_event_id,topic) DO NOTHING`,
    [event.provider_event_id, event.request_id ?? null, event.topic, event.subscription_id ?? null,
      JSON.stringify(event.payload ?? {})]);
  return result.rowCount === 1;
}

export async function readSubscription(db: Queryable, id: string): Promise<BillingSubscription | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const result = await db.query<SubscriptionRow>(`SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE id=$1`, [id]);
  return result.rows[0] ? toSubscription(result.rows[0]) : null;
}

/** The live (pending or authorized) subscription of a company, else the most recent one, else null. */
export async function currentSubscription(db: Queryable, companyId: string): Promise<BillingSubscription | null> {
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE company_id=$1
      ORDER BY (status IN ('authorized','pending')) DESC,created_at DESC,id LIMIT 1`, [companyId]);
  return result.rows[0] ? toSubscription(result.rows[0]) : null;
}

export interface CompanyAgentAllowance {
  exempt: boolean;
  /** null when exempt; 0 when the company has no authorized subscription. */
  limit: number | null;
  used: number;
}

/**
 * SQL over the alias `agent`: a live agent that counts toward a plan. A person's console seat that never got a
 * runtime and a company system principal (the context director) are identities, not agents, and never count.
 */
export const PLAN_AGENT_SQL = `((agent.enabled OR agent.lifecycle_state<>'retired') AND agent.retired_at IS NULL AND agent.purged_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM company_system_principals principal
    WHERE principal.tenant_id=agent.tenant_id AND principal.principal_alias=agent.alias)
  AND (agent.enabled OR agent.runtime_key IS NOT NULL
    OR (NOT EXISTS (SELECT 1 FROM console_users person WHERE person.tenant_id=agent.tenant_id AND person.alias=agent.alias)
      AND NOT EXISTS (SELECT 1 FROM human_tenant_memberships human
        WHERE human.tenant_id=agent.tenant_id AND human.actor_alias=agent.alias))))`;

/** In-flight fleet creates and restores of agents that do not count yet already hold a plan slot. */
export const PENDING_PLAN_AGENT_SQL = `SELECT DISTINCT operation.request->'target'->>'tenant_id' AS tenant_id,
    operation.request->'target'->>'alias' AS alias
   FROM fleet_operations operation
   JOIN tenants tenant ON tenant.id=operation.request->'target'->>'tenant_id'
   LEFT JOIN agents agent ON agent.tenant_id=tenant.id AND agent.alias=operation.request->'target'->>'alias'
  WHERE tenant.company_id=$1 AND operation.kind IN ('create','restore')
    AND operation.request->'target'->>'resource'='agent' AND operation.status IN ('queued','running')
    AND operation.request->'target'->>'alias' IS NOT NULL
    AND (agent.tenant_id IS NULL OR NOT ${PLAN_AGENT_SQL})`;

/** Serializes allowance checks of one company until the caller's transaction ends. */
export async function lockCompanyAllowance(db: Queryable, companyId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('cauce:billing-allowance'),hashtext($1))`, [companyId]);
}

export async function companyAgentAllowance(db: Queryable, companyId: string): Promise<CompanyAgentAllowance> {
  const result = await db.query<{ exempt: boolean; limit: number | null; used: number }>(
    `SELECT company.billing_exempt AS exempt,
        (SELECT subscription.agent_limit FROM billing_subscriptions subscription
          WHERE subscription.company_id=company.id AND subscription.status='authorized') AS "limit",
        (SELECT count(*)::integer FROM agents agent WHERE agent.company_id=company.id AND ${PLAN_AGENT_SQL})
          + (SELECT count(*)::integer FROM (${PENDING_PLAN_AGENT_SQL}) pending) AS used
       FROM companies company WHERE company.id=$1`, [companyId]);
  const row = result.rows[0];
  if (!row) throw new StoreError('not_found', 'company does not exist');
  return { exempt: row.exempt, limit: row.exempt ? null : row.limit ?? 0, used: row.used };
}

export function allowanceAdmitsAgent(allowance: CompanyAgentAllowance): boolean {
  return allowance.exempt || (allowance.limit !== null && allowance.used < allowance.limit);
}
