import type {
  PreparePublishIntentRateLimited,
  PreparePublishIntentReconciliation,
  PublishIntentExpired,
} from '../types';

export type FetchLike = typeof fetch;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 409 confiable y acotado: hay un efecto previo exacto que debe cerrarse antes de publicar otro. */
export class PublishIntentReconciliationError extends ApiError {
  constructor(readonly reconciliation: PreparePublishIntentReconciliation) {
    super('Hay una publicación durable anterior que requiere reconciliación.', 409,
      'publish_intent_reconciliation_required');
    this.name = 'PublishIntentReconciliationError';
  }
}

/** 410 exacto: el servidor cerró la reserva y demostró que nunca hubo efecto. */
export class PublishIntentExpiredError extends ApiError {
  constructor(readonly expiration: PublishIntentExpired) {
    super(
      'La reserva durable expiró sin publicar ningún mensaje. El borrador sigue intacto; volvé a enviarlo.',
      410,
      'publish_intent_expired',
    );
    this.name = 'PublishIntentExpiredError';
  }
}

/** 429 exacto: el servidor preservó el journal pero no admite otra reserva todavía. */
export class PublishIntentRateLimitedError extends ApiError {
  constructor(readonly rateLimit: PreparePublishIntentRateLimited) {
    super(
      `Hay demasiadas reservas durables recientes. Reintentá en ${String(rateLimit.retry_after_seconds)} s; `
      + 'el borrador sigue intacto.',
      429,
      'publish_intent_rate_limited',
    );
    this.name = 'PublishIntentRateLimitedError';
  }
}

export function safeBase(baseUrl: string): string {
  if (!baseUrl) return '';
  const locOrigin = typeof globalThis.location.origin === 'string' ? globalThis.location.origin : 'http://localhost';
  const parsed = new URL(baseUrl, locOrigin);
  if (parsed.username || parsed.password) {
    throw new Error('VITE_CAUCE_API_BASE must not contain credentials');
  }
  if (import.meta.env.PROD && typeof globalThis.location.origin === 'string' && parsed.origin !== globalThis.location.origin) {
    throw new Error('Production OIDC BFF API base must be same-origin');
  }
  return baseUrl.replace(/\/$/, '');
}

export function errorBody(value: unknown): { message?: string; error?: string } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

export function reconciliationBody(value: unknown): PreparePublishIntentReconciliation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'idempotency_key', 'receipt', 'state', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_reconciliation_required'
      || record.state !== 'committed'
      || typeof record.idempotency_key !== 'string'
      || record.idempotency_key.length < 1
      || record.idempotency_key.length > 200
      || record.receipt === null
      || typeof record.receipt !== 'object'
      || Array.isArray(record.receipt)) return undefined;
  return record as unknown as PreparePublishIntentReconciliation;
}

export function expirationBody(value: unknown): PublishIntentExpired | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'idempotency_key', 'safe_to_resubmit', 'state', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_expired'
      || record.state !== 'expired'
      || typeof record.idempotency_key !== 'string'
      || record.idempotency_key.length < 1
      || record.idempotency_key.length > 200
      || record.safe_to_resubmit !== true) return undefined;
  return record as unknown as PublishIntentExpired;
}

export function rateLimitBody(value: unknown): PreparePublishIntentRateLimited | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'retry_after_seconds', 'safe_to_retry', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_rate_limited'
      || !Number.isSafeInteger(record.retry_after_seconds)
      || Number(record.retry_after_seconds) < 1
      || Number(record.retry_after_seconds) > 86_400
      || record.safe_to_retry !== true) return undefined;
  return record as unknown as PreparePublishIntentRateLimited;
}

export interface RequestOptions {
  requireCsrf?: boolean;
  mapError?: (status: number, body: unknown) => Error | undefined;
}

/**
 * Tiempo máximo de espera para peticiones HTTP antes de abortar por timeout.
 */
export const TIEMPO_MAXIMO_MS = 30_000;

export function segundos(ms: number): string {
  return `${String(Math.round(ms / 1000))} s`;
}

export function esperaVencida(method: string, path: string, tope: number): ApiError {
  return new ApiError(
    `El servidor no contestó en ${segundos(tope)} y la consola cortó la espera (${method} ${path}). `
    + 'No quiere decir que no haya datos: quiere decir que no se pudieron leer.',
    504,
    'timeout',
  );
}

export function corteAlVencer(signal: AbortSignal, method: string, path: string, tope: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(esperaVencida(method, path, tope));
      return;
    }
    signal.addEventListener('abort', () => { reject(esperaVencida(method, path, tope)); }, { once: true });
  });
}
