// Callers loop on one long-lived AbortSignal for the process lifetime: a timeout resolution
// must remove its own listener too, or each poll interval leaks one more onto that signal.
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
