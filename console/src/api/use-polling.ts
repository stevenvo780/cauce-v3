import { useEffect } from 'react';

// A pause or a non-positive period registers NO interval: a poller nobody watches keeps no timer.
export function usePolling(reload: () => void, ms: number, options?: { pausedWhile?: boolean }): void {
  useEffect(() => {
    if (options?.pausedWhile || ms <= 0) return undefined;
    const timer = window.setInterval(reload, ms);
    return () => { window.clearInterval(timer); };
  }, [reload, ms, options?.pausedWhile]);
}
