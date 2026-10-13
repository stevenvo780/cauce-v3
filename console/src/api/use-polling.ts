import { useEffect, useRef } from 'react';

// A pause or a non-positive period registers NO interval: a poller nobody watches keeps no timer.
// The callback lives in a ref so a caller passing a fresh arrow each render never resets the interval.
export function usePolling(reload: () => void, ms: number, options?: { pausedWhile?: boolean }): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (options?.pausedWhile || ms <= 0) return undefined;
    const timer = window.setInterval(() => { latest.current(); }, ms);
    return () => { window.clearInterval(timer); };
  }, [ms, options?.pausedWhile]);
}
