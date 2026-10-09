import { useState } from 'react';
import { assignSlots, sameSlots } from './capacity';

/** A persistent id -> slot map: nobody else moves when someone arrives or leaves. */
export function useSlots(ids: readonly string[], limit?: number): ReadonlyMap<string, number> {
  const [kept, setKept] = useState<ReadonlyMap<string, number>>(() => new Map());
  const next = assignSlots(kept, ids, limit);
  if (!sameSlots(next, kept)) setKept(next);
  return sameSlots(next, kept) ? kept : next;
}
