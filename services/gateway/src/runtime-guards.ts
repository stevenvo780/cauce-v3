import { TLSSocket } from 'node:tls';

/** Node declarations cannot prove the request-bound TLS state observed at runtime. */
export function isAuthorizedTlsSocket(value: unknown): value is TLSSocket {
  if (!(value instanceof TLSSocket)) return false;
  const state = value as unknown as { readonly encrypted?: unknown; readonly authorized?: unknown };
  return state.encrypted === true && state.authorized === true;
}
