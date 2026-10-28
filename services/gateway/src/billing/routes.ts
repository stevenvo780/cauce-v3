import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyProviderStatus, attachProviderSubscription, BILLING_PLAN_DEFINITIONS, BILLING_PLANS, companyAgentAllowance, createPendingSubscription, currentSubscription,
  localAmount, planQuote, readSubscription, recordBillingEvent, StoreError, withTransaction,
  type BillingPlan, type BillingSubscription, type CompanyAuthority, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { scalarHeaderValue } from '../http-auth-primitives.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { replyError } from '../routes/shared.js';
import type { BillingSettings } from './config.js';
import { isPreapprovalId, MercadoPagoError, type MercadoPagoPreapproval } from './mercadopago-client.js';

export const BILLING_UNCONFIGURED = { error: 'billing_unconfigured', message: 'Pagos sin configurar.' } as const;
export const WEBHOOK_PATH = '/v3/billing/mercadopago/webhook';
const WEBHOOK_BODY_LIMIT = 32_768;
const PREAPPROVAL_TOPIC = 'subscription_preapproval';
const BILLING_ADMINISTRATORS: ReadonlySet<string> = new Set(['platform_admin', 'company_owner', 'company_admin']);
const PLAN_UNIT: Readonly<Record<BillingPlan, string>> = { gestionado: 'agent', hotel_20: 'network', hotel_50: 'network', espacio: 'space' };
const PLAN_NAME: Readonly<Record<BillingPlan, string>> = {
  gestionado: 'Gestionado', hotel_20: 'Hotel 20', hotel_50: 'Hotel 50', espacio: 'Espacio',
};

/** `payer_email` is the payer's Mercado Pago account, which may differ from the console login. */
const CheckoutInput = z.object({ plan: z.enum(BILLING_PLANS), quantity: z.number().int(), payer_email: z.email().max(254).optional() }).strict();

class BillingRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface BillingAdministrator {
  readonly company: string;
  readonly humanId: string;
}

function billingPlans() {
  return BILLING_PLANS.map(plan => {
    const definition = BILLING_PLAN_DEFINITIONS[plan];
    return { plan, price_usd: definition.unitUsd, unit: PLAN_UNIT[plan], agent_limit_per_unit: definition.agentsPerUnit,
      ...(definition.recommendedQuantity === undefined ? {} : { recommended_quantity: definition.recommendedQuantity }) };
  });
}

/** What the console sees: no company id, creator identity or provider id. */
function publicSubscription(subscription: BillingSubscription | null) {
  if (subscription === null) return null;
  const { id, plan, quantity, agent_limit, amount_usd, currency, amount_local, status, checkout_url, created_at, updated_at } = subscription;
  return { id, plan, quantity, agent_limit, amount_usd, currency, amount_local, status, checkout_url, created_at, updated_at };
}

function administrator(authority: CompanyAuthority): BillingAdministrator {
  if (!BILLING_ADMINISTRATORS.has(authority.role) || authority.humanId === null) {
    throw new AuthorizationError('Solo un administrador de la empresa gestiona su plan.');
  }
  return { company: authority.actingCompany, humanId: authority.humanId };
}

function providerReply(reply: FastifyReply, error: MercadoPagoError): FastifyReply {
  reply.log.warn({ event: 'billing_provider_failed', status: error.status }, 'Mercado Pago request failed');
  return reply.code(502).send({ error: 'billing_provider_unavailable', message: 'Mercado Pago no respondió. Intenta de nuevo en unos minutos.' });
}

function billingError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'invalid billing request' });
  if (error instanceof BillingRequestError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof MercadoPagoError) return providerReply(reply, error);
  if (error instanceof StoreError && error.code === 'invalid_input') return reply.code(400).send({ error: 'invalid_request', message: error.message });
  if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) { replyError(reply, error); return undefined; }
  throw error;
}

