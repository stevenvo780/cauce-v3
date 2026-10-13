import { useEffect, useRef } from 'react';

// The callback lives in a ref so a fresh arrow per render never resets the interval; a pause or ms <= 0 registers no timer.
export function usePolling(reload: () => void, ms: number, options?: { pausedWhile?: boolean }): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (options?.pausedWhile || ms <= 0) return undefined;
    const timer = window.setInterval(() => { latest.current(); }, ms);
    return () => { window.clearInterval(timer); };
  }, [ms, options?.pausedWhile]);
}
