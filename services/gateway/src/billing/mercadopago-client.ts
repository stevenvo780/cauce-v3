import { z } from 'zod';

const DEFAULT_API_URL = 'https://api.mercadopago.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const PREAPPROVAL_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const PreapprovalSchema = z.object({
  id: z.string().regex(PREAPPROVAL_ID),
  status: z.string().min(1).max(64),
  external_reference: z.string().max(256).nullish(),
  init_point: z.string().max(2048).nullish(),
});

export interface MercadoPagoPreapproval {
  readonly id: string;
  readonly status: string;
  readonly external_reference: string | null;
  readonly init_point: string | null;
}

export interface PreapprovalRequest {
  /** Internal subscription id: the external reference and the idempotency key. */
  readonly id: string;
  readonly reason: string;
  readonly payerEmail: string;
  readonly backUrl: string;
  readonly amount: number;
  readonly currency: string;
}

/** Carries only the HTTP status: provider bodies are never copied into errors or logs. */
export class MercadoPagoError extends Error {
  constructor(readonly status: number | undefined, message: string) {
    super(message);
    this.name = 'MercadoPagoError';
  }
}

export interface MercadoPagoClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function isPreapprovalId(value: string): boolean {
  return PREAPPROVAL_ID.test(value);
}

export class MercadoPagoClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(token: string, options: MercadoPagoClientOptions = {}) {
    if (token.length === 0) throw new Error('Mercado Pago access token is empty');
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/u, '');
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  createPreapproval(input: PreapprovalRequest): Promise<MercadoPagoPreapproval> {
    return this.#send('POST', '/preapproval', input.id, {
      reason: input.reason,
      external_reference: input.id,
      payer_email: input.payerEmail,
      back_url: input.backUrl,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: input.amount, currency_id: input.currency },
      status: 'pending',
    });
  }

  async getPreapproval(id: string): Promise<MercadoPagoPreapproval> {
    return this.#send('GET', `/preapproval/${encodeURIComponent(preapprovalId(id))}`);
  }

  /** The key differs from the creation key so the provider cannot replay the cached creation reply. */
  async cancelPreapproval(id: string, internalId: string): Promise<MercadoPagoPreapproval> {
    return this.#send('PUT', `/preapproval/${encodeURIComponent(preapprovalId(id))}`, `${internalId}:cancel`, { status: 'cancelled' });
  }

  async #send(method: 'GET' | 'POST' | 'PUT', path: string, idempotencyKey?: string, body?: unknown): Promise<MercadoPagoPreapproval> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
    if (idempotencyKey !== undefined) headers['X-Idempotency-Key'] = idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method, headers, signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new MercadoPagoError(undefined, `Mercado Pago ${method} ${path} did not answer`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MercadoPagoError(response.status, `Mercado Pago ${method} ${path} answered HTTP ${String(response.status)}`);
    }
    let parsed: z.infer<typeof PreapprovalSchema>;
    try {
      parsed = PreapprovalSchema.parse(await response.json());
    } catch {
      throw new MercadoPagoError(response.status, `Mercado Pago ${method} ${path} returned an unexpected preapproval`);
    }
    return { id: parsed.id, status: parsed.status, external_reference: parsed.external_reference ?? null, init_point: parsed.init_point ?? null };
  }
}

function preapprovalId(id: string): string {
  if (!isPreapprovalId(id)) throw new MercadoPagoError(undefined, 'invalid Mercado Pago preapproval id');
  return id;
}