function matchesSubscription(preapproval: MercadoPagoPreapproval, subscription: BillingSubscription): boolean {
  return preapproval.id === subscription.provider_subscription_id && preapproval.external_reference === subscription.id;
}

function checkoutUrl(value: string | null): string {
  try {
    if (value !== null && new URL(value).protocol === 'https:') return value;
  } catch { /* falls through to the provider error */ }
  throw new MercadoPagoError(undefined, 'Mercado Pago returned no secure checkout URL');
}

async function applyReread(pool: DatabasePool, subscription: BillingSubscription, preapproval: MercadoPagoPreapproval): Promise<BillingSubscription> {
  if (!matchesSubscription(preapproval, subscription)) throw new StoreError('conflict', 'Mercado Pago returned another subscription');
  const applied = await applyProviderStatus(pool, { id: subscription.id, provider_subscription_id: preapproval.id, status: preapproval.status });
  return applied ?? subscription;
}

export function registerBillingRoutes(
  app: FastifyInstance, provider: AuthProvider, pool: DatabasePool, settings: BillingSettings | undefined,
): void {
  const withAdministrator = async <T>(request: FastifyRequest, reply: FastifyReply,
    work: (client: DatabaseClient, admin: BillingAdministrator) => Promise<T>): Promise<T> => {
    const access = await consoleHumanAccess(provider, request, reply, 'read');
    if (!access) throw new AuthorizationError('a console session is required');
    try {
      return await withTransaction(pool, async client => work(client, administrator(await access.companyAuthority(client))));
    } finally { access.close(); }
  };
  const consoleRoute = (method: 'GET' | 'POST', url: string,
    handler: (request: FastifyRequest, reply: FastifyReply, billing: BillingSettings) => Promise<unknown>) => {
    app.route({ method, url, bodyLimit: 4096, handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (settings === undefined) return reply.code(503).send(BILLING_UNCONFIGURED);
      try {
        if (method === 'POST' && provider instanceof PasswordAuthProvider) await provider.requireCsrf(request);
        return await handler(request, reply, settings);
      } catch (error) { return billingError(reply, error); }
    } });
  };

  consoleRoute('GET', '/v3/console/billing', async (request, reply, billing) => withAdministrator(request, reply, async (client, admin) => {
    const allowance = await companyAgentAllowance(client, admin.company);
    return { configured: true, exempt: allowance.exempt, plans: billingPlans(), currency: billing.currency, usd_rate: billing.usdRate,
      fee: billing.fee ?? null,
      subscription: publicSubscription(await currentSubscription(client, admin.company)), allowance: { limit: allowance.limit, used: allowance.used } };
  }));

  consoleRoute('POST', '/v3/console/billing/checkout', async (request, reply, billing) => {
    const input = CheckoutInput.parse(request.body);
    const quote = planQuote(input.plan, input.quantity);
    const amount = localAmount(quote.amount_usd, billing.usdRate, billing.fee);
    return withAdministrator(request, reply, async (client, admin) => {
      if ((await companyAgentAllowance(client, admin.company)).exempt) {
        throw new BillingRequestError(409, 'billing_exempt', 'Esta empresa no paga plan.');
      }
      const email = (await client.query<{ email: string }>('SELECT email FROM console_users WHERE id=$1', [admin.humanId])).rows[0]?.email;
      if (email === undefined) throw new AuthorizationError();
      const pending = await createPendingSubscription(client, { company_id: admin.company, plan: input.plan, quantity: input.quantity,
        currency: billing.currency, amount_local: amount, created_by: `console:${admin.humanId}` });
      // The pending row holds the company's single live slot; a provider failure rolls it back with the transaction.
      const created = await billing.provider.createPreapproval({ id: pending.id, payerEmail: input.payer_email ?? email, backUrl: billing.backUrl,
        reason: `Cauce ${PLAN_NAME[input.plan]}${input.quantity > 1 ? ` x${String(input.quantity)}` : ''}`, amount, currency: billing.currency });
      if (created.external_reference !== null && created.external_reference !== pending.id) {
        throw new MercadoPagoError(undefined, 'Mercado Pago returned another external reference');
      }
      const url = checkoutUrl(created.init_point);
      await attachProviderSubscription(client, pending.id, { provider_subscription_id: created.id, checkout_url: url });
      request.log.info({ event: 'billing_checkout_created', company_id: admin.company, plan: input.plan, quantity: input.quantity },
        'billing checkout created');
      return { checkout_url: url };
    });
  });

  for (const action of ['cancel', 'refresh'] as const) {
    consoleRoute('POST', `/v3/console/billing/${action}`, async (request, reply, billing) => {
      const subscription = await withAdministrator(request, reply, async (client, admin) => currentSubscription(client, admin.company));
      if (subscription === null) {
        if (action === 'refresh') return { subscription: null };
        throw new BillingRequestError(404, 'not_found', 'La empresa no tiene una suscripción que cancelar.');
      }
      const providerId = subscription.provider_subscription_id;
      if (providerId === null || (action === 'cancel' && subscription.status === 'cancelled')) {
        if (action === 'refresh') return { subscription: publicSubscription(subscription) };
        throw new BillingRequestError(409, 'conflict', 'La suscripción ya está cancelada.');
      }
      if (action === 'cancel') await billing.provider.cancelPreapproval(providerId, subscription.id);
      const updated = await applyReread(pool, subscription, await billing.provider.getPreapproval(providerId));
      if (action === 'cancel') request.log.info({ event: 'billing_cancelled', company_id: subscription.company_id }, 'billing subscription cancelled');
      return { subscription: publicSubscription(updated) };
    });
  }

  app.post(WEBHOOK_PATH, { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (settings === undefined) return reply.code(503).send(BILLING_UNCONFIGURED);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const dataId = typeof query['data.id'] === 'string' ? query['data.id'] : undefined;
    const requestId = scalarHeaderValue(request.headers['x-request-id']);
    if (!settings.verifyWebhook({ signature: scalarHeaderValue(request.headers['x-signature']), requestId, dataId }) || dataId === undefined) {
      request.log.warn({ event: 'billing_webhook_rejected' }, 'billing webhook signature rejected');
      return reply.code(401).send({ error: 'invalid_signature', message: 'invalid webhook signature' });
    }
    const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const topic = [body.type, query.type, query.topic].find((value): value is string => typeof value === 'string' && value.length > 0);
    if (topic === undefined) return { received: true };
    const eventId = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id) : requestId ?? dataId;
    try {
      const preapproval = topic === PREAPPROVAL_TOPIC && isPreapprovalId(dataId) ? await settings.provider.getPreapproval(dataId) : undefined;
      if (preapproval !== undefined && preapproval.id !== dataId) throw new MercadoPagoError(undefined, 'Mercado Pago returned another preapproval');
      const applied = await withTransaction(pool, async client => {
        const subscription = preapproval?.external_reference ? await readSubscription(client, preapproval.external_reference) : null;
        const fresh = await recordBillingEvent(client, { provider_event_id: eventId, request_id: requestId ?? null, topic,
          subscription_id: subscription?.id ?? null, payload: body });
        if (!fresh || preapproval === undefined || subscription === null) return false;
        await client.query('SAVEPOINT billing_status');
        try {
          return await applyProviderStatus(client, { id: subscription.id, provider_subscription_id: preapproval.id, status: preapproval.status }) !== null;
        } catch (error) {
          if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
          await client.query('ROLLBACK TO SAVEPOINT billing_status');
          request.log.warn({ event: 'billing_status_conflict', subscription_id: subscription.id }, 'billing status conflicts with a live subscription');
          return false;
        }
      });
      request.log.info({ event: 'billing_webhook', topic, applied }, 'billing webhook received');
      return { received: true };
    } catch (error) {
      if (error instanceof MercadoPagoError) return providerReply(reply, error);
      throw error;
    }
  });
}
