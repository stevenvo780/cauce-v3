import { useEffect, useState } from 'react';

export type BloomKind = 'bloom' | 'sparkle';
type Listener = (kind: BloomKind) => void;

const listeners = new Map<string, Set<Listener>>();
const BLOOM_MS = 900;

/** Makes every orb of one agent react at once: the sidebar, the chat header and the thread. */
export function bloomOrb(seed: string, kind: BloomKind = 'bloom'): void {
  for (const listener of listeners.get(seed) ?? []) listener(kind);
}

export function useOrbBloom(seed: string): { kind: BloomKind; n: number } | null {
  const [bloom, setBloom] = useState<{ kind: BloomKind; n: number } | null>(null);
  useEffect(() => {
    let timer = 0;
    const listener: Listener = (kind) => {
      window.clearTimeout(timer);
      setBloom((current) => ({ kind, n: (current?.n ?? 0) + 1 }));
      timer = window.setTimeout(() => { setBloom(null); }, BLOOM_MS);
    };
    const set = listeners.get(seed) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(seed, set);
    return () => {
      window.clearTimeout(timer);
      set.delete(listener);
      if (set.size === 0) listeners.delete(seed);
    };
  }, [seed]);
  return bloom;
}
