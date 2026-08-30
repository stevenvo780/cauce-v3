import { TLSSocket } from 'node:tls';

/** Runtime inputs can violate literal boolean declarations at trust boundaries. */
export function isLiteralTrue(value: unknown): boolean {
  return value === true;
}

/** Abort state is sampled again after awaited work because it can change concurrently. */
export function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Node declarations cannot prove the request-bound TLS state observed at runtime. */
export function isAuthorizedTlsSocket(value: unknown): value is TLSSocket {
  if (!(value instanceof TLSSocket)) return false;
  const state = value as unknown as { readonly encrypted?: unknown; readonly authorized?: unknown };
  return state.encrypted === true && state.authorized === true;
}
