const GENERIC_HTTP = new Set([
  'forbidden',
  'not found',
  'conflict',
  'bad request',
  'api request failed',
  'unauthorized',
  'internal server error',
  'service unavailable',
]);

/** Keeps a concrete server reason beside the Spanish action. Generic HTTP phrases add nothing. */
export function spanishWithReason(spanish: string, detail: string | undefined): string {
  const reason = detail?.trim();
  if (!reason || GENERIC_HTTP.has(reason.toLowerCase()) || reason === spanish) return spanish;
  return `${spanish} Motivo: ${reason}`;
}
