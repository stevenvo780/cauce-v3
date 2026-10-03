import { useCallback, useSyncExternalStore } from 'react';

const QUERY = '(max-width: 760px)';

export function useCompactLayout(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(QUERY);
    media.addEventListener('change', onChange);
    return () => { media.removeEventListener('change', onChange); };
  }, []);
  const getSnapshot = useCallback(() => window.matchMedia(QUERY).matches, []);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
