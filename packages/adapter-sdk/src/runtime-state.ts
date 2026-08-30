/** Reads mutable cancellation state without carrying a pre-await TypeScript narrowing. */
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
