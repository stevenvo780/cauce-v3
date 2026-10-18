import { useEffect, useRef } from 'react';

// The callback lives in a ref so a fresh arrow per render never resets the interval; a pause or ms <= 0 registers no timer.
// Polling stops while the tab is hidden: a background tab must not keep hitting the gateway, and
// returning to the tab reloads once immediately instead of waiting for the next period.
export function usePolling(reload: () => void, ms: number, options?: { pausedWhile?: boolean }): void {
  const latest = useRef(reload);
  latest.current = reload;
  const paused = options?.pausedWhile ?? false;
  useEffect(() => {
    if (paused || ms <= 0) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => { latest.current(); }, ms);
    };
    const stop = () => {
      if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { latest.current(); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [ms, paused]);
}
