import { ApiError } from './client/core';

const GENERIC_HTTP = new Set([
  'forbidden',
  'not found',
  'conflict',
  'bad request',
  'api request failed',
  'unauthorized',
  'internal server error',
  'service unavailable',
  'too many requests',
]);

/** Keeps a concrete server reason beside the Spanish action. Generic HTTP phrases add nothing. */
export function spanishWithReason(spanish: string, detail: string | undefined): string {
  const reason = detail?.trim();
  if (!reason || GENERIC_HTTP.has(reason.toLowerCase()) || reason === spanish) return spanish;
  return `${spanish} Motivo: ${reason}`;
}

/** A failure as the person sees it: what to do next in Spanish and the stable code to report it with. */
export interface Failure { message: string; code?: string }

/** Stable code of a failed request: the server's own code, else its HTTP status, else a transport failure. */
export function failureCode(cause: unknown): string {
  if (cause instanceof ApiError) return cause.code ?? `http_${String(cause.status)}`;
  return 'request_failed';
}
